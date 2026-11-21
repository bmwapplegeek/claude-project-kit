// Phoenix layer. Shared by predeploy-check.mjs (writes the stamp) and the bash-guard rule
// rules/phoenix/deploy-needs-predeploy-stamp.mjs (reads it). Dependency-free and fast: the hook has a 2 s budget.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { kitHome, gitTop } from '../kit-env.mjs';

export const STAMP_MAX_AGE_MS = 30 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;

/** Repo root. PREDEPLOY_ROOT overrides it so tests can use a throwaway repo. */
export function repoRoot() {
  return process.env.PREDEPLOY_ROOT || gitTop(kitHome()) || process.cwd();
}

/** Gitignored (the installer adds .claude/kit/state/ to .gitignore). */
export const stampPath = (root = repoRoot()) => join(root, '.claude', 'kit', 'state', 'predeploy-stamp.json');
export const historyPath = (root = repoRoot()) => join(root, '.claude', 'kit', 'state', 'predeploy-history.json');

export function git(root, args, timeout = 1500) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// Commit messages that mean "do something before you deploy this".
const PREREQ_PATTERNS = [
  /\bprerequisites?\b/i,
  /\bmanual(ly)?[\s-]+(step|action|migration|setup|change)s?\b/i,
  /\bbefore\s+(you\s+|we\s+|the\s+next\s+)?(deploy|deploying|deployment|deployed|release|releasing)\b/i,
  /\b(do\s*n['o]?t|never|not)\s+deploy\b/i,
  /\bdeploy\s+(note|notes|first|blocker|gate|order|requirement)s?\b/i,
  /\bmust\s+(exist|be\s+(added|created|run|applied|set|configured))\b[^.\n]{0,40}\b(first|before)\b/i,
  /\bneeds?\s+to\s+(exist|be\s+\w+)\b[^.\n]{0,40}\b(first|before)\b/i,
  /\brequires?\s+(a\s+)?manual\b/i,
];

// Words that name this gate itself are not a prerequisite: a commit ABOUT the gate would otherwise flag
// itself and teach everyone to pass the flag by reflex.
const GATE_VOCABULARY = /--ack-prerequisites|\bpre-?deploy(?:-check)?\b/gi;

export function mentionsPrerequisite(message) {
  const text = String(message).replace(GATE_VOCABULARY, ' ');
  return PREREQ_PATTERNS.some((p) => p.test(text));
}

export function readStamp(root = repoRoot()) {
  try {
    const s = JSON.parse(readFileSync(stampPath(root), 'utf8'));
    return s && typeof s === 'object' ? s : null;
  } catch {
    return null;
  }
}

/** Is `stamp` good for deploying `headSha` at time `now`? Returns {ok, reason}. */
export function judgeStamp(stamp, headSha, now = Date.now()) {
  if (!stamp) return { ok: false, reason: 'no pre-deploy stamp exists' };
  if (typeof stamp.sha !== 'string' || typeof stamp.at !== 'string') {
    return { ok: false, reason: 'the stamp file is malformed' };
  }
  if (stamp.sha !== headSha) {
    return { ok: false, reason: `the stamp is for ${stamp.sha.slice(0, 8)} but HEAD is ${headSha.slice(0, 8)}` };
  }
  const t = Date.parse(stamp.at);
  if (Number.isNaN(t)) return { ok: false, reason: 'the stamp has no valid timestamp' };
  const age = now - t;
  if (age < -CLOCK_SKEW_MS) return { ok: false, reason: 'the stamp is dated in the future' };
  if (age > STAMP_MAX_AGE_MS) {
    return { ok: false, reason: `the stamp is ${Math.round(age / 60000)} min old (limit ${STAMP_MAX_AGE_MS / 60000})` };
  }
  return { ok: true, reason: '' };
}
