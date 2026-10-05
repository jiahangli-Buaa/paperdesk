#!/usr/bin/env python3
"""Local Paperdesk server. Runtime records are stored outside the project."""
import argparse
import json
import os
import re
from pathlib import Path
import secrets
import shutil
import sqlite3
from database import connect as open_database
import subprocess
import sys
import threading
import unicodedata
import portal_sync
import credential_store
from platform_runtime import user_data_dir, private_mode, ui_dir
from profile import Profile
import backup
from browser_runtime import close_browsers, close_profile
import journal_lookup
from refresh_schedule import RefreshSchedule
from attention import Attention
from appearance import Appearance
from concurrent.futures import ThreadPoolExecutor, as_completed
from time import monotonic
from datetime import date, datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, unquote
from uuid import uuid4

ROOT = Path(__file__).resolve().parent
DATA = user_data_dir()
DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
private_mode(DATA, 0o700)
DB = DATA / 'paperdesk.sqlite3'
HELPER = credential_store.helper_path()
TOKEN = os.environ.get('PAPERDESK_SESSION_TOKEN') or secrets.token_urlsafe(32)
SYNC_LOCK = threading.Lock()
METRICS_QUEUE_LOCK = threading.Lock()
METRICS_PENDING = set()
METRICS_ACTIVE = set()
METRICS_RUNNING = False
STATUSES = {'submitted': '已投稿', 'editor': '编辑处理中', 'review': '审稿中',
            'decision': '等待决定', 'revision': '待返修', 'accepted': '已录用',
            'rejected': '已拒稿', 'withdrawn': '已撤稿', 'unknown': '待确认'}
# Match the overview's 审稿中 group; revision and completed records retain their history.
REFRESH_STATUSES = frozenset(('submitted', 'editor', 'review', 'decision', 'unknown'))


def connect():
    con = open_database(DB)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA foreign_keys=ON')
    return con


PROFILE = Profile(connect)
SCHEDULE = RefreshSchedule(connect, lambda: refresh({}, lock_held=True), SYNC_LOCK, zone=PROFILE.zone)
ATTENTION = Attention(connect, clock=lambda: datetime.now(PROFILE.zone()))
APPEARANCE = Appearance(connect)


def initialize():
    with connect() as con:
        con.execute('PRAGMA foreign_keys=OFF')
        con.executescript('''
        CREATE TABLE IF NOT EXISTS journals (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, abbreviation TEXT NOT NULL,
          platform TEXT NOT NULL, login_url TEXT UNIQUE NOT NULL);
        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY, journal_id TEXT NOT NULL REFERENCES journals(id),
          username TEXT NOT NULL, label TEXT NOT NULL, has_password INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, UNIQUE(journal_id, username));
        CREATE TABLE IF NOT EXISTS manuscripts (
          id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
          title TEXT NOT NULL, number TEXT, status TEXT NOT NULL,
          raw_status TEXT NOT NULL, submitted_at TEXT NOT NULL, status_date TEXT NOT NULL,
          due_date TEXT NOT NULL, round TEXT NOT NULL, notes TEXT NOT NULL,
          recorded_at TEXT NOT NULL, last_success TEXT, source TEXT NOT NULL DEFAULT 'manual',
          UNIQUE(account_id, number));
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY, manuscript_id TEXT NOT NULL REFERENCES manuscripts(id),
          happened_at TEXT NOT NULL, old_status TEXT, new_status TEXT NOT NULL,
          raw_status TEXT NOT NULL, source TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sync_state (
          id INTEGER PRIMARY KEY CHECK (id=1), last_checked_at TEXT);
        CREATE TABLE IF NOT EXISTS account_sync (
          account_id TEXT PRIMARY KEY REFERENCES accounts(id),
          last_attempt_at TEXT, last_success_at TEXT, error TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS journal_metric_sync (
          journal_id TEXT PRIMARY KEY REFERENCES journals(id), payload TEXT NOT NULL DEFAULT '{}',
          last_attempt_at TEXT, last_success_at TEXT, error TEXT NOT NULL DEFAULT '');
        INSERT OR IGNORE INTO sync_state (id,last_checked_at) VALUES (1,NULL);
        ''')
        account_columns = {row['name'] for row in con.execute('PRAGMA table_info(accounts)')}
        for column, definition in (('login_method', "TEXT NOT NULL DEFAULT 'password'"),
                                   ('last_authenticated_at', 'TEXT'),
                                   ('session_generation', "TEXT NOT NULL DEFAULT ''")):
            if column not in account_columns:
                con.execute(f'ALTER TABLE accounts ADD COLUMN {column} {definition}')
        columns = {row['name'] for row in con.execute('PRAGMA table_info(manuscripts)')}
        for column in ('title_en', 'title_zh', 'corresponding_author'):
            if column not in columns:
                con.execute(f"ALTER TABLE manuscripts ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")
        for row in con.execute("SELECT id,title FROM manuscripts WHERE title_en='' AND title_zh=''").fetchall():
            column = 'title_zh' if re.search(r'[\u3400-\u9fff]', row['title']) else 'title_en'
            con.execute(f'UPDATE manuscripts SET {column}=? WHERE id=?', (row['title'], row['id']))
        number_column = next(row for row in con.execute('PRAGMA table_info(manuscripts)') if row['name']=='number')
        if number_column['notnull']:
            con.execute('''CREATE TABLE manuscripts_updated (
                id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
                title TEXT NOT NULL, number TEXT, status TEXT NOT NULL,
                raw_status TEXT NOT NULL, submitted_at TEXT NOT NULL, status_date TEXT NOT NULL,
                due_date TEXT NOT NULL, round TEXT NOT NULL, notes TEXT NOT NULL,
                recorded_at TEXT NOT NULL, last_success TEXT, source TEXT NOT NULL DEFAULT 'manual',
                title_en TEXT NOT NULL DEFAULT '', title_zh TEXT NOT NULL DEFAULT '',
                corresponding_author TEXT NOT NULL DEFAULT '', UNIQUE(account_id,number))''')
            con.execute('''INSERT INTO manuscripts_updated SELECT id,account_id,title,NULLIF(number,''),
                status,raw_status,submitted_at,status_date,due_date,round,notes,recorded_at,
                last_success,source,title_en,title_zh,corresponding_author FROM manuscripts''')
            con.execute('DROP TABLE manuscripts')
            con.execute('ALTER TABLE manuscripts_updated RENAME TO manuscripts')
        columns = {row['name'] for row in con.execute('PRAGMA table_info(manuscripts)')}
        for column in ('system_submitted_at', 'first_author'):
            if column not in columns:
                con.execute(f"ALTER TABLE manuscripts ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")
        # Reclassify existing resubmission decisions without changing observation times.
        for row in con.execute("SELECT id,raw_status FROM manuscripts WHERE status='rejected'").fetchall():
            if portal_sync.is_reject_resubmit(row['raw_status']):
                con.execute("UPDATE manuscripts SET status='revision' WHERE id=?", (row['id'],))
        for row in con.execute("SELECT * FROM events WHERE new_status='rejected'").fetchall():
            if portal_sync.is_reject_resubmit(row['raw_status']):
                con.execute("UPDATE events SET new_status='revision' WHERE id=?", (row['id'],))
                following = con.execute('''SELECT id,old_status FROM events WHERE manuscript_id=?
                    AND happened_at>? ORDER BY happened_at LIMIT 1''',
                    (row['manuscript_id'],row['happened_at'])).fetchone()
                if following and following['old_status']=='rejected':
                    con.execute("UPDATE events SET old_status='revision' WHERE id=?", (following['id'],))
        con.commit()
        con.execute('PRAGMA foreign_keys=ON')
    private_mode(DB, 0o600)
    PROFILE.initialize()
    SCHEDULE.initialize()
    ATTENTION.initialize()
    APPEARANCE.initialize()


def now():
    return datetime.now().astimezone().isoformat(timespec='seconds')


def text_field(body, key, required=False, limit=1000):
    value = body.get(key, '')
    if not isinstance(value, str):
        raise ValueError('填写内容格式有误')
    value = value.strip()
    if required and not value:
        raise ValueError('请填写所有必填项')
    if len(value) > limit:
        raise ValueError('填写内容过长')
    return value


def date_field(body, key):
    value = text_field(body, key, limit=10)
    if value:
        try:
            date.fromisoformat(value)
        except ValueError:
            raise ValueError('请填写有效日期')
    return value


def save_password(account_id, password, label):
    return credential_store.save(account_id, password, label)


def state():
    with connect() as con:
        result = {name: [dict(row) for row in con.execute('SELECT * FROM ' + name)]
                  for name in ('journals', 'accounts', 'manuscripts', 'events')}
        result['last_checked_at'] = con.execute('SELECT last_checked_at FROM sync_state WHERE id=1').fetchone()['last_checked_at']
        account_checks = {row['account_id']: dict(row) for row in con.execute('SELECT * FROM account_sync')}
        for paper in result['manuscripts']:
            paper['status_label'] = status_label(paper['status'], paper['raw_status'])
        for event in result['events']:
            event['new_status_label'] = status_label(event['new_status'], event['raw_status'])
        for account in result['accounts']:
            check = account_checks.get(account['id'], {})
            account.update(last_checked_at=check.get('last_success_at'), sync_error=check.get('error', ''))
            journal = next(j for j in result['journals'] if j['id'] == account['journal_id'])
            account['auto_read_supported'] = portal_sync.supported(journal['login_url'], account['login_method'], journal['platform'])
        # A successful retry can finish a partially completed check without re-reading other accounts.
        papers = [p for p in result['manuscripts'] if p['status'] in REFRESH_STATUSES]
        used_accounts = {p['account_id'] for p in papers}
        if papers and all(p['last_success'] for p in papers) and not any(
                a['sync_error'] for a in result['accounts'] if a['id'] in used_accounts):
            complete_through = min(p['last_success'] for p in papers)
            result['last_checked_at'] = max(result['last_checked_at'] or '', complete_through)
        metric_checks = {row['journal_id']:dict(row) for row in con.execute('SELECT * FROM journal_metric_sync')}
    seeds = json.loads((ROOT / 'journal_metrics.json').read_text(encoding='utf-8'))
    result['journal_metrics'] = []
    result['journal_metric_sync'] = {}
    with METRICS_QUEUE_LOCK:
        pending = METRICS_PENDING | METRICS_ACTIVE
    for journal in result['journals']:
        check = metric_checks.get(journal['id'], {})
        record = journal_lookup.merge_metrics(journal_lookup.seed_for(journal,seeds), json.loads(check.get('payload','{}')))
        if record:
            record['journal_id'] = journal['id']
            result['journal_metrics'].append(record)
        result['journal_metric_sync'][journal['id']] = {
            'pending':journal['id'] in pending, 'last_checked_at':check.get('last_success_at'),
            'error':check.get('error','')}
    result.update(token=TOKEN, keychain_ready=credential_store.ready(), version='1.1', profile=PROFILE.state(),
                  auto_refresh=SCHEDULE.state(), sync_in_progress=SYNC_LOCK.locked(),
                  appearance=APPEARANCE.state())
    ATTENTION.enrich(result)
    return result


def status_label(status, raw):
    if status == 'revision' and portal_sync.is_reject_resubmit(raw):
        return '拒稿重投'
    return STATUSES.get(status, status)


def queue_journal_metrics(journal_ids=None, force=False):
    global METRICS_RUNNING
    if os.environ.get('PAPERDESK_TEST_OFFLINE') == '1':
        return
    with connect() as con:
        journals = [dict(row) for row in con.execute('SELECT * FROM journals')
                    if journal_ids is None or row['id'] in journal_ids]
        checks = {row['journal_id']:dict(row) for row in con.execute('SELECT * FROM journal_metric_sync')}
    seeds = json.loads((ROOT / 'journal_metrics.json').read_text(encoding='utf-8'))
    due = []
    for journal in journals:
        check = checks.get(journal['id'], {})
        seed = journal_lookup.seed_for(journal,seeds) or {}
        checked = check.get('last_attempt_at') or seed.get('checked_at','')
        if force or not checked or checked[:10] != date.today().isoformat():
            due.append(journal['id'])
    with METRICS_QUEUE_LOCK:
        METRICS_PENDING.update(set(due)-METRICS_ACTIVE)
        if METRICS_PENDING and not METRICS_RUNNING:
            METRICS_RUNNING = True
            threading.Thread(target=journal_metrics_worker,daemon=True).start()


def journal_metrics_worker():
    global METRICS_RUNNING
    while True:
        with METRICS_QUEUE_LOCK:
            if not METRICS_PENDING:
                METRICS_RUNNING = False
                return
            selected = set(METRICS_PENDING)
            METRICS_PENDING.clear()
            METRICS_ACTIVE.update(selected)
        with connect() as con:
            journals = [dict(row) for row in con.execute('SELECT * FROM journals') if row['id'] in selected]
            checks = {row['journal_id']:dict(row) for row in con.execute('SELECT * FROM journal_metric_sync')}
        seeds = json.loads((ROOT / 'journal_metrics.json').read_text(encoding='utf-8'))
        for journal in journals:
            cached = json.loads(checks.get(journal['id'],{}).get('payload','{}'))
            seed = journal_lookup.seed_for(journal,seeds) or {}
            journal['lookup_url'] = cached.get('lookup_url') or seed.get('lookup_url')
        try:
            outcomes = journal_lookup.query(journals,DATA)
        except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired) as exc:
            message = str(exc) if isinstance(exc, RuntimeError) else '期刊指标查询未完成，请稍后刷新'
            outcomes = {j['id']:{'ok':False,'error':message} for j in journals}
        for journal in journals:
            outcome = outcomes.get(journal['id'],{})
            record, error = journal_lookup.parse_result(journal,outcome)
            if outcome.get('error'): error = outcome['error']
            previous = json.loads(checks.get(journal['id'],{}).get('payload','{}'))
            record = journal_lookup.merge_metrics(previous,record)
            stamp = now()
            with METRICS_QUEUE_LOCK, connect() as con:
                current = con.execute('SELECT name FROM journals WHERE id=?', (journal['id'],)).fetchone()
                if not current or current['name'] != journal['name']:
                    continue
                con.execute('''INSERT INTO journal_metric_sync(journal_id,payload,last_attempt_at,last_success_at,error)
                    VALUES(?,?,?,?,?) ON CONFLICT(journal_id) DO UPDATE SET payload=excluded.payload,
                    last_attempt_at=excluded.last_attempt_at,last_success_at=COALESCE(excluded.last_success_at,journal_metric_sync.last_success_at),
                    error=excluded.error''',(journal['id'],json.dumps(record,ensure_ascii=False),stamp,stamp if not error else None,error))
        with METRICS_QUEUE_LOCK:
            METRICS_ACTIVE.difference_update(selected)


def account_save(body, account_id=None):
    username = text_field(body, 'username', True, 320)
    label = text_field(body, 'label', limit=80) or username
    password = body.get('password', '')
    with connect() as con:
        if account_id:
            old = con.execute('SELECT * FROM accounts WHERE id=?', (account_id,)).fetchone()
            if not old:
                raise ValueError('找不到该账号')
            journal_id = old['journal_id']
            if 'label' not in body:
                label = old['label']
        else:
            journal_id = text_field(body, 'journal_id')
            if journal_id:
                if not con.execute('SELECT 1 FROM journals WHERE id=?', (journal_id,)).fetchone():
                    raise ValueError('请选择已有期刊')
            else:
                name = text_field(body, 'journal_name', True, 250)
                abbreviation = text_field(body, 'abbreviation', limit=20) or name[:12]
                platform = text_field(body, 'platform', True, 80)
                login_url = text_field(body, 'login_url', True, 2048).rstrip('/')
                parsed = urlsplit(login_url)
                if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
                    raise ValueError('请填写以 https:// 开头的期刊登录网址')
                platform = portal_sync.platform_name(login_url) or platform
                existing = con.execute('SELECT id FROM journals WHERE login_url=?', (login_url,)).fetchone()
                if existing:
                    journal_id = existing['id']
                else:
                    journal_id = str(uuid4())
                    con.execute('INSERT INTO journals VALUES (?,?,?,?,?)',
                                (journal_id, name, abbreviation, platform, login_url))
        login_method = text_field(body, 'login_method') or (old['login_method'] if account_id else 'password')
        if login_method not in ('password', 'orcid', 'elsevier'):
            raise ValueError('请选择有效登录方式')
        journal = con.execute('SELECT * FROM journals WHERE id=?', (journal_id,)).fetchone()
        if login_method == 'orcid' and not portal_sync.is_editorial_manager(journal['login_url']):
            raise ValueError('ORCID 登录需要填写提供该登录方式的 Editorial Manager 投稿入口')
        if login_method == 'elsevier' and not portal_sync.is_editorial_manager(journal['login_url']):
            raise ValueError('Elsevier 登录需要填写期刊的 Editorial Manager 投稿入口')
        duplicate = con.execute('SELECT id FROM accounts WHERE journal_id=? AND username=?',
                                (journal_id, username)).fetchone()
        if duplicate and duplicate['id'] != account_id:
            raise ValueError('这个期刊下已有相同账号，请直接编辑该账号')
        identifier = account_id or str(uuid4())
        journal_name = con.execute('SELECT name FROM journals WHERE id=?', (journal_id,)).fetchone()['name']
        stored = save_password(identifier, password, journal_name + ' · ' + label)
        if account_id:
            changed_identity = (username != old['username'] or login_method != old['login_method'])
            new_session = changed_identity and bool({'orcid','elsevier'} & {login_method,old['login_method']})
            con.execute('''UPDATE accounts SET username=?,label=?,has_password=?,login_method=?,
                           session_generation=?,last_authenticated_at=? WHERE id=?''',
                        (username, label, int(stored or (old['has_password'] and not new_session)), login_method,
                         str(uuid4()) if new_session else old['session_generation'],
                         None if new_session else old['last_authenticated_at'], identifier))
            if new_session:
                con.execute("UPDATE account_sync SET last_success_at=NULL,error='' WHERE account_id=?", (identifier,))
        else:
            con.execute('''INSERT INTO accounts(id,journal_id,username,label,has_password,created_at,login_method)
                           VALUES (?,?,?,?,?,?,?)''',
                        (identifier, journal_id, username, label, int(stored), now(), login_method))
    queue_journal_metrics([journal_id])
    return {'ok': True, 'id': identifier, 'message': '账号已保存' + ('，密码已由系统保护保存' if stored else '')}


def journal_save(body, journal_id):
    name = text_field(body, 'name', True, 250)
    abbreviation = text_field(body, 'abbreviation', limit=20) or name[:12]
    with METRICS_QUEUE_LOCK, connect() as con:
        old = con.execute('SELECT * FROM journals WHERE id=?', (journal_id,)).fetchone()
        if not old:
            raise ValueError('找不到该期刊')
        con.execute('UPDATE journals SET name=?,abbreviation=? WHERE id=?', (name, abbreviation, journal_id))
        if name != old['name']:
            con.execute('DELETE FROM journal_metric_sync WHERE journal_id=?', (journal_id,))
            if journal_id in METRICS_ACTIVE:
                METRICS_PENDING.add(journal_id)
    if name != old['name']:
        queue_journal_metrics([journal_id], force=True)
    return {'ok': True, 'id': journal_id, 'message': '期刊名称已保存'}


def delete_records(kind, identifier):
    if kind not in ('account', 'journal'):
        raise ValueError('请选择有效记录')
    if not SYNC_LOCK.acquire(blocking=False):
        raise ValueError('正在读取或登录，请完成后再删除')
    try:
        with METRICS_QUEUE_LOCK, connect() as con:
            con.execute('BEGIN IMMEDIATE')
            table = 'accounts' if kind == 'account' else 'journals'
            if not con.execute(f'SELECT 1 FROM {table} WHERE id=?', (identifier,)).fetchone():
                raise ValueError('找不到该账号' if kind == 'account' else '找不到该期刊')
            accounts = con.execute('SELECT * FROM accounts WHERE ' +
                                  ('id=?' if kind == 'account' else 'journal_id=?'), (identifier,)).fetchall()
            for account in accounts:
                account_id = account['id']
                profiles = DATA / 'browser-profiles'
                if profiles.is_dir():
                    pattern = re.compile(re.escape(account_id) + r'(?:-firefox|-(?:orcid|elsevier)-firefox(?:-[A-Za-z0-9-]+)?)?')
                    for profile in profiles.iterdir():
                        if pattern.fullmatch(profile.name):
                            close_profile(profile)
                            shutil.rmtree(profile)
                if account['has_password'] or credential_store.ready():
                    credential_store.delete(account_id)
                for related in ('notifications', 'events'):
                    con.execute(f'DELETE FROM {related} WHERE manuscript_id IN '
                                '(SELECT id FROM manuscripts WHERE account_id=?)', (account_id,))
                con.execute('DELETE FROM manuscripts WHERE account_id=?', (account_id,))
                con.execute('DELETE FROM account_sync WHERE account_id=?', (account_id,))
                con.execute('DELETE FROM accounts WHERE id=?', (account_id,))
            if kind == 'journal':
                con.execute('DELETE FROM journal_metric_sync WHERE journal_id=?', (identifier,))
                con.execute('DELETE FROM journals WHERE id=?', (identifier,))
                METRICS_PENDING.discard(identifier)
        return {'ok': True, 'message': '账号及关联记录已删除' if kind == 'account' else '期刊及关联记录已删除'}
    finally:
        SYNC_LOCK.release()


def connect_account(body):
    """Check the selected SSO login; a visible window is an explicit fallback."""
    identifier = text_field(body, 'account_id', True)
    interactive = body.get('interactive') is True
    if not SYNC_LOCK.acquire(blocking=False):
        raise ValueError('已有读取或登录正在进行，请稍候')
    try:
        with connect() as con:
            account = con.execute('SELECT * FROM accounts WHERE id=?', (identifier,)).fetchone()
            if not account or account['login_method'] not in ('orcid','elsevier'):
                raise ValueError('请选择通过 ORCID 或 Elsevier 登录的账号')
            journal = con.execute('SELECT * FROM journals WHERE id=?', (account['journal_id'],)).fetchone()
        try:
            portal_sync.read_account(dict(account), dict(journal), [], DATA,
                                     interactive=interactive, connect_only=True)
        except portal_sync.PortalError as exc:
            with connect() as con:
                con.execute('''INSERT INTO account_sync(account_id,last_attempt_at,error) VALUES(?,?,?)
                    ON CONFLICT(account_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,error=excluded.error''',
                    (identifier,now(),str(exc)))
            raise ValueError(str(exc))
        with connect() as con:
            con.execute('UPDATE accounts SET last_authenticated_at=? WHERE id=?', (now(),identifier))
            con.execute("UPDATE account_sync SET error='' WHERE account_id=?", (identifier,))
        provider = 'Elsevier' if account['login_method']=='elsevier' else 'ORCID'
        return {'ok':True, 'message':provider+' 已连接，可以添加论文并后台读取状态'}
    finally:
        SYNC_LOCK.release()


def manuscript_save(body, manuscript_id=None):
    account_id = text_field(body, 'account_id', True)
    legacy_title = text_field(body, 'title', limit=500)
    title_en = text_field(body, 'title_en', limit=1000)
    title_zh = text_field(body, 'title_zh', limit=1000)
    bilingual = 'title_en' in body or 'title_zh' in body
    if not bilingual and legacy_title:
        if re.search(r'[\u3400-\u9fff]', legacy_title):
            title_zh = legacy_title
        else:
            title_en = legacy_title
    if not title_en and not title_zh:
        raise ValueError('请至少填写英文题目或中文题目')
    corresponding_author = text_field(body, 'corresponding_author', limit=250)
    first_author = text_field(body, 'first_author', limit=250)
    number = text_field(body, 'number', limit=100) or None
    status = text_field(body, 'status', True)
    if status not in STATUSES:
        raise ValueError('请选择有效状态')
    raw_status = text_field(body, 'raw_status', limit=250) or STATUSES[status]
    submitted = date_field(body, 'submitted_at')
    status_date = date_field(body, 'status_date')
    due_date = date_field(body, 'due_date')
    revision = text_field(body, 'round', limit=60) or '初投'
    notes = text_field(body, 'notes', limit=5000)
    stamp = now()
    with connect() as con:
        if not con.execute('SELECT 1 FROM accounts WHERE id=?', (account_id,)).fetchone():
            raise ValueError('请先添加一个期刊账号')
        duplicate = con.execute('SELECT id FROM manuscripts WHERE account_id=? AND number=?',
                                (account_id, number)).fetchone()
        if duplicate and duplicate['id'] != manuscript_id:
            raise ValueError('此账号下已记录该稿件编号，请编辑已有稿件')
        identifier = manuscript_id or str(uuid4())
        old = None
        if manuscript_id:
            old = con.execute('SELECT * FROM manuscripts WHERE id=?', (identifier,)).fetchone()
            if not old:
                raise ValueError('找不到该稿件')
            if not bilingual:
                title_en = title_en or old['title_en']
                title_zh = title_zh or old['title_zh']
            if 'corresponding_author' not in body:
                corresponding_author = old['corresponding_author']
            if 'first_author' not in body:
                first_author = old['first_author']
            if 'submitted_at' not in body:
                submitted = old['submitted_at']
            title = title_zh or title_en
            con.execute('''UPDATE manuscripts SET account_id=?,title=?,number=?,status=?,raw_status=?,
                        submitted_at=?,status_date=?,due_date=?,round=?,notes=?,recorded_at=?,source='manual'
                        ,title_en=?,title_zh=?,corresponding_author=?,first_author=?
                        WHERE id=?''', (account_id,title,number,status,raw_status,submitted,status_date,
                                        due_date,revision,notes,stamp,title_en,title_zh,corresponding_author,first_author,identifier))
        else:
            title = title_zh or title_en
            con.execute('''INSERT INTO manuscripts
                        (id,account_id,title,number,status,raw_status,submitted_at,status_date,due_date,
                         round,notes,recorded_at,last_success,source,title_en,title_zh,corresponding_author,first_author)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                        (identifier,account_id,title,number,status,raw_status,submitted,status_date,
                         due_date,revision,notes,stamp,None,'manual',title_en,title_zh,corresponding_author,first_author))
        if not old or old['status'] != status or old['raw_status'] != raw_status:
            con.execute('INSERT INTO events VALUES (?,?,?,?,?,?,?)',
                        (str(uuid4()),identifier,stamp,old['status'] if old else None,status,raw_status,'manual'))
    return {'ok': True, 'id': identifier, 'message': '稿件已保存'}


def tracked_matches(account_id, portal_rows):
    """Resolve only manuscripts the user explicitly added; never import a whole account."""
    def title_key(value):
        return ' '.join(unicodedata.normalize('NFKC', value or '').split()).casefold()

    def base_number(value):
        return re.sub(r'(?:\.R|R)\d+$', '', value or '', flags=re.I)

    def revision_number(row):
        revision = re.search(r'(?:\.R|R)(\d+)$', row.get('number', ''), re.I)
        return int(revision[1]) if revision else 0

    with connect() as con:
        tracked = [dict(row) for row in con.execute('SELECT * FROM manuscripts WHERE account_id=?', (account_id,))]
    results = []
    for paper in tracked:
        if paper['number']:
            candidates = [row for row in portal_rows if base_number(row.get('number')) == base_number(paper['number'])]
            matched_by = 'number'
        else:
            key = title_key(paper['title_en'])
            candidates = [row for row in portal_rows if key and title_key(row.get('title_en') or row.get('title')) == key]
            matched_by = 'title'
        # ScholarOne displays earlier decisions alongside the explicitly numbered revisions.
        if len(candidates) > 1 and len({base_number(row.get('number')) for row in candidates}) == 1:
            ordered = sorted(candidates, key=revision_number)
            if len({revision_number(row) for row in ordered}) == len(ordered):
                latest = dict(ordered[-1])
                if revision_number(ordered[0]) == 0:
                    latest['submitted_at'] = ordered[0].get('submitted_at', '')
                candidates = [latest]
        results.append({'manuscript_id': paper['id'], 'matched_by': matched_by,
                        'status': 'matched' if len(candidates)==1 else 'ambiguous' if candidates else 'not_found',
                        'match': candidates[0] if len(candidates)==1 else None})
    return results


def refresh_account(account, journal, tracked, interactive=False):
    account_id = account['id']
    checked_ids, updated = set(), 0
    attempted = now()
    error = ''
    try:
        portal_rows = portal_sync.read_account(account, journal, tracked, DATA,
            **({'interactive':True} if interactive else {}))
        selected_ids = {p['id'] for p in tracked}
        matches = [m for m in tracked_matches(account_id, portal_rows) if m['manuscript_id'] in selected_ids]
        observations = []
        unknown_dates = 0
        for match in matches:
            if match['status'] != 'matched':
                error = '存在同名稿件，请补充稿件编号' if match['status'] == 'ambiguous' else '未找到已添加的论文，请核对完整英文题目和投稿账号'
                continue
            row = match['match']
            dates = []
            for key in ('submitted_at', 'status_date'):
                try:
                    dates.append(portal_sync.submission_date(row.get(key, '')))
                except portal_sync.PortalError:
                    dates.append(None)
                    unknown_dates += 1
            observations.append((match['manuscript_id'], row, *dates))
        if unknown_dates:
            error = '；'.join(filter(None, (error, f'{unknown_dates} 项网站日期暂未识别；可识别的稿件信息已同步')))
        stamp = now()
        with connect() as con:
            for paper_id, row, submitted, status_date in observations:
                old = con.execute('SELECT * FROM manuscripts WHERE id=? AND account_id=?', (paper_id, account_id)).fetchone()
                if not old:
                    continue
                raw = row['raw_status']
                status = portal_sync.normalize_status(raw, journal['platform'])
                changed = old['status'] != status or old['raw_status'] != raw
                con.execute('''UPDATE manuscripts SET number=?,status=?,raw_status=?,system_submitted_at=?,
                    last_success=?,source='website',recorded_at=?,status_date=? WHERE id=?''',
                    (row['number'], status, raw, submitted or old['system_submitted_at'], stamp, stamp,
                     status_date or ('' if changed else old['status_date']), paper_id))
                if changed:
                    event_id = str(uuid4())
                    con.execute('INSERT INTO events VALUES (?,?,?,?,?,?,?)',
                        (event_id, paper_id, stamp, old['status'], status, raw, 'website'))
                    ATTENTION.changed(con, event_id, paper_id, stamp,
                                      status_label(old['status'], old['raw_status']), old['raw_status'])
                    updated += 1
                checked_ids.add(paper_id)
    except portal_sync.PortalError as exc:
        error = str(exc)
    except (OSError, sqlite3.IntegrityError):
        error = '读取结果未能保存，请核对是否重复添加了同一篇论文'
    with connect() as con:
        con.execute('''INSERT INTO account_sync(account_id,last_attempt_at,last_success_at,error)
            VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET
            last_attempt_at=excluded.last_attempt_at,
            last_success_at=COALESCE(excluded.last_success_at,account_sync.last_success_at),error=excluded.error''',
            (account_id, attempted, now() if not error else None, error))
    return {'checked_ids': checked_ids, 'updated': updated, 'error': error}


def refresh_journal_accounts(jobs, interactive=False):
    # Keep the same portal's login sequence while other journals run concurrently.
    return {account['id']: refresh_account(account, journal, tracked, interactive)
            for account, journal, tracked in jobs}


def refresh(body, lock_held=False):
    started = monotonic()
    if not lock_held and not SYNC_LOCK.acquire(blocking=False):
        raise ValueError('已有检查正在进行，请稍候')
    try:
        identifier = text_field(body, 'manuscript_id')
        account_identifier = text_field(body, 'account_id')
        interactive = body.get('interactive') is True
        if interactive and not account_identifier:
            raise ValueError('请选择需要验证的账号')
        with connect() as con:
            papers = [dict(row) for row in con.execute('SELECT * FROM manuscripts')]
            accounts = {row['id']: dict(row) for row in con.execute('SELECT * FROM accounts')}
            journals = {row['id']: dict(row) for row in con.execute('SELECT * FROM journals')}
        eligible = [p for p in papers if p['status'] in REFRESH_STATUSES]
        selected = [p for p in eligible if (not identifier or p['id'] == identifier)
                    and (not account_identifier or p['account_id'] == account_identifier)]
        if not selected:
            return {'ok': True, 'checked': 0, 'updated': 0, 'issues': [],
                    'message': '当前没有需要刷新的审稿中稿件' if papers else '请先添加要跟踪的论文'}
        if not identifier and not account_identifier:
            queue_journal_metrics()
        checked_ids, issues, updated = set(), [], 0
        account_ids = list(dict.fromkeys(p['account_id'] for p in selected))
        groups = {}
        for account_id in account_ids:
            account = accounts[account_id]
            tracked = [p for p in selected if p['account_id'] == account_id]
            groups.setdefault(account['journal_id'], []).append((account, journals[account['journal_id']], tracked))
        outcomes = {}
        # Each account owns a separate browser profile; the outer lock prevents overlapping runs.
        with ThreadPoolExecutor(max_workers=len(groups)) as pool:
            futures = [pool.submit(refresh_journal_accounts, jobs, interactive) for jobs in groups.values()]
            for future in as_completed(futures):
                outcomes.update(future.result())
        for account_id in account_ids:
            outcome = outcomes[account_id]
            checked_ids.update(outcome['checked_ids'])
            updated += outcome['updated']
            if outcome['error']:
                issues.append({'account_id': account_id, 'message': outcome['error']})
        with connect() as con:
            # A decision received in this run may move a paper out of the refresh group.
            eligible_ids = {p['id'] for p in eligible}
            if checked_ids and checked_ids == eligible_ids and not issues:
                con.execute('UPDATE sync_state SET last_checked_at=? WHERE id=1', (now(),))
        message = f'已从期刊系统读取 {len(checked_ids)} 篇稿件'
        if issues:
            message += '。' + issues[0]['message']
        seconds = round(monotonic() - started, 1)
        message += f' · 耗时 {seconds:g} 秒'
        return {'ok': True, 'checked': len(checked_ids), 'updated': updated, 'issues': issues,
                'message': message, 'duration_seconds': seconds}
    finally:
        if not lock_held:
            SYNC_LOCK.release()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ui_dir()), **kwargs)

    def log_message(self, format, *args):
        pass  # Do not log form payloads, account names or passwords.

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'")
        super().end_headers()

    def valid_host(self):
        return self.headers.get('Host') in {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}

    def respond(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if not self.valid_host():
            return self.respond(403, {'error': '请从本地地址打开看板'})
        path = urlsplit(self.path).path
        if path.startswith('/api/') and self.headers.get('X-Paperdesk-Token') != TOKEN:
            return self.respond(403, {'error': '请从 Paperdesk 应用内访问'})
        if path == '/api/state':
            return self.respond(200, state())
        if path == '/api/background/image':
            image = APPEARANCE.image()
            if not image:
                return self.respond(404, {'error': '尚未设置背景图片'})
            data, content_type = image
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if path.startswith('/api/'):
            return self.respond(404, {'error': '找不到该功能'})
        if path not in ('/', '/index.html', '/app.js', '/desktop.js', '/style.css', '/desktop.css', '/favicon.svg'):
            return self.respond(404, {'error': '找不到该页面'})
        super().do_GET()

    def do_POST(self):
        if not self.valid_host():
            return self.respond(403, {'error': '请从本地地址打开看板'})
        origin = self.headers.get('Origin')
        if origin and origin not in {f'http://127.0.0.1:{self.server.server_port}', f'http://localhost:{self.server.server_port}'}:
            return self.respond(403, {'error': '请从本地看板操作'})
        if self.headers.get('X-Paperdesk-Token') != TOKEN:
            return self.respond(403, {'error': '页面连接已更新，请重新载入网页'})
        try:
            length = int(self.headers.get('Content-Length', 0))
            path = urlsplit(self.path).path
            if path == '/api/background/image':
                if length < 1:
                    raise ValueError('请选择一张图片')
                result = APPEARANCE.upload(self.rfile.read(length),
                    unquote(self.headers.get('X-Paperdesk-Filename', '背景图片')))
                return self.respond(200, result)
            if length < 2 or length > (180 * 1024 * 1024 if path == '/api/backup/restore' else 32768):
                raise ValueError('请求内容格式有误')
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError('请求内容格式有误')
            if path == '/api/profile':
                result = PROFILE.save(body)
                SCHEDULE.recalculate()
            elif path == '/api/backup/export':
                result = backup.export_backup(connect)
            elif path in ('/api/backup/restore', '/api/backup/legacy'):
                if not SYNC_LOCK.acquire(blocking=False):
                    raise ValueError('正在刷新，请等待完成后恢复数据')
                try:
                    with METRICS_QUEUE_LOCK:
                        if METRICS_RUNNING:
                            raise ValueError('正在查询期刊指标，请稍后恢复数据')
                        result = backup.restore_backup(body, connect, DATA, legacy=path.endswith('/legacy'))
                        initialize()
                        SCHEDULE.recalculate()
                finally:
                    SYNC_LOCK.release()
            elif path == '/api/shutdown':
                result = {'ok': True}
                threading.Thread(target=self.server.shutdown, daemon=True).start()
            elif path == '/api/accounts/connect':
                result = connect_account(body)
            elif path == '/api/accounts':
                result = account_save(body)
            elif re.fullmatch(r'/api/(accounts|journals)/[^/]+/delete', path):
                _, _, group, identifier, _ = path.split('/')
                result = delete_records('account' if group == 'accounts' else 'journal', identifier)
            elif path.startswith('/api/accounts/'):
                result = account_save(body, path.rsplit('/', 1)[1])
            elif re.fullmatch(r'/api/journals/[^/]+', path):
                result = journal_save(body, path.rsplit('/', 1)[1])
            elif path == '/api/manuscripts':
                result = manuscript_save(body)
            elif path.startswith('/api/manuscripts/'):
                result = manuscript_save(body, path.rsplit('/', 1)[1])
            elif path == '/api/refresh':
                result = refresh(body)
            elif path == '/api/schedule':
                result = SCHEDULE.save(body)
            elif path == '/api/settings':
                preferences = ATTENTION.validate(body.get('notifications'))
                SCHEDULE.save(body)
                ATTENTION.save(preferences)
                result = {'ok': True, 'message': '设置已保存'}
            elif path == '/api/background':
                result = APPEARANCE.save(body)
            elif path == '/api/notifications/read':
                result = ATTENTION.read(body)
            elif path == '/api/notifications/claim':
                result = ATTENTION.claim_desktop(body)
            elif path == '/api/journal-metrics/refresh':
                journal_id = text_field(body, 'journal_id')
                queue_journal_metrics([journal_id] if journal_id else None, force=True)
                result = {'ok':True,'message':'正在查询期刊分区和影响因子'}
            else:
                return self.respond(404, {'error': '找不到该功能'})
            self.respond(200, result)
        except (ValueError, json.JSONDecodeError) as exc:
            self.respond(400, {'error': str(exc)})
        except sqlite3.IntegrityError:
            self.respond(400, {'error': '该记录已存在，请编辑已有记录'})
        except Exception:
            self.respond(500, {'error': '保存未完成，请重试。原有记录已保留。'})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    initialize()
    try:
        server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    except OSError:
        print(f'端口 {args.port} 已在使用。请先打开 http://127.0.0.1:{args.port} 查看。', flush=True)
        sys.exit(1)
    queue_journal_metrics()
    SCHEDULE.start()
    print(json.dumps({'type': 'ready', 'port': server.server_port}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        SCHEDULE.stop.set()
        close_browsers()
        server.server_close()


if __name__ == '__main__':
    main()
