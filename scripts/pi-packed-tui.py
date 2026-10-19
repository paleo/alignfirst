"""Capture compact startup labels from an attached, prompt-free Pi terminal."""

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def capture_startup():
    pid, terminal = pty.fork()
    if pid == 0:
        os.execv(sys.argv[1], sys.argv[1:] + [
            "--offline", "--no-session", "--no-approve", "--no-skills",
            "--no-prompt-templates", "--no-context-files", "--tui-mode", "regular",
        ])
    output = bytearray()
    status = None
    quit_sent = False
    started = time.monotonic()
    last_output = started
    try:
        fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 240, 0, 0))
        while time.monotonic() - started < 25:
            ready, _, _ = select.select([terminal], [], [], 0.05)
            if ready:
                chunk = read_terminal(terminal)
                if chunk:
                    output.extend(chunk)
                    assert len(output) <= 1024 * 1024, "Terminal output exceeded 1 MiB"
                    last_output = time.monotonic()
                    answer_queries(terminal, chunk)
            if (not quit_sent and b"[Extensions]" in output
                    and time.monotonic() - last_output > 0.5):
                os.write(terminal, b"\x04")
                quit_sent = True
            exited, status = os.waitpid(pid, os.WNOHANG)
            if exited:
                assert quit_sent, output.decode(errors="replace")
                assert os.waitstatus_to_exitcode(status) == 0, output.decode(errors="replace")
                sys.stdout.buffer.write(output)
                return
            status = None
        raise AssertionError("Pi TUI startup watchdog expired:\n" + output.decode(errors="replace"))
    finally:
        if status is None:
            stop_and_reap(pid)
        os.close(terminal)


def read_terminal(terminal):
    try:
        return os.read(terminal, 65536)
    except OSError as error:
        if error.errno != errno.EIO:
            raise
        return b""


def answer_queries(terminal, chunk):
    for query, answer in [
        (b"\x1b[6n", b"\x1b[1;1R"),
        (b"\x1b[?u", b"\x1b[?0u"),
        (b"\x1b[c", b"\x1b[?1;2c"),
        (b"\x1b[>c", b"\x1b[>0;0;0c"),
        (b"\x1b]10;?", b"\x1b]10;rgb:ffff/ffff/ffff\x07"),
        (b"\x1b]11;?", b"\x1b]11;rgb:0000/0000/0000\x07"),
        (b"\x1b[?2026$p", b"\x1b[?2026;2$y"),
    ]:
        if query in chunk:
            os.write(terminal, answer)


def stop_and_reap(pid):
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if os.waitpid(pid, os.WNOHANG)[0]:
            return
        time.sleep(0.05)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.waitpid(pid, 0)


capture_startup()
