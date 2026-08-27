#!/bin/sh

validate_coding_agent() {
  require_environment ALIGNFIRST_CODE_AGENT
  if [ "$ALIGNFIRST_CODE_AGENT" != "claude" ]; then
    echo "ALIGNFIRST_CODE_AGENT must be claude for the selected overlay." >&2
    exit 1
  fi
  command -v claude >/dev/null 2>&1 || {
    echo "Claude Code is not installed for the service user." >&2
    exit 1
  }
}

configure_coding_agent() {
  merge_global_instructions "$HOME/.claude/CLAUDE.md" \
    "$script_dir/coding-agent/CLAUDE.md" "alignfirst-developer"
}

merge_global_instructions() {
  target_file=$1
  source_file=$2
  block_name=$3
  target_dir=$(dirname -- "$target_file")
  begin_marker="<!-- $block_name:start -->"
  end_marker="<!-- $block_name:end -->"

  install -d -m 0700 "$target_dir"
  temporary_file=$(mktemp "$target_dir/.instructions.XXXXXX")
  if [ -f "$target_file" ]; then
    sed "/^$begin_marker\$/,/^$end_marker\$/d" "$target_file" >"$temporary_file"
  fi
  if [ -s "$temporary_file" ]; then printf '\n' >>"$temporary_file"; fi
  printf '%s\n' "$begin_marker" >>"$temporary_file"
  cat "$source_file" >>"$temporary_file"
  printf '%s\n' "$end_marker" >>"$temporary_file"
  install -m 0600 "$temporary_file" "$target_file"
  rm -f "$temporary_file"
}
