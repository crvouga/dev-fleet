"""Credential and prompt redaction for every diagnostic that leaves the process."""

import re

_PATTERNS = [
    (re.compile(r"(?i)(bearer\s+)[^\s\"']+"), r"\1[REDACTED]"),
    (re.compile(r"(?:sk-|eyJ|hvs\.|hvb\.)[A-Za-z0-9_.-]{12,}"), "[REDACTED]"),
]


class Redactor:
    """Replaces every registered secret value and known token shape."""

    def __init__(self, secrets=()):
        self.secrets = sorted({s for s in secrets if s and len(s) >= 6}, key=len, reverse=True)

    def add(self, secret):
        if secret and len(secret) >= 6 and secret not in self.secrets:
            self.secrets = sorted(self.secrets + [secret], key=len, reverse=True)

    def __call__(self, text, limit=300):
        text = str(text)
        for secret in self.secrets:
            text = text.replace(secret, "[REDACTED]")
        for pattern, replacement in _PATTERNS:
            text = pattern.sub(replacement, text)
        text = " ".join(text.split())
        return text if len(text) <= limit else text[: limit - 1] + "…"
