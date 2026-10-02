import io
import json
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock,patch
from browser_runtime import ReaderWorker


def child(reads=5):
    p=Mock()
    p.stdin=io.StringIO()
    p.stdout=io.StringIO((json.dumps({'ok':True,'rows':[]})+'\n')*reads)
    p.poll.return_value=None
    return p


class BrowserRuntimeTests(unittest.TestCase):
    def test_repeated_requests_reuse_one_account_process_and_eof_closes_it(self):
        p=child()
        worker=ReaderWorker('node','reader.mjs')
        request={'login_url':'https://example.test/journal','username':'author','password':'synthetic'}
        with patch('browser_runtime.subprocess.Popen',return_value=p) as start:
            with ThreadPoolExecutor(max_workers=5) as pool:
                results=list(pool.map(lambda _:worker.read(request,30),range(5)))
            start.assert_called_once()
            self.assertTrue(all(json.loads(r.stdout)['ok'] for r in results))
            requests=[json.loads(line) for line in p.stdin.getvalue().splitlines()]
            self.assertTrue(all(r['keep_browser'] for r in requests))
            worker.close()
        self.assertTrue(p.stdin.closed)
        self.assertTrue(p.stdout.closed)

    def test_changed_account_identity_restarts_and_resets_the_login(self):
        first,second=child(1),child(1)
        worker=ReaderWorker('node','reader.mjs')
        request={'login_url':'https://example.test/journal','username':'first'}
        with patch('browser_runtime.subprocess.Popen',side_effect=[first,second]) as start:
            worker.read(request,30)
            worker.read(dict(request,username='second'),30)
            self.assertEqual(start.call_count,2)
            self.assertTrue(first.stdin.closed)
            self.assertTrue(json.loads(second.stdin.getvalue())['reset_session'])
            worker.close()


if __name__=='__main__':unittest.main()
