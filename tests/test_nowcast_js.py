import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js not installed")
def test_nowcast_engine():
    test = Path(__file__).with_name("nowcast.test.js")
    result = subprocess.run(["node", str(test)], capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stderr + result.stdout
