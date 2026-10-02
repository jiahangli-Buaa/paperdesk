import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


class RecordsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'PAPERDESK_DATA_DIR': self.temp.name})
        self.env.start()
        spec = importlib.util.spec_from_file_location('paperdesk_test_server', Path(__file__).resolve().parents[2] / 'src/backend/server.py')
        self.app = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.app)
        self.app.initialize()
        with self.app.connect() as con:
            con.execute('INSERT OR IGNORE INTO journals VALUES(?,?,?,?,?)', ('scis','SCIENCE CHINA Information Sciences','SCIS','ScholarOne','https://mc03.manuscriptcentral.com/scis'))
        self.metric_queue = patch.object(self.app, 'queue_journal_metrics')
        self.metric_queue.start()
        self.reader_pool = patch.object(self.app.portal_sync, 'read_with_browser', side_effect=lambda node,reader,payload,timeout:self.app.portal_sync.subprocess.run([node,str(reader)],input=json.dumps(payload),text=True,capture_output=True,timeout=timeout))
        self.reader_pool_mock = self.reader_pool.start()

    def tearDown(self):
        self.reader_pool.stop()
        self.metric_queue.stop()
        self.env.stop()
        self.temp.cleanup()

    def test_embedded_scheduler_calls_full_refresh_and_preserves_real_status(self):
        from datetime import datetime, timedelta
        from refresh_schedule import BEIJING
        account = self.account('scheduled-reader')
        paper = self.app.manuscript_save(self.paper(account, 'AUTO-01', status='submitted'))['id']
        paused = self.app.manuscript_save(self.paper(account, 'AUTO-PAUSED', status='revision'))['id']
        closed_account = self.account('scheduled-skip')
        closed = self.app.manuscript_save(self.paper(closed_account, 'AUTO-CLOSED', status='rejected'))['id']
        moment = datetime.now(BEIJING) + timedelta(seconds=1)
        self.app.SCHEDULE.clock = lambda: moment
        with self.app.connect() as con:
            con.execute('UPDATE refresh_schedule SET next_run_at=? WHERE id=1', (moment.isoformat(),))
        with patch.object(self.app, 'queue_journal_metrics') as metrics, patch.object(
                self.app.portal_sync, 'read_account', return_value=[{
                    'number': 'AUTO-01', 'title_en': 'Scheduled paper', 'raw_status': 'Under Review',
                    'submitted_at': '2026-09-01', 'status_date': ''}]) as reader:
            self.assertTrue(self.app.SCHEDULE.tick())
            metrics.assert_called_once_with()
            reader.assert_called_once()
            self.assertEqual(reader.call_args.args[0]['id'], account)
            self.assertEqual([p['id'] for p in reader.call_args.args[2]], [paper])
        state = self.app.state()
        observed = next(p for p in state['manuscripts'] if p['id'] == paper)
        self.assertEqual(observed['status'], 'review')
        self.assertEqual(observed['system_submitted_at'], '2026-09-01')
        self.assertEqual(observed['source'], 'website')
        self.assertEqual(state['auto_refresh']['last_result']['checked'], 1)
        self.assertFalse(state['sync_in_progress'])
        self.assertTrue(state['last_checked_at'])
        self.assertTrue(all(p['last_success'] is None for p in state['manuscripts'] if p['id'] in (paused, closed)))

    def test_tac_routes_pin_account_to_papercept_with_isolated_session(self):
        from types import SimpleNamespace
        with patch.object(self.app,'queue_journal_metrics'), patch.object(self.app,'save_password',return_value=True):
            identifier=self.app.account_save(dict(username='123456',password='synthetic-secret',
                login_method='password',journal_name='IEEE Transactions on Automatic Control',
                abbreviation='TAC',platform='PaperCept',login_url='https://css.paperplaza.net/journals/tac/scripts/login.pl'))['id']
        state=self.app.state()
        account=next(a for a in state['accounts'] if a['id']==identifier)
        journal=next(j for j in state['journals'] if j['id']==account['journal_id'])
        self.assertTrue(account['auto_read_supported'])
        module=self.app.DATA/'browser-runtime/node_modules/playwright-core/index.mjs'
        module.parent.mkdir(parents=True)
        module.touch()
        outcomes=[SimpleNamespace(stdout='{"ok":true,"rows":[]}',returncode=0)]
        with patch.object(self.app.portal_sync.credential_store,'get',return_value='synthetic-secret') as credential, patch.object(self.app.portal_sync.subprocess,'run',side_effect=outcomes) as run:
            self.app.portal_sync.read_account(account,journal,[],self.app.DATA)
            payload=json.loads(run.call_args.kwargs['input'])
            self.assertEqual(payload['username'],'123456')
            self.assertEqual(payload['browser_engine'],'firefox')
            self.assertTrue(payload['profile_dir'].endswith(identifier+'-firefox'))
            self.assertFalse(payload['interactive'])
            self.assertEqual(Path(run.call_args.args[0][1]).name,'papercept_reader.mjs')
            self.assertNotIn('browser_endpoint',payload)
        self.reader_pool_mock.assert_called_once()
        with patch.object(self.app.portal_sync.credential_store,'get',return_value='synthetic-secret') as credential, patch.object(self.app.portal_sync.subprocess,'run',side_effect=outcomes):
            self.app.portal_sync.read_account(account,journal,[],self.app.DATA,interactive=True)
        self.reader_pool_mock.assert_called_once()
        with patch.object(self.app.portal_sync.credential_store,'get',return_value='synthetic-secret'), \
                patch.object(self.app.portal_sync.subprocess,'run',return_value=SimpleNamespace(
                    stdout='{"ok":false,"code":"site_unavailable"}',returncode=1)):
            with self.assertRaisesRegex(self.app.portal_sync.PortalError,'投稿网站暂时无法连接'):
                self.app.portal_sync.read_account(account,journal,[],self.app.DATA)
        self.assertEqual(self.app.portal_sync.submission_date('August 14, 2026'),'2026-08-14')

    def orcid_account(self):
        with patch.object(self.app,'queue_journal_metrics'):
            return self.app.account_save(dict(username='test-orcid-account',login_method='orcid',
                journal_name='Control Engineering Practice',abbreviation='CEP',platform='Editorial Manager',
                login_url='https://www.editorialmanager.com/conengprac/'))['id']

    def test_platform_routes_are_independent_of_specific_journal_names(self):
        from types import SimpleNamespace
        cases = [
            ('https://www.editorialmanager.com/example/', 'password', 'Editorial Manager', 'editorial_manager_reader.mjs'),
            ('https://www.editorialmanager.com/example/default.aspx', 'orcid', 'Editorial Manager', 'cep_reader.mjs'),
            ('https://www.editorialmanager.com/another', 'elsevier', 'Editorial Manager', 'elsevier_reader.mjs'),
            ('https://ras.papercept.net/journals/example/scripts/login.pl', 'password', 'PaperCept', 'papercept_reader.mjs')
        ]
        for index, (url, method, platform, reader) in enumerate(cases):
            with self.subTest(url=url, method=method), patch.object(self.app, 'save_password', return_value=True):
                identifier = self.app.account_save(dict(username='test-user-'+str(index), password='synthetic-secret',
                    journal_name='User supplied journal '+str(index), abbreviation='EXAMPLE', platform='其他',
                    login_url=url, login_method=method))['id']
                state = self.app.state()
                account = next(a for a in state['accounts'] if a['id'] == identifier)
                journal = next(j for j in state['journals'] if j['id'] == account['journal_id'])
                self.assertEqual(journal['platform'], platform)
                self.assertTrue(account['auto_read_supported'])
                with patch.object(self.app.portal_sync.credential_store, 'get', return_value='synthetic-secret'), \
                        patch.object(self.app.portal_sync.subprocess, 'run', return_value=SimpleNamespace(
                            stdout='{"ok":true,"rows":[]}', returncode=0)) as run:
                    self.app.portal_sync.read_account(account, journal, [], self.app.DATA)
                    self.assertEqual(Path(run.call_args.args[0][1]).name, reader)
                    payload = json.loads(run.call_args.kwargs['input'])
                    self.assertEqual(payload['login_method'], method)
                    self.assertEqual(payload['login_url'], url.rstrip('/'))
        self.assertFalse(self.app.portal_sync.supported('https://example.com/login', 'password'))
        self.assertFalse(self.app.portal_sync.supported('https://css.paperplaza.net/journals/tac/scripts/login.pl', 'orcid'))
        self.assertFalse(self.app.portal_sync.supported('https://mc.manuscriptcentral.com/example', 'elsevier'))

    def test_ojs34_requires_selected_platform_and_routes_to_author_reader(self):
        from types import SimpleNamespace
        url = 'https://ojs.example.test/index.php/journal/login'
        self.assertFalse(self.app.portal_sync.supported(url))
        self.assertFalse(self.app.portal_sync.supported(url, 'orcid', 'Open Journal Systems 3.4'))
        with patch.object(self.app, 'save_password', return_value=True):
            identifier = self.app.account_save(dict(username='ojs-example', password='synthetic-secret',
                journal_name='OJS example journal', abbreviation='EXAMPLE', platform='Open Journal Systems 3.4',
                login_url=url, login_method='password'))['id']
        state = self.app.state()
        account = next(a for a in state['accounts'] if a['id'] == identifier)
        journal = next(j for j in state['journals'] if j['id'] == account['journal_id'])
        self.assertTrue(account['auto_read_supported'])
        with patch.object(self.app.portal_sync.credential_store, 'get', return_value='synthetic-secret'), \
                patch.object(self.app.portal_sync.subprocess, 'run', return_value=SimpleNamespace(
                    stdout='{"ok":true,"rows":[]}', returncode=0)) as run:
            self.app.portal_sync.read_account(account, journal, [], self.app.DATA)
            self.assertEqual(Path(run.call_args.args[0][1]).name, 'ojs_reader.mjs')
        self.assertEqual(self.app.portal_sync.normalize_status('Submission'), 'submitted')
        self.assertEqual(self.app.portal_sync.normalize_status('Review'), 'review')
        self.assertEqual(self.app.portal_sync.normalize_status('Revisions requested'), 'revision')
        self.assertEqual(self.app.portal_sync.normalize_status('Copyediting', 'Open Journal Systems 3.4'), 'accepted')
        self.assertEqual(self.app.portal_sync.normalize_status('Published', 'Open Journal Systems 3.4'), 'accepted')
        self.assertEqual(self.app.portal_sync.normalize_status(
            'The submission must be resubmitted for another review round.', 'Open Journal Systems 3.4'), 'revision')
        self.assertEqual(self.app.portal_sync.normalize_status(
            'Submission has been resubmitted for another review round.', 'Open Journal Systems 3.4'), 'review')
        self.assertEqual(self.app.portal_sync.normalize_status('Scheduled'), 'unknown')

    def test_elsevier_account_uses_credential_store_and_separate_session(self):
        from types import SimpleNamespace
        with patch.object(self.app,'queue_journal_metrics'), patch.object(self.app,'save_password',return_value=True):
            identifier=self.app.account_save(dict(username='elsevier-test@example.test',password='synthetic-secret',
                login_method='elsevier',journal_name='Aerospace Science and Technology',abbreviation='AST',
                platform='Editorial Manager',login_url='https://www.editorialmanager.com/aescte/'))['id']
        state=self.app.state()
        account=next(a for a in state['accounts'] if a['id']==identifier)
        self.assertEqual(account['login_method'],'elsevier')
        self.assertTrue(account['auto_read_supported'])
        self.assertTrue(account['has_password'])
        self.assertNotIn('synthetic-secret',json.dumps(state))
        self.assertNotIn(b'synthetic-secret',self.app.DB.read_bytes())
        module=self.app.DATA/'browser-runtime/node_modules/playwright-core/index.mjs'
        module.parent.mkdir(parents=True)
        module.touch()
        outcomes=[SimpleNamespace(stdout='{"ok":true,"rows":[]}',returncode=0)]
        with patch.object(self.app.portal_sync.credential_store,'get',return_value='synthetic-secret') as credential, patch.object(self.app.portal_sync.subprocess,'run',side_effect=outcomes) as run:
            self.app.connect_account({'account_id':identifier})
            credential.assert_called_once_with(identifier)
            payload=json.loads(run.call_args.kwargs['input'])
            self.assertEqual(payload['login_method'],'elsevier')
            self.assertEqual(payload['password'],'synthetic-secret')
            self.assertTrue(payload['profile_dir'].endswith(identifier+'-elsevier-firefox'))
            self.assertFalse(payload['interactive'])
            self.assertEqual(Path(run.call_args.args[0][1]).name,'elsevier_reader.mjs')
        account=next(a for a in self.app.state()['accounts'] if a['id']==identifier)
        self.assertTrue(account['last_authenticated_at'])
        self.assertIsNone(account['last_checked_at'])
        first_generation=account['session_generation']
        with patch.object(self.app,'queue_journal_metrics'):
            self.app.account_save(dict(username='different-elsevier@example.test'),identifier)
        changed=next(a for a in self.app.state()['accounts'] if a['id']==identifier)
        self.assertNotEqual(changed['session_generation'],first_generation)
        self.assertFalse(changed['has_password'])
        self.assertIsNone(changed['last_authenticated_at'])

    def test_elsevier_requires_editorial_manager_entry_and_preserves_unsynced_paper(self):
        with patch.object(self.app,'queue_journal_metrics'):
            with self.assertRaisesRegex(ValueError,'Editorial Manager'):
                self.app.account_save(dict(journal_id='scis',username='elsevier-test@example.test',login_method='elsevier'))
            account=self.app.account_save(dict(username='elsevier-test@example.test',login_method='elsevier',
                journal_name='Aerospace Science and Technology',abbreviation='AST',platform='Editorial Manager',
                login_url='https://www.editorialmanager.com/aescte'))['id']
        paper=self.app.manuscript_save(self.paper(account,'',title_en='AST Test Paper',status='review'))['id']
        before=self.app.state()['manuscripts']
        with patch.object(self.app.portal_sync,'read_account',side_effect=self.app.portal_sync.PortalError('请先保存 Elsevier 密码')):
            self.assertEqual(self.app.refresh({'manuscript_id':paper})['checked'],0)
        self.assertEqual(self.app.state()['manuscripts'],before)

    def test_new_scholarone_journal_is_recognized_and_uses_its_own_firefox_session(self):
        from types import SimpleNamespace
        with patch.object(self.app,'queue_journal_metrics'), patch.object(self.app,'save_password',return_value=True):
            identifier=self.app.account_save(dict(username='future-journal-account',password='synthetic-secret',
                journal_name='Future Test Journal',abbreviation='FTJ',platform='ScholarOne',
                login_url='https://mc12.manuscriptcentral.com/future-journal'))['id']
        state=self.app.state()
        account=next(a for a in state['accounts'] if a['id']==identifier)
        journal=next(j for j in state['journals'] if j['id']==account['journal_id'])
        self.assertTrue(account['auto_read_supported'])
        module=self.app.DATA/'browser-runtime/node_modules/playwright-core/index.mjs'
        module.parent.mkdir(parents=True)
        module.touch()
        outcomes=[SimpleNamespace(stdout='{"ok":true,"rows":[]}',returncode=0)]
        with patch.object(self.app.portal_sync.credential_store,'get',return_value='synthetic-secret') as credential, patch.object(self.app.portal_sync.subprocess,'run',side_effect=outcomes) as run:
            self.app.portal_sync.read_account(account,journal,[],self.app.DATA)
            credential.assert_called_once_with(identifier)
            payload=json.loads(run.call_args.kwargs['input'])
            self.assertEqual(payload['browser_engine'],'firefox')
            self.assertFalse(payload['interactive'])
            self.assertTrue(payload['profile_dir'].endswith(identifier+'-firefox'))
            self.assertEqual(Path(run.call_args.args[0][1]).name,'scis_reader.mjs')
        for url in ('https://mc.manuscriptcentral.com/taes','https://mc03.manuscriptcentral.com/scis/'):
            self.assertTrue(self.app.portal_sync.is_scholarone(url))
        for url in ('https://example.com/taes','https://mc.manuscriptcentral.com','http://mc.manuscriptcentral.com/taes'):
            self.assertFalse(self.app.portal_sync.is_scholarone(url))

    def test_orcid_account_connects_before_manuscript_without_password(self):
        account=self.orcid_account()
        before=self.app.state()['accounts'][0]
        self.assertEqual(before['login_method'],'orcid')
        self.assertFalse(before['has_password'])
        self.assertIsNone(before['last_authenticated_at'])
        with patch.object(self.app.portal_sync,'read_account',return_value=[]) as reader:
            self.app.connect_account({'account_id':account,'interactive':True})
            self.assertEqual(reader.call_args.args[0]['id'],account)
            self.assertEqual(reader.call_args.args[2],[])
            self.assertEqual(reader.call_args.kwargs,dict(interactive=True,connect_only=True))
        after=self.app.state()
        self.assertTrue(after['accounts'][0]['last_authenticated_at'])
        self.assertIsNone(after['accounts'][0]['last_checked_at'])
        self.assertEqual(after['manuscripts'],[])
        secret='synthetic-orcid-password'
        with patch.object(self.app,'save_password',return_value=True) as password_store, patch.object(self.app,'queue_journal_metrics'):
            self.app.account_save(dict(username='test-orcid-account',password=secret),account)
            self.assertEqual(password_store.call_args.args[:2],(account,secret))
        data=self.app.state()
        self.assertTrue(data['accounts'][0]['has_password'])
        self.assertNotIn(secret,json.dumps(data))
        self.assertNotIn(secret.encode(),self.app.DB.read_bytes())
        with patch.object(self.app.portal_sync,'read_account',return_value=[]) as reader:
            self.app.connect_account({'account_id':account})
            self.assertFalse(reader.call_args.kwargs['interactive'])

    def test_cep_revision_keeps_deadline_and_uses_initial_submission(self):
        account=self.orcid_account()
        body=self.paper(account,'CONENGPRAC-TEST-1',
            title_en='CEP Test Paper',status='revision',raw_status='Revision Requested',
            due_date='2026-10-26',status_date='2026-09-26')
        identifier=self.app.manuscript_save(body)['id']
        # A pending revision is preserved until the user resumes the review workflow.
        before=self.app.state()['manuscripts']
        with patch.object(self.app.portal_sync,'read_account') as reader:
            self.assertEqual(self.app.refresh({'manuscript_id':identifier})['checked'],0)
            reader.assert_not_called()
        self.assertEqual(self.app.state()['manuscripts'],before)
        body.update(status='review',raw_status='Under Review')
        self.app.manuscript_save(body,identifier)
        rows=[dict(number='CONENGPRAC-TEST-1R1',title_en='CEP Test Paper',raw_status='Under Review',
                   submitted_at='Aug 9 2026 3:27AM',status_date='Sep 30 2026 5:08PM')]
        with patch.object(self.app.portal_sync,'read_account',return_value=rows):
            self.assertEqual(self.app.refresh({'manuscript_id':identifier})['checked'],1)
        paper=self.app.state()['manuscripts'][0]
        self.assertEqual(paper['due_date'],'2026-10-26')
        self.assertEqual(paper['system_submitted_at'],'2026-08-09')
        self.assertEqual(paper['status'],'review')
        self.assertEqual(paper['number'],'CONENGPRAC-TEST-1R1')

    def test_orcid_reader_uses_separate_session_and_no_keychain(self):
        from types import SimpleNamespace
        account=self.orcid_account()
        state=self.app.state()
        module=self.app.DATA/'browser-runtime/node_modules/playwright-core/index.mjs'
        module.parent.mkdir(parents=True)
        module.touch()
        with patch.object(self.app.portal_sync.subprocess,'run',return_value=SimpleNamespace(stdout='{"ok":true,"rows":[]}',returncode=0)) as run:
            self.app.portal_sync.read_account(state['accounts'][0],state['journals'][-1],[],self.app.DATA,interactive=True,connect_only=True)
            run.assert_called_once()
            payload=json.loads(run.call_args.kwargs['input'])
            self.assertEqual(payload['password'],'')
            self.assertIn(account+'-orcid-firefox',payload['profile_dir'])
            self.assertEqual(Path(run.call_args.args[0][1]).name,'cep_reader.mjs')
            self.assertTrue(payload['connect_only'])

    def test_orcid_password_is_loaded_by_selected_account_for_background_login(self):
        from types import SimpleNamespace
        account=self.orcid_account()
        with patch.object(self.app,'save_password',return_value=True), patch.object(self.app,'queue_journal_metrics'):
            self.app.account_save(dict(username='test-orcid-account',password='synthetic-secret'),account)
        module=self.app.DATA/'browser-runtime/node_modules/playwright-core/index.mjs'
        module.parent.mkdir(parents=True)
        module.touch()
        outcomes=[SimpleNamespace(stdout='{"ok":true,"rows":[]}',returncode=0)]
        with patch.object(self.app.portal_sync.credential_store,'get',return_value='synthetic-secret') as credential, patch.object(self.app.portal_sync.subprocess,'run',side_effect=outcomes) as run:
            self.app.connect_account({'account_id':account})
            self.assertEqual(run.call_count,1)
            credential.assert_called_once_with(account)
            reader=json.loads(run.call_args.kwargs['input'])
            self.assertEqual(reader['password'],'synthetic-secret')
            self.assertEqual(reader['username'],'test-orcid-account')
            self.assertFalse(reader['interactive'])
            self.assertIn(account+'-orcid-firefox',reader['profile_dir'])
        # Changing the ORCID identity without a replacement password must not reuse the old credential.
        with patch.object(self.app,'queue_journal_metrics'):
            self.app.account_save(dict(username='different-orcid-account'),account)
        updated=next(a for a in self.app.state()['accounts'] if a['id']==account)
        self.assertFalse(updated['has_password'])
        self.assertIsNone(updated['last_authenticated_at'])
        with patch.object(self.app.portal_sync,'read_account',side_effect=self.app.portal_sync.PortalError('ORCID 需要人工验证')):
            with self.assertRaisesRegex(ValueError,'人工验证'):
                self.app.connect_account({'account_id':account})
        self.assertIn('人工验证',self.app.state()['accounts'][0]['sync_error'])

    def test_multiple_orcid_accounts_and_changed_identity_keep_sessions_separate(self):
        from types import SimpleNamespace
        first=self.orcid_account()
        first_account=next(a for a in self.app.state()['accounts'] if a['id']==first)
        with patch.object(self.app,'queue_journal_metrics'):
            second=self.app.account_save(dict(journal_id=first_account['journal_id'],
                username='second-test-orcid',login_method='orcid'))['id']
        module=self.app.DATA/'browser-runtime/node_modules/playwright-core/index.mjs'
        module.parent.mkdir(parents=True)
        module.touch()
        paths=[]
        with patch.object(self.app.portal_sync.subprocess,'run',return_value=SimpleNamespace(stdout='{"ok":true,"rows":[]}',returncode=0)) as run:
            self.app.connect_account({'account_id':first})
            paths.append(json.loads(run.call_args.kwargs['input'])['profile_dir'])
            self.app.connect_account({'account_id':second})
            paths.append(json.loads(run.call_args.kwargs['input'])['profile_dir'])
            self.assertNotEqual(paths[0],paths[1])
            with patch.object(self.app,'queue_journal_metrics'):
                self.app.account_save(dict(username='replacement-test-orcid'),first)
            accounts={a['id']:a for a in self.app.state()['accounts']}
            self.assertIsNone(accounts[first]['last_authenticated_at'])
            self.assertTrue(accounts[second]['last_authenticated_at'])
            self.app.connect_account({'account_id':first})
            new_path=json.loads(run.call_args.kwargs['input'])['profile_dir']
            self.assertNotIn(new_path,paths)

    def account(self, username):
        return self.app.account_save({'journal_id':'scis','username':username,'label':username})['id']

    def paper(self, account, number, **changes):
        body = dict(account_id=account, number=number,title='测试稿件',status='submitted',round='初投')
        body.update(changes)
        return body

    def test_multiple_accounts_and_papers_do_not_collide(self):
        a,b=self.account('test-author-a'),self.account('test-author-b')
        self.app.manuscript_save(self.paper(a,'TEST-01'))
        self.app.manuscript_save(self.paper(a,'TEST-02'))
        self.app.manuscript_save(self.paper(b,'TEST-01'))
        data=self.app.state()
        self.assertEqual(len(data['journals']),1)
        self.assertEqual(len(data['accounts']),2)
        self.assertEqual(len(data['manuscripts']),3)
        self.assertEqual(sum(p['account_id']==a for p in data['manuscripts']),2)
        self.assertEqual(sum(p['account_id']==b for p in data['manuscripts']),1)
        with self.assertRaises(ValueError):
            self.app.manuscript_save(self.paper(a,'TEST-01'))

    def test_duplicate_account_cannot_replace_credentials(self):
        self.account('test-author-a')
        with patch.object(self.app, 'save_password') as store:
            with self.assertRaises(ValueError):
                self.account('test-author-a')
            store.assert_not_called()

    def test_history_changes_only_with_status(self):
        account=self.account('test-author-a')
        body=self.paper(account,'TEST-01')
        identifier=self.app.manuscript_save(body)['id']
        self.app.manuscript_save(dict(body,notes='新增备注'),identifier)
        self.assertEqual(len(self.app.state()['events']),1)
        self.app.manuscript_save(dict(body,status='review',raw_status='Under Review'),identifier)
        data=self.app.state()
        self.assertEqual(len(data['events']),2)
        self.assertEqual(data['events'][-1]['old_status'],'submitted')
        self.assertIsNone(data['manuscripts'][0]['last_success'])

    def test_password_is_not_in_records_or_state(self):
        password='synthetic-credential-for-unit-test'
        with patch.object(self.app,'save_password',return_value=True) as store:
            self.app.account_save({'journal_id':'scis','username':'test-author-a','label':'测试账号','password':password})
            self.assertEqual(store.call_count,1)
        data=self.app.state()
        self.assertTrue(data['accounts'][0]['has_password'])
        self.assertNotIn(password,json.dumps(data))
        self.assertNotIn(password.encode(),self.app.DB.read_bytes())

    def test_invalid_date_leaves_record_unchanged(self):
        account=self.account('test-author-a')
        with self.assertRaises(ValueError):
            self.app.manuscript_save(self.paper(account,'TEST-01',due_date='2026-02-30'))
        self.assertEqual(self.app.state()['manuscripts'],[])

    def test_bilingual_titles_and_authors_are_per_manuscript(self):
        account=self.app.account_save({'journal_id':'scis','username':'shared-account'})['id']
        first=self.app.manuscript_save(self.paper(account,'',title_en='Cooperative Control',title_zh='协同控制',first_author='李佳航',corresponding_author='王卓'))['id']
        second=self.app.manuscript_save(self.paper(account,'',title_en='State Estimation',title_zh='状态估计',first_author='示例作者甲',corresponding_author='李佳航'))['id']
        papers={p['id']:p for p in self.app.state()['manuscripts']}
        self.assertIsNone(papers[first]['number'])
        self.assertIsNone(papers[second]['number'])
        self.assertEqual(papers[first]['title_en'],'Cooperative Control')
        self.assertEqual(papers[first]['title_zh'],'协同控制')
        self.assertEqual(papers[first]['corresponding_author'],'王卓')
        self.assertEqual(papers[second]['corresponding_author'],'李佳航')
        self.assertEqual(papers[first]['first_author'],'李佳航')
        self.assertEqual(papers[second]['first_author'],'示例作者甲')
        self.app.manuscript_save(self.paper(account,'SCIS-001',title_en='Cooperative Control',title_zh='协同控制',corresponding_author='王卓'),first)
        self.assertEqual(len(self.app.state()['manuscripts']),2)
        self.assertEqual(self.app.state()['manuscripts'][0]['first_author'],'李佳航')
        self.app.manuscript_save(self.paper(account,'SCIS-001',first_author='Jiahang Li'),first)
        self.assertEqual(self.app.state()['manuscripts'][0]['first_author'],'Jiahang Li')
        self.assertIsNone(self.app.state()['last_checked_at'])

    def test_system_submission_date_is_separate_from_manual_dates(self):
        account=self.account('date-test-account')
        body=self.paper(account,'DATE-01',submitted_at='2026-08-01')
        identifier=self.app.manuscript_save(body)['id']
        self.assertEqual(self.app.state()['manuscripts'][0]['system_submitted_at'],'')
        with self.app.connect() as con:
            con.execute('UPDATE manuscripts SET system_submitted_at=? WHERE id=?',('2026-08-03',identifier))
        self.app.manuscript_save(self.paper(account,'DATE-01',notes='更新备注'),identifier)
        paper=self.app.state()['manuscripts'][0]
        self.assertEqual(paper['system_submitted_at'],'2026-08-03')
        self.assertEqual(paper['submitted_at'],'2026-08-01')

    def test_shared_account_only_matches_explicitly_added_titles(self):
        account=self.account('shared-account')
        identifier=self.app.manuscript_save(self.paper(account,'',title_en='Cooperative Control',title_zh='协同控制'))['id']
        portal=[{'number':'OTHER-1','title':'A Different Control Paper'},
                {'number':'MINE-1','title':'  COOPERATIVE   CONTROL  '},
                {'number':'OTHER-2','title':'Cooperative Control for Other Systems'}]
        result=self.app.tracked_matches(account,portal)
        self.assertEqual(len(result),1)
        self.assertEqual(result[0]['manuscript_id'],identifier)
        self.assertEqual(result[0]['match']['number'],'MINE-1')
        self.assertEqual(len(self.app.state()['manuscripts']),1)
        ambiguous=self.app.tracked_matches(account,portal+[{'number':'OTHER-3','title':'Cooperative Control'}])
        self.assertEqual(ambiguous[0]['status'],'ambiguous')
        self.assertIsNone(ambiguous[0]['match'])

    def test_legacy_records_migrate_with_history(self):
        account=self.account('legacy-account')
        identifier=self.app.manuscript_save(self.paper(account,'LEGACY-01'))['id']
        with self.app.connect() as con:
            con.execute('PRAGMA foreign_keys=OFF')
            con.execute('''CREATE TABLE manuscripts_old (
                id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),
                title TEXT NOT NULL,number TEXT NOT NULL,status TEXT NOT NULL,
                raw_status TEXT NOT NULL,submitted_at TEXT NOT NULL,status_date TEXT NOT NULL,
                due_date TEXT NOT NULL,round TEXT NOT NULL,notes TEXT NOT NULL,
                recorded_at TEXT NOT NULL,last_success TEXT,source TEXT NOT NULL DEFAULT 'manual',
                UNIQUE(account_id,number))''')
            con.execute('''INSERT INTO manuscripts_old SELECT id,account_id,title,number,status,
                raw_status,submitted_at,status_date,due_date,round,notes,recorded_at,last_success,source
                FROM manuscripts''')
            con.execute('DROP TABLE manuscripts')
            con.execute('ALTER TABLE manuscripts_old RENAME TO manuscripts')
        self.app.initialize()
        with self.app.connect() as con:
            con.execute('INSERT OR IGNORE INTO journals VALUES(?,?,?,?,?)', ('scis','SCIENCE CHINA Information Sciences','SCIS','ScholarOne','https://mc03.manuscriptcentral.com/scis'))
        data=self.app.state()
        self.assertEqual(data['manuscripts'][0]['id'],identifier)
        self.assertEqual(data['manuscripts'][0]['title_zh'],'测试稿件')
        self.assertEqual(data['manuscripts'][0]['title_en'],'')
        self.assertEqual(data['manuscripts'][0]['corresponding_author'],'')
        self.assertEqual(data['manuscripts'][0]['first_author'],'')
        self.assertEqual(data['events'][0]['manuscript_id'],identifier)
        with self.app.connect() as con:
            self.assertEqual(con.execute('PRAGMA foreign_key_check').fetchall(),[])

    def test_refresh_binds_only_tracked_paper_and_keeps_personal_fields(self):
        account=self.account('sync-test')
        identifier=self.app.manuscript_save(self.paper(account,'',title_en='Cooperative Control',
            title_zh='协同控制',first_author='李佳航',corresponding_author='王卓',notes='保留备注'))['id']
        portal=[dict(number='TEST-SYNC-1',title_en='Cooperative Control',raw_status='Under Review',submitted_at='09-Sep-2026'),
                dict(number='TEST-OTHER-2',title_en='Another Paper',raw_status='Accepted',submitted_at='01-Sep-2026')]
        with patch.object(self.app.portal_sync,'read_account',return_value=portal):
            result=self.app.refresh({'manuscript_id':identifier})
            self.assertEqual(result['checked'],1)
            data=self.app.state()
            self.assertEqual(len(data['manuscripts']),1)
            paper=data['manuscripts'][0]
            for key,value in dict(number='TEST-SYNC-1',status='review',raw_status='Under Review',
                system_submitted_at='2026-09-09',first_author='李佳航',corresponding_author='王卓',
                title_zh='协同控制',notes='保留备注',source='website').items():
                self.assertEqual(paper[key],value)
            self.assertTrue(data['last_checked_at'])
            self.assertEqual(data['events'][-1]['source'],'website')
            self.assertEqual(self.app.refresh({})['updated'],0)
            self.assertEqual(len(self.app.state()['events']),2)
        previous=self.app.state()
        with patch.object(self.app.portal_sync,'read_account',side_effect=self.app.portal_sync.PortalError('测试读取失败')):
            result=self.app.refresh({})
        after=self.app.state()
        self.assertEqual(result['checked'],0)
        self.assertEqual(after['manuscripts'],previous['manuscripts'])
        self.assertEqual(after['last_checked_at'],previous['last_checked_at'])
        self.assertEqual(after['accounts'][0]['sync_error'],'测试读取失败')

    def test_partial_refresh_does_not_claim_all_papers_checked(self):
        a,b=self.account('sync-a'),self.account('sync-b')
        self.app.manuscript_save(self.paper(a,'',title_en='Paper A'))
        self.app.manuscript_save(self.paper(b,'',title_en='Paper B'))
        def read(account,*args):
            if account['id']==a: raise self.app.portal_sync.PortalError('测试账号不可用')
            return [dict(number='TEST-B',title_en='Paper B',raw_status='Under Review',submitted_at='09-Sep-2026')]
        with patch.object(self.app.portal_sync,'read_account',side_effect=read):
            result=self.app.refresh({})
        self.assertEqual(result['checked'],1)
        self.assertIsNone(self.app.state()['last_checked_at'])
        self.assertTrue(next(a for a in self.app.state()['accounts'] if a['id']==b)['last_checked_at'])

    def test_all_journals_refresh_together_and_keep_account_results_separate(self):
        import threading
        accounts = [self.app.account_save(dict(username='parallel-' + str(i),
            journal_name='Parallel test journal ' + str(i), abbreviation='PAR-' + str(i),
            platform='ScholarOne', login_url='https://mc.manuscriptcentral.com/parallel-' + str(i)))['id']
            for i in range(5)]
        with self.app.connect() as con:
            shared_journal = con.execute('SELECT journal_id FROM accounts WHERE id=?', (accounts[1],)).fetchone()[0]
        accounts.append(self.app.account_save(dict(journal_id=shared_journal, username='parallel-shared'))['id'])
        expected = {}
        for i, account in enumerate(accounts):
            expected[account] = [self.app.manuscript_save(self.paper(account, f'PAR-{i}-{j}',
                title_en=f'Parallel {i} {j}', status='review'))['id'] for j in range(2 if i == 2 else 1)]
        barrier = threading.Barrier(5, timeout=3)
        guard = threading.Lock()
        active, peak, seen, journal_active = 0, 0, [], {}
        def read(account, journal, tracked, data):
            nonlocal active, peak
            with guard:
                active += 1
                peak = max(peak, active)
                seen.append(account['id'])
                journal_active[journal['id']] = journal_active.get(journal['id'], 0) + 1
                self.assertEqual(journal_active[journal['id']], 1, 'Same journal accounts log in sequentially')
            try:
                self.assertEqual([p['id'] for p in tracked], expected[account['id']])
                if account['id'] in accounts[:5]:
                    barrier.wait()
                if account['id'] == accounts[0]:
                    raise self.app.portal_sync.PortalError('单个账号读取失败')
                return [dict(number=p['number'], title_en=p['title_en'], raw_status='Under Review',
                             submitted_at='2026-09-01') for p in tracked]
            finally:
                with guard:
                    active -= 1
                    journal_active[journal['id']] -= 1
        with patch.object(self.app.portal_sync, 'read_account', side_effect=read):
            result = self.app.refresh({})
        self.assertEqual(peak, 5)
        self.assertCountEqual(seen, accounts)
        self.assertEqual(result['checked'], 6)
        self.assertEqual(result['issues'], [{'account_id': accounts[0], 'message': '单个账号读取失败'}])
        self.assertGreaterEqual(result['duration_seconds'], 0)
        state = self.app.state()
        self.assertIsNone(state['last_checked_at'])
        for paper in state['manuscripts']:
            self.assertEqual(paper['source'], 'manual' if paper['account_id'] == accounts[0] else 'website')
            self.assertEqual(paper['title_en'], f"Parallel {accounts.index(paper['account_id'])} {paper['number'].split('-')[-1]}")

    def test_refresh_only_overview_review_group_and_preserves_other_records(self):
        mixed = self.account('mixed-refresh-account')
        skipped_account = self.account('no-review-account')
        expected = []
        skipped = []
        for status in ('submitted', 'editor', 'review', 'decision', 'unknown'):
            expected.append(self.app.manuscript_save(self.paper(mixed, 'READ-' + status,
                title_en='Read ' + status, status=status))['id'])
        for status in ('revision', 'accepted', 'rejected', 'withdrawn'):
            skipped.append(self.app.manuscript_save(self.paper(mixed, 'KEEP-' + status,
                title_en='Keep ' + status, status=status))['id'])
        skipped.append(self.app.manuscript_save(self.paper(skipped_account, 'KEEP-RESUBMIT',
            title_en='Keep resubmission', status='revision', raw_status='Reject and Resubmit'))['id'])
        with self.app.connect() as con:
            before = {r['id']: dict(r) for r in con.execute('SELECT * FROM manuscripts') if r['id'] in skipped}
            events_before = [dict(r) for r in con.execute('SELECT * FROM events') if r['manuscript_id'] in skipped]
        def read(account, journal, tracked, data):
            self.assertEqual(account['id'], mixed)
            self.assertEqual({p['id'] for p in tracked}, set(expected))
            return [dict(number=p['number'], title_en=p['title_en'], raw_status='Under Review',
                         submitted_at='2026-09-01') for p in tracked]
        stamp = '2026-10-01T22:00:00+08:00'
        with patch.object(self.app.portal_sync, 'read_account', side_effect=read) as reader, \
                patch.object(self.app, 'now', return_value=stamp):
            result = self.app.refresh({})
        reader.assert_called_once()
        self.assertEqual(result['checked'], len(expected))
        self.assertEqual(result['issues'], [])
        self.assertEqual(self.app.state()['last_checked_at'], stamp)
        with self.app.connect() as con:
            after = {r['id']: dict(r) for r in con.execute('SELECT * FROM manuscripts') if r['id'] in skipped}
            events_after = [dict(r) for r in con.execute('SELECT * FROM events') if r['manuscript_id'] in skipped]
            self.assertIsNone(con.execute('SELECT * FROM account_sync WHERE account_id=?', (skipped_account,)).fetchone())
        self.assertEqual(after, before)
        self.assertEqual(events_after, events_before)

    def test_non_review_refresh_requests_do_not_log_into_portals(self):
        account = self.account('skip-refresh-account')
        identifier = self.app.manuscript_save(self.paper(account, 'KEEP-REJECT', status='rejected'))['id']
        with patch.object(self.app.portal_sync, 'read_account') as reader:
            for body in ({}, {'account_id': account}, {'manuscript_id': identifier}):
                with self.subTest(body=body):
                    result = self.app.refresh(body)
                    self.assertEqual(result['checked'], 0)
                    self.assertEqual(result['issues'], [])
                    self.assertIn('没有需要刷新', result['message'])
        reader.assert_not_called()
        self.assertIsNone(self.app.state()['last_checked_at'])

    def test_final_decision_completes_refresh_and_stops_future_reads(self):
        account = self.account('final-decision-account')
        identifier = self.app.manuscript_save(self.paper(account, 'FINAL-01',
            title_en='Final decision', status='review'))['id']
        row = dict(number='FINAL-01', title_en='Final decision', raw_status='Reject', submitted_at='2026-09-01')
        stamp = '2026-10-01T22:01:00+08:00'
        with patch.object(self.app.portal_sync, 'read_account', return_value=[row]), \
                patch.object(self.app, 'now', return_value=stamp):
            self.assertEqual(self.app.refresh({})['checked'], 1)
        state = self.app.state()
        self.assertEqual(state['manuscripts'][0]['status'], 'rejected')
        self.assertEqual(state['last_checked_at'], stamp)
        with patch.object(self.app.portal_sync, 'read_account') as reader:
            self.assertEqual(self.app.refresh({'manuscript_id': identifier})['checked'], 0)
            reader.assert_not_called()
        self.assertEqual(self.app.state()['manuscripts'], state['manuscripts'])
        self.assertEqual(self.app.state()['events'], state['events'])

    def test_refresh_ambiguous_title_is_not_bound(self):
        account=self.account('sync-ambiguous')
        self.app.manuscript_save(self.paper(account,'',title_en='Same Title'))
        portal=[dict(number=n,title_en='Same Title',raw_status='Under Review',submitted_at='09-Sep-2026') for n in ('TEST-1','TEST-2')]
        with patch.object(self.app.portal_sync,'read_account',return_value=portal):
            result=self.app.refresh({})
        self.assertEqual(result['checked'],0)
        self.assertIsNone(self.app.state()['manuscripts'][0]['number'])
        self.assertIn('同名',result['message'])

    def test_revision_series_uses_latest_decision_and_initial_submission(self):
        account=self.account('revision-account')
        self.app.manuscript_save(self.paper(account,'',title_en='Same Research Title'))
        rows=[dict(number='TEST-2026-1',title_en='SAME Research Title',raw_status='Major Revision',submitted_at='23-Jan-2026'),
              dict(number='TEST-2026-1.R1',title_en='Same Research Title',raw_status='Minor Revision',submitted_at='23-Mar-2026'),
              dict(number='TEST-2026-1.R2',title_en='Same Research Title',raw_status='Accept (30-Apr-2026)',submitted_at='21-Apr-2026')]
        with patch.object(self.app.portal_sync,'read_account',return_value=rows):
            self.assertEqual(self.app.refresh({})['checked'],1)
        paper=self.app.state()['manuscripts'][0]
        self.assertEqual(paper['number'],'TEST-2026-1.R2')
        self.assertEqual(paper['status'],'accepted')
        self.assertEqual(paper['system_submitted_at'],'2026-01-23')
        self.assertEqual(self.app.tracked_matches(account,rows)[0]['status'],'matched')

    def test_reject_resubmit_is_pending_revision_after_migration_and_skips_refresh(self):
        raw='Reject with Possibility for Resubmission (09-Sep-2026)'
        account=self.account('resubmission-account')
        identifier=self.app.manuscript_save(self.paper(account,'TEST-RESUBMIT',
            title_en='Resubmission Test',status='rejected',raw_status=raw))['id']
        before=self.app.state()['manuscripts'][0]
        self.app.initialize()
        with self.app.connect() as con:
            con.execute('INSERT OR IGNORE INTO journals VALUES(?,?,?,?,?)', ('scis','SCIENCE CHINA Information Sciences','SCIS','ScholarOne','https://mc03.manuscriptcentral.com/scis'))
        migrated=self.app.state()
        paper=migrated['manuscripts'][0]
        self.assertEqual(paper['status'],'revision')
        self.assertEqual(paper['status_label'],'拒稿重投')
        for key in ('raw_status','last_success','recorded_at','source'):
            self.assertEqual(paper[key],before[key])
        self.assertEqual(migrated['events'][0]['new_status'],'revision')
        self.assertEqual(migrated['events'][0]['new_status_label'],'拒稿重投')
        rows=[dict(number='TEST-RESUBMIT',title_en='Resubmission Test',raw_status=raw,
                   submitted_at='05-Aug-2026')]
        with patch.object(self.app.portal_sync,'read_account',return_value=rows) as reader:
            self.assertEqual(self.app.refresh({'manuscript_id':identifier})['updated'],0)
            reader.assert_not_called()
        synced=self.app.state()['manuscripts'][0]
        self.assertEqual(synced['status'],'revision')
        self.assertEqual(synced['status_label'],'拒稿重投')
        self.assertEqual(synced['source'],before['source'])
        self.assertEqual(synced['last_success'],before['last_success'])
        for raw_value in ('Reject and Resubmit','Reject & Resubmit','拒稿重投'):
            self.assertEqual(self.app.portal_sync.normalize_status(raw_value),'revision')
        self.assertEqual(self.app.portal_sync.normalize_status('Reject'),'rejected')
        self.assertEqual(self.app.portal_sync.normalize_status('Major Revision'),'revision')

    def test_new_journal_status_and_date_formats(self):
        self.assertEqual(self.app.portal_sync.normalize_status('Awaiting Referee Reports'),'review')
        self.assertEqual(self.app.portal_sync.submission_date('Aug  9 2026  3:27AM'),'2026-08-09')
        account=self.account('tim-format-account')
        self.app.manuscript_save(self.paper(account,'',title_en='TIM Test Paper'))
        rows=[dict(number='TIM-TEST-1',title_en='TIM Test Paper',raw_status='Under Review',
                   submitted_at='Aug 9 2026 3:27AM',status_date='Sep 27 2026 5:08PM')]
        with patch.object(self.app.portal_sync,'read_account',return_value=rows):
            self.assertEqual(self.app.refresh({})['checked'],1)
        paper=self.app.state()['manuscripts'][0]
        self.assertEqual(paper['system_submitted_at'],'2026-08-09')
        self.assertEqual(paper['status_date'],'2026-09-27')

    def test_cep_comma_dates_sync_revision(self):
        account=self.orcid_account()
        identifier=self.app.manuscript_save(self.paper(account,'',title_en='CEP Revision Test',status='review'))['id']
        rows=[dict(number='CONENGPRAC-TEST-1',title_en='CEP Revision Test',raw_status='Revise',
                   submitted_at='Jun 29, 2026',status_date='Sep 28, 2026')]
        with patch.object(self.app.portal_sync,'read_account',return_value=rows):
            self.assertEqual(self.app.refresh({'manuscript_id':identifier})['checked'],1)
        paper=self.app.state()['manuscripts'][0]
        self.assertEqual(paper['status'],'revision')
        self.assertEqual(paper['raw_status'],'Revise')
        self.assertEqual(paper['system_submitted_at'],'2026-06-29')
        self.assertEqual(paper['status_date'],'2026-09-28')
        self.assertEqual(paper['source'],'website')
        self.assertTrue(paper['last_success'])

    def test_visible_verification_reads_only_requested_account(self):
        a,b=self.account('verify-a'),self.account('verify-b')
        self.app.manuscript_save(self.paper(a,'TEST-A',title_en='Paper A'))
        self.app.manuscript_save(self.paper(b,'TEST-B',title_en='Paper B'))
        row=dict(number='TEST-A',title_en='Paper A',raw_status='Under Review',submitted_at='09-Sep-2026')
        with patch.object(self.app.portal_sync,'read_account',return_value=[row]) as reader:
            result=self.app.refresh({'account_id':a,'interactive':True})
            self.assertEqual(result['checked'],1)
            reader.assert_called_once()
            self.assertEqual(reader.call_args.args[0]['id'],a)
            self.assertTrue(reader.call_args.kwargs['interactive'])
        self.assertIsNone(next(p for p in self.app.state()['manuscripts'] if p['account_id']==b)['last_success'])
        with self.assertRaisesRegex(ValueError,'请选择需要验证的账号'):
            self.app.refresh({'interactive':True})

    def test_retry_finishes_partial_check_without_rereading_successful_accounts(self):
        a,b=self.account('retry-a'),self.account('retry-b')
        skipped = self.account('retry-skip')
        self.app.manuscript_save(self.paper(skipped, 'OLD-REJECT', status='rejected'))
        with self.app.connect() as con:
            con.execute('INSERT INTO account_sync(account_id,error) VALUES(?,?)', (skipped, '历史超时'))
        self.app.manuscript_save(self.paper(a,'',title_en='Paper A'))
        second=self.app.manuscript_save(self.paper(b,'',title_en='Paper B'))['id']
        row=lambda letter:dict(number='TEST-'+letter,title_en='Paper '+letter,raw_status='Under Review',submitted_at='09-Sep-2026')
        def read(account,*args):
            if account['id']==b: raise self.app.portal_sync.PortalError('测试读取失败')
            return [row('A')]
        with patch.object(self.app.portal_sync,'read_account',side_effect=read):
            self.app.refresh({})
        self.assertIsNone(self.app.state()['last_checked_at'])
        with patch.object(self.app.portal_sync,'read_account',return_value=[row('B')]) as reader:
            self.app.refresh({'manuscript_id':second})
            self.assertEqual(reader.call_count,1)
        self.assertTrue(self.app.state()['last_checked_at'])


if __name__=='__main__':
    unittest.main()
