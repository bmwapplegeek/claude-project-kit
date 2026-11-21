---
name: differential-review
description: Security-focused differential review (git history, blast radius, test gaps, attacker model) of a change. Use IN ADDITION to code-review for any change touching login, OAuth, permissions/roles, sessions, tokens, secrets handling or an API/MCP connector. Wraps Trail of Bits' differential-review (vendored, pinned, under upstream/).
---

# Differential security review (Trail of Bits `differential-review`, vendored by the project kit)

Use this **in addition to** the `code-review` skill whenever a change touches login, OAuth,
permissions/roles, sessions, tokens, secrets handling, or an API/MCP connector. The repo's
CLAUDE.md may list the exact paths that count. When in doubt, run it.

## What to do

1. Read `upstream/skills/differential-review/SKILL.md` first, then the files it routes
   to: `methodology.md` (Pre-Analysis, Phases 0-4), `adversarial.md` (Phase 5, for HIGH
   RISK changes), `reporting.md` (Phase 6), `patterns.md` (reference).
   `upstream/agents/adversarial-modeler.md` is the Phase 5 helper, and
   `upstream/commands/diff-review.md` and `upstream/README.md` are the plugin's entry
   point and overview. `upstream/` is a pinned, verbatim copy: never edit it (see
   `review-skills.lock.json` beside this skill's folder). Licence: CC BY-SA 4.0
   (`upstream/LICENSE`), by Trail of Bits.
2. Apply the adaptations below. They override the upstream text where they differ.

## Adaptations

- **If `gh` is not installed**, where upstream says `gh pr view ...` use
  `git diff origin/<base>...<branch> --stat`, `git log origin/<base>..<branch>`, and for PR
  metadata the hosting provider's REST API with a token the environment provides. Never print a token.
- **Never `git checkout <baseline>`** (upstream Pre-Analysis does this): other work may be in
  progress in the same directory. Read the baseline with `git show origin/<base>:<path>` or a
  throwaway `git worktree add /tmp/<new-dir> origin/<base>` (remove it afterwards).
- **`audit-context-building` and the `differential-review:adversarial-modeler` agent may not
  be installed.** Then do the manual line-by-line analysis upstream describes as the fallback,
  and do Phase 5 yourself from `adversarial.md`.
- **Report location:** upstream writes `<PROJECT>_DIFFERENTIAL_REVIEW_<DATE>.md` into the working
  directory. Do NOT leave it in the repo: write it under `/tmp/` (or put it in the session summary)
  unless the owner asks for it to be committed.
- **Translate the examples to the project's stack.** Upstream is Solidity/DeFi-flavoured
  (`require`, `onlyOwner`, reentrancy). In a web app the equivalents are auth and permission
  middleware, ownership checks on every route, session/JWT verification and expiry, OAuth
  `redirect_uri`/`state`/PKCE and token storage, connector tool authorisation, and database
  queries that must be scoped to the caller. Use the grep patterns in `patterns.md` as models
  ("removed auth check", "relaxed role", "new unauthenticated route") with the project's file globs.
- **Attacker model (adjust to the app):** unauthenticated internet user, authenticated low-role
  user, user of another role or tenant, holder of a leaked connector URL or token, malicious or
  compromised admin.
- Treat anything weakening auth, role checks, token/session handling or connector scoping as
  HIGH RISK regardless of diff size (upstream: "classify by RISK, not size").

---
This wrapper adapts Trail of Bits' `differential-review` instructions and is licensed, like them,
under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/; full text in `upstream/LICENSE`).
