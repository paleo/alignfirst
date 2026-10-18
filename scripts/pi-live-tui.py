"""Opt-in real Pi terminal lifecycle probe; invoked by pi-live-runner.mjs."""

import errno
import fcntl
import glob
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

config = json.loads(open(sys.argv[1], encoding="utf8").read())
pid, terminal = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execv(config["argv"][0], config["argv"])

fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))
started = time.monotonic()
prompted = False
acknowledged = False
requested = False
finished = False
fixture_pid = None
exit_status = None
reload_ready = False
recent_output = b""
last_output = started


def alive(target):
    try:
        stat = open(f"/proc/{target}/stat", encoding="utf8").read()
        return stat.rsplit(") ", 1)[1].split()[0] != "Z"
    except FileNotFoundError:
        return False


def has_acknowledgement():
    for path in glob.glob(config["sessions"] + "/**/*.jsonl", recursive=True):
        if not path.endswith("_" + config["sessionId"] + ".jsonl"):
            continue
        with open(path, encoding="utf8") as stream:
            for line in stream:
                entry = json.loads(line)
                message = entry.get("message", {})
                if message.get("role") != "assistant" or message.get("stopReason") != "stop":
                    continue
                text = "\n".join(block.get("text", "") for block in message["content"])
                if text.strip() == "CLI-ACK":
                    return True
    return False


try:
    while time.monotonic() - started < 180:
        ready, _, _ = select.select([terminal], [], [], 0.05)
        if ready:
            try:
                output = os.read(terminal, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                output = b""
            last_output = time.monotonic()
            recent_output = (recent_output + output)[-65536:]
            if b"Reloaded keybindings" in recent_output:
                reload_ready = True
            for query, answer in [
                (b"\x1b[6n", b"\x1b[1;1R"),
                (b"\x1b[?u", b"\x1b[?0u"),
                (b"\x1b[c", b"\x1b[?1;2c"),
                (b"\x1b[>c", b"\x1b[>0;0;0c"),
                (b"\x1b]10;?", b"\x1b]10;rgb:ffff/ffff/ffff\x07"),
                (b"\x1b]11;?", b"\x1b]11;rgb:0000/0000/0000\x07"),
                (b"\x1b[?2026$p", b"\x1b[?2026;2$y"),
            ]:
                if query in output:
                    os.write(terminal, answer)
        if not prompted and time.monotonic() - started > 3 and time.monotonic() - last_output > 0.3:
            os.write(terminal, config["prompt"].encode() + b"\r")
            prompted = True
        if not acknowledged and os.path.exists(config["pidfile"]) and has_acknowledgement():
            fixture_pid = int(open(config["pidfile"], encoding="utf8").read())
            acknowledged = True
            os.write(terminal, b"/reload\r" if config["operation"] == "reload" else b"\x04")
            requested = True
        if acknowledged and config["operation"] == "reload" and reload_ready and not alive(fixture_pid) and not finished:
            os.write(terminal, b"\x04")
            finished = True
        exited, status = os.waitpid(pid, os.WNOHANG)
        if exited:
            exit_status = os.waitstatus_to_exitcode(status)
            break
    evidence = {"operation": config["operation"], "parentPid": pid, "fixturePid": fixture_pid,
                "acknowledged": acknowledged, "requested": requested, "reloadReady": reload_ready, "exitCode": exit_status,
                "fixtureGone": fixture_pid is not None and not alive(fixture_pid)}
    with open(config["evidence"], "w", encoding="utf8") as stream:
        json.dump(evidence, stream, indent=2)
    assert acknowledged and requested and exit_status == 0 and evidence["fixtureGone"], evidence
finally:
    if exit_status is None:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            exited, _ = os.waitpid(pid, os.WNOHANG)
            if exited:
                break
            time.sleep(0.05)
        else:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        if fixture_pid is not None and alive(fixture_pid):
            os.kill(fixture_pid, signal.SIGKILL)
    os.close(terminal)
