# Project kit

Mechanical guardrails for Claude Code agents: hooks and scripts that stop the mistakes agents actually make
(sweeping another session's work into a commit, deleting a branch whose merge silently failed, committing a
secret, deploying an unchecked commit, two jobs colliding in one checkout), plus pinned copies of two review
skills. Everything is enforced by code, not prose, and every hook fails open: an internal error allows the
action and is written to a log, so a bug in the kit never stops an agent from working.

## Two ways in, one set of files

| | Repo install (`install.mjs`) | Plugin (`guardrails@project-kit`) |
|---|---|---|
| Where it applies | One repository, for everyone and every session that opens it | Every repository opened in Claude Code on one machine |
| What it brings | All layers: hooks, review skills, pre-commit secret scan, CI workflow, job worktrees, Phoenix deploy gate | Core hooks, review skills and update reminders only |
| Cloud (web) sessions | Yes: committed `.claude/settings.json` hooks run there | No: Claude Code does not load plugins in cloud sessions |
| Phoenix Studio projects | Yes (this is the reliable way: Studio agents read the repo) | No |
| Secret scan and CI | Yes | No (they only work when committed to a repo); the plugin leaves a short session-start note on repos without them |

When both are present, the plugin steps aside in a repo that has its own install (`.claude/kit/installed.json`),
so each check runs exactly once, with the version and layers that repo pinned.

### Install into a repository

Tell the repo's agent: **"Install the project kit from https://github.com/bmwapplegeek/claude-project-kit (follow its INSTALL.md)."**
[INSTALL.md](INSTALL.md) is the step-by-step an agent follows. By hand:

```bash
git clone --depth 1 --branch v1.0.1 https://github.com/bmwapplegeek/claude-project-kit.git /tmp/project-kit
node /tmp/project-kit/install.mjs --target /path/to/repo --preset basic      # or --preset phoenix, or --with core,jobs,ci-node
```

The installer is non-interactive and idempotent (a second run changes nothing). It merges and never clobbers:

- Files the kit owns (`.claude/kit/`, `.claude/skills/<skill>/`) are tracked by sha256 in
  `.claude/kit/installed.json`; a file the repo changed after install is left alone and reported (`--force` overwrites).
- `.claude/settings.json`: only the kit's hook entries are added or replaced; every other key and hook stays.
- `CLAUDE.md`, `.gitignore` and the pre-commit hook: the kit owns one marked block in each, rewritten in place.
- `.gitleaks.toml` and the CI workflow: created only when absent, then they belong to the repo.
- Nothing is committed. Review `git status`, commit by name on a branch, open a pull request.

Options: `--dry-run`, `--no-download` (skip fetching the scanner), `--force`, `--uninstall`, `--list-layers`.

### Install the plugin (once per machine)

```bash
claude plugin marketplace add bmwapplegeek/claude-project-kit@v1.0.1
claude plugin install guardrails@project-kit
```

or in a session: `/plugin marketplace add bmwapplegeek/claude-project-kit@v1.0.1`, then
`/plugin install guardrails@project-kit`. The terminal, the desktop app and the VS Code and JetBrains extensions
read the same `~/.claude` settings, so one install covers all of them on that machine. Leave the marketplace's
auto-update off (the default for third-party marketplaces): updates are meant to be read before they are taken.
To try it from a clone without installing: `claude --plugin-dir /path/to/claude-project-kit`.

Requirements for both: `bash`, `git` and Node.js 18 or newer on `PATH` (on Windows, Git Bash). Without `node` the
hooks do nothing and log that they skipped.

## Layers

| Layer | What it adds | Preset |
|---|---|---|
| `core` (always) | Bash guard rules `no-sweep-staging` and `no-merge-and-delete`; review skills `code-review` and `differential-review` with a weekly upstream check; pre-commit secret scan (pinned gitleaks); weekly kit update check | `basic`, `phoenix` |
| `jobs` | One git worktree per agent job (`node .claude/kit/lib/jobs/job.mjs start <type>/<slug>`); rule `main-dir-stays-on-main`; a pre-commit check; a session-start STOP note when the main checkout holds someone else's work | `phoenix` |
| `phoenix` | Pre-deploy checklist (`node .claude/kit/lib/phoenix/predeploy-check.mjs`) and rule `deploy-needs-predeploy-stamp` for the Phoenix Studio deploy endpoint | `phoenix` |
| `ci-node` | `.github/workflows/project-kit-ci-node.yml`: `npm ci`, typecheck / lint / test when defined, gitleaks over the PR's commits, one `CI passed` check | `phoenix` (via `ci-auto`, when `package.json` exists) |

Each layer also adds its rules to the CLAUDE.md block, so agents know why something was blocked.
`ci-auto` in a preset picks the first `ci-*` layer whose `detect` file exists in the repo.

## What the hooks block, and what they do not

The Bash guard (PreToolUse, matcher `Bash`) parses the command line: `&&`, `;`, pipes, subshells, `$(...)`,
`bash -c`, `eval` and heredocs fed to a shell. Text that only *mentions* a command (a quoted commit message, a
heredoc written to a file, `grep`, `echo`) is not blocked.

| Rule | Blocks | Does not block |
|---|---|---|
| `no-sweep-staging` | `git add -A/--all/-u/--update/.`, `git add -- .`, `git stage .`, `git commit -a/-am/--all`, also behind `cd`, `-C`, `bash -c`, `eval` | `git add <paths>`, `git add -p`, `git add dir/`, `git commit -m`, `git stash -u` |
| `no-merge-and-delete` | One command line that merges a PR (`gh pr merge`, a REST `.../pulls/N/merge` call) **and** deletes a branch (`git branch -d/-D`, `git push --delete` / `-d` / `:branch`, a REST DELETE of a ref) | The merge alone; the delete alone; `gh pr merge --delete-branch` (gh deletes only after a successful merge) |
| `main-dir-stays-on-main` (jobs) | In the main checkout: creating or switching branches; committing while it is off the base branch; stash / reset --hard / clean -f / discarding files while it has uncommitted changes | Linked worktrees (free); read-only git; returning a clean main checkout to the base branch; anything prefixed `JOB_ALLOW_MAIN_DIR=1` (owner-approved) |
| `deploy-needs-predeploy-stamp` (phoenix) | `curl/wget/http ... /project/deploy` (also inside `ssh '...'`) unless the pre-deploy check passed for the current HEAD under 30 minutes ago and the tree is still clean | Rollback, deployments list, publish, snapshots, env; the check never replaces the owner's yes |

The pre-commit secret scan runs `gitleaks protect --staged --redact` and refuses the commit on a finding. It
warns and lets the commit through when the scanner is missing or errors (fail open), and CI scans again.

These are guardrails against habits, not a sandbox: a git alias, a script file that runs git, or
`git commit --no-verify` is not seen. That is what the CI scan and code review are for.

## Updates are flagged, never applied

- **Kit:** at most once a week a session-start note compares the installed version with the newest `v*` tag of
  the kit repository (`git ls-remote`, no credentials needed) and, if newer, tells the agent to tell the owner,
  with the exact update steps. A repo updates by re-running the new release's installer on a branch and merging the
  pull request after reading the diff and `CHANGELOG.md`. The plugin updates with `claude plugin marketplace update
  project-kit` and `claude plugin update guardrails@project-kit`, after reading the diff between the two tags.
  `plugin.json` pins `version`, so pushed commits never reach a machine until a release changes it.
- **Review skills:** weekly, `lib/review-skills-check.mjs` compares each vendored skill with its pinned upstream
  commit and with the sha256 of every vendored file (`skills/review-skills.lock.json`). An upstream change produces a
  note with a compare link; local edits are reported as drift. `--fetch <skill>` downloads the new files for a
  pull request whose diff a person reads; nothing is ever applied automatically.

To silence the plugin's "kit not installed here" note for one repo: the command is in the note itself, or put
`{"nudge": false}` in that repo's `.claude/project-kit.json`.

## Configuration: `.claude/project-kit.json` (optional, per repo)

```json
{
  "nudge": false,
  "jobs": { "baseBranch": "main", "worktreesDir": "../worktrees" },
  "predeploy": { "commands": ["npm run typecheck", "npm test"], "minFreeGb": 2 }
}
```

## State and logs

Throttles, stamps and error logs live in `.claude/kit/state/` in a repo install (gitignored) and in
`${CLAUDE_PLUGIN_DATA}` for the plugin. Hook errors go to `hook-errors.log` and `bash-guard-errors.log` there.

## Extending

- **A rule:** drop `lib/bash-guard/rules/<layer>/<name>.mjs` exporting `name` and `check({command, commands, cwd})`
  (return a message to block). No registration.
- **A CI stack:** add `addons/ci/<stack>/ci.yml` and a `ci-<stack>` entry in `layers.json` with a `detect` file.
- **A layer:** an entry in `layers.json` (its `lib` paths, `files`, and a `templates/claude-md/<layer>.md` section).

## Licences

| Files | Licence |
|---|---|
| Everything in this repository not listed below | MIT, see [LICENSE](LICENSE) |
| `skills/code-review/upstream/**` (Anthropic's `code-review` plugin, verbatim) | Apache-2.0, see `skills/code-review/upstream/LICENSE` |
| `skills/differential-review/upstream/**` (Trail of Bits' `differential-review`, verbatim) | CC BY-SA 4.0, see `skills/differential-review/upstream/LICENSE` |
| `skills/differential-review/SKILL.md` (the kit's wrapper, which adapts those instructions) | CC BY-SA 4.0 |

**Credit and changes.**

- **`code-review`** by Anthropic, from https://github.com/anthropics/claude-plugins-official
  (`plugins/code-review`, plugin version 1.0.1, commit `4f2303046518925cde9907d25e23bf85645849eb`), licensed under
  the Apache License 2.0. The files under `skills/code-review/upstream/` are copied **unmodified**, including the
  upstream `LICENSE`; upstream ships no NOTICE file. `skills/code-review/SKILL.md` is the kit's own wrapper (MIT):
  it points the agent at the upstream command and lists how to run it without the `gh` CLI or sub-agents.
- **`differential-review`** by Trail of Bits, from https://github.com/trailofbits/skills
  (`plugins/differential-review`, plugin version 1.1.4, commit `149d7b21f4067765b82e67029730b42d228ef4b4`),
  licensed under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/). The files under
  `skills/differential-review/upstream/` are copied **unmodified**; `upstream/LICENSE` is the licence file from
  the upstream repository's root (the plugin folder has none of its own). Two upstream files are not included
  (`assets/trail-of-bits-mark.svg`, `agents/openai.yaml`). `skills/differential-review/SKILL.md` is an
  **adaptation**: a short entry point that sends the agent to the upstream instructions and adds a web-app
  attacker model (auth, roles, sessions, OAuth, connectors). It is shared under the same CC BY-SA 4.0 licence.
  Both are provided as is, without warranties, as their licences state.

Each vendored file is pinned by upstream commit and sha256 in `skills/review-skills.lock.json`; the kit's tests
fail if a vendored file differs from its pin.

## Development

Tests use Node only: `node --test test/*.test.mjs` (they build throwaway git repos, so git needs a user identity). Validate the plugin with `claude plugin validate .`.
Release: bump `VERSION` and `.claude-plugin/plugin.json` together (a test checks they match), add a
`CHANGELOG.md` entry, tag `vX.Y.Z`.
