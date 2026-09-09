"""Check the installed CLI without accessing a user's credentials or network."""

import json
import os
import subprocess
import tempfile


with tempfile.TemporaryDirectory(prefix="gitmind-smoke-") as home:
    env = {"PATH": os.environ["PATH"], "HOME": home, "GITMIND_CONFIG_DIR": home}
    subprocess.run(["gitmind", "--help"], env=env, check=True, stdout=subprocess.DEVNULL)
    subprocess.run(
        ["/usr/local/lib/gitmind/.venv/bin/python", "-c", "import gmind, oss2"],
        env=env,
        check=True,
    )
    result = subprocess.run(
        ["gitmind", "doctor", "--json"], env=env, capture_output=True, text=True
    )
    status = json.loads(result.stdout)
    assert result.returncode == 1, "Unauthenticated doctor must fail"
    assert status["ok"] is False
    assert status["auth"]["available"] is False
    assert status["auth"]["source"] is None
    assert status["endpoint"]["reachable"] is False
    assert status["error"].startswith("missing auth")
    print(json.dumps({"installed": True, "version": status["version"], "authenticated": False}))
