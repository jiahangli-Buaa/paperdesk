"""Round-trip one disposable credential through the native OS implementation."""
import os
from pathlib import Path
import sys
import tempfile
import uuid
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,os.environ.get('PAPERDESK_BACKEND_DIR',str(ROOT/'src/backend')))
import credential_store
with tempfile.TemporaryDirectory(prefix='paperdesk-credential-check-') as folder:
 os.environ['PAPERDESK_DATA_DIR']=folder
 account='desktop-check-'+uuid.uuid4().hex
 value=uuid.uuid4().hex
 try:
  credential_store.save(account,value,'Paperdesk verification')
  assert credential_store.get(account)==value
 finally:
  credential_store.delete(account)
 print('Native credential round-trip and cleanup passed.')
