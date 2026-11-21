// How a repo extends the kit without forking it: its own guard rules (.claude/guard-rules/), its own job and
// pre-deploy commands (.claude/project-kit.json), and a tracked hooks dir it already used. Run: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT, git, makeRepo, payload, runHook, tmp } from './helpers.mjs';
import { install } from '../install.mjs';
import { kitCommands } from '../lib/kit-env.mjs';
import { evaluate, ruleFiles } from '../lib/bash-guard/bash-guard.mjs';

const quiet = { log: () => {}, download: false, preset: null, with: null, dryRun: false, force: false };
const CFG = { jobs: { startCommand: 'scripts/job-start', finishCommand: 'scripts/job-finish' }, predeploy: { checkCommand: 'node scripts/predeploy-check.mjs' } };
const writeCfg = (dir, cfg = CFG) => {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'project-kit.json'), JSON.stringify(cfg));
};
const RULE = `export const name = 'no-npm-publish';
export function check({ commands }) { return commands.some((c) => c.name === 'npm' && c.args[0] === 'publish') ? 'Blocked: no npm publish here.' : null; }
`;

test('kitCommands: defaults, repo overrides, and unsafe strings ignored', () => {
  const d = kitCommands({});
  assert.equal(d.jobStart, 'node .claude/kit/lib/jobs/job.mjs start');
  assert.deepEqual(d.custom, { jobStart: false, jobFinish: false, predeployCheck: false });
  const c = kitCommands(CFG);
  assert.equal(c.jobStart, 'scripts/job-start');
  assert.equal(c.predeployCheck, 'node scripts/predeploy-check.mjs');
  assert.deepEqual(c.custom, { jobStart: true, jobFinish: true, predeployCheck: true });
  for (const bad of ['a`rm -rf`', 'a\nb', '', '   ', 'x'.repeat(201), 42]) {
    assert.equal(kitCommands({ jobs: { startCommand: bad } }).custom.jobStart, false, JSON.stringify(bad));
  }
});

test('repo rules: .claude/guard-rules/*.mjs run after the layers in a repo install, through the real hook', () => {
  const r = makeRepo();
  install({ target: r, ...quiet, preset: 'basic' });
  mkdirSync(join(r, '.claude', 'guard-rules'));
  writeFileSync(join(r, '.claude', 'guard-rules', 'no-npm-publish.mjs'), RULE);
  const runSh = join(r, '.claude/kit/lib/hooks/run.sh');
  const state = tmp('kit-state-');
  const hit = runHook(runSh, 'pre-bash', payload('npm publish', r), { projectDir: r, env: { PROJECT_KIT_STATE: state } });
  assert.equal(hit.status, 2, hit.stderr);
  assert.match(hit.stderr, /\[no-npm-publish\]: Blocked: no npm publish here\./);
  const core = runHook(runSh, 'pre-bash', payload('git add -A', r), { projectDir: r, env: { PROJECT_KIT_STATE: state } });
  assert.match(core.stderr, /\[no-sweep-staging\]/, 'layer rules still come first');
  assert.equal(runHook(runSh, 'pre-bash', payload('npm test', r), { projectDir: r, env: { PROJECT_KIT_STATE: state } }).status, 0);
});

test('repo rules: not loaded in plugin mode; a broken repo rule fails open', async () => {
  assert.ok(ruleFiles(['core']).every((f) => !f.includes('guard-rules')), 'the kit source is plugin mode: no repo dir');
  const dir = tmp('kit-rules-');
  writeFileSync(join(dir, 'broken.mjs'), 'export function check() { throw new Error("boom"); }\n');
  writeFileSync(join(dir, 'z.mjs'), RULE);
  assert.equal(await evaluate('npm ci', tmp(), ['core'], dir), null);
  assert.equal((await evaluate('npm publish', tmp(), ['core'], dir))?.rule, 'no-npm-publish', 'later rules still run');
});

test('jobs rule, pre-commit check and session note name the repo\'s own start command', () => {
  const r = makeRepo();
  writeCfg(r);
  git(r, 'add', '.claude/project-kit.json');
  git(r, 'commit', '-q', '-m', 'cfg');
  install({ target: r, ...quiet, preset: 'phoenix' });
  const runSh = join(r, '.claude/kit/lib/hooks/run.sh');
  const state = tmp('kit-state-');
  const blocked = runHook(runSh, 'pre-bash', payload('git switch -c feat/x', r), { projectDir: r, env: { PROJECT_KIT_STATE: state } });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /`scripts\/job-start <feat\|fix\|chore\|docs>\/<slug>`/);
  assert.doesNotMatch(blocked.stderr, /\.claude\/kit\/lib\/jobs/);
  git(r, 'switch', '-q', '-c', 'feat/left');
  const commit = spawnSync('bash', [join(r, '.claude/kit/lib/githooks/main-dir-check.sh')], { cwd: r, encoding: 'utf8' });
  assert.equal(commit.status, 1);
  assert.match(commit.stderr, /worktree: scripts\/job-start <type>\/<slug>/);
  const md = readFileSync(join(r, 'CLAUDE.md'), 'utf8');
  assert.match(md, /`scripts\/job-start <feat\|fix\|chore\|docs>\/<slug>`/);
  assert.match(md, /`scripts\/job-finish <branch>`/);
  assert.match(md, /`node scripts\/predeploy-check\.mjs`/);
  assert.doesNotMatch(md, /\{\{/, 'every placeholder filled');
});

test('the CLAUDE.md block keeps the kit\'s own commands when the repo names none', () => {
  const r = makeRepo();
  install({ target: r, ...quiet, preset: 'phoenix' });
  const md = readFileSync(join(r, 'CLAUDE.md'), 'utf8');
  assert.match(md, /`node \.claude\/kit\/lib\/jobs\/job\.mjs start <feat/);
  assert.match(md, /`node \.claude\/kit\/lib\/phoenix\/predeploy-check\.mjs`/);
});

test('deploy rule names the repo\'s check; the kit\'s generic check refuses to stand in for it', () => {
  const r = makeRepo();
  writeCfg(r);
  git(r, 'add', '.claude/project-kit.json');
  git(r, 'commit', '-q', '-m', 'cfg');
  install({ target: r, ...quiet, preset: 'phoenix' });
  writeFileSync(join(r, '.gitignore'), '.claude/kit/state/\n');
  const deploy = 'curl -s -X POST "$STUDIO_API_BASE/api/v1/ws/project/deploy"';
  const hook = runHook(join(r, '.claude/kit/lib/hooks/run.sh'), 'pre-bash', payload(deploy, r), { projectDir: r, env: { PROJECT_KIT_STATE: tmp('kit-state-'), PREDEPLOY_ROOT: r } });
  assert.equal(hook.status, 2);
  assert.match(hook.stderr, /Run `node scripts\/predeploy-check\.mjs`/);
  const own = spawnSync('node', [join(r, '.claude/kit/lib/phoenix/predeploy-check.mjs')], {
    cwd: r, encoding: 'utf8', env: { ...process.env, PREDEPLOY_ROOT: r, STUDIO_API_BASE: '', STUDIO_API_TOKEN_FILE: '' },
  });
  assert.equal(own.status, 2, own.stdout + own.stderr);
  assert.match(own.stdout, /own pre-deploy check: `node scripts\/predeploy-check\.mjs`/);
  assert.ok(!existsSync(join(r, '.claude/kit/state/predeploy-stamp.json')), 'no stamp written');
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
  return { root, origin };
}
const job = (cwd, ...args) => spawnSync('node', [join(KIT, 'lib/jobs/job.mjs'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, JOB_WORKTREES_DIR: '' } });

test('jobs: start and finish defer to the repo\'s own commands', () => {
  const { root } = clone();
  writeCfg(root);
  const s = job(root, 'start', 'feat/one');
  assert.equal(s.status, 1);
  assert.match(s.stderr, /this repo starts jobs with `scripts\/job-start`/);
  assert.ok(!existsSync(join(root, '..', 'worktrees', 'feat-one')), 'no worktree made');
  const f = job(root, 'finish', 'feat/one');
  assert.equal(f.status, 1);
  assert.match(f.stderr, /finishes jobs with `scripts\/job-finish`/);
});

test('jobs: the session note lists dirty paths, each worktree\'s state, and merged-and-clean ones', () => {
  const { root } = clone();
  assert.equal(job(root, 'start', 'feat/done').status, 0);
  assert.equal(job(root, 'start', 'feat/busy').status, 0);
  const done = join(root, '..', 'worktrees', 'feat-done');
  const busy = join(root, '..', 'worktrees', 'feat-busy');
  writeFileSync(join(done, 'd.txt'), 'd\n');
  git(done, 'add', 'd.txt');
  git(done, 'commit', '-q', '-m', 'd');
  git(done, 'push', '-q', 'origin', 'HEAD:main'); // "the PR merged"
  git(root, 'fetch', '-q', 'origin');
  writeFileSync(join(busy, 'c.txt'), 'c\n');
  git(busy, 'add', 'c.txt');
  git(busy, 'commit', '-q', '-m', 'c'); // not pushed
  writeFileSync(join(busy, 'b.txt'), 'b\n'); // uncommitted, its owner is still working

  const healthy = job(root, 'session-check').stdout;
  assert.doesNotMatch(healthy, /STOP/);
  assert.match(healthy, /- feat\/done: clean, merged into origin\/main, age 0\.\dh - /);
  assert.match(healthy, /- feat\/busy: 1 uncommitted, 1 commit\(s\) not in origin\/main, age /);
  assert.match(healthy, /probably finished: `node \.claude\/kit\/lib\/jobs\/job\.mjs finish feat\/done`/);
  assert.doesNotMatch(healthy, /finish feat\/busy/);

  git(root, 'switch', '-q', '-c', 'feat/left');
  writeFileSync(join(root, 'a.txt'), 'half done\n');
  writeFileSync(join(root, 'new.ts'), 'x\n');
  const stop = job(root, 'session-check').stdout;
  assert.match(stop, /^STOP \(project-kit jobs\): the main checkout .* is on branch 'feat\/left', not 'main', with 2 uncommitted change\(s\)\./);
  assert.match(stop, /^ {4} M a\.txt$/m);
  assert.match(stop, /^ {4}\?\? new\.ts$/m);
  assert.match(stop.replace(/\n/g, ' '), /do not stash, commit, switch, reset, clean or discard it/);
});

// 2026-11-21 false alarm: a note claimed "3,402 uncommitted changes" with "A " lines for a clean checkout.
const NOT_EVIDENCE = /NOT evidence of uncommitted work/;
const DO_NOT_CLEAN = /Do not stash, commit, reset, clean, switch or discard anything/;
function assertUnreadableNote(text, reasonRe) {
  assert.match(text, /^NOTE \(project-kit jobs\): git state in the main checkout .* could not be read: /);
  assert.match(text, reasonRe);
  assert.match(text.replace(/\n/g, ' '), NOT_EVIDENCE);
  assert.match(text.replace(/\n/g, ' '), DO_NOT_CLEAN);
  assert.match(text, /re-check with `git status`/);
  assert.match(text, /own worktree: `(scripts\/job-start|node \.claude\/kit\/lib\/jobs\/job\.mjs start) /);
  assert.doesNotMatch(text, /STOP/);
  assert.doesNotMatch(text, /uncommitted change\(s\)/, 'no change count');
  assert.doesNotMatch(text, /^ {4}\S/m, 'no file list');
  assert.doesNotMatch(text, /^ *A /m, 'no "A " lines');
}

test('jobs: an unborn HEAD with tracked files in the index is "unreadable", not a pile of added files', () => {
  const { root } = clone();
  // The failure mode: the index still lists every tracked file but HEAD resolves to no commit.
  git(root, 'symbolic-ref', 'HEAD', 'refs/heads/does-not-exist');
  const raw = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).stdout;
  assert.match(raw, /^A /m, 'precondition: plain git status does list tracked files as added');
  const out = job(root, 'session-check').stdout;
  assertUnreadableNote(out, /HEAD does not resolve to a commit \(unborn branch or unreadable refs\)/);
});

test('jobs: a failing git status is "unreadable", never silently "clean"', () => {
  const { root } = clone();
  writeFileSync(join(root, '.git', 'index'), 'this is not an index file\n');
  const out = job(root, 'session-check').stdout;
  assertUnreadableNote(out, /git status failed: /);
});

test('jobs: a job worktree whose state cannot be read shows as unreadable, not clean', () => {
  const { root } = clone();
  assert.equal(job(root, 'start', 'feat/broken').status, 0);
  const wt = join(root, '..', 'worktrees', 'feat-broken');
  const gitDir = git(wt, 'rev-parse', '--path-format=absolute', '--git-dir');
  writeFileSync(join(gitDir, 'index'), 'garbage\n');
  const out = job(root, 'session-check').stdout;
  assert.doesNotMatch(out, /STOP|NOTE/, 'the main checkout itself is fine');
  assert.match(out, /- feat\/broken: state unreadable \(git status failed: .*\) - /);
  assert.doesNotMatch(out, /feat\/broken: clean/);
  assert.doesNotMatch(out, /probably finished/);
});

test('session-start: an unreadable main checkout gets its own message, not "another session\'s work"', () => {
  const r = makeRepo();
  install({ target: r, ...quiet, preset: 'phoenix' });
  git(r, 'symbolic-ref', 'HEAD', 'refs/heads/does-not-exist');
  const res = runHook(join(r, '.claude/kit/lib/hooks/run.sh'), 'session-start', '{}', {
    projectDir: r, env: { PROJECT_KIT_STATE: tmp('kit-state-'), PROJECT_KIT_MODE: '' },
  });
  const out = JSON.parse(res.stdout);
  assert.match(out.systemMessage, /could not read git state in the main checkout.*not evidence of uncommitted work/);
  assert.doesNotMatch(out.systemMessage, /another session/);
  assert.match(out.hookSpecificOutput.additionalContext, /^NOTE \(project-kit jobs\)/);
  assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /STOP/);
});

test('session-start: STOP comes with a user-visible systemMessage', () => {
  const r = makeRepo();
  install({ target: r, ...quiet, preset: 'phoenix' });
  writeFileSync(join(r, 'a.txt'), 'dirty\n');
  const res = runHook(join(r, '.claude/kit/lib/hooks/run.sh'), 'session-start', '{}', {
    projectDir: r, env: { PROJECT_KIT_STATE: tmp('kit-state-'), PROJECT_KIT_MODE: '' },
  });
  const out = JSON.parse(res.stdout);
  assert.match(out.systemMessage, /another session's branch or uncommitted work/);
  assert.match(out.hookSpecificOutput.additionalContext, /^STOP/);
});

test('a corrupt installed.json fails safe: every installed layer\'s rules still run', () => {
  const r = makeRepo();
  install({ target: r, ...quiet, preset: 'phoenix' });
  writeFileSync(join(r, '.claude/kit/installed.json'), '{not json');
  const state = tmp('kit-state-');
  const res = runHook(join(r, '.claude/kit/lib/hooks/run.sh'), 'pre-bash', payload('git switch -c feat/x', r), { projectDir: r, env: { PROJECT_KIT_STATE: state } });
  assert.equal(res.status, 2, 'the jobs rule still blocks');
  assert.match(res.stderr, /\[main-dir-stays-on-main\]/);
  assert.match(readFileSync(join(state, 'hook-errors.log'), 'utf8'), /installed\.json unreadable/);
});

// ---------------------------------------------------------------- githooks
test('githooks: a tracked hooks dir the repo already used is re-wired on a fresh clone, never overridden', () => {
  const r = makeRepo();
  mkdirSync(join(r, '.githooks'));
  writeFileSync(join(r, '.githooks', 'pre-commit'), '#!/usr/bin/env bash\necho repo-check\nexit 0\n');
  git(r, 'config', 'core.hooksPath', '.githooks');
  install({ target: r, ...quiet, preset: 'basic' });
  const inst = JSON.parse(readFileSync(join(r, '.claude/kit/installed.json'), 'utf8'));
  assert.deepEqual(inst.githooks, { kind: 'tracked', dir: '.githooks', setHooksPath: false }, 'the repo owns the setting');
  const env = { PROJECT_KIT_STATE: tmp('kit-state-'), PROJECT_KIT_MODE: '' };
  writeFileSync(join(env.PROJECT_KIT_STATE, 'gitleaks-download.json'), JSON.stringify({ at: new Date().toISOString() }));
  const runSh = join(r, '.claude/kit/lib/hooks/run.sh');
  git(r, 'config', '--unset', 'core.hooksPath'); // a fresh clone
  const res = runHook(runSh, 'githooks', '{}', { projectDir: r, env });
  assert.match(res.stderr, /core\.hooksPath -> \.githooks/);
  assert.equal(git(r, 'config', '--get', 'core.hooksPath'), '.githooks');
  git(r, 'config', 'core.hooksPath', '.husky'); // pointed elsewhere on purpose
  runHook(runSh, 'githooks', '{}', { projectDir: r, env });
  assert.equal(git(r, 'config', '--get', 'core.hooksPath'), '.husky', 'left alone');
});
