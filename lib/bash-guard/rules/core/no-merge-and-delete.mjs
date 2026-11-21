// Core rule: never delete a branch in the same command line that merges a PR.
// Why: when the merge call silently fails (an empty token, a merge conflict), a chained
// `git branch -d && git push origin --delete` still runs and deletes finished, unmerged work.
// Delete in a SEPARATE call after the merge returned "merged": true.
import { gitInvocation } from '../../shell.mjs';

export const name = 'no-merge-and-delete';

const HTTP_CLIENTS = new Set(['curl', 'wget', 'http', 'https', 'xh']);

function isMerge(cmd) {
  if (HTTP_CLIENTS.has(cmd.name)) return cmd.args.some((a) => /\/pulls\/[^\s/]+\/merge/.test(a));
  if (cmd.name === 'gh') return cmd.args[0] === 'pr' && cmd.args[1] === 'merge';
  return false;
}

function deletion(cmd) {
  const g = gitInvocation(cmd);
  if (g) {
    if (g.sub === 'branch') {
      const hit = g.args.find((a) => a === '--delete' || (/^-[A-Za-z]+$/.test(a) && /[dD]/.test(a)));
      if (hit) return `git branch ${hit}`;
    }
    if (g.sub === 'push') {
      const hit = g.args.find(
        (a) => a === '--delete' || (/^-[A-Za-z]+$/.test(a) && a.includes('d')) || /^:[^\s:]/.test(a),
      );
      if (hit) return `git push ${hit}`;
    }
    return null;
  }
  // GitHub REST: DELETE /repos/:o/:r/git/refs/heads/<branch>
  if (HTTP_CLIENTS.has(cmd.name) &&
      cmd.args.some((a) => /DELETE/.test(a)) && cmd.args.some((a) => /\/git\/refs\//.test(a))) {
    return 'REST DELETE of a git ref';
  }
  return null;
}

export function check({ commands }) {
  if (!commands.some(isMerge)) return null;
  for (const cmd of commands) {
    const d = deletion(cmd);
    if (d) {
      return `Blocked: this command line both merges a PR and deletes a branch (\`${d}\`). ` +
        'Run the merge alone, confirm it returned "merged": true and the main branch has the commit, ' +
        'then delete the branch in a separate call.';
    }
  }
  return null;
}
