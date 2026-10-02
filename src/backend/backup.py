"""Portable manuscript backups. Credentials and browser profiles stay on the device."""
import base64
import io
import json
import os
from pathlib import Path
import sqlite3
from database import connect as open_database
import sys
import tempfile
import zipfile
from datetime import datetime

REQUIRED = {'journals', 'accounts', 'manuscripts', 'events'}
ALLOWED = REQUIRED | {'sync_state', 'account_sync', 'journal_metric_sync', 'refresh_schedule',
    'notification_settings', 'notifications', 'appearance', 'user_profile'}
MAX_DATABASE = 128 * 1024 * 1024


def _clean_login(db):
    columns = {r[1] for r in db.execute('PRAGMA table_info(accounts)')}
    assignments = ['has_password=0']
    if 'last_authenticated_at' in columns:
        assignments.append('last_authenticated_at=NULL')
    if 'session_generation' in columns:
        assignments.append("session_generation=''")
    db.execute('UPDATE accounts SET ' + ','.join(assignments))
    db.commit()


def export_backup(connect):
    with tempfile.TemporaryDirectory(prefix='paperdesk-backup-') as folder:
        target = Path(folder) / 'records.sqlite3'
        with connect() as source, open_database(target) as destination:
            source.backup(destination)
            _clean_login(destination)
        data = io.BytesIO()
        with zipfile.ZipFile(data, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('manifest.json', json.dumps({'format': 'paperdesk', 'version': 1,
                'created_at': datetime.now().astimezone().isoformat(), 'credentials_included': False}))
            archive.write(target, 'records.sqlite3')
        return {'ok': True, 'data': base64.b64encode(data.getvalue()).decode('ascii')}


def _validate(path):
    if path.stat().st_size > MAX_DATABASE:
        raise ValueError('备份文件过大')
    with open_database(path) as db:
        db.execute('PRAGMA trusted_schema=OFF')
        rows = db.execute("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").fetchall()
        tables = {name for kind, name in rows if kind == 'table'}
        if not REQUIRED <= tables or not tables <= ALLOWED or any(kind not in ('table', 'index') for kind, _ in rows):
            raise ValueError('请选择 Paperdesk 导出的备份')
        if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise ValueError('备份数据库未通过完整性检查')
        for table, columns in {'journals': {'id', 'name', 'login_url'},
            'accounts': {'id', 'journal_id', 'username', 'has_password'},
            'manuscripts': {'id', 'account_id', 'title', 'status', 'raw_status'},
            'events': {'id', 'manuscript_id', 'happened_at'}}.items():
            if not columns <= {r[1] for r in db.execute('PRAGMA table_info(' + table + ')')}:
                raise ValueError('备份数据结构不完整')
        _clean_login(db)


def restore_backup(body, connect, data_dir, legacy=False):
    with tempfile.TemporaryDirectory(prefix='paperdesk-restore-') as folder:
        target = Path(folder) / 'records.sqlite3'
        try:
            if legacy:
                if sys.platform != 'darwin':
                    raise ValueError('旧版 Mac 数据迁移仅适用于 Mac')
                source_path = Path.home() / 'Library/Application Support/Paperdesk/paperdesk.sqlite3'
                if not source_path.is_file():
                    raise ValueError('未找到本机旧版 Paperdesk 数据')
                with open_database(source_path.as_uri() + '?mode=ro', uri=True) as old, open_database(target) as new:
                    old.backup(new)
            else:
                data = base64.b64decode(body.get('data', ''), validate=True)
                with zipfile.ZipFile(io.BytesIO(data)) as archive:
                    meta = json.loads(archive.read('manifest.json'))
                    if meta.get('format') != 'paperdesk' or meta.get('version') != 1:
                        raise ValueError('备份版本暂不支持')
                    if archive.getinfo('records.sqlite3').file_size > MAX_DATABASE:
                        raise ValueError('备份文件过大')
                    target.write_bytes(archive.read('records.sqlite3'))
            _validate(target)
        except (sqlite3.Error, zipfile.BadZipFile, KeyError, TypeError, json.JSONDecodeError) as exc:
            raise ValueError('无法读取此备份，请选择有效的 Paperdesk 备份文件') from None
        snapshots = data_dir / 'backups'
        snapshots.mkdir(exist_ok=True)
        before = snapshots / ('before-restore-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f') + '.sqlite3')
        with connect() as destination, open_database(before) as saved, open_database(target) as source:
            destination.backup(saved)
            source.backup(destination)
        return {'ok': True, 'message': '稿件和设置已恢复，请在账号管理中重新保存密码',
                'backup_path': str(before)}
