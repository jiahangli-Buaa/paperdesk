"""Per-user author names and time zone; no personal seed data."""
import json
import os
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


class Profile:
    def __init__(self, connect):
        self.connect = connect

    def initialize(self):
        with self.connect() as con:
            con.execute('CREATE TABLE IF NOT EXISTS user_profile (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)')
            con.execute('INSERT OR IGNORE INTO user_profile VALUES(1,?)', (json.dumps({
                'name': '', 'aliases': [], 'timezone': os.environ.get('PAPERDESK_TIMEZONE', 'Asia/Shanghai'),
                'onboarding_complete': False}),))

    def state(self):
        with self.connect() as con:
            return json.loads(con.execute('SELECT value FROM user_profile WHERE id=1').fetchone()[0])

    def zone(self):
        return ZoneInfo(self.state()['timezone'])

    def save(self, body):
        name, aliases, zone = body.get('name'), body.get('aliases'), body.get('timezone')
        if not isinstance(name, str) or not name.strip() or len(name) > 100:
            raise ValueError('请填写你的姓名')
        if not isinstance(aliases, list) or len(aliases) > 20 or any(not isinstance(a, str) or len(a) > 100 for a in aliases):
            raise ValueError('请填写有效的署名')
        try:
            ZoneInfo(zone)
        except (ZoneInfoNotFoundError, TypeError, ValueError):
            raise ValueError('请选择有效时区') from None
        value = {'name': name.strip(), 'aliases': list(dict.fromkeys(a.strip() for a in aliases if a.strip())),
                 'timezone': zone, 'onboarding_complete': True}
        with self.connect() as con:
            con.execute('UPDATE user_profile SET value=? WHERE id=1', (json.dumps(value, ensure_ascii=False),))
        return {'ok': True, 'message': '个人设置已保存', 'profile': value}
