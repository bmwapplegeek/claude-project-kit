// install.mjs against throwaway repos. Run: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { KIT, git, hasGitleaks, makeRepo, payload, tmp } from './helpers.mjs';
import { install, uninstall, mergeSettings, plannedFiles, upsertMarked, removeMarked } from '../install.mjs';

const MD_START = '<!-- >>> project-kit';
const quiet = { log: () => {}, download: false };
const run = (target, o = {}) => install({ target, preset: null, with: null, dryRun: false, force: false, ...quiet, ...o });
const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');

/** sha256 of every file in the work tree (not .git), for byte-identical comparisons. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex') + (statSync(p).mode & 0o111 ? 'x' : '');
    }
  };
  walk(dir);
  return out;
}

test('fresh install (basic): files, hooks, CLAUDE.md block, .gitignore, pre-commit, hooksPath', () => {
  const r = makeRepo();
  const rep = run(r, { preset: 'basic' });
  assert.deepEqual(rep.layers, ['core']);
  for (const f of ['.claude/kit/lib/hooks/run.sh', '.claude/kit/lib/bash-guard/rules/core/no-sweep-staging.mjs',
    '.claude/skills/code-review/SKILL.md', '.claude/skills/review-skills.lock.json', '.gitleaks.toml', '.claude/kit/installed.json']) {
    assert.ok(existsSync(join(r, f)), f);
  }
  assert.ok(!existsSync(join(r, '.claude/kit/lib/jobs')), 'jobs layer not installed');
  assert.ok(statSync(join(r, '.claude/kit/lib/hooks/run.sh')).mode & 0o100, 'run.sh is executable');
  const s = JSON.parse(read(r, '.claude/settings.json'));
  assert.equal(s.hooks.SessionStart.length, 2);
  assert.equal(s.hooks.PreToolUse[0].matcher, 'Bash');
  const md = read(r, 'CLAUDE.md');
  assert.equal(md.split(MD_START).length, 2, 'exactly one block');
  assert.match(md, /<!-- <<< project-kit <<< -->\n$/);
  assert.match(md, /Stage files by name/);
  assert.doesNotMatch(md, /One worktree per job/);
  assert.match(read(r, '.gitignore'), /\.claude\/kit\/state\/\n\.claude\/kit\/bin\//);
  assert.match(read(r, '.githooks/pre-commit'), /^#!\/usr\/bin\/env bash\n# >>> project-kit >>>[\s\S]*scan-staged\.sh[\s\S]*exit 0\n$/);
  assert.equal(git(r, 'config', '--get', 'core.hooksPath'), '.githooks');
});

test('idempotent: a second run reports nothing and changes no byte', () => {
  const r = makeRepo();
  run(r, { preset: 'phoenix' });
  const before = snapshot(r);
  const rep = run(r);
  for (const k of ['added', 'updated', 'removed', 'merged', 'kept']) assert.deepEqual(rep[k], [], k);
  assert.deepEqual(rep.layers, ['core', 'jobs', 'phoenix'], 'no --preset keeps the installed layers');
  assert.deepEqual(snapshot(r), before);
});

test('merge, never clobber: existing settings, CLAUDE.md, .gitignore and pre-commit are kept', () => {
  const r = makeRepo();
  mkdirSync(join(r, '.claude'));
  const mine = { permissions: { allow: ['Bash(npm test)'] }, hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo mine' }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] } };
  writeFileSync(join(r, '.claude/settings.json'), JSON.stringify(mine));
  writeFileSync(join(r, 'CLAUDE.md'), '# My project\n\nOwn rules.\n');
  writeFileSync(join(r, '.gitignore'), 'node_modules/\n');
  mkdirSync(join(r, '.git/hooks'), { recursive: true });
  writeFileSync(join(r, '.git/hooks/pre-commit'), '#!/bin/sh\necho own-hook\n', { mode: 0o755 });
  run(r, { preset: 'basic' });
  const s = JSON.parse(read(r, '.claude/settings.json'));
  assert.deepEqual(s.permissions, mine.permissions);
  assert.deepEqual(s.hooks.Stop, mine.hooks.Stop);
  assert.equal(s.hooks.PreToolUse[0].matcher, 'Write', 'own hook keeps its place');
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.match(read(r, 'CLAUDE.md'), /^# My project\n\nOwn rules\.\n\n<!-- >>> project-kit/);
  assert.match(read(r, '.gitignore'), /^node_modules\/\n\n# >>> project-kit >>>/);
  const hook = read(r, '.git/hooks/pre-commit');
  assert.match(hook, /^#!\/bin\/sh\n# >>> project-kit >>>[\s\S]*# <<< project-kit <<<\necho own-hook\n$/);
  assert.equal(JSON.parse(read(r, '.claude/kit/installed.json')).githooks.kind, 'local');

  // uninstall puts every one of them back
  uninstall({ target: r, log: () => {} });
  assert.deepEqual(JSON.parse(read(r, '.claude/settings.json')), mine);
  assert.equal(read(r, 'CLAUDE.md'), '# My project\n\nOwn rules.\n');
  assert.equal(read(r, '.gitignore'), 'node_modules/\n');
  assert.equal(read(r, '.git/hooks/pre-commit'), '#!/bin/sh\necho own-hook\n');
  assert.ok(!existsSync(join(r, '.claude/kit')));
  assert.ok(!existsSync(join(r, '.claude/skills')));
  assert.ok(!existsSync(join(r, '.gitleaks.toml')));
});

test('uninstall of a fresh install leaves the repo as it was, hooksPath unset', () => {
  const r = makeRepo();
  const before = snapshot(r);
  run(r, { preset: 'phoenix' });
  uninstall({ target: r, log: () => {} });
  assert.deepEqual(snapshot(r), before);
  assert.equal(spawnSync('git', ['-C', r, 'config', '--get', 'core.hooksPath']).status, 1);
});

test('a kit file the repo changed is kept; --force overwrites it', () => {
  const r = makeRepo();
  run(r, { preset: 'basic' });
  const f = join(r, '.claude/skills/code-review/SKILL.md');
  writeFileSync(f, 'local edit\n');
  const rep = run(r);
  assert.equal(readFileSync(f, 'utf8'), 'local edit\n');
  assert.match(rep.kept.join('\n'), /code-review\/SKILL\.md \(changed in this repo/);
  run(r, { force: true });
  assert.notEqual(readFileSync(f, 'utf8'), 'local edit\n');
});

test('changing layers adds and removes their files, pre-commit lines and CLAUDE.md sections', () => {
  const r = makeRepo();
  run(r, { with: ['core', 'jobs', 'phoenix'] });
  assert.match(read(r, '.githooks/pre-commit'), /main-dir-check\.sh/);
  assert.match(read(r, 'CLAUDE.md'), /One worktree per job/);
  const rep = run(r, { with: ['core'] });
  assert.ok(rep.removed.includes('.claude/kit/lib/jobs/job.mjs'));
  assert.ok(!existsSync(join(r, '.claude/kit/lib/phoenix')));
  assert.doesNotMatch(read(r, '.githooks/pre-commit'), /main-dir-check/);
  assert.doesNotMatch(read(r, 'CLAUDE.md'), /One worktree per job|Phoenix Studio/);
});

test('ci-auto picks the Node workflow when package.json exists; once installed it is the repo\'s', () => {
  const r = makeRepo();
  writeFileSync(join(r, 'package.json'), '{"name":"x","scripts":{"test":"node -e 0"}}');
  const rep = run(r, { preset: 'phoenix' });
  assert.ok(rep.layers.includes('ci-node'));
  const wf = join(r, '.github/workflows/project-kit-ci-node.yml');
  assert.ok(existsSync(wf));
  writeFileSync(wf, `${readFileSync(wf, 'utf8')}# local\n`);
  const again = run(r);
  assert.match(readFileSync(wf, 'utf8'), /# local\n$/);
  assert.match(again.kept.join('\n'), /project-kit-ci-node\.yml/);
});

test('refusals: invalid settings.json writes nothing; unknown layer; the kit folder itself; not a repo', () => {
  const r = makeRepo();
  mkdirSync(join(r, '.claude'));
  writeFileSync(join(r, '.claude/settings.json'), '{ broken');
  const before = snapshot(r);
  assert.throws(() => run(r, { preset: 'basic' }), /not valid JSON/);
  assert.deepEqual(snapshot(r), before);
  assert.throws(() => run(makeRepo(), { with: ['nope'] }), /unknown layer/);
  assert.throws(() => run(KIT), /own source folder/);
  assert.throws(() => run(tmp('kit-notrepo-')), /not inside a git work tree/);
});

test('--dry-run writes nothing', () => {
  const r = makeRepo();
  const before = snapshot(r);
  const rep = run(r, { preset: 'phoenix', dryRun: true });
  assert.ok(rep.added.length > 30);
  assert.deepEqual(snapshot(r), before);
});

test('helpers: marked blocks and settings merge', () => {
  const t = upsertMarked('a\n', '#S', '#E', 'one');
  assert.equal(t, 'a\n\n#S\none\n#E\n');
  assert.equal(upsertMarked(t, '#S', '#E', 'two'), 'a\n\n#S\ntwo\n#E\n');
  assert.equal(removeMarked(t, '#S', '#E'), 'a\n');
  assert.throws(() => mergeSettings({ hooks: [] }), /not an object/);
  assert.deepEqual(mergeSettings(mergeSettings({ model: 'x' }), true), { model: 'x' });
});

test('the installed hook command blocks `git add -A` and allows staging by name', () => {
  const r = makeRepo();
  run(r, { preset: 'basic' });
  const cmd = JSON.parse(read(r, '.claude/settings.json')).hooks.PreToolUse[0].hooks[0].command;
  const exec = (command) => spawnSync('bash', ['-c', cmd], {
    input: payload(command, r), encoding: 'utf8', cwd: r, env: { ...process.env, CLAUDE_PROJECT_DIR: r },
  });
  const blocked = exec('git add -A');
  assert.equal(blocked.status, 2, blocked.stderr);
  assert.match(blocked.stderr, /no-sweep-staging/);
  assert.equal(exec('git add a.txt').status, 0);
  // a checkout without the kit files (an old branch): silent, exit 0
  const bare = makeRepo();
  const r2 = spawnSync('bash', ['-c', cmd], { input: payload('git add -A', bare), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: bare } });
  assert.equal(r2.status, 0);
  assert.equal(r2.stderr, '');
});

test('no installed path carries a gitleaks keyword (installed.json pairs each path with a hash)', () => {
  // gitleaks' generic-api-key rule fires on <keyword...>": "<long token>"; a path such as secret-scan.sh next to
  // its sha256 blocked the kit's own install commit in a repo that keeps its own .gitleaks.toml.
  const KEYWORD = /access|auth|credential|creds|key|passw(or)?d|secret|token/i;
  const hits = [...plannedFiles(['core', 'jobs', 'phoenix', 'ci-node']).keys()].filter((p) => KEYWORD.test(p) || /[Aa]pi|API/.test(p));
  assert.deepEqual(hits, []);
});

test('a fresh install commits cleanly; then a planted secret is refused', { skip: hasGitleaks() ? false : 'gitleaks not on PATH (the scratch-repo run in the PR covers it)' }, () => {
  const r = makeRepo();
  run(r, { preset: 'phoenix' });
  rmSync(join(r, '.gitleaks.toml')); // a repo with its own config does not get the kit's allowlist
  const files = git(r, 'status', '--porcelain', '--untracked-files=all').split('\n').map((l) => l.slice(3));
  git(r, 'add', ...files);
  const install = spawnSync('git', ['-C', r, 'commit', '-m', 'install the kit'], { encoding: 'utf8' });
  assert.equal(install.status, 0, install.stdout + install.stderr);
  const key = ['AKIA', 'QYLPMN5HHHFPZAM2'].join('');
  writeFileSync(join(r, 'config.js'), `const aws_access_key_id = "${key}";\nconst secret = "${['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCYzEXAMPLEKEY'].join('/')}";\n`);
  git(r, 'add', 'config.js');
  const c = spawnSync('git', ['-C', r, 'commit', '-m', 'add config'], { encoding: 'utf8' });
  assert.equal(c.status, 1, c.stdout + c.stderr);
  assert.match(c.stderr, /BLOCKED \(project-kit\)/);
});
