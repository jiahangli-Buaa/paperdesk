"""Read-only journal connectors used by the local dashboard."""
import json
import credential_store
from platform_runtime import node_path, browser_module, reader_path as runtime_reader_path, process_options
import re
from pathlib import Path
import shutil
import subprocess
from browser_runtime import read_with_browser, close_profile
from urllib.parse import urlsplit

class PortalError(Exception):
    pass


def is_scholarone(login_url):
    url = urlsplit(login_url)
    return (url.scheme == 'https' and not url.username and not url.password
            and bool(re.fullmatch(r'mc\d*\.manuscriptcentral\.com', url.netloc.casefold()))
            and bool(re.fullmatch(r'/[A-Za-z0-9][A-Za-z0-9_-]*/?', url.path)))


def is_editorial_manager(login_url):
    url = urlsplit(login_url)
    return (url.scheme == 'https' and not url.username and not url.password
            and url.netloc.casefold() == 'www.editorialmanager.com'
            and bool(re.fullmatch(r'/[A-Za-z0-9_-]+(?:/(?:default2?\.aspx|login\.asp))?/?', url.path, re.I)))


def is_papercept(login_url):
    url = urlsplit(login_url)
    return (url.scheme == 'https' and not url.username and not url.password
            and bool(re.fullmatch(r'[a-z0-9-]+\.(?:paperplaza\.net|papercept\.net)', url.netloc.casefold()))
            and bool(re.fullmatch(r'/journals/[A-Za-z0-9_-]+/scripts/login\.pl/?', url.path)))


def platform_name(login_url):
    for check, name in ((is_scholarone, 'ScholarOne'),
                        (is_editorial_manager, 'Editorial Manager'), (is_papercept, 'PaperCept')):
        if check(login_url):
            return name
    return ''


def is_ojs34(login_url):
    url = urlsplit(login_url)
    return (url.scheme == 'https' and bool(url.hostname) and not url.username and not url.password
            and bool(re.fullmatch(r'/index\.php/[A-Za-z0-9_-]+(?:/(?:login(?:/signIn)?|submissions))?/?', url.path)))


def supported(login_url, login_method='password', platform=''):
    if is_editorial_manager(login_url):
        return login_method in ('password', 'orcid', 'elsevier')
    if platform == 'Open Journal Systems 3.4':
        return login_method == 'password' and is_ojs34(login_url)
    return login_method == 'password' and (is_scholarone(login_url) or is_papercept(login_url))


def read_account(account, journal, tracked, data_dir, interactive=False, connect_only=False):
    login_method = account.get('login_method', 'password')
    if not supported(journal['login_url'], login_method, journal.get('platform', '')):
        raise PortalError('这个期刊的自动读取尚未接入')
    orcid = login_method == 'orcid'
    elsevier = login_method == 'elsevier'
    sso = orcid or elsevier
    provider = 'Elsevier' if elsevier else 'ORCID'
    firefox_scholarone = is_scholarone(journal['login_url'])
    papercept = is_papercept(journal['login_url'])
    ojs = journal.get('platform') == 'Open Journal Systems 3.4'
    if not sso and not account['has_password']:
        raise PortalError('请先为此账号保存登录密码')
    node = node_path()
    module = browser_module()
    if not module.is_file():
        raise PortalError('期刊读取组件缺失，请重新安装 Paperdesk')
    password = ''
    if account['has_password']:
        try:
            password = credential_store.get(account['id'])
        except (ValueError, OSError, subprocess.TimeoutExpired) as exc:
            raise PortalError(str(exc)) from None
    profile_name = account['id']
    if sso:
        profile_name += '-' + login_method + '-firefox'
        if account.get('session_generation'):
            profile_name += '-' + account['session_generation']
    elif firefox_scholarone or papercept:
        profile_name += '-firefox'
    payload = {
        'login_url': journal['login_url'], 'username': account['username'],
        'password': password, 'tracked': [
            {'number':p['number'], 'title_en':p['title_en']} for p in tracked],
        'browser_module': str(module),
        'profile_dir': str(data_dir / 'browser-profiles' / profile_name),
        'interactive': interactive, 'connect_only': connect_only, 'login_method': login_method,
        'browser_engine': 'firefox' if firefox_scholarone or papercept or sso else 'chromium'
    }
    credential = None
    password = ''
    try:
        reader = ('ojs_reader.mjs' if ojs else 'papercept_reader.mjs' if papercept else 'elsevier_reader.mjs' if elsevier
                  else 'cep_reader.mjs' if orcid else 'editorial_manager_reader.mjs'
                  if is_editorial_manager(journal['login_url']) else 'scis_reader.mjs')
        reader_path = runtime_reader_path(reader)
        if not interactive and not sso:
            result = read_with_browser(node, reader_path, payload, 180)
        else:
            close_profile(payload['profile_dir'])
            result = subprocess.run([node, str(reader_path)], input=json.dumps(payload),
                                    text=True, encoding='utf-8', capture_output=True, timeout=360 if interactive else 180, **process_options())
    except RuntimeError as exc:
        raise PortalError(str(exc))
    except subprocess.TimeoutExpired:
        raise PortalError('期刊网站响应超时，请稍后重试')
    finally:
        payload['password'] = ''
    try:
        outcome = json.loads(result.stdout)
    except (ValueError, TypeError):
        raise PortalError('浏览器读取未完成，请重试')
    if not outcome.get('ok'):
        messages = {
            'verification_required':'网站要求人工验证，请点击“打开验证窗口”完成验证，现有记录已保留',
            'login_incomplete':'期刊登录未完成，请核对账号密码，或点击“打开验证窗口”处理网站验证',
            'credentials_rejected':'期刊网站提示账号或密码不正确，请在账号管理中修改后重试',
            'account_unavailable':'期刊网站提示账号暂不可用，请打开投稿网站查看账号提示',
            'browser_unavailable':'未能启动投稿读取组件，请检查应用中的浏览器组件是否完整',
            'site_unavailable':'投稿网站暂时无法连接，请稍后重试；现有记录已保留',
            'papercept_action_required':'PaperCept 需要在网站中完成账号确认，请点击“打开验证窗口”处理',
            'sso_login_required':f'请先为这个 {provider} 账号保存密码，或点击“打开验证窗口”完成登录',
            'elsevier_login_incomplete':'Elsevier 登录未完成，请核对账号密码；如需验证码，可点击“打开验证窗口”',
            'elsevier_credentials_rejected':'Elsevier 提示账号或密码不正确，请在账号管理中修改后重试',
            'elsevier_action_required':'Elsevier 需要邮箱验证或确认期刊账号关联，请点击“打开验证窗口”处理',
            'elsevier_login_unavailable':'该投稿入口未提供 Elsevier 登录，请核对期刊入口与登录方式',
            'orcid_login_incomplete':'ORCID 登录未完成，请核对账号密码；如需人工验证，可点击“打开验证窗口”',
            'orcid_authorization_required':'ORCID 需要确认授权或完成账号关联，请点击“打开验证窗口”处理',
            'orcid_login_unavailable':'该投稿入口未提供 ORCID 登录，请核对期刊入口与登录方式',
            'read_incomplete':'期刊页面读取未完成，现有记录已保留',
            'unrecognized_table':'期刊稿件列表格式需要适配，现有记录已保留',
            'unsupported_journal':'这个期刊的自动读取尚未接入'
        }
        raise PortalError(messages.get(outcome.get('code'), '期刊页面读取未完成'))
    return outcome['rows']


def is_reject_resubmit(raw):
    value = ' '.join(raw.casefold().split())
    return value == '拒稿重投' or bool(re.search(
        r'\breject(?:ed)?\s*(?:and|&|/)\s*resubmit\b|'
        r'\breject(?:ed)?\s+with\s+(?:the\s+)?possibility\s+(?:for|of)\s+resubmission\b', value))


def normalize_status(raw, platform=''):
    value = raw.casefold()
    if platform == 'Open Journal Systems 3.4':
        if value.strip() in ('copyediting', 'production', 'published', 'scheduled'):
            return 'accepted'
        if 'must be resubmitted' in value or value.strip() == 'resubmit for review':
            return 'revision'
        if 'has been resubmitted' in value:
            return 'review'
        if 'revisions have been submitted' in value and 'decision' in value:
            return 'decision'
    if value.strip() == 'submission':
        return 'submitted'
    if value.strip() == 'review':
        return 'review'
    if is_reject_resubmit(raw):
        return 'revision'
    if any(term in value for term in ('under review', 'awaiting reviewer scores', 'awaiting referee reports')):
        return 'review'
    if 'reject' in value or 'decline' in value:
        return 'rejected'
    if 'accept' in value:
        return 'accepted'
    if 'withdraw' in value:
        return 'withdrawn'
    if 'revision' in value or 'revise' in value:
        return 'revision'
    if 'decision' in value or 'recommendation' in value:
        return 'decision'
    if 'awaiting' in value or 'editor' in value or 'assigned' in value:
        return 'editor'
    if 'submitted' in value:
        return 'submitted'
    return 'unknown'


def submission_date(value):
    from datetime import date, datetime
    if not value:
        return ''
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        pass
    for date_format in ('%b %d %Y', '%B %d %Y'):
        try:
            return datetime.strptime(' '.join(value.replace(',', '').split()[:3]), date_format).date().isoformat()
        except ValueError:
            pass
    months = {name:index+1 for index,name in enumerate(
        ('jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'))}
    try:
        day, month, year = value.split('-')
        return date(int(year), months[month.casefold()], int(day)).isoformat()
    except (ValueError, KeyError):
        raise PortalError('网站投稿日期格式需要适配，现有记录已保留')
