"""Persistent unread changes and revision reminders for the local dashboard."""
import json
from datetime import date, datetime
from refresh_schedule import BEIJING


DEFAULTS = {'deadline_reminders': True, 'status_desktop': False, 'deadline_desktop': False}


class Attention:
    def __init__(self, connect, clock=None):
        self.connect = connect
        self.clock = clock or (lambda: datetime.now(BEIJING))

    def initialize(self):
        with self.connect() as con:
            con.executescript('''
                CREATE TABLE IF NOT EXISTS notification_settings (
                    id INTEGER PRIMARY KEY CHECK(id=1), preferences TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS notifications (
                    id TEXT PRIMARY KEY, manuscript_id TEXT NOT NULL REFERENCES manuscripts(id),
                    kind TEXT NOT NULL, event_id TEXT, due_date TEXT, threshold INTEGER,
                    created_at TEXT NOT NULL, read_at TEXT, desktop_at TEXT,
                    old_label TEXT NOT NULL DEFAULT '', old_raw TEXT NOT NULL DEFAULT '');
            ''')
            con.execute('INSERT OR IGNORE INTO notification_settings VALUES(1,?)',
                        (json.dumps(DEFAULTS),))

    def settings(self):
        with self.connect() as con:
            return {**DEFAULTS, **json.loads(con.execute(
                'SELECT preferences FROM notification_settings WHERE id=1').fetchone()[0])}

    @staticmethod
    def validate(body):
        if not isinstance(body, dict) or any(not isinstance(body.get(key), bool) for key in DEFAULTS):
            raise ValueError('请设置有效的通知选项')
        return {key: body[key] for key in DEFAULTS}

    def save(self, body):
        prefs = self.validate(body)
        with self.connect() as con:
            con.execute('UPDATE notification_settings SET preferences=? WHERE id=1', (json.dumps(prefs),))

    def changed(self, con, event_id, paper_id, stamp, old_label, old_raw):
        # Only newly observed website changes enter the inbox. Existing history stays read.
        con.execute('''INSERT INTO notifications(id,manuscript_id,kind,event_id,created_at,old_label,old_raw)
            VALUES(?,?,'status',?,?,?,?)''',
            ('event:' + event_id, paper_id, event_id, stamp, old_label, old_raw))

    def read(self, body):
        identifiers = self.identifiers(body)
        with self.connect() as con:
            con.executemany('UPDATE notifications SET read_at=? WHERE id=? AND read_at IS NULL',
                            [(self.clock().isoformat(timespec='seconds'), identifier) for identifier in identifiers])
        return {'ok': True}

    @staticmethod
    def identifiers(body):
        identifiers = body.get('ids')
        if not isinstance(identifiers, list) or len(identifiers) > 500 or any(not isinstance(i, str) for i in identifiers):
            raise ValueError('请选择要处理的提醒')
        return identifiers

    def claim_desktop(self, body):
        identifiers, claimed = self.identifiers(body), []
        prefs = self.settings()
        with self.connect() as con:
            for identifier in identifiers:
                row = con.execute('''SELECT n.*,p.status,p.due_date AS current_due FROM notifications n
                    JOIN manuscripts p ON p.id=n.manuscript_id WHERE n.id=?''', (identifier,)).fetchone()
                if not row or row['read_at'] or row['desktop_at']:
                    continue
                if row['kind'] == 'status' and not prefs['status_desktop']:
                    continue
                if row['kind'] == 'deadline' and (not prefs['deadline_desktop'] or not prefs['deadline_reminders']
                        or row['status'] != 'revision' or row['current_due'] != row['due_date']):
                    continue
                result = con.execute('UPDATE notifications SET desktop_at=? WHERE id=? AND desktop_at IS NULL',
                                     (self.clock().isoformat(timespec='seconds'), identifier))
                if result.rowcount:
                    claimed.append(identifier)
        return {'ok': True, 'ids': claimed}

    def enrich(self, result):
        moment = self.clock()
        today = moment.date()
        stamp = moment.isoformat(timespec='seconds')
        prefs = self.settings()
        papers = {p['id']: p for p in result['manuscripts']}
        events = {e['id']: e for e in result['events']}
        # Event order also preserves second-level ties from the original insert order.
        ordered = sorted(result['events'], key=lambda e: e['happened_at'])
        previous = {}
        for event in ordered:
            prior = previous.get(event['manuscript_id'])
            if prior:
                event.update(old_status_label=prior['new_status_label'], old_raw_status=prior['raw_status'])
            previous[event['manuscript_id']] = event
        for paper in papers.values():
            paper['submitted_days'] = self.elapsed(paper['system_submitted_at'], today)
            paper['status_started_at'] = paper['status_date'] or paper['system_submitted_at']
            paper['status_days'] = self.elapsed(paper['status_started_at'], today)
            paper['status_days_source'] = 'status_date' if paper['status_date'] else 'submission_date'
            paper['due_days'] = (date.fromisoformat(paper['due_date']) - today).days if paper['due_date'] else None
            paper['unread_changes'] = []
            paper['deadline_alerts'] = []
        with self.connect() as con:
            if prefs['deadline_reminders']:
                for paper in papers.values():
                    days = paper['due_days']
                    if paper['status'] != 'revision' or days is None or days > 7:
                        continue
                    threshold = next(t for t in (0, 1, 3, 7) if days <= t)
                    identifier = f"due:{paper['id']}:{paper['due_date']}:{threshold}"
                    con.execute('''INSERT OR IGNORE INTO notifications
                        (id,manuscript_id,kind,due_date,threshold,created_at) VALUES(?,?,'deadline',?,?,?)''',
                        (identifier, paper['id'], paper['due_date'], threshold, stamp))
                    # Keep only the most urgent milestone unread if the page was away for several days.
                    con.execute('''UPDATE notifications SET read_at=? WHERE manuscript_id=? AND kind='deadline'
                        AND due_date=? AND threshold>? AND read_at IS NULL''',
                        (stamp, paper['id'], paper['due_date'], threshold))
            notices = [dict(n) for n in con.execute('SELECT * FROM notifications WHERE read_at IS NULL ORDER BY created_at DESC,rowid DESC')]
        active = []
        for notice in notices:
            paper = papers.get(notice['manuscript_id'])
            if not paper:
                continue
            if notice['kind'] == 'status':
                event = events.get(notice['event_id'])
                if not event:
                    continue
                notice.update(new_label=event['new_status_label'], new_raw=event['raw_status'])
                event['unread'] = True
                event['old_status_label'] = notice['old_label']
                event['old_raw_status'] = notice['old_raw']
                paper['unread_changes'].append(notice)
            else:
                if not prefs['deadline_reminders'] or paper['status'] != 'revision' or notice['due_date'] != paper['due_date']:
                    continue
                paper['deadline_alerts'].append(notice)
            active.append(notice)
        result.update(notifications=active, notification_settings=prefs, today=today.isoformat())

    @staticmethod
    def elapsed(value, today):
        if not value:
            return None
        if 'T' in value:
            start = datetime.fromisoformat(value).astimezone(BEIJING).date()
        else:
            start = date.fromisoformat(value)
        # A future portal date cannot support an elapsed-day count.
        return (today - start).days if start <= today else None
