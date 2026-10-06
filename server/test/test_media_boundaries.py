import importlib.util
from pathlib import Path
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1] / 'src'
def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

class NoticeTests(unittest.TestCase):
    def setUp(self):
        self.n = module('scoped_notice_ws_filter')
        self.n.BOT = '1000000004'
        self.n.PRIVATES = {'1000000001'}
        self.n.GROUPS = {'1000000003'}
        self.raw = dict(post_type='notice', notice_type='group_recall', self_id=self.n.BOT,
                        group_id='1000000003', user_id='1000000001', message_id='1', time=int(time.time()))
    def test_allowed_notice_scrubs_extra_fields(self):
        value = self.n.filter_notice({**self.raw, 'message': 'private content', 'url': 'https://example.invalid'})
        self.assertEqual(value, self.raw)
    def test_account_and_group_must_match(self):
        self.assertIsNone(self.n.filter_notice({**self.raw, 'self_id': '1000000002'}))
        self.assertIsNone(self.n.filter_notice({**self.raw, 'group_id': '1000000002'}))
    def test_message_content_is_never_forwarded(self):
        self.assertIsNone(self.n.filter_notice({**self.raw, 'post_type': 'message'}))

class CacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.r = module('cache_image_reader')
        self.r.HOST_QQ_ROOT = self.temp.name
        self.r.CONTAINER_QQ_ROOT = '/app/.config/QQ'
        self.relative = 'nt_qq_fixture/nt_data/Pic/test.png'
        target = Path(self.temp.name) / self.relative
        target.parent.mkdir(parents=True)
        target.write_bytes(b'synthetic-image-bytes')
        self.value = {'path': '/app/.config/QQ/' + self.relative, 'file_id': 'test.png'}
    def test_only_matching_scoped_file_can_be_read(self):
        self.assertEqual(self.r.read_image(self.value), b'synthetic-image-bytes')
        with self.assertRaises(self.r.ReaderFailure):
            self.r.read_image({**self.value, 'file_id': 'different.png'})
    def test_traversal_and_symlinks_are_refused(self):
        with self.assertRaises(self.r.ReaderFailure):
            self.r.read_image({**self.value, 'path': '/app/.config/QQ/../test.png'})
        target = Path(self.temp.name) / self.relative
        target.unlink()
        target.symlink_to('/etc/passwd')
        with self.assertRaises(OSError):
            self.r.read_image(self.value)
    def test_unconfigured_mount_is_refused(self):
        self.r.HOST_QQ_ROOT = ''
        with self.assertRaises(self.r.ReaderFailure):
            self.r.read_image(self.value)
