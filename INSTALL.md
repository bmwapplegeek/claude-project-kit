# Install the project kit into a repository

**For an agent told "install the project kit".** Follow these steps in order. Do not improvise around a step
that fails: stop and tell the owner what it printed.

1. **Look first.** If the repository already has its own hooks for the same things (a PreToolUse Bash guard in
   `.claude/settings.json`, a gitleaks pre-commit hook, vendored review skills), stop and ask the owner which to
   keep. Two copies of the same guardrail fire twice.
2. **Worktree.** Do the install in a separate git worktree on a new branch, not in the main checkout. If you
   already work in your own job worktree, use that. Otherwise, from the repository root:

   ```bash
   git fetch origin
   git worktree add ../worktrees/chore-project-kit -b chore/project-kit origin/main
   cd ../worktrees/chore-project-kit
   ```

   (Use the repository's base branch if it is not `main`.) Why: the `jobs` layer, part of `--preset phoenix`,
   blocks commits on any branch in the main checkout as soon as it is installed, so the install commit in
   step 7 would be refused there. After the pull request is merged: `git worktree remove ../worktrees/chore-project-kit`.
3. **Get a release.** Find the newest tag and clone it outside the repository:

   ```bash
   git ls-remote --tags --refs https://github.com/bmwapplegeek/claude-project-kit.git 'v*'
   git clone --depth 1 --branch vX.Y.Z https://github.com/bmwapplegeek/claude-project-kit.git /tmp/project-kit-vX.Y.Z
   ```

   (`vX.Y.Z` = the highest version the first command listed.)
4. **Pick the preset.**
   - Phoenix Studio project (the environment has `STUDIO_API_BASE` set): `--preset phoenix`
     (core + job worktrees + pre-deploy gate + a CI workflow when the stack has a template).
   - Anything else: `--preset basic` (core only). Add layers with `--with`, for example
     `--with core,jobs,ci-node`. `node /tmp/project-kit-vX.Y.Z/install.mjs --list-layers` lists them.
5. **Dry run, then install**, from the root of the worktree from step 2:

   ```bash
   node /tmp/project-kit-vX.Y.Z/install.mjs --target . --preset <preset> --dry-run
   node /tmp/project-kit-vX.Y.Z/install.mjs --target . --preset <preset>
   ```

   The installer merges and never clobbers. Read its report: `kept` lines are files the repository already had
   and the kit left alone; mention them to the owner.
6. **Check it works:**

   ```bash
   echo '{"tool_name":"Bash","tool_input":{"command":"git add -A"}}' | CLAUDE_PROJECT_DIR="$PWD" bash .claude/kit/lib/hooks/run.sh pre-bash; echo "exit $?"
   ```

   It must print a `project-kit bash-guard [no-sweep-staging]` line and `exit 2`.
7. **Commit by name** (the hook now blocks `git add -A`): stage exactly the paths `git status --porcelain` lists
   for the kit (`.claude/kit`, `.claude/skills/...`, `.claude/settings.json`, `CLAUDE.md`, `.gitignore`,
   `.gitleaks.toml`, `.githooks/pre-commit`, `.github/workflows/project-kit-ci-*.yml`), commit, push, open a pull
   request, and merge it only after review (and green CI, if the repository has CI).
8. **Tell the owner** which preset and layers were installed and anything the report listed as `kept`.

Updating later is the same steps with the new tag and no `--preset` (the installed layers are kept). Removing:
`node /tmp/project-kit-vX.Y.Z/install.mjs --target . --uninstall`, then commit the result through a pull request.
