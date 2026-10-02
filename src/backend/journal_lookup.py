"""Public journal metrics lookup, separate from private manuscript-status readers."""
from datetime import date
import json
from platform_runtime import node_path, browser_module, reader_path, process_options
from pathlib import Path
import re
import shutil
import subprocess
import unicodedata


def name_key(value):
    value = unicodedata.normalize('NFKC', value or '').casefold().replace('&', 'and')
    return re.sub(r'[^a-z0-9\u3400-\u9fff]', '', value)


def seed_for(journal, seeds):
    return next((item for item in seeds if name_key(journal['name']) in [name_key(n) for n in item['names']]
                 or journal['login_url'].rstrip('/') in item.get('login_urls', [])), None)


def merge_metrics(seed, cached):
    result = dict(seed or {})
    for key in ('names', 'login_urls', 'issn', 'lookup_url', 'checked_at'):
        if cached.get(key): result[key] = cached[key]
    for key in ('cas', 'impact_factor'):
        incoming, previous = cached.get(key), result.get(key)
        # Keep the verified source when both describe the same year; never move backwards.
        if incoming and (not previous or incoming['year'] > previous['year'] or
                         (incoming['year'] == previous['year'] and previous.get('source_name') == 'Scholay（公开转录）')):
            result[key] = incoming
    return result


def parse_result(journal, raw):
    if not raw.get('ok'):
        messages = {'not_found':'未查到该期刊，请核对完整期刊名称', 'ambiguous':'存在同名期刊，指标暂待核实',
                    'name_mismatch':'期刊名称不一致，指标暂待核实'}
        return {}, messages.get(raw.get('code'), '期刊指标来源暂时无法读取，请稍后刷新')
    if name_key(raw.get('name')) != name_key(journal['name']):
        return {}, '期刊名称不一致，指标暂待核实'
    source = dict(source_name='Scholay（公开转录）',source_url=raw['source_url'])
    record = {'names':[journal['name'],raw['name']], 'login_urls':[journal['login_url']],
              'issn':next(iter(raw.get('issns',[])),''), 'lookup_url':raw['source_url'],
              'checked_at':date.today().isoformat()}
    for group in raw.get('groups',[]):
        label, fields = group.get('label',''), group.get('fields',{})
        year = str(fields.get('数据年份',''))
        if not re.fullmatch(r'20\d{2}',year): continue
        year = int(year)
        if label.startswith('JCR'):
            value = fields.get('影响因子','')
            if re.fullmatch(r'\d+(?:\.\d+)?',value):
                record['impact_factor'] = dict(value=value if '.' in value else value+'.0',year=year,**source)
        elif label.startswith('中科院') and '新锐' not in label:
            zone = fields.get('大类分区','')
            if zone in ('1','2','3','4') and fields.get('大类学科'):
                record['cas'] = dict(zone=int(zone),year=year,edition=f'{year}年版',
                    category=fields['大类学科'],top=bool(fields.get('Top 期刊')),**source)
    missing = [name for key,name in (('cas','中科院分区'),('impact_factor','IF')) if key not in record]
    return record, '来源暂未提供'+'、'.join(missing)+'的完整数据' if missing else ''


def query(journals, data_dir):
    node = node_path()
    module = browser_module()
    if not module.is_file():
        raise RuntimeError('期刊读取组件缺失，请重新安装 Paperdesk')
    payload = {'journals':journals,'browser_module':str(module),
               'profile_dir':str(data_dir / 'browser-profiles/journal-metrics')}
    result = subprocess.run([node,str(reader_path('journal_metrics_reader.mjs'))],
                            input=json.dumps(payload),text=True,encoding='utf-8',capture_output=True,timeout=40+60*len(journals), **process_options())
    outcome = json.loads(result.stdout)
    if not outcome.get('ok'): raise RuntimeError('期刊指标查询未完成，请稍后刷新')
    return {entry['id']:entry for entry in outcome['results']}
