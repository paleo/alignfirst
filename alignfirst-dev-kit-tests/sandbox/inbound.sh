#!/usr/bin/env bash
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "inbound.sh requires jq on the host." >&2
  exit 1
fi

if [[ $# -lt 3 || $# -gt 4 ]]; then
  echo "usage: sandbox/inbound.sh <channel> <conversation-id> <text> [thread-id]" >&2
  exit 1
fi

channel=$1
conversation_id=$2
message_text=$3
thread_id=${4-}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
project_dir=$(dirname "$script_dir")

jq -n \
  --arg accountId "$channel" \
  --arg conversationId "$conversation_id" \
  --arg title "$conversation_id" \
  --arg senderId "ROBIN01" \
  --arg senderName "Robin" \
  --arg text "$message_text" \
  --arg threadId "$thread_id" \
  '{
    accountId: $accountId,
    conversation: { kind: "channel", id: $conversationId, title: $title },
    senderId: $senderId,
    senderName: $senderName,
    text: $text
  } + if $threadId == "" then {} else { threadId: $threadId } end' |
  docker compose -p alignfirst-dev-kit-tests-w1 --project-directory "$project_dir" exec -T gateway \
    curl -sS -X POST -H 'content-type: application/json' --data-binary @- \
      http://bus:43123/v1/inbound/message
