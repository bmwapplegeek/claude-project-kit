// Phoenix layer: a command that calls the Phoenix Studio deploy endpoint (.../project/deploy) is blocked
// unless `node .claude/kit/lib/phoenix/predeploy-check.mjs` passed for the CURRENT HEAD less than 30 minutes
// ago and the working tree is still clean.
//
// This is an ADDITION to the owner's explicit yes, not a replacement: a fresh stamp only means the
// checklist passed. Rollback, publish, snapshots and the deployments list are not deploys and are not blocked.
// Fail open: a git error or timeout throws, and the dispatcher logs it and allows the command.
import { git, readStamp, judgeStamp, repoRoot } from '../../../phoenix/predeploy-lib.mjs';

export const name = 'deploy-needs-predeploy-stamp';

const HTTP_CLIENTS = new Set(['curl', 'wget', 'http', 'https', 'xh']);
// .../project/deploy (also with a trailing slash or ?query), but not .../project/deploy/rollback
// or .../project/deployments.
const DEPLOY_URL = /\/project\/deploy(?![\w-]|\/[\w-])/;

function callsDeploy(cmd) {
  if (HTTP_CLIENTS.has(cmd.name)) return cmd.args.some((a) => DEPLOY_URL.test(a));
  // `ssh host 'curl .../project/deploy'`: the remote command is one word.
  if (cmd.name === 'ssh') return cmd.args.some((a) => /\b(curl|wget)\b/.test(a) && DEPLOY_URL.test(a));
  return false;
}

const block = (why) =>
  `Blocked: a deploy needs the pre-deploy check first (${why}). Run \`node .claude/kit/lib/phoenix/predeploy-check.mjs\`, ` +
  'fix what it reports, then deploy. It does not replace the owner\'s explicit yes.';

export function check({ commands }) {
  if (!commands.some(callsDeploy)) return null;
  const root = repoRoot();
  const head = git(root, ['rev-parse', 'HEAD']);
  const verdict = judgeStamp(readStamp(root), head);
  if (!verdict.ok) return block(verdict.reason);
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=all'], 1300);
  if (dirty) return block('the working tree changed after the check passed');
  return null;
}
