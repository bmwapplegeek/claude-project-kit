#!/usr/bin/env bash
# The ONE entry point for every project-kit Claude Code hook, in both installs:
#   repo:   bash "$CLAUDE_PROJECT_DIR/.claude/kit/lib/hooks/run.sh" <event>
#   plugin: bash "${CLAUDE_PLUGIN_ROOT}/lib/hooks/run.sh" <event> "${CLAUDE_PLUGIN_DATA}"
# Events: pre-bash (PreToolUse, matcher Bash) | session-start | githooks (repo only).
#
# NO DOUBLE FIRING: when this copy is the plugin and the session's repo has the kit installed
# (.claude/kit/installed.json at the project dir or at its git top level), the plugin steps aside and exits 0:
# the repo's own pinned copy runs instead, with the layers that repo chose. So each check runs exactly once.
#
# Fails open: no node, unknown event or any error -> exit 0 (never blocks a session or a command by accident).
# What could not run is appended to <state>/hook-errors.log.
EVENT="${1:-}"
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIT_HOME="$(dirname "$LIB")"
PROJ="${CLAUDE_PROJECT_DIR:-$PWD}"

if [ -f "$KIT_HOME/installed.json" ]; then MODE=repo; else MODE=plugin; fi
if [ "$MODE" = plugin ]; then
  if [ -f "$PROJ/.claude/kit/installed.json" ]; then cat >/dev/null 2>&1; exit 0; fi
  TOP="$(git -C "$PROJ" rev-parse --show-toplevel 2>/dev/null)"
  if [ -n "$TOP" ] && [ -f "$TOP/.claude/kit/installed.json" ]; then cat >/dev/null 2>&1; exit 0; fi
  [ -n "${2:-}" ] && export PROJECT_KIT_DATA="$2"
fi

log_error() {
  local dir="${PROJECT_KIT_STATE:-}"
  if [ -z "$dir" ]; then
    if [ "$MODE" = repo ]; then dir="$KIT_HOME/state"
    else dir="${PROJECT_KIT_DATA:-${CLAUDE_PLUGIN_DATA:-${XDG_STATE_HOME:-$HOME/.local/state}/project-kit}}"; fi
  fi
  { mkdir -p "$dir" && printf '%s run.sh %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"$dir/hook-errors.log"; } 2>/dev/null
}

if ! command -v node >/dev/null 2>&1; then
  cat >/dev/null 2>&1
  log_error "node not found on PATH: project-kit hooks skipped ($EVENT)"
  exit 0
fi
export PROJECT_KIT_MODE="$MODE" PROJECT_KIT_HOME="$KIT_HOME"

case "$EVENT" in
  pre-bash)
    node "$LIB/bash-guard/bash-guard.mjs"
    rc=$?
    # 0 = allow, 2 = block. Anything else is a crash: allow, and say so in the log.
    if [ "$rc" -ne 0 ] && [ "$rc" -ne 2 ]; then log_error "bash-guard exited $rc (allowed)"; exit 0; fi
    exit "$rc" ;;
  session-start) cat >/dev/null 2>&1; node "$LIB/session-start.mjs" || log_error "session-start exited $?"; exit 0 ;;
  githooks)      cat >/dev/null 2>&1; [ "$MODE" = repo ] && { node "$LIB/session-start.mjs" githooks || log_error "githooks exited $?"; }; exit 0 ;;
  *)             cat >/dev/null 2>&1; log_error "unknown event '$EVENT'"; exit 0 ;;
esac
