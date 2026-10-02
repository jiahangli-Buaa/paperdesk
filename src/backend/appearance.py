"""Custom background stored with the local dashboard settings."""
from uuid import uuid4


DEFAULT_TRANSPARENCY = 70
DEFAULT_PANEL_TRANSPARENCY = 65
DEFAULT_SIDEBAR_TRANSPARENCY = 60
TRANSPARENCY_DEFAULTS = {
    'transparency': DEFAULT_TRANSPARENCY,
    'panel_transparency': DEFAULT_PANEL_TRANSPARENCY,
    'sidebar_transparency': DEFAULT_SIDEBAR_TRANSPARENCY,
}


class Appearance:
    def __init__(self, connect):
        self.connect = connect

    def initialize(self):
        with self.connect() as con:
            con.execute('''CREATE TABLE IF NOT EXISTS appearance (
                id INTEGER PRIMARY KEY CHECK(id=1), transparency INTEGER NOT NULL,
                image BLOB, image_type TEXT, image_name TEXT, image_id TEXT,
                panel_transparency INTEGER NOT NULL DEFAULT 65,
                sidebar_transparency INTEGER NOT NULL DEFAULT 60)''')
            columns = {row['name'] for row in con.execute('PRAGMA table_info(appearance)')}
            for key in ('panel_transparency', 'sidebar_transparency'):
                if key not in columns:
                    con.execute(f'ALTER TABLE appearance ADD COLUMN {key} INTEGER NOT NULL '
                                f'DEFAULT {TRANSPARENCY_DEFAULTS[key]}')
            con.execute('INSERT OR IGNORE INTO appearance(id,transparency) VALUES(1,?)',
                        (DEFAULT_TRANSPARENCY,))

    def state(self):
        with self.connect() as con:
            row = con.execute('''SELECT transparency,panel_transparency,sidebar_transparency,
                image_type,image_name,image_id
                FROM appearance WHERE id=1''').fetchone()
        return {**{key: row[key] for key in TRANSPARENCY_DEFAULTS},
                'has_image': bool(row['image_id']),
                'image_name': row['image_name'] or '',
                'image_url': '/api/background/image?v=' + row['image_id'] if row['image_id'] else ''}

    def image(self):
        with self.connect() as con:
            row = con.execute('SELECT image,image_type FROM appearance WHERE id=1').fetchone()
        return (row['image'], row['image_type']) if row['image'] else None

    def upload(self, data, filename):
        if not data:
            raise ValueError('请选择一张图片')
        if data.startswith(b'\x89PNG\r\n\x1a\n'):
            content_type = 'image/png'
        elif data.startswith(b'\xff\xd8\xff'):
            content_type = 'image/jpeg'
        elif data.startswith((b'GIF87a', b'GIF89a')):
            content_type = 'image/gif'
        elif data[:4] == b'RIFF' and data[8:12] == b'WEBP':
            content_type = 'image/webp'
        else:
            raise ValueError('支持 JPG、PNG、WebP 和 GIF 图片')
        name = filename.replace('\\', '/').rsplit('/', 1)[-1][:250] or '背景图片'
        with self.connect() as con:
            con.execute('UPDATE appearance SET image=?,image_type=?,image_name=?,image_id=? WHERE id=1',
                        (data, content_type, name, str(uuid4())))
        return {'ok': True, 'appearance': self.state(), 'message': '背景图片已保存'}

    def save(self, body):
        if body.get('reset') is True:
            with self.connect() as con:
                con.execute('''UPDATE appearance SET transparency=?,panel_transparency=?,
                    sidebar_transparency=?,image=NULL,image_type=NULL,
                    image_name=NULL,image_id=NULL WHERE id=1''',
                    tuple(TRANSPARENCY_DEFAULTS.values()))
            message = '已恢复默认背景'
        else:
            values = {key: body[key] for key in TRANSPARENCY_DEFAULTS if key in body}
            if not values or any(not isinstance(value, int) or isinstance(value, bool)
                                 or not 0 <= value <= 100 for value in values.values()):
                raise ValueError('透明度应在 0% 到 100% 之间')
            with self.connect() as con:
                assignments = ','.join(key + '=?' for key in values)
                con.execute(f'UPDATE appearance SET {assignments} WHERE id=1',
                            tuple(values.values()))
            message = '透明度已保存'
        return {'ok': True, 'appearance': self.state(), 'message': message}
