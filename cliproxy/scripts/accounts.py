"""Account routing: each signed-in provider account gets its own model prefix.

The proxy's credential files are the only source of truth for accounts. A
credential of a routed type is given the prefix `<type>-<email>`, so a client
that asks for `<type>-<email>/<model>` is served only by that account, and the
proxy's model list tells every client which accounts exist. Unprefixed models
keep using the whole fill-first pool.
"""
import json
import pathlib
import re

# Provider credential types that T3 offers once per account.
ROUTED = ('claude', 'codex', 'antigravity')


def prefix(kind, email):
    """The model prefix for one credential, or None when it is not routed."""
    if kind in ROUTED and isinstance(email, str) and re.fullmatch(r'[^\s@/]{1,64}@[^\s@/]{1,255}', email):
        return kind + '-' + email
    return None


def pending(auths):
    """[(credential file name, prefix)] for credentials without their prefix.
    Reads only type, email and prefix; never a token."""
    result = []
    for path in sorted(pathlib.Path(auths).glob('*.json')):
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        wanted = prefix(data.get('type'), data.get('email'))
        if wanted and data.get('prefix') != wanted:
            result.append((path.name, wanted))
    return result
