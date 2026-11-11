import importlib.machinery
import importlib.util
import pathlib
import tempfile
import unittest

script = pathlib.Path(__file__).resolve().parents[1] / "scripts/public-endpoint"
loader = importlib.machinery.SourceFileLoader("public_endpoint", str(script))
spec = importlib.util.spec_from_loader(loader.name, loader)
endpoint = importlib.util.module_from_spec(spec)
loader.exec_module(endpoint)


class PublicCredential(unittest.TestCase):
    def test_atomic_refresh_keeps_private_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "token"
            self.assertTrue(endpoint.save_token(path, "first"))
            old = path.stat().st_ino
            # Unchanged: no rewrite, so a running connector is not recreated.
            self.assertFalse(endpoint.save_token(path, "first"))
            self.assertEqual(path.stat().st_ino, old)
            self.assertTrue(endpoint.save_token(path, "rotated"))
            self.assertEqual(path.read_text(), "rotated\n")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertNotEqual(path.stat().st_ino, old)
            for invalid in [None, "", "\n", "bad\ncredential"]:
                with self.assertRaises(ValueError):
                    endpoint.save_token(path, invalid)
                self.assertEqual(path.read_text(), "rotated\n")
