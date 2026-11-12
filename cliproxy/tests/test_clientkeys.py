import importlib.util
import json
import pathlib
import tempfile
import unittest

PACKAGE = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('clientkeys', PACKAGE / 'scripts/clientkeys.py')
clientkeys = importlib.util.module_from_spec(spec)
spec.loader.exec_module(clientkeys)


def counter():
    values = iter('k%031d' % n for n in range(1, 100))
    return lambda: next(values)


class ClientKeys(unittest.TestCase):
    def test_a_rotation_keeps_the_old_key_accepted_until_it_is_retired(self):
        ring, generate = {'version': 1, 'nodes': {}}, counter()
        old = clientkeys.issue(ring, 'worker-one', generate)
        new = clientkeys.rotate(ring, 'worker-one', generate)
        # A running agent still holds the old key: it keeps working.
        self.assertEqual(set(clientkeys.api_keys(ring)), {old, new})
        self.assertTrue(clientkeys.report(ring)['worker-one']['rotating'])
        clientkeys.retire(ring, 'worker-one')
        self.assertEqual(clientkeys.api_keys(ring), [new])

    def test_revoking_one_node_leaves_the_others_working(self):
        ring, generate = {'version': 1, 'nodes': {}}, counter()
        one = clientkeys.issue(ring, 'worker-one', generate)
        two = clientkeys.issue(ring, 'worker-two', generate)
        clientkeys.revoke(ring, 'worker-one')
        self.assertEqual(clientkeys.api_keys(ring, ['shared' * 6]), ['shared' * 6, two])
        self.assertNotIn(one, clientkeys.api_keys(ring))

    def test_issuing_is_idempotent_and_a_second_rotation_waits(self):
        ring, generate = {'version': 1, 'nodes': {}}, counter()
        self.assertEqual(clientkeys.issue(ring, 'worker-one', generate), clientkeys.issue(ring, 'worker-one', generate))
        clientkeys.rotate(ring, 'worker-one', generate)
        with self.assertRaises(ValueError):
            clientkeys.rotate(ring, 'worker-one', generate)

    def test_the_report_and_the_saved_ring_are_private(self):
        ring, generate = {'version': 1, 'nodes': {}}, counter()
        key = clientkeys.issue(ring, 'worker-one', generate)
        self.assertNotIn(key, json.dumps(clientkeys.report(ring)))
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'client-keys.json'
            clientkeys.save(path, ring)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(clientkeys.load(path), ring)
