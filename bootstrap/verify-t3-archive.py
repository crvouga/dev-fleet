"""Verify the pinned T3 archive against its user-owned installation.

Release-builder numeric identities are not portable. All installed members must
instead belong to the invoking development user; content, modes and links must
still match. This reads the archive and installation without modifying either.
"""
import os
from pathlib import Path
import stat
import sys
import tarfile


def verify(archive, root):
    root = Path(root).resolve()
    with tarfile.open(archive, 'r:gz') as source:
        for member in source:
            path = root / member.name
            if not path.parent.resolve().is_relative_to(root):
                return False
            observed = path.lstat()
            if observed.st_uid != os.getuid():
                return False
            if member.issym():
                if not stat.S_ISLNK(observed.st_mode) or os.readlink(path) != member.linkname:
                    return False
            elif member.isdir():
                if not stat.S_ISDIR(observed.st_mode):
                    return False
            elif member.isfile():
                if not stat.S_ISREG(observed.st_mode) or observed.st_size != member.size:
                    return False
                if stat.S_IMODE(observed.st_mode) != member.mode:
                    return False
                with source.extractfile(member) as expected, path.open('rb') as actual:
                    while chunk := expected.read(1024 * 1024):
                        if actual.read(len(chunk)) != chunk:
                            return False
            else:
                return False
    return True


if __name__ == '__main__':
    try:
        valid = verify(sys.argv[1], sys.argv[2])
    except (OSError, ValueError, tarfile.TarError):
        valid = False
    sys.exit(0 if valid else 1)
