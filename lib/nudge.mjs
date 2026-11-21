#!/usr/bin/env node
// Plugin mode only: "this repo does not carry the kit" note at session start.
//
// The plugin brings the guardrail hooks and review skills to every repo on the machine, but secret scanning
// (a git pre-commit hook) and CI (a workflow file) only work when they are committed to the repo. When the
// session's repo lacks either, the agent gets a short note once a week per repo saying how to install.
//
//   node nudge.mjs --silence [dir]     never show the note for this repo again (stored on this machine)
//   node nudge.mjs --unsilence [dir]
// A repo can also silence it for everyone: {"nudge": false} in .claude/project-kit.json.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gitTop, kitHome, projectDir, readJson, stateDir, userConfig } from './kit-env.mjs';
import { BLOCK_START, hookTarget } from './githooks/wiring.mjs';

const WEEK = 7 * 24 * 60 * 60 * 1000;
const stateFile = () => path.join(stateDir(), 'nudge.json');
const repoKey = (top) => crypto.createHash('sha256').update(path.resolve(top)).digest('hex').slice(0, 16);

/** What a repo is missing among the parts only a repo install provides. */
export function missingParts(top) {
  const missing = [];
  const t = hookTarget(top);
  const hookFile = t.kind === 'tracked' ? path.join(top, t.dir, 'pre-commit') : t.file;
  let hookText = '';
  try { hookText = fs.readFileSync(hookFile, 'utf8'); } catch { /* none */ }
  let preCommitFw = '';
  try { preCommitFw = fs.readFileSync(path.join(top, '.pre-commit-config.yaml'), 'utf8'); } catch { /* none */ }
  const scans = hookText.includes(BLOCK_START) || /gitleaks|trufflehog|detect-secrets|git-secrets/.test(hookText) ||
    /gitleaks|trufflehog|detect-secrets/.test(preCommitFw);
  if (!scans) missing.push('secret scanning');
  const wf = path.join(top, '.github', 'workflows');
  const hasCi = (fs.existsSync(wf) && fs.readdirSync(wf).some((f) => /\.ya?ml$/.test(f))) ||
    fs.existsSync(path.join(top, '.gitlab-ci.yml')) || fs.existsSync(path.join(top, '.circleci'));
  if (!hasCi) missing.push('CI');
  return missing;
}

/** The note to show, or null. Never throws. */
export function runNudge({ now = Date.now(), dir = projectDir(), file = stateFile(), home = kitHome() } = {}) {
  try {
    const top = gitTop(dir);
    if (!top) return null;
    if (fs.existsSync(path.join(top, '.claude', 'kit', 'installed.json'))) return null;
    if (userConfig(top)?.nudge === false) return null;
    const state = readJson(file, {}) || {};
    const key = repoKey(top);
    const entry = state[key] || {};
    if (entry.silenced) return null;
    if (entry.lastAt && now - Date.parse(entry.lastAt) < WEEK) return null;
    const missing = missingParts(top);
    if (!missing.length) return null;
    state[key] = { ...entry, path: top, lastAt: new Date(now).toISOString() };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
    return `PROJECT KIT NOTE: this repo does not have the project kit installed (missing here: ${missing.join(', ')}). ` +
      'The plugin\'s guardrail hooks and review skills are active, but secret scanning and CI only work when committed to the repo. ' +
      'Mention this to the owner once; do not install without their yes. ' +
      `To install (on a branch, then open a PR): \`node "${path.join(home, 'install.mjs')}" --target "${top}"\`. ` +
      `To silence this note for this repo: \`PROJECT_KIT_STATE="${path.dirname(file)}" node "${path.join(home, 'lib', 'nudge.mjs')}" --silence "${top}"\`.`;
  } catch {
    return null;
  }
}

export function setSilenced(dir, silenced, file = stateFile()) {
  const top = gitTop(dir) || path.resolve(dir);
  const state = readJson(file, {}) || {};
  const key = repoKey(top);
  state[key] = { ...(state[key] || {}), path: top, silenced };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  return top;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [flag, dir = process.cwd()] = process.argv.slice(2);
  if (flag === '--silence' || flag === '--unsilence') {
    const top = setSilenced(dir, flag === '--silence');
    console.log(`project-kit note ${flag === '--silence' ? 'silenced' : 'unsilenced'} for ${top}`);
  } else {
    console.error('usage: nudge.mjs --silence [dir] | --unsilence [dir]');
    process.exit(2);
  }
}
