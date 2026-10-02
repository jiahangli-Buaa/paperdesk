"""Paths and process options supplied by the desktop launcher."""
import os
from pathlib import Path
import shutil
import subprocess
import sys

SOURCE = Path(__file__).resolve().parent.parent


def user_data_dir():
    if os.environ.get('PAPERDESK_DATA_DIR'):
        return Path(os.environ['PAPERDESK_DATA_DIR'])
    if sys.platform == 'win32':
        return Path(os.environ['LOCALAPPDATA']) / 'Paperdesk'
    return Path.home() / 'Library/Application Support/PaperdeskDesktop'


def private_mode(path, mode):
    if os.name != 'nt':
        Path(path).chmod(mode)


def process_options():
    return {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}


def node_path():
    result = os.environ.get('PAPERDESK_NODE') or shutil.which('node')
    if not result:
        raise RuntimeError('期刊读取组件缺失，请重新安装 Paperdesk')
    return result


def browser_module():
    return Path(os.environ.get('PAPERDESK_BROWSER_MODULE',
        str(SOURCE.parent / 'node_modules/playwright-core/index.mjs')))


def reader_path(name):
    return SOURCE / 'readers' / name


def ui_dir():
    return SOURCE / 'ui'
