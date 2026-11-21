// Jobs layer: the MAIN checkout of the repo stays on the base branch (default `main`); each agent job works
// in its own git worktree (node .claude/kit/lib/jobs/job.mjs start <type>/<slug>).
// Why: sessions that share one working directory collide - one switches branches under another, or a new
// job starts on top of the previous job's uncommitted changes and branch.
//
// Only the main worktree of a repo is guarded (git-dir == common-dir); linked worktrees are free.
// In the main checkout:
//   - creating a branch or switching to anything but the base branch is blocked;
//   - commit / merge / rebase / pull / cherry-pick / revert / am are blocked while it is not on the base branch;
//   - stash, reset --hard, clean -f, checkout/restore of files and switching are blocked while it has
//     uncommitted changes: nothing in the main checkout is a job's own work, so they are someone else's.
// Owner-approved exception: prefix the command with JOB_ALLOW_MAIN_DIR=1 (the pre-commit block honours it too).
// Unknown directories (`cd "$X"`) are allowed: the rule never guesses. A git error throws -> logged, allowed.
import { execFileSync } from 'node:child_process';
import { gitInvocation } from '../../shell.mjs';
import { withDirs, repoState } from '../../repo-state.mjs';
import { userConfig } from '../../../kit-env.mjs';

export const name = 'main-dir-stays-on-main';

const OVERRIDE = 'JOB_ALLOW_MAIN_DIR=1';
const START = 'Do your job in its own worktree: `node .claude/kit/lib/jobs/job.mjs start <feat|fix|chore|docs>/<slug>` ' +
  '(works even now; it does not touch the main checkout).';
const COMMITTING = new Set(['commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'pull']);

function overridden(cmd) {
  for (const w of cmd.words) {
    if (w === OVERRIDE) return true;
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) return false;
  }
  return false;
}

const operands = (args) => {
  const out = [];
  for (const a of args) {
    if (a === '--') break;
    if (!a.startsWith('-')) out.push(a);
  }
  return out;
};
const hasFlag = (args, longs, letter) =>
  args.some((a) => longs.includes(a) || longs.some((l) => a.startsWith(`${l}=`)) || (letter && /^-[A-Za-z]+$/.test(a) && a.includes(letter)));

function isCommitish(top, ref) {
  try {
    execFileSync('git', ['-C', top, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { timeout: 1000, stdio: 'ignore' });
    return true;
  } catch (e) {
    if (e.code === 'ETIMEDOUT') throw e;
    return false;
  }
}

// -> 'create' | 'switch' | 'to-base' | 'discard' | 'commit' | null
function classify(g, top, base) {
  const { sub, args } = g;
  if ((sub === 'switch' || sub === 'checkout') && args.includes('-')) return 'switch'; // the previous branch
  if (sub === 'switch') {
    if (args.some((a) => /^(-c|-C|--create|--force-create|--orphan)(=|$)/.test(a))) return 'create';
    if (hasFlag(args, ['--detach'], 'd')) return 'switch';
    const [op] = operands(args);
    if (op === undefined) return null;
    return op === base ? 'to-base' : 'switch';
  }
  if (sub === 'checkout') {
    if (args.some((a) => /^(-b|-B|--orphan)$/.test(a) || /^-[A-Za-z]*[bB]$/.test(a))) return 'create';
    if (args.includes('--')) return 'discard';
    if (args.includes('--detach')) return 'switch';
    const ops = operands(args);
    if (!ops.length) return hasFlag(args, ['--patch'], 'p') ? 'discard' : null;
    if (ops.length > 1 || ops[0] === '.' || ops[0] === './') return 'discard';
    if (ops[0] === base) return 'to-base';
    return isCommitish(top, ops[0]) ? 'switch' : 'discard';
  }
  if (sub === 'restore') {
    const staged = hasFlag(args, ['--staged'], 'S');
    const worktree = hasFlag(args, ['--worktree'], 'W');
    return staged && !worktree ? null : 'discard';
  }
  if (sub === 'stash') {
    const [verb] = operands(args);
    return verb === 'list' || verb === 'show' ? null : 'discard';
  }
  if (sub === 'reset') return hasFlag(args, ['--hard', '--merge', '--keep']) ? 'discard' : null;
  if (sub === 'clean') {
    const force = hasFlag(args, ['--force'], 'f');
    const dry = hasFlag(args, ['--dry-run'], 'n');
    return force && !dry ? 'discard' : null;
  }
  if (COMMITTING.has(sub)) return 'commit';
  return null;
}

export function check({ commands, cwd }) {
  const cache = new Map();
  for (const { cmd, dir } of withDirs(commands, cwd)) {
    const g = gitInvocation(cmd);
    if (!g || overridden(cmd)) continue;
    const st = repoState(dir, cache);
    if (!st || !st.isMain) continue;
    const base = userConfig(st.top)?.jobs?.baseBranch || 'main';
    const kind = classify(g, st.top, base);
    if (!kind) continue;
    const what = `\`git ${g.sub}\``;
    if (kind === 'create' || kind === 'switch') {
      return `Blocked ${what}: it would move the main checkout off \`${base}\` (it stays there for deploys and previews). ${START}`;
    }
    if (kind === 'commit' && st.branch !== base) {
      return `Blocked ${what}: the main checkout is on \`${st.branch}\`, not \`${base}\` - probably another session's branch. ` +
        `Do not commit on top of it; leave it and tell the owner. ${START}`;
    }
    if (kind === 'to-base' && st.branch === base) continue; // a no-op
    // Returning a CLEAN main checkout to the base branch is the recovery, so it is allowed; with changes it is not.
    if (kind === 'discard' || kind === 'to-base') {
      const n = st.dirty().length;
      if (n) {
        return `Blocked ${what}: the main checkout has ${n} uncommitted change(s) that are not yours (another ` +
          `session's, maybe one that ended). Do not stash, discard, switch or commit them; tell the owner. ${START}`;
      }
    }
  }
  return null;
}
