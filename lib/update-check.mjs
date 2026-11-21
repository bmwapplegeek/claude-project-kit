#!/usr/bin/env node
// Is a newer project-kit release out? Releases are git tags <tagPrefix><semver> in the repo named by
// kit.config.json (gitUrl). Asked with `git ls-remote`, so it works for a public kit repo anonymously and
// for a private one with whatever git credentials the machine already has. Never prompts for a password.
//
//   node update-check.mjs [--force]   print the result now (exit 0 current, 3 update, 2 could not check)
//
// NEVER applies an update. The session-start hook only reminds the agent to tell the owner; the update
// itself arrives as a pull request (repo install) or a reviewed plugin update (plugin).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { kitConfig, kitHome, kitVersion, mode, stateDir } from './kit-env.mjs';

const DAY = 24 * 60 * 60 * 1000;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function compareSemver(a, b) {
  const x = SEMVER.exec(a); const y = SEMVER.exec(b);
  if (!x || !y) return 0;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  return 0;
}

/** Highest semver among `refs/tags/<prefix>X.Y.Z` lines of `git ls-remote` output. */
export function parseTags(out, prefix) {
  let best = null;
  for (const line of String(out).split('\n')) {
    const ref = line.split(/\s+/)[1] || '';
    if (!ref.startsWith(`refs/tags/${prefix}`)) continue;
    const v = ref.slice(`refs/tags/${prefix}`.length);
    if (SEMVER.test(v) && (!best || compareSemver(v, best) > 0)) best = v;
  }
  return best;
}

export function latestRelease(cfg, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    if (!cfg?.gitUrl || !cfg?.tagPrefix) return resolve({ error: 'kit.config.json has no gitUrl / tagPrefix' });
    execFile('git', ['ls-remote', '--tags', '--refs', cfg.gitUrl, `refs/tags/${cfg.tagPrefix}*`], {
      timeout: timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', SSH_ASKPASS: 'echo', GCM_INTERACTIVE: 'never' },
    }, (err, stdout) => {
      if (err) return resolve({ error: err.killed ? 'timed out' : 'git ls-remote failed (no access or offline)' });
      const v = parseTags(stdout, cfg.tagPrefix);
      resolve(v ? { version: v } : { error: 'no release tags found yet' });
    });
  });
}

export function updateMessage({ installed, latest, cfg, m = mode() }) {
  const head = `PROJECT KIT UPDATE (project-kit): v${latest} is available; this ${m === 'repo' ? 'repo has' : 'plugin is'} v${installed}. ` +
    'Tell the owner. Do not update silently.';
  const how = m === 'repo'
    ? `To update (owner's yes first): on a new branch, \`git clone --depth 1 --branch ${cfg.tagPrefix}${latest} ${cfg.gitUrl} /tmp/project-kit-${latest}\`, ` +
      `then \`node /tmp/project-kit-${latest}/${cfg.path ? `${cfg.path}/` : ''}install.mjs --target .\` (keeps the installed layers), read the whole diff and the kit CHANGELOG, and open a pull request.`
    : 'To update (owner\'s yes first): read the kit CHANGELOG and the diff between the two tags, then `claude plugin marketplace update project-kit` and ' +
      '`claude plugin update guardrails@project-kit` (or `git pull` the local kit clone if the marketplace was added from a folder).';
  return `${head}\n${how}`;
}

/**
 * Session-start reminder. Checks at most once every 7 days (a failed check retries after 1 day).
 * Returns the context text or null. Never throws.
 */
export async function runHook({ now = Date.now(), force = false, home = kitHome(), stateFile, latestImpl = latestRelease, timeoutMs } = {}) {
  const file = stateFile ?? path.join(stateDir(home), 'kit-update.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  const write = (s) => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`); } catch { /* ignore */ } };
  try {
    const installed = kitVersion(home);
    if (!installed) return null;
    const lastTry = Date.parse(state.lastTryAt || '');
    const wait = state.lastResult === 'failed' ? DAY : 7 * DAY;
    if (!force && Number.isFinite(lastTry) && now - lastTry < wait) return null;
    const cfg = kitConfig(home);
    const r = await latestImpl(cfg, { timeoutMs });
    if (r.error) {
      write({ lastTryAt: new Date(now).toISOString(), lastResult: r.error === 'no release tags found yet' ? 'current' : 'failed', lastError: r.error });
      return null;
    }
    const newer = compareSemver(r.version, installed) > 0;
    write({ lastTryAt: new Date(now).toISOString(), lastResult: newer ? 'update' : 'current', latest: r.version });
    return newer ? updateMessage({ installed, latest: r.version, cfg, m: mode(home) }) : null;
  } catch (e) {
    write({ ...state, lastTryAt: new Date(now).toISOString(), lastResult: 'failed', lastError: String(e?.message ?? e).slice(0, 200) });
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const home = kitHome();
  const cfg = kitConfig(home);
  latestRelease(cfg, { timeoutMs: 15000 }).then((r) => {
    const installed = kitVersion(home);
    if (r.error) { console.log(`installed v${installed}; could not check: ${r.error}`); process.exit(2); }
    const newer = compareSemver(r.version, installed) > 0;
    console.log(newer ? updateMessage({ installed, latest: r.version, cfg, m: mode(home) }) : `installed v${installed}; latest release v${r.version}: current`);
    process.exit(newer ? 3 : 0);
  });
}
