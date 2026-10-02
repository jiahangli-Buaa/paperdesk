import base64
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
import urllib.request
import zipfile
from datetime import datetime
from unittest.mock import patch
from zoneinfo import ZoneInfo
import backup
from refresh_schedule import next_run_after
import test_records


class DesktopTest(test_records.RecordsTest):
    # Keep this class independent from inherited record tests during discovery.
    def test_new_profile_names_and_timezone(self):
        self.assertFalse(self.app.PROFILE.state()['onboarding_complete'])
        saved = self.app.PROFILE.save({'name': '示例作者', 'aliases': ['Example Author'], 'timezone': 'America/New_York'})
        self.assertTrue(saved['profile']['onboarding_complete'])
        self.assertEqual(self.app.PROFILE.state()['name'], '示例作者')
        moment = datetime(2026, 10, 2, 12, tzinfo=ZoneInfo('UTC'))
        upcoming = next_run_after(moment, ['10:00'], self.app.PROFILE.zone())
        self.assertEqual(upcoming, '2026-10-02T10:00:00-04:00')
        with self.assertRaises(ValueError):
            self.app.PROFILE.save({'name': '作者', 'aliases': [], 'timezone': 'invalid'})

    def test_backup_restore_preserves_history_without_credentials(self):
        account = self.account('backup-example')
        paper = self.app.manuscript_save(self.paper(account, 'EXAMPLE-1'))['id']
        with self.app.connect() as con:
            con.execute('UPDATE accounts SET has_password=1 WHERE id=?', (account,))
        exported = backup.export_backup(self.app.connect)
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(exported['data']))) as bundle:
            self.assertEqual(set(bundle.namelist()), {'manifest.json', 'records.sqlite3'})
            self.assertFalse(json.loads(bundle.read('manifest.json'))['credentials_included'])
        self.app.manuscript_save(self.paper(account, 'EXAMPLE-2'))
        result = backup.restore_backup(exported, self.app.connect, self.app.DATA)
        self.assertTrue(Path(result['backup_path']).is_file())
        self.app.initialize()
        state = self.app.state()
        self.assertEqual([p['id'] for p in state['manuscripts']], [paper])
        self.assertEqual(len(state['events']), 1)
        self.assertEqual(state['accounts'][0]['has_password'], 0)

    def test_invalid_backup_does_not_change_records(self):
        before = self.app.state()['manuscripts']
        with self.assertRaises(ValueError):
            backup.restore_backup({'data': base64.b64encode(b'invalid archive').decode()}, self.app.connect, self.app.DATA)
        self.assertEqual(self.app.state()['manuscripts'], before)

    def test_api_requires_desktop_session_for_reads(self):
        http = self.app.ThreadingHTTPServer(('127.0.0.1', 0), self.app.Handler)
        thread = threading.Thread(target=http.serve_forever, daemon=True); thread.start()
        try:
            url = f'http://127.0.0.1:{http.server_port}/api/state'
            with self.assertRaises(urllib.error.HTTPError) as failure:
                urllib.request.urlopen(url)
            self.assertEqual(failure.exception.code, 403)
            request = urllib.request.Request(url, headers={'X-Paperdesk-Token': self.app.TOKEN})
            with urllib.request.urlopen(request) as response:
                self.assertEqual(json.load(response)['profile']['name'], '')
        finally:
            http.shutdown(); http.server_close(); thread.join()

# Reuse setup helpers without registering inherited tests twice.
for name in dir(test_records.RecordsTest):
    if name.startswith('test_') and name not in DesktopTest.__dict__:
        setattr(DesktopTest, name, None)
