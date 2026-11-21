#!/usr/bin/env bash
# Jobs layer: refuse a commit in the MAIN checkout when it is not on the base branch. The bash-guard rule
# main-dir-stays-on-main blocks this for agents; this catches commits made any other way.
# Owner-approved exception: JOB_ALLOW_MAIN_DIR=1 git commit ...
[ "${JOB_ALLOW_MAIN_DIR:-}" = "1" ] && exit 0
GD="$(git rev-parse --path-format=absolute --git-dir)" || exit 0
CD="$(git rev-parse --path-format=absolute --git-common-dir)" || exit 0
[ "$GD" = "$CD" ] || exit 0   # a linked worktree: free to commit
ROOT="$(git rev-parse --show-toplevel)"
BASE="$(node -e 'try{const c=require(process.argv[1]);process.stdout.write((c.jobs&&c.jobs.baseBranch)||"main")}catch{process.stdout.write("main")}' "$ROOT/.claude/project-kit.json" 2>/dev/null || echo main)"
BR="$(git symbolic-ref --quiet --short HEAD || echo '(detached)')"
if [ "$BR" != "$BASE" ]; then
  cat >&2 <<EOF

BLOCKED (project-kit jobs): this is the main checkout and it is on '$BR', not '$BASE'. Do your work in your own
worktree: node .claude/kit/lib/jobs/job.mjs start <type>/<slug>. If '$BR' is another session's branch, leave it
and tell the owner. Owner-approved exception: JOB_ALLOW_MAIN_DIR=1 git commit ...
EOF
  exit 1
fi
exit 0
