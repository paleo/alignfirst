import json
import os
from pathlib import Path
import signal
import sys

from shared import greeting


def describe(role):
    context = json.loads(os.environ["ALIGNFIRST_CONTEXT"])
    value = {
        "context": context,
        "cwd": os.getcwd(),
        "prefix": sys.prefix,
        "role": os.environ["APP_ROLE"],
        "message": greeting(role),
        "pid": os.getpid(),
    }
    path = Path(context["currentWorktree"]) / ".local-wt" / (role + ".json")
    path.write_text(json.dumps(value))
    return value


if __name__ == "__main__":
    describe("worker")
    print("WORKER_READY", flush=True)
    while True:
        signal.pause()
