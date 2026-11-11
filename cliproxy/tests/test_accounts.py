import importlib.util
import json
import pathlib
import tempfile
import unittest

PACKAGE = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('accounts', PACKAGE / 'scripts/accounts.py')
accounts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(accounts)


class AccountRouting(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.auths = pathlib.Path(self.temp.name)

    def credential(self, name, **fields):
        (self.auths / name).write_text(json.dumps({'access_token': 'secret', **fields}))

    def test_prefix_is_derived_from_the_credential_itself(self):
        self.assertEqual(accounts.prefix('codex', 'a@example.com'), 'codex-a@example.com')
        self.assertIsNone(accounts.prefix('xai', 'a@example.com'))
        self.assertIsNone(accounts.prefix('claude', None))
        self.assertIsNone(accounts.prefix('claude', 'a/b@example.com'))

    def test_only_routed_credentials_without_their_prefix_are_pending(self):
        self.credential('claude-1.json', type='claude', email='a@example.com')
        self.credential('claude-2.json', type='claude', email='b@example.com', prefix='claude-b@example.com')
        self.credential('codex-1.json', type='codex', email='a@example.com', prefix='other')
        self.credential('xai-1.json', type='xai', email='a@example.com')
        self.credential('meta-1.json', type='meta')
        (self.auths / 'broken.json').write_text('{')
        self.assertEqual(accounts.pending(self.auths),
                         [('claude-1.json', 'claude-a@example.com'), ('codex-1.json', 'codex-a@example.com')])

    def test_no_account_is_named_in_tracked_source(self):
        self.assertFalse((PACKAGE / 'accounts.json').exists())
