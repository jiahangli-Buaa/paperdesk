from pathlib import Path
import sqlite3
from database import connect as open_database
import tempfile
import threading
import unittest
from datetime import datetime
from refresh_schedule import BEIJING, RefreshSchedule


class RefreshScheduleTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / 'schedule.sqlite3'
        self.moment = datetime(2026, 9, 30, 9, 59, tzinfo=BEIJING)
        self.calls = []
        self.lock = threading.Lock()
        self.scheduler = self.create_scheduler()
        self.scheduler.initialize()

    def tearDown(self):
        self.temp.cleanup()

    def connect(self):
        con = open_database(self.db)
        con.row_factory = sqlite3.Row
        return con

    def refresh(self):
        self.assertTrue(self.lock.locked())
        self.calls.append(self.moment)
        return {'ok': True, 'checked': 2, 'updated': 0, 'issues': []}

    def create_scheduler(self):
        return RefreshSchedule(self.connect, self.refresh, self.lock, lambda: self.moment)

    def test_three_daily_slots_are_persistent_and_execute_once(self):
        self.assertFalse(self.scheduler.tick())
        for hour, next_hour in ((10, 15), (15, 20), (20, 10)):
            self.moment = self.moment.replace(hour=hour, minute=0)
            self.assertTrue(self.scheduler.tick())
            self.assertFalse(self.scheduler.tick())
            self.scheduler = self.create_scheduler()
            self.scheduler.initialize()
            self.assertFalse(self.scheduler.tick())
            state = self.scheduler.state()
            next_time = datetime.fromisoformat(state['next_run_at'])
            self.assertEqual(next_time.hour, next_hour)
            if hour == 20:
                self.assertEqual(next_time.day, 1)
            self.assertEqual(state['last_result']['checked'], 2)
        self.assertEqual(len(self.calls), 3)

    def test_sleep_coalesces_missed_times_and_busy_manual_read_defers(self):
        self.moment = self.moment.replace(hour=21, minute=30)
        with self.lock:
            self.assertFalse(self.scheduler.tick())
        self.assertEqual(self.scheduler.state()['next_run_at'], '2026-09-30T10:00:00+08:00')
        self.assertTrue(self.scheduler.tick())
        self.assertFalse(self.scheduler.tick())
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.scheduler.state()['next_run_at'], '2026-10-01T10:00:00+08:00')

    def test_disabled_and_edited_schedule_survive_restart(self):
        self.scheduler.save({'enabled': False, 'times': ['10:00', '15:00', '20:00']})
        self.moment = self.moment.replace(hour=10, minute=0)
        self.scheduler = self.create_scheduler()
        self.scheduler.initialize()
        self.assertFalse(self.scheduler.tick())
        self.scheduler.save({'enabled': True, 'times': ['20:10', '10:10', '15:10']})
        self.moment = self.moment.replace(minute=10)
        self.assertTrue(self.scheduler.tick())
        self.assertEqual(self.scheduler.state()['next_run_at'], '2026-09-30T15:10:00+08:00')

    def test_partial_failure_is_reported_and_next_slot_remains_scheduled(self):
        self.scheduler.refresh = lambda: {'ok': True, 'checked': 1,
            'issues': [{'account_id': 'test', 'message': '需要完成网站验证'}]}
        self.moment = self.moment.replace(hour=10, minute=0)
        self.assertTrue(self.scheduler.tick())
        state = self.scheduler.state()
        self.assertEqual(state['last_error'], '需要完成网站验证')
        self.assertFalse(state['running'])
        self.assertFalse(self.lock.locked())
        self.assertEqual(state['next_run_at'], '2026-09-30T15:00:00+08:00')


if __name__ == '__main__':
    unittest.main()
