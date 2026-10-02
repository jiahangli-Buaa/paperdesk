import base64
import json
import struct
import threading
import unittest
import urllib.request
import zlib
import test_records

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=')


class AppearanceTests(unittest.TestCase):
    setUp = test_records.RecordsTest.setUp
    tearDown = test_records.RecordsTest.tearDown

    def test_upload_transparency_persist_and_restore(self):
        appearance = self.app.APPEARANCE
        initial = appearance.state()
        self.assertFalse(initial['has_image'])
        self.assertEqual(initial['transparency'], 70)
        self.assertEqual(initial['panel_transparency'], 65)
        self.assertEqual(initial['sidebar_transparency'], 60)
        appearance.upload(PNG, '测试背景.png')
        appearance.save({'transparency': 35})
        self.app.initialize()
        state = self.app.state()['appearance']
        self.assertTrue(state['has_image'])
        self.assertEqual(state['transparency'], 35)
        self.assertEqual(state['image_name'], '测试背景.png')
        self.assertEqual(appearance.image(), (PNG, 'image/png'))
        self.assertNotIn('image', state)
        for value in (0, 100):
            appearance.save({'transparency': value})
            self.assertEqual(appearance.state()['transparency'], value)
        appearance.save({'reset': True})
        self.assertFalse(appearance.state()['has_image'])
        self.assertEqual(appearance.state()['transparency'], 70)
        self.assertEqual(appearance.state()['panel_transparency'], 65)
        self.assertEqual(appearance.state()['sidebar_transparency'], 60)
        self.assertIsNone(appearance.image())

    def test_existing_image_migration_and_independent_surface_settings(self):
        with self.app.connect() as con:
            con.execute('DROP TABLE appearance')
            con.execute('''CREATE TABLE appearance (
                id INTEGER PRIMARY KEY CHECK(id=1), transparency INTEGER NOT NULL,
                image BLOB, image_type TEXT, image_name TEXT, image_id TEXT)''')
            con.execute('INSERT INTO appearance VALUES(1,35,?,?,?,?)',
                        (PNG, 'image/png', '已上传图片.png', 'existing-image'))
        appearance = self.app.APPEARANCE
        appearance.initialize()
        state = appearance.state()
        self.assertEqual(state['transparency'], 35)
        self.assertEqual(state['image_url'], '/api/background/image?v=existing-image')
        self.assertEqual(appearance.image(), (PNG, 'image/png'))
        appearance.save({'panel_transparency': 100})
        appearance.save({'sidebar_transparency': 0})
        appearance.initialize()
        saved = appearance.state()
        self.assertEqual(saved['panel_transparency'], 100)
        self.assertEqual(saved['sidebar_transparency'], 0)
        self.assertEqual(saved['transparency'], 35)
        self.assertEqual(saved['image_url'], state['image_url'])
        with self.assertRaises(ValueError):
            appearance.save({'panel_transparency': 20, 'sidebar_transparency': 101})
        self.assertEqual(appearance.state(), saved)
        appearance.save({'reset': True})
        self.assertFalse(appearance.state()['has_image'])
        self.assertEqual(appearance.state()['panel_transparency'], 65)
        self.assertEqual(appearance.state()['sidebar_transparency'], 60)

    def test_http_image_upload_serving_and_invalid_file_preserves_background(self):
        http = self.app.ThreadingHTTPServer(('127.0.0.1', 0), self.app.Handler)
        worker = threading.Thread(target=http.serve_forever, daemon=True)
        worker.start()
        url = f'http://127.0.0.1:{http.server_port}'
        headers = {'X-Paperdesk-Token': self.app.TOKEN, 'X-Paperdesk-Filename': 'background.png'}
        try:
            request = urllib.request.Request(url+'/api/background/image', data=PNG, headers=headers, method='POST')
            with urllib.request.urlopen(request) as response:
                saved = json.load(response)['appearance']
            with urllib.request.urlopen(urllib.request.Request(url+saved['image_url'],headers={'X-Paperdesk-Token':self.app.TOKEN})) as response:
                self.assertEqual(response.headers['Content-Type'], 'image/png')
                self.assertEqual(response.read(), PNG)
            request = urllib.request.Request(url+'/api/background/image', data=b'not an image', headers=headers, method='POST')
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(request)
            self.assertEqual(error.exception.code, 400)
            self.assertEqual(self.app.APPEARANCE.state(), saved)
            with self.assertRaises(ValueError):
                self.app.APPEARANCE.save({'transparency': 150})
            self.assertEqual(self.app.APPEARANCE.state(), saved)
        finally:
            http.shutdown()
            http.server_close()
            worker.join()

    def test_http_accepts_image_larger_than_previous_limit(self):
        metadata = b'Comment\x00' + b'x' * (13 * 1024 * 1024)
        chunk = b'tEXt' + metadata
        large_png = (PNG[:-12] + struct.pack('>I', len(metadata)) + chunk
                     + struct.pack('>I', zlib.crc32(chunk)) + PNG[-12:])
        http = self.app.ThreadingHTTPServer(('127.0.0.1', 0), self.app.Handler)
        worker = threading.Thread(target=http.serve_forever, daemon=True)
        worker.start()
        try:
            request = urllib.request.Request(
                f'http://127.0.0.1:{http.server_port}/api/background/image',
                data=large_png, method='POST', headers={
                    'X-Paperdesk-Token': self.app.TOKEN,
                    'X-Paperdesk-Filename': 'large.png'})
            with urllib.request.urlopen(request) as response:
                self.assertTrue(json.load(response)['appearance']['has_image'])
            self.assertEqual(self.app.APPEARANCE.image(), (large_png, 'image/png'))
        finally:
            http.shutdown()
            http.server_close()
            worker.join()


if __name__ == '__main__':
    unittest.main()
