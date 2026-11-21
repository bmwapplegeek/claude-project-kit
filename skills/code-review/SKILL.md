---
name: code-review
description: Review a pull request or branch for real bugs and CLAUDE.md violations, high signal only. Use for EVERY PR / branch review before it is merged. Wraps Anthropic's official code-review plugin (vendored, pinned, under upstream/).
---

# Code review (Anthropic `code-review`, vendored by the project kit)

Use this for **every** review of a PR or branch. Changes that touch login, OAuth,
permissions/roles, sessions, tokens, secrets handling or an API/MCP connector must ALSO
get the `differential-review` skill.

## What to do

1. Read `upstream/commands/code-review.md` in this folder end to end and follow its
   method (skip-check, collect CLAUDE.md files, summary, independent bug + CLAUDE.md
   passes, validate each issue, keep only high-signal findings, no nitpicks).
   `upstream/README.md` explains the intent. `upstream/` is a pinned, verbatim copy:
   never edit it (see `review-skills.lock.json` beside this skill's folder).
2. Apply the adaptations below. They override the upstream text where they differ.

## Adaptations (upstream assumes the `gh` CLI and sub-agents)

- **If `gh` is not installed**, do not run `gh pr view/diff/comment`. Read the change with
  `git fetch origin && git diff origin/<base>...<branch>` and `git log origin/<base>..<branch>`.
  For PR title, description and comments use the hosting provider's REST API with a token
  the environment already provides. Never print a token; check it is non-empty first.
- **Output goes to the terminal or the session summary.** Treat upstream's `--comment`
  mode (inline PR comments) as OFF unless the owner or the task explicitly asks for PR comments.
- **Sub-agents are optional.** If your environment can launch them, use them as upstream
  describes. If not, do the same passes yourself one after another: CLAUDE.md compliance,
  bug scan of the diff, security/logic scan of the changed code, then re-verify each
  candidate issue against the code before keeping it.
- **"CLAUDE.md compliance" means this repository's rules**: every CLAUDE.md in the repo
  and any docs it points to for the area that changed.
- Upstream's "already reviewed / draft / closed" skip-check is about PR state; when you
  were explicitly asked to review, review anyway.
- Link code with the full commit SHA, as upstream describes.
