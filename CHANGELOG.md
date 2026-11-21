# Changelog

Every release is a `vX.Y.Z` tag. Read the entry and the diff between the two tags before updating a repo or the
plugin: these files are instructions and hooks that agents run.

## 1.1.1

Session note: never report an unreadable git state as uncommitted work. (A real session was told the main
checkout had "3,402 uncommitted changes", all listed as added files; minutes later it was clean. Best explanation:
git could not resolve HEAD to a commit, and `git status --porcelain` then lists every tracked file as added.)

- **Unreadable is its own note.** `sessionCheck` first checks `git rev-parse --verify -q HEAD` and that
  `git status` succeeds. If either fails it prints a `NOTE (project-kit jobs): git state in the main checkout ...
  could not be read: <reason>` with no change count and no file list, says it is not evidence of uncommitted
  work, and says not to stash, commit, reset, clean, switch or discard anything. It is not a STOP. The reason names
  the unborn-HEAD case or carries the first line of git's error.
- **Visible message.** `session-start` shows its own message for this case ("could not read git state ... not
  evidence of uncommitted work") instead of "another session's branch or uncommitted work".
- **Job worktrees.** A worktree whose state cannot be read shows as `state unreadable (<reason>)`, not `clean`,
  and is never named "probably finished". `sessionCheck` also returns `unreadable`.
- Genuine cases are unchanged: wrong branch, real uncommitted changes, healthy (silent), the worktree list.

## 1.1.0

Extension points, so a repo with richer versions of some steps can run the kit instead of a fork of it
(found by switching the kit's source repo onto its own kit). Nothing changes for a repo that uses none of them,
except the richer session note and the hooksPath fix below.

- **Repo rules:** `.claude/guard-rules/*.mjs` in a repo install run after the layers' rules (same shape as a
  layer rule, fail open). The installer never writes or removes them.
- **Repo commands:** `jobs.startCommand`, `jobs.finishCommand` and `predeploy.checkCommand` in
  `.claude/project-kit.json` name a repo's own scripts. Hook messages, the session STOP note, the pre-commit
  message and the CLAUDE.md block (placeholders filled at install) name them; the kit's own `job.mjs start|finish`
  and `predeploy-check.mjs` then refuse to run there, so a weaker generic step cannot satisfy the gate.
- **Session note:** the STOP note lists the uncommitted paths (up to 15) and says exactly what not to do; each job
  worktree shows clean/dirty, commits not in `origin/<base>` or merged, and its age; merged-and-clean ones are
  named as probably finished, with the finish command. `job.mjs list` prints the same lines.
- **Fix:** a tracked hooks dir the repo already used through `core.hooksPath` (so the kit did not set it) is now
  re-wired on a fresh clone too, where the setting is unset; one the repo points elsewhere is left alone.
  Before, on a fresh clone of such a repo the kit's pre-commit block never ran.
- **Fix:** the status lines in the job notes keep their first column (`git` output was trimmed).
- **Fail safe:** an unreadable `.claude/kit/installed.json` used to leave only the core rules running (the jobs
  and deploy rules went quiet). The guard now runs every rule folder installed on disk and logs the problem.

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
