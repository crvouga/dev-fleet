"""Shared helpers for the model-health tests (not collected: no test_ prefix)."""

import contextlib
import copy
import json
import os
import pathlib
import sys
from unittest import mock

PACKAGE = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE / "scripts"))
sys.dont_write_bytecode = True

from modelhealth import config as configuration  # noqa: E402
from modelhealth import emulator as emulation  # noqa: E402
from modelhealth import runner, simulate  # noqa: E402

RAW = json.loads((PACKAGE / "models.json").read_text())
MODEL_IDS = [m["id"] for m in RAW["models"]]


def load(mutate=None):
    raw = copy.deepcopy(RAW)
    if mutate:
        mutate(raw)
    configuration.validate(raw)
    return configuration.Config(raw)


# Ambient settings a developer machine, CI job or T3 Code session may carry. The offline suite must
# neither depend on them nor leak them.
AMBIENT = ("CLIPROXY_API_KEY", "CLIPROXY_ROOT", "VAULT_TOKEN", "VAULT_ADDR", "GITHUB_STEP_SUMMARY",
           "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")


def hermetic_environment(**extra):
    """Process environment with ambient credentials and proxies removed (use with patch.dict semantics)."""
    patcher = mock.patch.dict(os.environ, {}, clear=False)
    patcher.start()
    for name in AMBIENT:
        os.environ.pop(name, None)
    os.environ.update(extra)
    return patcher


def child_environment(**extra):
    env = {k: v for k, v in os.environ.items() if k not in AMBIENT}
    env["NO_PROXY"] = "127.0.0.1,localhost"
    env.update(extra)
    return env


@contextlib.contextmanager
def served(model_ids=None, **options):
    emulator = emulation.Emulator(model_ids or MODEL_IDS, **options)
    base = emulator.start()
    try:
        yield emulator, base
    finally:
        emulator.stop()


def run(emulator, base, profile="nightly", config=None, key=None, **kwargs):
    config = config or load()
    scenarios = (lambda: simulate.run_all(config)) if kwargs.pop("simulations", False) else None
    return runner.run(config, profile, kwargs.pop("suite", "all"), base, key or emulator.key, "mock",
                      seed=kwargs.pop("seed", 3), simulate=scenarios, **kwargs)


def model(report, model_id):
    return next(m for m in report["models"] if m["id"] == model_id)
