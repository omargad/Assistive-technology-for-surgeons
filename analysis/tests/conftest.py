"""Shared pytest configuration for the SurgeonPulse analysis toolkit."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ANALYSIS_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = ANALYSIS_DIR.parent
FIXTURES = REPO_ROOT / "fixtures"

# Fallback for runs that bypass pyproject's `pythonpath` (e.g. an IDE runner from another cwd).
for _p in (ANALYSIS_DIR / "src", ANALYSIS_DIR / "tests"):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))


@pytest.fixture(scope="session")
def fixtures_dir() -> Path:
    if not (FIXTURES / "manifest.json").is_file():
        pytest.skip("fixtures/manifest.json missing - run `npm run fixtures -w @surgeonpulse/core`")
    return FIXTURES
