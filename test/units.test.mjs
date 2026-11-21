// Update check, review-skills check, job worktrees and pre-deploy helpers. No network: fetch and git ls-remote
// are replaced by fakes, and "origin" is a local bare repo. Run: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT, git, makeRepo, tmp } from './helpers.mjs';
import { compareSemver, parseTags, runHook as updateHook, updateMessage } from '../lib/update-check.mjs';
import { localDrift, readLock, runHook as skillsHook } from '../lib/review-skills-check.mjs';
import { judgeStamp, mentionsPrerequisite } from '../lib/phoenix/predeploy-lib.mjs';

const DAY = 864e5;

test('update check: semver compare and tag parsing', () => {
  assert.ok(compareSemver('1.10.0', '1.9.9') > 0);
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  const out = 'a\trefs/tags/v1.2.0\nb\trefs/tags/v1.10.1\nc\trefs/tags/v2.0.0-rc1\nd\trefs/tags/other-v9.0.0\n';
  assert.equal(parseTags(out, 'v'), '1.10.1');
  assert.equal(parseTags('', 'v'), null);
});

test('update check: flags a newer release once a week, never applies it', async () => {
  const home = tmp('kit-home-');
  writeFileSync(join(home, 'VERSION'), '1.0.0\n');
  writeFileSync(join(home, 'kit.config.json'), readFileSync(join(KIT, 'kit.config.json')));
  const stateFile = join(tmp('kit-state-'), 'kit-update.json');
  const latestImpl = async () => ({ version: '1.2.0' });
  const now = Date.parse('2026-01-10T00:00:00Z');
  const msg = await updateHook({ now, home, stateFile, latestImpl });
  assert.match(msg, /v1\.2\.0 is available; this plugin is v1\.0\.0\. Tell the owner\. Do not update silently\./);
  assert.match(msg, /claude plugin update guardrails@project-kit/);
  assert.equal(await updateHook({ now: now + DAY, home, stateFile, latestImpl }), null, 'throttled');
  assert.match(await updateHook({ now: now + 8 * DAY, home, stateFile, latestImpl }), /v1\.2\.0/);
  // a failed check stays silent and retries after a day
  const failFile = join(tmp('kit-state-'), 'kit-update.json');
  assert.equal(await updateHook({ now, home, stateFile: failFile, latestImpl: async () => ({ error: 'offline' }) }), null);
  assert.equal(JSON.parse(readFileSync(failFile, 'utf8')).lastResult, 'failed');
  assert.match(await updateHook({ now: now + DAY + 1, home, stateFile: failFile, latestImpl }), /available/);
});

test('update check: the repo message clones the tag and re-runs the installer', () => {
  const cfg = JSON.parse(readFileSync(join(KIT, 'kit.config.json'), 'utf8'));
  const msg = updateMessage({ installed: '1.0.0', latest: '1.1.0', cfg, m: 'repo' });
  assert.match(msg, /git clone --depth 1 --branch v1\.1\.0 https:\/\/github\.com\/\S+\.git \/tmp\/project-kit-1\.1\.0/);
  assert.match(msg, /node \/tmp\/project-kit-1\.1\.0\/install\.mjs --target \./);
});

test('review skills: the vendored copies match their lock', () => {
  const dir = join(KIT, 'skills');
  const lock = readLock(dir);
  assert.deepEqual(lock.skills.map((s) => s.name), ['code-review', 'differential-review']);
  for (const s of lock.skills) assert.deepEqual(localDrift(s, dir), [], s.name);
  assert.deepEqual(lock.skills.map((s) => s.licence), ['Apache-2.0', 'CC-BY-SA-4.0']);
});

test('review skills: edits and extra files show as drift; an unsafe lock path is refused', () => {
  const dir = tmp('kit-skills-');
  cpSync(join(KIT, 'skills'), dir, { recursive: true });
  writeFileSync(join(dir, 'code-review/upstream/README.md'), 'edited\n');
  writeFileSync(join(dir, 'code-review/upstream/extra.md'), 'x\n');
  const entry = readLock(dir).skills[0];
  assert.deepEqual(localDrift(entry, dir).map((d) => `${d.file}:${d.reason}`).sort(),
    ['upstream/README.md:modified', 'upstream/extra.md:not in lock']);
  const lock = JSON.parse(readFileSync(join(dir, 'review-skills.lock.json'), 'utf8'));
  lock.skills[0].files['upstream/../../x'] = 'a'.repeat(64);
  writeFileSync(join(dir, 'review-skills.lock.json'), JSON.stringify(lock));
  assert.throws(() => readLock(dir), /unsafe path/);
});

test('review skills: an upstream change produces a note with a compare link (fake GitHub)', async () => {
  const dir = join(KIT, 'skills');
  const pinned = readLock(dir).skills;
  const newer = 'f'.repeat(40);
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const pin = pinned.find((s) => u.searchParams.get('sha') === s.commit);
    const sha = pin ? pin.commit : u.searchParams.get('path') === pinned[0].path ? newer : pinned[1].commit;
    return { ok: true, json: async () => [{ sha, commit: { committer: { date: '2026-01-01T00:00:00Z' } } }] };
  };
  const stateFile = join(tmp('kit-state-'), 'review-skills.json');
  const msg = await skillsHook({ skillsDir: dir, stateFile, fetchImpl, mode: 'repo', now: Date.now() });
  assert.match(msg, /REVIEW SKILLS CHECK/);
  assert.match(msg, new RegExp(`code-review: pinned ${pinned[0].commit.slice(0, 7)}, latest fffffff\\. Compare: https://github\\.com/anthropics/claude-plugins-official/compare/${pinned[0].commit}\\.\\.\\.${newer}`));
  assert.doesNotMatch(msg, /differential-review: pinned/);
  assert.match(msg, /Do not update silently/);
  // offline: silent, and the next session tries again
  const off = join(tmp('kit-state-'), 'review-skills.json');
  assert.equal(await skillsHook({ skillsDir: dir, stateFile: off, fetchImpl: async () => { throw new Error('offline'); } }), null);
  assert.ok(JSON.parse(readFileSync(off, 'utf8')).lastFailure);
});

// ---------------------------------------------------------------- jobs
function clone() {
  const origin = tmp('kit-origin-');
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const src = makeRepo();
  git(src, 'remote', 'add', 'origin', origin);
  git(src, 'push', '-q', 'origin', 'main');
  const root = join(tmp('kit-clone-'), 'project');
  spawnSync('git', ['clone', '-q', origin, root]);
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 't');
  return root;
}
const job = (cwd, ...args) => spawnSync('node', [join(KIT, 'lib/jobs/job.mjs'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, JOB_WORKTREES_DIR: '' } });

test('jobs: start makes a worktree beside the repo; finish refuses until merged, then cleans up', () => {
  const root = clone();
  assert.equal(job(root, 'start', 'Feat/Bad').status, 1, 'branch name checked');
  const s = job(root, 'start', 'feat/one');
  assert.equal(s.status, 0, s.stderr);
  const wt = join(root, '..', 'worktrees', 'feat-one');
  assert.ok(existsSync(join(wt, 'a.txt')));
  assert.equal(git(root, 'branch', '--show-current'), 'main', 'main checkout untouched');
  writeFileSync(join(wt, 'b.txt'), 'b\n');
  git(wt, 'add', 'b.txt');
  git(wt, 'commit', '-q', '-m', 'b');
  git(wt, 'push', '-q', '-u', 'origin', 'feat/one');
  const early = job(root, 'finish', 'feat/one');
  assert.equal(early.status, 1);
  assert.match(early.stderr, /not in origin\/main: merge the PR first/);
  git(wt, 'push', '-q', 'origin', 'feat/one:main'); // "the PR merged"
  const done = job(root, 'finish', 'feat/one');
  assert.equal(done.status, 0, done.stderr);
  assert.ok(!existsSync(wt));
  assert.equal(git(root, 'branch', '--list', 'feat/one'), '');
  assert.ok(existsSync(join(root, 'b.txt')), 'main checkout fast-forwarded');
});

test('jobs: session-check says STOP when the main checkout holds someone else\'s work', () => {
  const root = clone();
  assert.equal(job(root, 'session-check').stdout, '');
  writeFileSync(join(root, 'a.txt'), 'edited\n');
  assert.match(job(root, 'session-check').stdout, /STOP \(project-kit jobs\).*1 uncommitted change/);
});

// ---------------------------------------------------------------- phoenix
test('pre-deploy: prerequisite wording and stamp judgement', () => {
  assert.ok(mentionsPrerequisite('feat: x\n\nRun the migration manually before you deploy.'));
  assert.ok(!mentionsPrerequisite('docs: explain the pre-deploy check and --ack-prerequisites'));
  const head = 'a'.repeat(40);
  const now = Date.now();
  assert.equal(judgeStamp({ sha: head, at: new Date(now).toISOString() }, head, now).ok, true);
  assert.equal(judgeStamp(null, head, now).ok, false);
  assert.match(judgeStamp({ sha: head, at: new Date(now - 40 * 60e3).toISOString() }, head, now).reason, /40 min old/);
});

test('pre-deploy: the check fails on a dirty tree and writes no stamp', () => {
  const root = clone();
  writeFileSync(join(root, 'stray.txt'), 'x\n');
  const r = spawnSync('node', [join(KIT, 'lib/phoenix/predeploy-check.mjs'), '--fast'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PREDEPLOY_ROOT: root, STUDIO_API_BASE: '', STUDIO_API_TOKEN_FILE: '' },
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL tree +1 uncommitted path/);
  assert.match(r.stdout, /does NOT authorise a deploy/);
  assert.ok(!existsSync(join(root, '.claude/kit/state/predeploy-stamp.json')));
});
