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


# ── Account state ────────────────────────────────────────────────────────────
#
# One state per credential, from its file (never a token, only whether one is
# there and when the access token expires) and from the proxy's management
# API, which knows about refreshes, cooldowns and disabled credentials.

STATES = ('usable', 'cooling-down', 'needs-login', 'refresh-failing', 'removed')

# A refresh the provider refused for good: only a new sign-in helps.
REJECTED = re.compile(r'invalid_grant|invalid_token|unauthorized|revoked|refresh token (?:is )?(?:invalid|expired|rejected|reused)', re.I)


def _instant(value):
    """Seconds since the epoch from an ISO 8601 string or a number, or None."""
    import datetime
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
        return float(value) / (1000 if value > 1e11 else 1)
    if isinstance(value, str) and value and not value.startswith('0001-'):
        try:
            parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=datetime.timezone.utc)
        return parsed.timestamp()
    return None


def iso(seconds):
    import datetime
    return datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def classify(credential, entry, now):
    """(state, until): `credential` is the auth file, `entry` what the
    management API says about it (None when it does not list it). `until` is
    when a cooldown clears, as epoch seconds, or None."""
    entry = entry or {}
    if entry.get('disabled') is True or credential.get('disabled') is True:
        return 'removed', None
    message = str(entry.get('status_message') or entry.get('last_error') or '')
    expires = _instant(credential.get('expired') or credential.get('expiry'))
    expired = expires is not None and expires <= now
    has_refresh = bool(credential.get('refresh_token'))
    if REJECTED.search(message) or (expired and not has_refresh):
        return 'needs-login', None
    if entry.get('status') == 'error' and 'refresh' in message.lower():
        return ('needs-login' if expired else 'refresh-failing'), None
    quota = entry.get('quota') if isinstance(entry.get('quota'), dict) else {}
    until = max(
        [t for t in (_instant(entry.get('next_retry_after')),
                     _instant(quota.get('next_recover_at'))) if t is not None and t > now]
        or [0]
    )
    if until or entry.get('unavailable') is True or quota.get('exceeded') is True:
        return 'cooling-down', (until or None)
    return 'usable', None


def credentials(auths):
    """[(file name, credential)] for every readable credential, in a stable
    order: by provider, then sign-in email, then file name. Each provider's
    accounts are numbered in this order, the same order every node lists
    them in (src/agents/accounts.ts), so an index means one account
    everywhere."""
    found = []
    for path in pathlib.Path(auths).glob('*.json'):
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and isinstance(data.get('type'), str):
            found.append((path.name, data))
    email = lambda data: data.get('email') if isinstance(data.get('email'), str) else ''
    return sorted(found, key=lambda item: (item[1]['type'], email(item[1]), item[0]))


def roster(auths, entries=(), now=None):
    """Every provider account: provider, opaque index (1, 2, … per provider),
    label, state and, while cooling down, when it clears. `entries` is the
    management API's list of auth files. Never a token."""
    import time
    now = time.time() if now is None else now
    by_name = {e.get('name'): e for e in entries if isinstance(e, dict)}
    counters = {}
    result = []
    for name, credential in credentials(auths):
        provider = credential['type']
        counters[provider] = counters.get(provider, 0) + 1
        state, until = classify(credential, by_name.get(name), now)
        email = credential.get('email')
        result.append({
            'provider': provider,
            'index': counters[provider],
            'label': email if isinstance(email, str) else provider + '-' + str(counters[provider]),
            'prefix': prefix(provider, email),
            'state': state,
            'until': iso(until) if until else None,
            'file': name,
        })
    return result


def version(accounts):
    """The roster version: a digest of the non-secret metadata of the accounts
    every node offers (their routing prefixes). Every node computes the same
    digest from the proxy's model list (src/accounts/roster.ts)."""
    import hashlib
    prefixes = sorted({a['prefix'] for a in accounts if a.get('prefix') and a.get('state') != 'removed'})
    return hashlib.sha256('\n'.join(prefixes).encode()).hexdigest()[:16]


def public(accounts):
    """The roster as reported: no file name."""
    return [{k: v for k, v in a.items() if k != 'file'} for a in accounts]


def find(accounts, provider, index):
    """The one account `provider` `index` names, or None."""
    for account in accounts:
        if account['provider'] == provider and account['index'] == index:
            return account
    return None


# ── Sign-in, re-login and removal ────────────────────────────────────────────
#
# A login writes into a staging directory, never into the auth directory. Only
# a complete credential (readable JSON with a type) is moved in, with one
# rename, so an interrupted login leaves no half-written auth file.

def staging(auths):
    return pathlib.Path(auths).parent / 'auths-staging'


def begin(auths):
    """A fresh, empty staging directory; leftovers of an interrupted login are
    discarded."""
    import shutil
    stage = staging(auths)
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(mode=0o700, parents=True)
    return stage


def adopt(stage, auths, replace=None):
    """Moves every complete credential from `stage` into `auths` and returns
    their file names. `replace` (a file name) is the credential a re-login
    signs in again: it is replaced by the new one in the same rename. The
    staging directory is removed whatever happens."""
    import os
    import shutil
    stage, auths = pathlib.Path(stage), pathlib.Path(auths)
    adopted = []
    try:
        complete = []
        for path in sorted(stage.glob('*.json')):
            try:
                data = json.loads(path.read_text())
            except (OSError, ValueError):
                continue
            if isinstance(data, dict) and isinstance(data.get('type'), str):
                complete.append(path)
        if replace and len(complete) != 1:
            raise ValueError('A re-login must produce exactly one credential')
        for path in complete:
            target = auths / (replace or path.name)
            os.chmod(path, 0o600)
            os.replace(path, target)
            adopted.append(target.name)
        if replace and adopted and adopted[0] != replace:
            (auths / replace).unlink(missing_ok=True)
        return adopted
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def remove(auths, provider, index):
    """Deletes the credential of one account; returns its file name."""
    account = find(roster(auths), provider, index)
    if account is None:
        raise ValueError('No such account')
    (pathlib.Path(auths) / account['file']).unlink()
    return account['file']


# ── Refresh tokens across checkpoints ────────────────────────────────────────
#
# Providers rotate refresh tokens. Each checkpoint records a short digest of
# every credential's refresh token (never the token). After a restore, a
# credential whose digest differs from the newest checkpoint's carries a
# token the provider has already replaced: that account needs a new login.

def token_digests(auths):
    import hashlib
    digests = {}
    for name, credential in credentials(auths):
        token = credential.get('refresh_token')
        if isinstance(token, str) and token:
            digests[name] = hashlib.sha256(token.encode()).hexdigest()[:16]
    return digests


def stale_after_restore(auths, newest):
    """[(provider, index)] of the restored accounts whose refresh token is
    older than the one `newest` (the token digests of the newest checkpoint)
    records."""
    current = token_digests(auths)
    stale = []
    for account in roster(auths):
        name = account['file']
        if name in newest and name in current and current[name] != newest[name]:
            stale.append((account['provider'], account['index']))
    return stale
