- **One worktree per job.** Start every task with `node .claude/kit/lib/jobs/job.mjs start <feat|fix|chore|docs>/<slug>`
  and work only in the worktree it prints (outside the repo, in `../worktrees/`). The main checkout stays on
  `main` and clean; a hook blocks branch work, stash, reset and discards there. Uncommitted changes in the main
  checkout belong to another session: do not touch them, tell the owner. After the PR is merged:
  `node .claude/kit/lib/jobs/job.mjs finish <branch>`.
