"""A fencing lease on the proxy state: only its holder is the writer.

Providers rotate refresh tokens, so two proxies started from the same
checkpoint spend each other's tokens. The lease is one small JSON document in
a store both would see (the checkpoint bucket in production, a directory in
tests): the holder, a fencing epoch that only ever grows, and when it
expires. A proxy that cannot take the lease refuses to start as writer.
"""
import json
import os
import pathlib
import time

TTL = 120


class Held(Exception):
    """Another proxy holds the lease."""

    def __init__(self, holder, expires):
        super().__init__('The proxy state lease is held by another proxy')
        self.holder = holder
        self.expires = expires


class DirectoryStore:
    """A lease document in a directory, replaced with one rename. `put`
    writes only when the document is still the one `get` returned."""

    def __init__(self, directory):
        self.path = pathlib.Path(directory) / 'proxy-lease.json'

    def get(self):
        try:
            return json.loads(self.path.read_text())
        except (OSError, ValueError):
            return None

    def put(self, document, expected):
        import fcntl
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.path.with_suffix('.lock'), 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if self.get() != expected:
                return False
            staged = self.path.with_suffix('.new')
            staged.write_text(json.dumps(document) + '\n')
            os.replace(staged, self.path)
            return True


def acquire(store, holder, now=None, ttl=TTL):
    """Takes or renews the lease for `holder`; returns its fencing epoch.
    Raises Held while another holder's lease has not expired. Taking over an
    expired lease increases the epoch, so the old holder's writes are fenced."""
    now = time.time() if now is None else now
    current = store.get()
    if current and current.get('holder') != holder and current.get('expires', 0) > now:
        raise Held(current.get('holder'), current.get('expires'))
    epoch = (current or {}).get('epoch', 0)
    if not current or current.get('holder') != holder:
        epoch += 1
    document = {'holder': holder, 'epoch': epoch, 'expires': now + ttl}
    if not store.put(document, current):
        raise Held(None, None)
    return epoch


def valid(store, holder, epoch, now=None):
    """Whether `holder` still holds the lease at `epoch`: checked before a
    token refresh is written."""
    now = time.time() if now is None else now
    current = store.get() or {}
    return current.get('holder') == holder and current.get('epoch') == epoch and current.get('expires', 0) > now


def release(store, holder):
    current = store.get()
    if current and current.get('holder') == holder:
        store.put({**current, 'expires': 0}, current)
