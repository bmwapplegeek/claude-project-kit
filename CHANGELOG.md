# Changelog

Every release is a `vX.Y.Z` tag. Read the entry and the diff between the two tags before updating a repo or the
plugin: these files are instructions and hooks that agents run.

## 1.0.0

First release.

- Core: Bash guard rules `no-sweep-staging` and `no-merge-and-delete`; vendored `code-review` (Anthropic,
  Apache-2.0) and `differential-review` (Trail of Bits, CC BY-SA 4.0) pinned by commit and sha256, with a weekly
  upstream check; pre-commit gitleaks scan (8.30.1, checksum-pinned); weekly kit update reminder.
- Layers: `jobs` (one worktree per agent job), `phoenix` (pre-deploy check and deploy gate), `ci-node` (GitHub
  Actions workflow).
- Two install paths from one tree: `install.mjs` (repo) and the `guardrails` Claude Code plugin, with a guard so
  the plugin stays silent in a repo that has its own install.
