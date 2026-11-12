"""One proxy client key per node, rotated with overlap and revoked with the node.

The key ring is a private JSON document in the proxy's secrets
(`state/secrets/client-keys.json`): per node, the current key and, during a
rotation, the previous one. The proxy accepts every key in the ring
(`api_keys`), so a rotation adds the new key, every node moves to it, and
only then is the old key retired: no request fails in between. Revoking a
node removes its keys and leaves every other node working. Reports name keys
only by a short fingerprint, never by value.
"""
import hashlib
import json
import os
import pathlib
import re
import secrets

NODE = re.compile(r'^[a-z][a-z0-9-]{0,62}$')


def fingerprint(key):
    return hashlib.sha256(key.encode()).hexdigest()[:12]


def load(path):
    try:
        ring = json.loads(pathlib.Path(path).read_text())
    except (OSError, ValueError):
        return {'version': 1, 'nodes': {}}
    if not isinstance(ring, dict) or ring.get('version') != 1:
        raise ValueError('Unsupported client key ring')
    return ring


def save(path, ring):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    staged = path.with_suffix('.new')
    staged.write_text(json.dumps(ring, indent=2, sort_keys=True) + '\n')
    os.chmod(staged, 0o600)
    os.replace(staged, path)


def _node(ring, node):
    if not NODE.match(node):
        raise ValueError('Invalid node id')
    return ring['nodes'].setdefault(node, {'current': None, 'previous': None})


def issue(ring, node, generate=lambda: secrets.token_urlsafe(32)):
    """Gives `node` a key when it has none; returns its current key."""
    entry = _node(ring, node)
    if not entry['current']:
        entry['current'] = generate()
    return entry['current']


def rotate(ring, node, generate=lambda: secrets.token_urlsafe(32)):
    """Starts a rotation: a new current key, the old one kept as previous
    until `retire`. Both are accepted meanwhile."""
    entry = _node(ring, node)
    if entry['previous']:
        raise ValueError('A rotation of this node is already in progress; retire it first')
    entry['previous'], entry['current'] = entry['current'], generate()
    return entry['current']


def retire(ring, node):
    """Ends a rotation once the node uses its new key."""
    _node(ring, node)['previous'] = None


def revoke(ring, node):
    """Removes every key of `node`."""
    ring['nodes'].pop(node, None)


def api_keys(ring, shared=()):
    """Every key the proxy accepts: the ring's, plus `shared` keys still in
    use (the fleet-wide key, until each node has its own)."""
    keys = list(shared)
    for node in sorted(ring['nodes']):
        entry = ring['nodes'][node]
        for key in (entry['current'], entry['previous']):
            if key and key not in keys:
                keys.append(key)
    return keys


def report(ring):
    """Per node: the current key's fingerprint and whether a rotation is
    still waiting to be retired. No key value."""
    return {
        node: {
            'current': fingerprint(entry['current']) if entry['current'] else None,
            'rotating': bool(entry['previous']),
        }
        for node, entry in sorted(ring['nodes'].items())
    }
