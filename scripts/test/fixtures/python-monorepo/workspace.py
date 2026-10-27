import json
import os
from pathlib import Path
import sys
import venv

context = json.loads(os.environ["ALIGNFIRST_CONTEXT"])
root = Path(context["currentWorktree"])
action = sys.argv[1]

if action == "finalize":
    venv.EnvBuilder(with_pip=False).create(root / ".venv")
    data = root / ".local-wt" / "data"
    data.mkdir(exist_ok=True)
    (data / "identity.json").write_text(json.dumps(context))
elif action == "content":
    print(json.dumps({"local": "seed"}))
elif action == "patch":
    value = json.load(sys.stdin)
    value.update(name=context["name"], port=context["ports"]["api"])
    print(json.dumps(value, sort_keys=True))
elif action == "summary":
    print("Python workspace " + context["name"])
else:
    raise ValueError(action)
