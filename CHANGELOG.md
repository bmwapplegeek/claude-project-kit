# Changelog

Every release is a `vX.Y.Z` tag. Read the entry and the diff between the two tags before updating a repo or the
plugin: these files are instructions and hooks that agents run.

## 1.0.1

Documentation and licence only; no hook, rule or installer behaviour changed.

- INSTALL.md: do the install in a separate git worktree. With `--preset phoenix`, the `jobs` layer blocks
  commits on a branch in the main checkout as soon as it is installed, so the install commit was refused when
  the steps were followed on a plain branch.
- LICENSE is the standard MIT text again (an added paragraph stopped GitHub from detecting it). Which files are
  under other licences is in README.md, "Licences", as before.

## 1.0.0

First release.

- Core: Bash guard rules `no-sweep-staging` and `no-merge-and-delete`; vendored `code-review` (Anthropic,
  Apache-2.0) and `differential-review` (Trail of Bits, CC BY-SA 4.0) pinned by commit and sha256, with a weekly
  upstream check; pre-commit gitleaks scan (8.30.1, checksum-pinned); weekly kit update reminder.
- Layers: `jobs` (one worktree per agent job), `phoenix` (pre-deploy check and deploy gate), `ci-node` (GitHub
  Actions workflow).
- Two install paths from one tree: `install.mjs` (repo) and the `guardrails` Claude Code plugin, with a guard so
  the plugin stays silent in a repo that has its own install.
