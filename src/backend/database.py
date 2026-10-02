"""SQLite transactions that release their file handle when the block ends."""
import sqlite3


class Connection(sqlite3.Connection):
    def __exit__(self, *exception):
        try:
            return super().__exit__(*exception)
        finally:
            self.close()


def connect(*args, **kwargs):
    return sqlite3.connect(*args, factory=Connection, **kwargs)
