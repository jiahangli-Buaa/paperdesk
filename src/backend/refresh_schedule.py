"""Daily refresh scheduling owned by the local Paperdesk service."""
import json
import re
import threading
from datetime import datetime, timedelta, timezone

BEIJING = timezone(timedelta(hours=8), 'Asia/Shanghai')
DEFAULT_TIMES = ['10:00', '15:00', '20:00']


def next_run_after(moment, times, zone=BEIJING):
    local = moment.astimezone(zone)
    for day in (local, local + timedelta(days=1)):
        for value in sorted(times):
            hour, minute = map(int, value.split(':'))
            candidate = day.replace(hour=hour, minute=minute, second=0, microsecond=0)
            if candidate > local:
                return candidate.isoformat(timespec='seconds')


class RefreshSchedule:
    def __init__(self, connect, refresh, sync_lock, clock=None, zone=None):
        self.connect = connect
        self.refresh = refresh
        self.sync_lock = sync_lock
        self.zone = zone or (lambda: BEIJING)
        self.clock = clock or (lambda: datetime.now(self.zone()))
        self.running = threading.Event()
        self.stop = threading.Event()

    def initialize(self):
        with self.connect() as con:
            con.execute('''CREATE TABLE IF NOT EXISTS refresh_schedule (
                id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL,
                times TEXT NOT NULL, next_run_at TEXT, last_started_at TEXT,
                last_finished_at TEXT, last_result TEXT NOT NULL DEFAULT '{}',
                last_error TEXT NOT NULL DEFAULT '')''')
            con.execute('''INSERT OR IGNORE INTO refresh_schedule(id,enabled,times,next_run_at)
                VALUES(1,1,?,?)''',
                (json.dumps(DEFAULT_TIMES), next_run_after(self.clock(), DEFAULT_TIMES, self.zone())))

    def state(self):
        with self.connect() as con:
            row = dict(con.execute('SELECT * FROM refresh_schedule WHERE id=1').fetchone())
        row.pop('id')
        row['enabled'] = bool(row['enabled'])
        row['times'] = json.loads(row['times'])
        row['last_result'] = json.loads(row['last_result'])
        row.update(timezone=str(self.zone()), running=self.running.is_set())
        return row

    def save(self, body):
        enabled, times = body.get('enabled'), body.get('times')
        if not isinstance(enabled, bool) or not isinstance(times, list) or len(times) != 3:
            raise ValueError('请设置是否启用以及每天的三个刷新时间')
        if any(not isinstance(t, str) or not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', t) for t in times):
            raise ValueError('请填写有效的刷新时间')
        if len(set(times)) != len(times):
            raise ValueError('三个刷新时间不能重复')
        times = sorted(times)
        with self.connect() as con:
            con.execute('UPDATE refresh_schedule SET enabled=?,times=?,next_run_at=? WHERE id=1',
                (int(enabled), json.dumps(times), next_run_after(self.clock(), times, self.zone()) if enabled else None))
        return {'ok': True, 'message': '自动刷新设置已保存'}

    def recalculate(self):
        config = self.state()
        with self.connect() as con:
            con.execute('UPDATE refresh_schedule SET next_run_at=? WHERE id=1',
                        (next_run_after(self.clock(), config['times'], self.zone()) if config['enabled'] else None,))

    def tick(self):
        current = self.clock().astimezone(self.zone())
        config = self.state()
        if not config['enabled'] or datetime.fromisoformat(config['next_run_at']) > current:
            return False
        # Manual and scheduled reads share the same lock. A busy run delays this slot.
        if not self.sync_lock.acquire(blocking=False):
            return False
        try:
            with self.connect() as con:
                con.execute('BEGIN IMMEDIATE')
                row = con.execute('SELECT * FROM refresh_schedule WHERE id=1').fetchone()
                if not row['enabled'] or datetime.fromisoformat(row['next_run_at']) > current:
                    return False
                # After sleep, coalesce missed slots into one read and resume the regular schedule.
                con.execute('''UPDATE refresh_schedule SET next_run_at=?,last_started_at=?,
                    last_finished_at=NULL,last_result='{}',last_error='' WHERE id=1''',
                    (next_run_after(current, json.loads(row['times']), self.zone()), current.isoformat(timespec='seconds')))
            self.running.set()
            result, error = {}, ''
            try:
                result = self.refresh()
                if result.get('issues'):
                    error = result['issues'][0]['message']
            except Exception:
                error = '自动刷新未完成，请点击“刷新审稿中”重试'
            finally:
                with self.connect() as con:
                    con.execute('''UPDATE refresh_schedule SET last_finished_at=?,last_result=?,last_error=?
                        WHERE id=1''', (self.clock().astimezone(self.zone()).isoformat(timespec='seconds'),
                                       json.dumps(result, ensure_ascii=False), error))
                self.running.clear()
            return True
        finally:
            self.sync_lock.release()

    def start(self):
        def loop():
            while not self.stop.is_set():
                self.tick()
                self.stop.wait(5)
        threading.Thread(target=loop, name='paperdesk-auto-refresh', daemon=True).start()
