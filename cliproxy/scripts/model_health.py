#!/usr/bin/env python3
"""Entry point for `personal infra-cliproxy model-health` and `model-suite`."""

import sys

sys.dont_write_bytecode = True

import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from modelhealth import cli

if __name__ == "__main__":
    command, *arguments = sys.argv[1:] or ["model-health"]
    raise SystemExit(cli.main(arguments, "nightly" if command == "model-suite" else "light"))
