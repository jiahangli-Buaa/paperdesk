"""Copy matching accounts' existing passwords between this Mac's two app stores.

This is a local repair utility. Passwords travel only through captured stdin/stdout
between the installed Keychain helpers and are never written to files or logs.
"""
from datetime import datetime
import json
from pathlib import Path
import sqlite3
import subprocess
import sys


def call(helper, request):
    return subprocess.run([str(helper)], input=json.dumps(request), text=True,
                          encoding='utf-8', capture_output=True, timeout=45)


def main():
    if sys.platform != 'darwin':
        raise SystemExit('This utility requires the original and desktop apps on the same Mac.')
    base = Path.home() / 'Library/Application Support'
    legacy = base / 'Paperdesk'
    desktop = base / 'PaperdeskDesktop'
    old_helper = legacy / 'bin/keychain-helper'
    new_helper = Path('/Applications/Paperdesk.app/Contents/Resources/runtime/keychain-helper')
    old_database = legacy / 'paperdesk.sqlite3'
    new_database = desktop / 'paperdesk.sqlite3'
    if not all(path.is_file() for path in (old_helper, new_helper, old_database, new_database)):
        raise SystemExit('The original app data or installed desktop app could not be found.')
    query = '''SELECT a.id,a.username,a.login_method,a.has_password,a.label,
                      j.login_url,j.name,j.abbreviation
               FROM accounts a JOIN journals j ON j.id=a.journal_id'''
    with sqlite3.connect(old_database.as_uri()+'?mode=ro', uri=True) as old:
        old.row_factory = sqlite3.Row
        previous = {row['id']:dict(row) for row in old.execute(query)}
    with sqlite3.connect(new_database.as_uri()+'?mode=rw', uri=True) as current:
        current.row_factory = sqlite3.Row
        accounts = [dict(row) for row in current.execute(query)]
        backup = desktop / 'backups' / ('before-password-import-'+datetime.now().strftime('%Y%m%d-%H%M%S')+'.sqlite3')
        backup.parent.mkdir(exist_ok=True)
        with sqlite3.connect(backup) as snapshot:
            current.backup(snapshot)
    report = {'accounts':len(accounts), 'copied':0, 'alreadySaved':0, 'skipped':0, 'failed':[], 'verified':0}
    verified = []
    for account in accounts:
        source = previous.get(account['id'])
        if not source or any(source[key] != account[key] for key in ('username','login_method','login_url')):
            report['skipped'] += 1
            continue
        existing = call(new_helper, {'operation':'get', 'account':account['id']})
        if existing.returncode == 0 and existing.stdout:
            report['alreadySaved'] += 1
            verified.append(account['id'])
            continue
        saved = call(old_helper, {'operation':'get', 'account':source['id']})
        if saved.returncode or not saved.stdout:
            report['failed'].append({'journal':account['abbreviation'], 'stage':'readOriginal'})
            continue
        password = saved.stdout
        result = call(new_helper, {'operation':'save', 'account':account['id'],
                      'password':password, 'label':account['name']+' · '+account['label']})
        if result.returncode:
            report['failed'].append({'journal':account['abbreviation'], 'stage':'saveDesktop'})
            continue
        checked = call(new_helper, {'operation':'verify', 'account':account['id'], 'password':password})
        if checked.returncode:
            report['failed'].append({'journal':account['abbreviation'], 'stage':'verifyDesktop'})
            continue
        verified.append(account['id'])
        report['copied'] += 1
    with sqlite3.connect(new_database.as_uri()+'?mode=rw', uri=True) as current:
        current.executemany('UPDATE accounts SET has_password=1 WHERE id=?', [(key,) for key in verified])
    report['verified'] = len(verified)
    report['ok'] = not report['failed'] and report['skipped'] == 0
    report['backup'] = str(backup)
    # Only result counts and journal abbreviations are stored in the local log.
    logs = desktop / 'logs'
    logs.mkdir(exist_ok=True)
    (logs / 'local-password-import.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
