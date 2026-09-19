#!/usr/bin/env bash
#
# Pushes the heartbeat checklist from the seed snapshot (infra/openclaw/heartbeat-scratch.md) into
# the scratch of the system-owned `heartbeat:main` cron job when the two differ. Idempotent: an
# unchanged scratch is left alone. Needs the gateway running: cron commands go through it.
#
# Run as the service account:
#   sudo -i -u {{SERVICE_USER}} -- /home/{{SERVICE_USER}}/seed/bin/apply-heartbeat-scratch.sh

set -euo pipefail

SOURCE_FILE="$HOME/seed/heartbeat-scratch.md"
JOB_ID=
CURRENT_REVISION=
CURRENT_CONTENT=

main() {
  check_preconditions
  find_heartbeat_job
  read_current_scratch
  if [ "$CURRENT_CONTENT" = "$(cat "$SOURCE_FILE")" ]; then
    echo "[apply-heartbeat-scratch] unchanged (job $JOB_ID, revision $CURRENT_REVISION)"
    return
  fi
  push_scratch
}

check_preconditions() {
  if [ "$(id -un)" != "{{SERVICE_USER}}" ]; then
    echo "Run as {{SERVICE_USER}}: sudo -i -u {{SERVICE_USER}} -- ~/seed/bin/apply-heartbeat-scratch.sh" >&2
    exit 1
  fi
  if [ ! -f "$SOURCE_FILE" ]; then
    echo "No heartbeat scratch at $SOURCE_FILE — refresh the seed snapshot first." >&2
    exit 1
  fi
}

# The gateway derives the job from agents.defaults.heartbeat.every at its first start; its id is
# stable across restarts, its declaration key identifies it in the listing.
find_heartbeat_job() {
  JOB_ID=$(openclaw cron list --all --json | node -e '
    const listing = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const jobs = Array.isArray(listing) ? listing : listing.jobs;
    const job = jobs.find((entry) => entry.declarationKey === "heartbeat:main");
    if (!job) {
      console.error("[apply-heartbeat-scratch] no heartbeat:main job; has the gateway started once?");
      process.exit(1);
    }
    console.log(job.id);
  ')
}

# One read gives the content to compare and the revision the push is conditioned on, so a scratch
# rewritten between the read and the push is reported instead of overwritten.
read_current_scratch() {
  local result
  result=$(openclaw cron scratch "$JOB_ID" --json)
  CURRENT_REVISION=$(printf '%s' "$result" | node -e '
    const result = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    console.log(result.currentRevision ?? 0);
  ')
  CURRENT_CONTENT=$(printf '%s' "$result" | node -e '
    const result = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    process.stdout.write(result.scratch?.content ?? "");
  ')
}

push_scratch() {
  openclaw cron scratch "$JOB_ID" --file "$SOURCE_FILE" --expected-revision "$CURRENT_REVISION" \
    >/dev/null
  echo "[apply-heartbeat-scratch] pushed $SOURCE_FILE (job $JOB_ID, was revision $CURRENT_REVISION)"
}

main "$@"
