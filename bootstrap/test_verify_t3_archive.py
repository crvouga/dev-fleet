"""Artifact integrity regression tests; no upstream downloads or live state."""
import importlib.util
import io
import os
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('verify', Path(__file__).with_name('verify-t3-archive.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ArchiveIntegrity(unittest.TestCase):
    def test_builder_identity_is_not_the_installation_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / 'release.tar.gz'
            installed = root / 'installed'
            installed.mkdir()
            (installed / 't3').write_bytes(b'pinned binary')
            (installed / 't3').chmod(0o755)
            with tarfile.open(archive, 'w:gz') as target:
                entry = tarfile.TarInfo('t3')
                entry.uid = os.getuid() + 1234
                entry.gid = os.getgid() + 1234
                entry.mode = 0o755
                entry.size = len(b'pinned binary')
                target.addfile(entry, io.BytesIO(b'pinned binary'))
            self.assertTrue(module.verify(archive, installed))
            (installed / 't3').chmod(0o644)
            self.assertFalse(module.verify(archive, installed))
            (installed / 't3').chmod(0o755)
            (installed / 't3').write_bytes(b'edited binary')
            self.assertFalse(module.verify(archive, installed))
            (installed / 't3').unlink()
            (root / 'outside').write_bytes(b'pinned binary')
            (installed / 't3').symlink_to(root / 'outside')
            self.assertFalse(module.verify(archive, installed))


if __name__ == '__main__':
    unittest.main()
