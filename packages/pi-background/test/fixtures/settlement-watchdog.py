"""Linux subreaper: bound a deliberately deadlocking public Pi call and reap its tree."""

import ctypes
import errno
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def main():
    node, probe, action, directory = sys.argv[1:]
    root = Path(directory)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "Cannot establish test subreaper")
    env = {
        "PATH": os.environ["PATH"],
        "HOME": directory,
        "XDG_CONFIG_HOME": str(root / "xdg"),
        "PI_CODING_AGENT_DIR": str(root / "agent"),
        "PI_CODING_AGENT_SESSION_DIR": str(root / "sessions"),
        "PI_OFFLINE": "1",
        "PI_SKIP_VERSION_CHECK": "1",
        "PI_TELEMETRY": "0",
    }
    observation = root / "observation.json"
    reaped = []
    killed = False
    evidence = None
    with (root / "stdout.log").open("wb") as out, (root / "stderr.log").open("wb") as err:
        process = subprocess.Popen(
            [node, probe, action], cwd=directory, env=env,
            stdin=subprocess.DEVNULL, stdout=out, stderr=err, start_new_session=True,
        )
        try:
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                if observation.exists():
                    evidence = json.loads(observation.read_text())
                    break
                if process.poll() is not None:
                    break
                time.sleep(0.02)
            if action == "control" and evidence is not None:
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass
        finally:
            # Kill the entire isolated group even if its leader already exited.
            try:
                os.killpg(process.pid, signal.SIGKILL)
                killed = True
            except ProcessLookupError:
                pass
            process.wait(timeout=2)
            reaped.append(process.pid)
            deadline = time.monotonic() + 3
            while True:
                try:
                    pid, _status = os.waitpid(-1, os.WNOHANG)
                    if pid > 0:
                        reaped.append(pid)
                        continue
                except ChildProcessError:
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError("Watchdog could not reap all adopted descendants")
                time.sleep(0.01)
    remaining = []
    for pid in [process.pid, *(evidence or {}).get("workerPids", [])]:
        try:
            os.kill(pid, 0)
            remaining.append(pid)
        except OSError as error:
            if error.errno != errno.ESRCH:
                raise
    print(json.dumps({
        "action": action,
        "evidence": evidence,
        "watchdogKilled": killed,
        "returnCode": process.returncode,
        "probePid": process.pid,
        "reaped": reaped,
        "remaining": remaining,
        "stdout": (root / "stdout.log").read_text()[-4096:],
        "stderr": (root / "stderr.log").read_text()[-4096:],
    }))
    if evidence is None or remaining:
        sys.exit(1)


if __name__ == "__main__":
    main()
