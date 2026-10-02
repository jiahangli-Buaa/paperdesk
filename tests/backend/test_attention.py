from datetime import datetime, timedelta
import unittest
from unittest.mock import patch
import test_records
from refresh_schedule import BEIJING


class AttentionTests(unittest.TestCase):
    setUp = test_records.RecordsTest.setUp
    tearDown = test_records.RecordsTest.tearDown
    account = test_records.RecordsTest.account
    paper = test_records.RecordsTest.paper

    def create(self, **changes):
        self.moment = datetime(2026, 9, 30, 10, tzinfo=BEIJING)
        self.app.ATTENTION.clock = lambda: self.moment
        self.aid = self.account('attention-fixture')
        with patch.object(self.app, 'now', return_value=self.moment.isoformat()):
            self.pid = self.app.manuscript_save(self.paper(self.aid, 'ATT-01', **changes))['id']
        return self.pid

    def refresh_to(self, raw, status_date=''):
        with patch.object(self.app, 'now', return_value=self.moment.isoformat()), patch.object(
                self.app.portal_sync, 'read_account', return_value=[dict(number='ATT-01', title_en='Test paper',
                raw_status=raw, submitted_at='2026-09-01', status_date=status_date)]):
            return self.app.refresh({'manuscript_id': self.pid})

    def test_new_changes_are_unread_unchanged_read_does_not_reset_days(self):
        self.create(status='submitted')
        self.assertEqual(self.app.state()['notifications'], [])
        self.refresh_to('Under Review')
        self.moment += timedelta(days=2)
        self.refresh_to('Under Review')
        state = self.app.state()
        self.assertEqual(len(state['notifications']), 1)
        paper = state['manuscripts'][0]
        self.assertEqual(paper['submitted_days'], 31)
        self.assertEqual(paper['status_days'], 31)
        self.assertEqual(paper['status_days_source'], 'submission_date')
        self.assertEqual(paper['status_started_at'], '2026-09-01')
        first = state['notifications'][0]
        self.moment += timedelta(days=1)
        self.refresh_to('Awaiting Decision')
        self.app.ATTENTION.read({'ids': [first['id']]})
        state = self.app.state()
        self.assertEqual(len(state['notifications']), 1)
        self.assertEqual(state['notifications'][0]['old_label'], '审稿中')
        self.assertEqual(state['notifications'][0]['new_label'], '等待决定')
        self.assertEqual(state['manuscripts'][0]['status_days'], 32)
        self.app.initialize()
        self.assertEqual(len(self.app.state()['notifications']), 1)

    def test_explicit_status_date_and_same_category_raw_change(self):
        self.create(status='review', raw_status='Under Review')
        self.refresh_to('Awaiting Reviewer Scores', '2026-09-15')
        paper = self.app.state()['manuscripts'][0]
        self.assertEqual(paper['status_days'], 15)
        self.assertEqual(paper['status_days_source'], 'status_date')
        change = paper['unread_changes'][0]
        self.assertEqual(change['old_label'], change['new_label'])
        self.assertNotEqual(change['old_raw'], change['new_raw'])
        self.refresh_to('Awaiting Decision')
        self.assertEqual(self.app.state()['manuscripts'][0]['status_days_source'], 'submission_date')
        self.assertEqual(self.app.state()['manuscripts'][0]['status_days'], 29)
        self.assertEqual(self.app.ATTENTION.elapsed('2026-09-29T20:00:00+00:00', self.moment.date()), 0)

    def test_deadline_milestones_deduplicate_and_ignore_changed_or_closed_deadlines(self):
        self.create(status='revision', due_date='2026-10-07')
        state = self.app.state()
        first = state['notifications'][0]
        self.assertEqual(first['threshold'], 7)
        self.app.ATTENTION.read({'ids': [first['id']]})
        self.moment += timedelta(days=1)
        self.assertEqual(self.app.state()['notifications'], [])
        self.moment += timedelta(days=3)
        state = self.app.state()
        self.assertEqual(len(state['notifications']), 1)
        self.assertEqual(state['notifications'][0]['threshold'], 3)
        self.moment += timedelta(days=2)
        state = self.app.state()
        self.assertEqual([n['threshold'] for n in state['notifications']], [1])
        self.moment += timedelta(days=1)
        self.assertEqual([n['threshold'] for n in self.app.state()['notifications']], [0])
        self.moment += timedelta(days=1)
        self.assertEqual([n['threshold'] for n in self.app.state()['notifications']], [0])
        with self.app.connect() as con:
            con.execute("UPDATE manuscripts SET due_date='2026-11-07' WHERE id=?", (self.pid,))
        self.assertEqual(self.app.state()['notifications'], [])
        with self.app.connect() as con:
            con.execute("UPDATE manuscripts SET status='review',due_date='2026-10-09' WHERE id=?", (self.pid,))
        self.assertEqual(self.app.state()['notifications'], [])

    def test_missed_milestones_only_show_most_urgent_and_desktop_claim_is_once(self):
        self.create(status='revision', due_date='2026-10-02')
        notice = self.app.state()['notifications'][0]
        self.assertEqual(notice['threshold'], 3)
        self.assertEqual(self.app.ATTENTION.claim_desktop({'ids': [notice['id']]})['ids'], [])
        self.app.ATTENTION.save(dict(deadline_reminders=True, status_desktop=False, deadline_desktop=True))
        self.assertEqual(self.app.ATTENTION.claim_desktop({'ids': [notice['id']]})['ids'], [notice['id']])
        self.assertEqual(self.app.ATTENTION.claim_desktop({'ids': [notice['id']]})['ids'], [])
        self.app.ATTENTION.save(dict(deadline_reminders=False, status_desktop=False, deadline_desktop=False))
        self.assertEqual(self.app.state()['notifications'], [])
        self.assertEqual(self.app.state()['manuscripts'][0]['due_days'], 2)


if __name__ == '__main__':
    unittest.main()
