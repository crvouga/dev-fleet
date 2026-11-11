#!/usr/bin/env python3
"""Offline syntax/config checks; no cloud access or running deployment required."""

import sys

sys.dont_write_bytecode = True


import ast
import json
import pathlib
import re
import subprocess

root = pathlib.Path(__file__).resolve().parent.parent
for directory in ["scripts", "clients", "tests"]:
    for path in (root / directory).rglob("*"):
        if not path.is_file() or "__pycache__" in path.parts:
            continue
        data = path.read_text()
        if path.suffix == ".py" or data.startswith("#!/usr/bin/env python3"):
            ast.parse(data, filename=str(path))
        elif data.startswith("#!/usr/bin/env bash") or data.startswith("#!/bin/bash"):
            subprocess.run(["bash", "-n", str(path)], check=True)
images = json.loads((root / "image.lock.json").read_text())
assert all(
    re.fullmatch(r"[a-z0-9/.-]+@sha256:[0-9a-f]{64}", image)
    for image in images.values()
)
sys.path.insert(0, str(root / "scripts"))
from modelhealth import config as model_config

model_config.load(root / "models.json")  # declarative model-health contract
print("Python/shell syntax, immutable image pins and models.json passed.")
