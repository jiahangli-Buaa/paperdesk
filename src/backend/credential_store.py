"""OS-protected credentials, separate from the portable manuscript database."""
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from platform_runtime import process_options, user_data_dir


def helper_path():
    return Path(os.environ.get('PAPERDESK_KEYCHAIN_HELPER',
        str(Path(__file__).resolve().parents[2] / 'build/runtime/macos-arm64/keychain-helper')))


def ready():
    return sys.platform == 'win32' or (sys.platform == 'darwin' and helper_path().is_file())


class Blob(ctypes.Structure):
    _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_ubyte))]


def _dpapi(data, decrypt=False):
    """Windows DPAPI binds encrypted bytes to this Windows user's profile."""
    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    buffer = ctypes.create_string_buffer(data, len(data))
    incoming = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    outgoing = Blob()
    call = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    call.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                     ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    call.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    if not call(ctypes.byref(incoming), None, None, None, None, 1, ctypes.byref(outgoing)):
        raise ValueError('系统密码存储暂时不可用，请重新登录 Windows 后重试')
    try:
        return ctypes.string_at(outgoing.pbData, outgoing.cbData)
    finally:
        kernel.LocalFree(outgoing.pbData)


def _credential_file(account):
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', account):
        raise ValueError('账号标识无效')
    directory = user_data_dir() / 'credentials'
    directory.mkdir(parents=True, exist_ok=True)
    return directory / (account + '.bin')


def _keychain(operation, account, password='', label=''):
    if not ready():
        raise ValueError('系统密码组件未准备好，请重新安装 Paperdesk')
    request = {'operation': operation, 'account': account}
    if operation == 'save':
        request.update(password=password, label=label)
    result = subprocess.run([str(helper_path())], input=json.dumps(request),
        text=True, encoding='utf-8', capture_output=True, timeout=45, **process_options())
    if result.returncode:
        raise ValueError('未能访问系统保存的密码，请解锁钥匙串或重新填写密码')
    return result.stdout


def save(account, password, label=''):
    if not isinstance(password, str) or len(password) > 4096:
        raise ValueError('密码格式有误')
    if not password:
        return False
    if sys.platform == 'win32':
        path = _credential_file(account)
        temporary = path.with_suffix('.tmp')
        temporary.write_bytes(_dpapi(password.encode('utf-8')))
        os.replace(temporary, path)
    else:
        _keychain('save', account, password, label)
    return True


def get(account):
    if sys.platform == 'win32':
        try:
            return _dpapi(_credential_file(account).read_bytes(), decrypt=True).decode('utf-8')
        except OSError:
            raise ValueError('请在账号管理中重新保存密码') from None
    return _keychain('get', account)


def delete(account):
    if sys.platform == 'win32':
        _credential_file(account).unlink(missing_ok=True)
    else:
        _keychain('delete', account)
