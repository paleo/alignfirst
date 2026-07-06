Under OpenClaw, background it through the `exec` tool:

- Pass `background: true` and `timeout: 0` (no kill timer). Never rely on the auto-yield or a finite timeout.
- Set the exec `workdir` to the project root as an **absolute** path (`~` is not expanded there), or `cd` into the project inside the command itself.
- The session-file path comes from the run's first stdout line (`Session file: …`), available via `process log <id>`. The stamp in the file name is the run's start time; it cannot be derived from the clock.
- If the outcome must be reported into a thread **you created yourself** via `message` `action: "thread-create"`, add `--meta "<THREAD_ID>"` with that thread's `chat_id`: the completion wake's plain reply goes to this session's default surface (the channel), and only the session file's `meta` can point your report back at the thread (via `message` `action: "thread-reply"`). In every other case omit `--meta` — platform-threaded replies and thread-bound sessions already report in the right place.
