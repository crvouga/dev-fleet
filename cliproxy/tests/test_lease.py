import importlib.util
import pathlib
import tempfile
import unittest

PACKAGE = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('lease', PACKAGE / 'scripts/lease.py')
lease = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lease)


class ProxyStateLease(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = lease.DirectoryStore(self.temp.name)

    def test_a_second_proxy_on_the_same_state_refuses_to_start_as_writer(self):
        lease.acquire(self.store, 'manager', now=100)
        with self.assertRaises(lease.Held):
            lease.acquire(self.store, 'standby', now=150)

    def test_the_holder_renews_without_a_new_epoch(self):
        first = lease.acquire(self.store, 'manager', now=100)
        self.assertEqual(lease.acquire(self.store, 'manager', now=150), first)
        self.assertTrue(lease.valid(self.store, 'manager', first, now=200))

    def test_an_expired_lease_is_taken_over_and_the_old_holder_is_fenced(self):
        old = lease.acquire(self.store, 'manager', now=100)
        new = lease.acquire(self.store, 'standby', now=100 + lease.TTL + 1)
        self.assertGreater(new, old)
        self.assertFalse(lease.valid(self.store, 'manager', old, now=100 + lease.TTL + 2))
        self.assertTrue(lease.valid(self.store, 'standby', new, now=100 + lease.TTL + 2))

    def test_a_released_lease_is_free(self):
        lease.acquire(self.store, 'manager', now=100)
        lease.release(self.store, 'manager')
        self.assertEqual(lease.acquire(self.store, 'standby', now=101), 2)
