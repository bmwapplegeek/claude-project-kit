// Core rule: no sweep-staging. Files are staged by name.
// Why: `git commit -am` / `git add -A` sweep up whatever else is in the working tree, including another
// session's half-finished work, and that has broken a main branch before.
import { gitInvocation } from '../../shell.mjs';

export const name = 'no-sweep-staging';

const ADVICE =
  'Stage files by name instead: `git add path/a path/b`, then `git commit -m "..."` ' +
  '(another session may have uncommitted work in this tree).';

function badAdd(args) {
  let afterDashes = false;
  for (const a of args) {
    if (a === '.' || a === './') return `git add ${a}`;
    if (afterDashes) continue;
    if (a === '--') { afterDashes = true; continue; }
    if (a === '--all' || a === '--update') return `git add ${a}`;
    if (/^-[A-Za-z]+$/.test(a) && /[Au]/.test(a)) return `git add ${a}`;
  }
  return null;
}

// Long options of `git commit` that consume the next word as their value.
const COMMIT_LONG_WITH_VALUE = new Set([
  '--message', '--file', '--author', '--date', '--template', '--reuse-message',
  '--reedit-message', '--fixup', '--squash', '--cleanup', '--trailer',
]);

function badCommit(args) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') break;
    if (a === '--all') return 'git commit --all';
    if (COMMIT_LONG_WITH_VALUE.has(a)) { k++; continue; }
    if (!/^-[A-Za-z]+$/.test(a)) continue;
    // Walk the cluster left to right; letters after a value-taking one are its value (-mfoo).
    for (let p = 1; p < a.length; p++) {
      const ch = a[p];
      if (ch === 'a') return `git commit ${a}`;
      if ('mFCcSu'.includes(ch)) {
        if (p === a.length - 1 && ch !== 'S' && ch !== 'u') k++; // value is the next word
        break;
      }
    }
  }
  return null;
}

export function check({ commands }) {
  for (const cmd of commands) {
    const g = gitInvocation(cmd);
    if (!g) continue;
    let hit = null;
    if (g.sub === 'add' || g.sub === 'stage') hit = badAdd(g.args);
    else if (g.sub === 'commit') hit = badCommit(g.args);
    if (hit) return `Blocked \`${hit}\`: it stages everything in the working tree. ${ADVICE}`;
  }
  return null;
}
