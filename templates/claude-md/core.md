## Engineering guardrails (project kit)

Installed by the project kit (`.claude/kit/`, version in `.claude/kit/installed.json`). Hooks enforce most of
this; the rules are written here so you know why a command was blocked.

- **Code review:** every PR or branch review follows the `code-review` skill (`.claude/skills/code-review/`).
  A change touching login, OAuth, permissions/roles, sessions, tokens, secrets handling or an API/MCP
  connector ALSO follows `differential-review`. The skills are pinned copies (`.claude/skills/review-skills.lock.json`):
  never edit them by hand.
- **Stage files by name.** `git add -A`, `git add .`, `git add -u` and `git commit -a` are blocked by a hook:
  another session may have uncommitted work in the same tree.
- **Never delete a branch in the same command that merges a PR.** Merge, confirm `"merged": true`, then
  delete in a separate call.
- **No secrets in code, commits or chat.** Read secrets from the environment. The pre-commit secret scan
  (gitleaks) blocks a commit that contains one; never `--no-verify` past a real finding, and rotate any
  secret that was pushed. False positives get a narrow entry in `.gitleaks.toml`.
- **Updates are flagged, never applied silently.** When a session-start note says the review skills or the
  kit have a newer version, tell the owner. Updates arrive as a pull request whose diff is read before merge.
