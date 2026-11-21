#!/usr/bin/env node
// Keeps the vendored review skills (code-review, differential-review) honest.
//
//   node review-skills-check.mjs --check [--json]   compare the lock with upstream and with disk
//   node review-skills-check.mjs --fetch <skill>    download that skill's new upstream files into the
//                                                   working tree + update its lock entry (a git diff to review)
//   options: --skills-dir <dir> (holds <skill>/ folders and review-skills.lock.json)  --timeout <ms>
//            --api-base <url>  --raw-base <url>
// Default skills dir: <repo>/.claude/skills in a repo install, <plugin>/skills in the plugin.
//
// Exit codes for --check: 0 current | 2 could not check (network, rate limit, bad answer) |
//   3 update available | 4 local drift (vendored file edited/added/removed) | 5 both.
//   Drift and update outrank 2, so a failed check can never read as "up to date".
//
// Updates are NEVER applied automatically. These files are instructions agents follow, so an upstream
// change has to be read by a person in a PR diff first. --fetch only writes text files under
// <skill>/upstream/ and the lock file; it never executes anything it downloads and never touches the
// wrapper SKILL.md. Only public GitHub endpoints are used, unauthenticated, with a generic User-Agent: no
// token or other credential is ever sent. Upstream commit messages are untrusted text and are never printed.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { kitHome, mode, stateDir } from './kit-env.mjs';

export const EXIT = { CURRENT: 0, USAGE: 1, UNKNOWN: 2, UPDATE: 3, DRIFT: 4, BOTH: 5 };
const USER_AGENT = 'review-skills-check';
const API_BASE = 'https://api.github.com';
const RAW_BASE = 'https://raw.githubusercontent.com';
const MAX_FILE_BYTES = 1024 * 1024;
const TEXT_EXT = new Set(['.md', '.json', '.txt', '.yaml', '.yml']);
const SHA_RE = /^[0-9a-f]{40}$/;
const DAY = 24 * 60 * 60 * 1000;

class CheckError extends Error {}

export const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

export const defaultSkillsDir = (home = kitHome()) =>
  mode(home) === 'repo' ? path.join(home, '..', 'skills') : path.join(home, 'skills');

/** A relative path made only of plain segments: no '..', no absolute, no backslash, no NUL. */
export function safeRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || rel.includes('\\') || rel.startsWith('/')) return false;
  return rel.split('/').every(s => s && s !== '.' && s !== '..');
}

function resolveInside(base, rel) {
  if (!safeRel(rel)) throw new CheckError(`refusing unsafe path: ${JSON.stringify(rel)}`);
  const abs = path.resolve(base, rel);
  if (!abs.startsWith(base + path.sep)) throw new CheckError(`refusing path outside ${base}: ${JSON.stringify(rel)}`);
  return abs;
}

function repoSlug(repo) {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)$/.exec(repo ?? '');
  if (!m) throw new CheckError(`lock entry has a repo that is not a plain github.com URL: ${repo}`);
  return `${m[1]}/${m[2]}`;
}

export const lockPath = dir => path.join(dir, 'review-skills.lock.json');
export const skillDir = (dir, name) => path.join(path.resolve(dir), name);

export function readLock(dir) {
  const lock = JSON.parse(fs.readFileSync(lockPath(dir), 'utf8'));
  if (!lock || !Array.isArray(lock.skills)) throw new CheckError('lock file has no "skills" array');
  for (const s of lock.skills) {
    if (!/^[a-z0-9-]+$/.test(s.name ?? '')) throw new CheckError(`bad skill name in lock: ${s.name}`);
    if (!safeRel(s.path)) throw new CheckError(`bad upstream path in lock for ${s.name}: ${s.path}`);
    if (!SHA_RE.test(s.commit ?? '')) throw new CheckError(`bad pinned commit in lock for ${s.name}`);
    repoSlug(s.repo);
    for (const rel of Object.keys(s.files ?? {})) {
      if (!safeRel(rel) || !rel.startsWith('upstream/')) throw new CheckError(`refusing unsafe path in lock for ${s.name}: ${JSON.stringify(rel)}`);
    }
  }
  return lock;
}

function ctxFrom(opts) {
  return {
    dir: path.resolve(opts.skillsDir ?? defaultSkillsDir()),
    fetchImpl: opts.fetchImpl ?? globalThis.fetch,
    apiBase: (opts.apiBase ?? API_BASE).replace(/\/$/, ''),
    rawBase: (opts.rawBase ?? RAW_BASE).replace(/\/$/, ''),
    // One deadline for the whole run, so several requests can never add up past the cap.
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
  };
}

async function httpGet(url, ctx, accept) {
  let res;
  try {
    res = await ctx.fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: accept }, signal: ctx.signal });
  } catch (e) {
    throw new CheckError(`network error (${e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timed out' : e?.message ?? e})`);
  }
  if (!res.ok) {
    const limited = (res.status === 403 || res.status === 429) && res.headers?.get?.('x-ratelimit-remaining') === '0';
    throw new CheckError(limited ? 'GitHub API rate limit reached' : `GitHub answered HTTP ${res.status}`);
  }
  return res;
}

async function getJson(url, ctx) {
  const res = await httpGet(url, ctx, 'application/vnd.github+json');
  try {
    return await res.json();
  } catch {
    throw new CheckError('GitHub answered with something that is not JSON');
  }
}

/** Newest commit touching `p`, optionally as of `ref` (a commit sha). */
async function latestPathCommit(slug, p, ref, ctx) {
  const q = new URLSearchParams({ path: p, per_page: '1' });
  if (ref) q.set('sha', ref);
  const list = await getJson(`${ctx.apiBase}/repos/${slug}/commits?${q}`, ctx);
  const c = Array.isArray(list) ? list[0] : null;
  if (!c || !SHA_RE.test(c.sha ?? '')) throw new CheckError(`no commit found upstream for ${p}`);
  const date = String(c.commit?.committer?.date ?? '');
  return { sha: c.sha, date: /^\d{4}-\d\d-\d\dT[\d:]+Z$/.test(date) ? date.slice(0, 10) : null };
}

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/** Vendored files whose bytes differ from the lock, are gone, or were added without a lock entry. */
export function localDrift(entry, dir) {
  const sdir = skillDir(dir, entry.name);
  const drift = [];
  for (const [rel, want] of Object.entries(entry.files ?? {})) {
    let abs;
    try {
      abs = resolveInside(sdir, rel);
    } catch {
      drift.push({ file: rel, reason: 'unsafe path in lock' });
      continue;
    }
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      drift.push({ file: rel, reason: 'missing' });
      continue;
    }
    if (sha256(buf) !== want) drift.push({ file: rel, reason: 'modified' });
  }
  const upstreamDir = path.join(sdir, 'upstream');
  if (fs.existsSync(upstreamDir)) {
    for (const f of walk(upstreamDir)) {
      const rel = `upstream/${f}`;
      if (!(rel in (entry.files ?? {}))) drift.push({ file: rel, reason: 'not in lock' });
    }
  }
  return drift;
}

export const compareUrl = (entry, latest) => `${entry.repo}/compare/${entry.commit}...${latest}`;

async function checkSkill(entry, ctx) {
  const slug = repoSlug(entry.repo);
  const out = { name: entry.name, pinned: entry.commit, latest: null, latestDate: null, compareUrl: null, drift: localDrift(entry, ctx.dir), error: null, updateAvailable: false };
  try {
    const latest = await latestPathCommit(slug, entry.path, null, ctx);
    out.latest = latest.sha;
    out.latestDate = latest.date;
    if (latest.sha !== entry.commit) {
      // The pin may be a newer repo HEAD than the last commit that touched this path; only a
      // change under the path counts as an update.
      const atPin = await latestPathCommit(slug, entry.path, entry.commit, ctx);
      out.updateAvailable = atPin.sha !== latest.sha;
      if (out.updateAvailable) out.compareUrl = compareUrl(entry, latest.sha);
    }
  } catch (e) {
    out.error = e instanceof CheckError ? e.message : `unexpected error: ${e?.message ?? e}`;
  }
  out.status = out.error && !out.updateAvailable && !out.drift.length ? 'error'
    : out.updateAvailable && out.drift.length ? 'update-and-drift'
    : out.updateAvailable ? 'update-available'
    : out.drift.length ? 'drift'
    : out.error ? 'error'
    : 'current';
  return out;
}

export async function runCheck(opts = {}) {
  const ctx = ctxFrom(opts);
  const lock = readLock(ctx.dir);
  const skills = await Promise.all(lock.skills.map(s => checkSkill(s, ctx)));
  const update = skills.some(s => s.updateAvailable);
  const drift = skills.some(s => s.drift.length);
  const error = skills.some(s => s.error);
  const exitCode = update && drift ? EXIT.BOTH : update ? EXIT.UPDATE : drift ? EXIT.DRIFT : error ? EXIT.UNKNOWN : EXIT.CURRENT;
  const status = exitCode === EXIT.CURRENT ? 'current' : exitCode === EXIT.UNKNOWN ? 'could-not-check' : 'needs-attention';
  return { status, exitCode, skills };
}

const short = sha => (sha ? sha.slice(0, 7) : '?');
const clean = s => String(s).replace(/[^\w./ ():,'-]/g, '?').slice(0, 120);

/** How to act on a finding, which differs between a repo install and the plugin. */
export function updateHint(m = mode()) {
  return m === 'repo'
    ? 'Do not update silently: tell the owner, and update only via `node .claude/kit/lib/review-skills-check.mjs --fetch <skill>` on a branch with a PR whose diff has been read (or take a newer kit release, which carries the reviewed copies).'
    : 'Do not update silently: tell the owner. In the plugin the skills change only with a new project-kit release, which the owner reviews before updating the plugin.';
}

export function formatReport(result, m = mode()) {
  const lines = [];
  for (const s of result.skills) {
    const head = s.name.padEnd(20);
    if (s.status === 'current') lines.push(`${head} current            pinned ${short(s.pinned)}${s.latestDate ? ` (upstream last changed ${s.latestDate})` : ''}`);
    if (s.updateAvailable) lines.push(`${head} UPDATE AVAILABLE   pinned ${short(s.pinned)} -> latest ${short(s.latest)}${s.latestDate ? ` (${s.latestDate})` : ''}\n${' '.repeat(21)}compare: ${s.compareUrl}`);
    for (const d of s.drift) lines.push(`${head} LOCAL DRIFT        ${clean(d.file)} (${d.reason})`);
    if (s.error) lines.push(`${head} COULD NOT CHECK    ${clean(s.error)}`);
  }
  const verdict = {
    current: 'All vendored review skills are current.',
    'could-not-check': 'COULD NOT CHECK upstream: this is NOT an "up to date" result. Retry later.',
    'needs-attention': `Attention needed. ${updateHint(m)}`,
  }[result.status];
  return `${lines.join('\n')}\n${verdict}\n`;
}

// ---------------------------------------------------------------- --fetch

function isTextFile(rel) {
  const base = rel.split('/').pop();
  return base === 'LICENSE' || TEXT_EXT.has(path.extname(base).toLowerCase());
}

function decodeText(buf, label) {
  if (buf.length > MAX_FILE_BYTES) throw new CheckError(`${label} is larger than ${MAX_FILE_BYTES} bytes`);
  if (buf.includes(0)) throw new CheckError(`${label} contains NUL bytes: not a text file`);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new CheckError(`${label} is not valid UTF-8 text`);
  }
}

function assertRealInside(dirRealBase, target) {
  // Walk up to the nearest existing ancestor and make sure symlinks do not lead out of the skill folder.
  let probe = target;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const real = fs.realpathSync(probe);
  if (real !== dirRealBase && !real.startsWith(dirRealBase + path.sep)) {
    throw new CheckError(`refusing to write through a symlink out of the skill folder: ${target}`);
  }
}

export async function fetchSkill(name, opts = {}) {
  const ctx = ctxFrom(opts);
  const lock = readLock(ctx.dir);
  const entry = lock.skills.find(s => s.name === name);
  if (!entry) throw new CheckError(`no skill "${name}" in the lock (have: ${lock.skills.map(s => s.name).join(', ')})`);
  const slug = repoSlug(entry.repo);
  const sdir = skillDir(ctx.dir, entry.name);
  const upstreamDir = path.join(sdir, 'upstream');
  const today = (opts.today ?? new Date().toISOString().slice(0, 10));

  const latest = await latestPathCommit(slug, entry.path, null, ctx);
  const tree = await getJson(`${ctx.apiBase}/repos/${slug}/git/trees/${latest.sha}?recursive=1`, ctx);
  if (!tree || !Array.isArray(tree.tree) || tree.truncated) throw new CheckError('upstream file tree unavailable or truncated');

  const skipRel = Array.isArray(lock.notVendored?.[name]) ? new Set(lock.notVendored[name]) : new Set();
  const wanted = new Map(); // local rel (under the skill folder) -> upstream path
  const skipped = [];
  for (const t of tree.tree) {
    if (t.type !== 'blob' || !t.path.startsWith(`${entry.path}/`)) continue;
    const rel = t.path.slice(entry.path.length + 1);
    if (skipRel.has(rel)) continue;
    if (t.mode === '120000') { skipped.push(`${rel} (symlink)`); continue; }
    if (!isTextFile(rel)) { skipped.push(`${rel} (not a text type)`); continue; }
    wanted.set(`upstream/${rel}`, t.path);
  }
  if (entry.licenceUpstreamPath) {
    const lic = tree.tree.find(t => t.type === 'blob' && t.path === entry.licenceUpstreamPath);
    if (!lic) throw new CheckError(`licence file ${entry.licenceUpstreamPath} not found upstream`);
    wanted.set(entry.licenceFile, lic.path);
  } else if (!wanted.has(entry.licenceFile)) {
    throw new CheckError(`licence file ${entry.licenceFile} not found upstream under ${entry.path}`);
  }

  // Download and validate everything in memory first; write only if all of it is good.
  const downloaded = new Map();
  for (const [rel, up] of wanted) {
    if (!rel.startsWith('upstream/')) throw new CheckError(`refusing destination outside upstream/: ${rel}`);
    resolveInside(sdir, rel);
    const res = await httpGet(`${ctx.rawBase}/${slug}/${latest.sha}/${up.split('/').map(encodeURIComponent).join('/')}`, ctx, 'text/plain');
    const buf = Buffer.from(await res.arrayBuffer());
    decodeText(buf, up);
    downloaded.set(rel, buf);
  }

  fs.mkdirSync(upstreamDir, { recursive: true });
  const realBase = fs.realpathSync(upstreamDir);
  const written = [];
  const files = {};
  for (const rel of [...downloaded.keys()].sort()) {
    const abs = resolveInside(sdir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    assertRealInside(realBase, path.dirname(abs));
    if (fs.existsSync(abs) && fs.lstatSync(abs).isSymbolicLink()) fs.unlinkSync(abs);
    const buf = downloaded.get(rel);
    files[rel] = sha256(buf);
    const old = fs.existsSync(abs) ? sha256(fs.readFileSync(abs)) : null;
    if (old !== files[rel]) {
      fs.writeFileSync(abs, buf, { mode: 0o644 });
      written.push(`${old ? 'updated' : 'added'} ${rel}`);
    }
  }
  const removed = [];
  for (const rel of Object.keys(entry.files ?? {})) {
    if (downloaded.has(rel)) continue;
    const abs = resolveInside(sdir, rel);
    if (fs.existsSync(abs)) { fs.unlinkSync(abs); removed.push(`removed ${rel}`); }
  }

  const plugin = downloaded.get('upstream/.claude-plugin/plugin.json');
  if (plugin) {
    try {
      const v = JSON.parse(plugin.toString('utf8')).version;
      if (typeof v === 'string' && /^[\w.+-]{1,30}$/.test(v)) entry.upstreamVersion = v;
    } catch { /* keep the old version string */ }
  }
  const previous = entry.commit;
  entry.commit = latest.sha;
  entry.fetchedAt = today;
  entry.files = files;
  fs.writeFileSync(lockPath(ctx.dir), `${JSON.stringify(lock, null, 2)}\n`);
  return { name, previous, commit: latest.sha, changes: [...written, ...removed], skipped, compareUrl: previous === latest.sha ? null : compareUrl({ ...entry, commit: previous }, latest.sha) };
}

// ---------------------------------------------------------------- session-start reminder

const stateFile = opts => opts.stateFile ?? path.join(stateDir(), 'review-skills.json');

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

export function hookMessage(result, m = mode()) {
  const lines = ['REVIEW SKILLS CHECK (project-kit): the vendored review skills need attention.'];
  for (const s of result.skills) {
    if (s.updateAvailable) lines.push(`- ${s.name}: pinned ${short(s.pinned)}, latest ${short(s.latest)}. Compare: ${s.compareUrl}`);
    for (const d of s.drift.slice(0, 5)) lines.push(`- ${s.name}: local drift in ${clean(d.file)} (${d.reason}); vendored files must match the lock.`);
    if (s.drift.length > 5) lines.push(`- ${s.name}: ... and ${s.drift.length - 5} more drifted files.`);
  }
  lines.push(updateHint(m));
  return lines.join('\n');
}

/**
 * Throttled: after a clean check wait 7 days; after a check that found something, remind again after 1 day;
 * after a failed check (network, rate limit) the success time is untouched so the next session retries.
 * Returns the context string to show, or null for silence. Never throws.
 */
export async function runHook(opts = {}) {
  const now = opts.now ?? Date.now();
  const file = stateFile(opts);
  try {
    const dir = path.resolve(opts.skillsDir ?? defaultSkillsDir());
    if (!fs.existsSync(lockPath(dir))) return null;
    const state = readState(file);
    const wait = state.lastResult === 'current' ? 7 * DAY : DAY;
    if (!opts.force && state.lastSuccessAt && now - Date.parse(state.lastSuccessAt) < wait) return null;
    const result = await runCheck({ ...opts, skillsDir: dir });
    const failed = result.skills.some(s => s.error);
    const found = result.skills.some(s => s.updateAvailable || s.drift.length);
    if (failed && !found) {
      writeState(file, { ...state, lastFailure: { at: new Date(now).toISOString(), message: clean(result.skills.find(s => s.error).error) } });
      return null;
    }
    const next = { lastSuccessAt: failed ? state.lastSuccessAt : new Date(now).toISOString(), lastResult: found || failed ? 'findings' : 'current', lastFailure: failed ? { at: new Date(now).toISOString(), message: clean(result.skills.find(s => s.error).error) } : null };
    writeState(file, next);
    return found ? hookMessage(result, opts.mode) : null;
  } catch (e) {
    try {
      writeState(file, { ...readState(file), lastFailure: { at: new Date(now).toISOString(), message: clean(e?.message ?? e) } });
    } catch { /* never fail the session */ }
    return null;
  }
}

// ---------------------------------------------------------------- CLI

async function main(argv) {
  const args = argv.slice(2);
  const opt = name => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const common = { skillsDir: opt('--skills-dir'), timeoutMs: Number(opt('--timeout') ?? 15000), apiBase: opt('--api-base'), rawBase: opt('--raw-base') };
  if (args.includes('--fetch')) {
    const name = opt('--fetch');
    if (!name || name.startsWith('--')) throw new CheckError('usage: --fetch <skill>');
    const r = await fetchSkill(name, common);
    console.log(`${r.name}: ${r.previous === r.commit ? 'already at' : `${short(r.previous)} ->`} ${short(r.commit)}`);
    for (const c of r.changes) console.log(`  ${c}`);
    for (const s of r.skipped) console.log(`  NOT vendored (review by hand): ${clean(s)}`);
    if (!r.changes.length) console.log('  no file changes');
    if (r.compareUrl) console.log(`compare: ${r.compareUrl}`);
    console.log('Nothing is committed. Read `git diff` line by line (these are instructions agents will follow), check the wrapper SKILL.md still\nmatches, then commit on a branch and open a PR. Do not merge a diff you have not read.');
    return 0;
  }
  if (args.includes('--check')) {
    const result = await runCheck(common);
    if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else process.stdout.write(formatReport(result));
    return result.exitCode;
  }
  console.error('usage: review-skills-check.mjs --check [--json] | --fetch <skill>   (see the header of this file)');
  return EXIT.USAGE;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).then(
    code => process.exit(code),
    e => {
      console.error(e instanceof CheckError ? `error: ${e.message}` : e);
      process.exit(EXIT.UNKNOWN);
    },
  );
}
