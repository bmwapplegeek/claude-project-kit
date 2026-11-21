#!/usr/bin/env bash
# Core layer: pre-commit secret scan of the STAGED changes with gitleaks. Called from the project-kit block
# in the repo's pre-commit hook. Exit 1 = a finding (block the commit); 0 otherwise. Fails open (warns)
# when the scanner is missing or errors, so a broken install never stops all commits.
ROOT="$(git rev-parse --show-toplevel)" || exit 0
# A linked worktree has no gitignored .claude/kit/bin of its own: fall back to the main checkout's.
MAIN="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
GL=""
for c in "$ROOT/.claude/kit/bin/gitleaks" "$MAIN/.claude/kit/bin/gitleaks" "$(command -v gitleaks 2>/dev/null)"; do
  if [ -n "$c" ] && [ -x "$c" ]; then GL="$c"; break; fi
done
if [ -z "$GL" ]; then
  echo "project-kit WARNING: gitleaks not installed - secret scan SKIPPED. Install: bash .claude/kit/lib/githooks/install-gitleaks.sh .claude/kit/bin" >&2
  exit 0
fi
CFG=()
[ -f "$ROOT/.gitleaks.toml" ] && CFG=(--config "$ROOT/.gitleaks.toml")
# --redact: never print the secret value.
"$GL" protect --staged --redact --no-banner --verbose "${CFG[@]}" >&2
rc=$?
if [ $rc -eq 1 ]; then
  cat >&2 <<'EOF'

BLOCKED (project-kit): gitleaks found what looks like a secret in the staged changes (values redacted above).
  - Real secret: remove it, read it from the environment instead, and ROTATE it if it was ever pushed.
  - False positive: add a NARROW [[allowlists]] entry to .gitleaks.toml (a rule plus a path or line regex,
    never a whole rule). Last resort for one commit: git commit --no-verify
EOF
  exit 1
elif [ $rc -ne 0 ]; then
  echo "project-kit WARNING: gitleaks errored (exit $rc) - secret scan SKIPPED for this commit." >&2
fi
exit 0
