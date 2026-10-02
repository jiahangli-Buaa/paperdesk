"""One read per existing login route in isolated temporary profiles; no account data is packaged."""
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from time import monotonic
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
RUNTIME=ROOT/'build/runtime/macos-arm64'
sys.path.insert(0,str(ROOT/'src/backend'))
os.environ.update(PAPERDESK_NODE=str(RUNTIME/'node/bin/node'),PAPERDESK_BROWSER_MODULE=str(RUNTIME/'browser-module/playwright-core/index.mjs'),PLAYWRIGHT_BROWSERS_PATH=str(RUNTIME/'browsers'))
import portal_sync
from browser_runtime import close_browsers
LEGACY=Path.home()/'Library/Application Support/Paperdesk'
con=sqlite3.connect((LEGACY/'paperdesk.sqlite3').as_uri()+'?mode=ro',uri=True);con.row_factory=sqlite3.Row
accounts=[dict(r) for r in con.execute('SELECT * FROM accounts WHERE has_password=1')]
journals={r['id']:dict(r) for r in con.execute('SELECT * FROM journals')}
selected={}
for account in accounts:
 journal=journals[account['journal_id']]
 tracked=[dict(r) for r in con.execute("SELECT * FROM manuscripts WHERE account_id=? AND status IN ('submitted','editor','review','decision','unknown')",(account['id'],))]
 if not tracked:continue
 route=account['login_method'] if account['login_method'] in ('orcid','elsevier') else 'scholarone' if portal_sync.is_scholarone(journal['login_url']) else 'papercept' if journal['platform']=='PaperCept' else 'editorial-manager'
 if route not in selected:selected[route]=(account,journal,tracked)

def password(account_id):
 result=subprocess.run([str(LEGACY/'bin/keychain-helper')],input=json.dumps({'operation':'get','account':account_id}),text=True,capture_output=True,timeout=45,check=True)
 return result.stdout

result_path=ROOT/'build/test-results/live-readers.json'
report=json.loads(result_path.read_text()) if result_path.exists() else []
with tempfile.TemporaryDirectory(prefix='paperdesk-read-check-') as folder:
 data=Path(folder)
 for route,(account,journal,tracked) in selected.items():
  if len(sys.argv)>1 and route not in sys.argv[1:]:continue
  profile=account['id']
  if account['login_method'] in ('orcid','elsevier'):
   profile+='-'+account['login_method']+'-firefox'
   if account.get('session_generation'):profile+='-'+account['session_generation']
  elif route in ('scholarone','papercept'):profile+='-firefox'
  old=LEGACY/'browser-profiles'/profile
  if old.is_dir():
   shutil.copytree(old,data/'browser-profiles'/profile,ignore=shutil.ignore_patterns('Singleton*','RunningChromeVersion','lock','.parentlock','parent.lock','*.log'),ignore_dangling_symlinks=True)
  print(json.dumps({'route':route,'phase':'reading'}),flush=True)
  started=monotonic()
  try:
   with patch.object(portal_sync.credential_store,'get',side_effect=password):
    rows=portal_sync.read_account(account,journal,tracked,data)
   result={'route':route,'ok':True,'rows':len(rows),'seconds':round(monotonic()-started,1)}
  except Exception as exc:
   result={'route':route,'ok':False,'error':str(exc),'seconds':round(monotonic()-started,1)}
  report=[r for r in report if r['route']!=route]+[result]
  result_path.write_text(json.dumps(report,ensure_ascii=False,indent=2))
  print(json.dumps(result,ensure_ascii=False),flush=True)
 close_browsers()
(ROOT/'build/test-results/live-readers.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
