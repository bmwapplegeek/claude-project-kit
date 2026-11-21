// The plugin side: manifests, the double-fire guard, the "kit not installed here" note, and what the kit may
// not contain. Run: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { KIT, RUN_SH, makeRepo, payload, runHook, tmp } from './helpers.mjs';
import { install } from '../install.mjs';

const readJson = (rel) => JSON.parse(readFileSync(join(KIT, rel), 'utf8'));

function kitFiles(dir = KIT, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) kitFiles(p, out); else out.push(relative(KIT, p));
  }
  return out;
}

test('manifest: plugin.json and marketplace.json have the shape the docs require', () => {
  const p = readJson('.claude-plugin/plugin.json');
  assert.match(p.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.doesNotMatch(p.name, /^(claude|anthropic|cc-plugin)/, 'reserved prefixes');
  assert.equal(p.version, readFileSync(join(KIT, 'VERSION'), 'utf8').trim(), 'plugin.json version == VERSION');
  assert.equal(p.license, 'MIT');
  const m = readJson('.claude-plugin/marketplace.json');
  assert.match(m.name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  assert.ok(m.owner?.name);
  assert.equal(m.plugins.length, 1);
  assert.equal(m.plugins[0].name, p.name);
  assert.equal(m.plugins[0].source, './', 'the kit folder is the plugin root');
  assert.equal(m.plugins[0].version, undefined, 'version lives in plugin.json only');
});

test('manifest: hooks/hooks.json wraps the event map and calls files that exist', () => {
  const h = readJson('hooks/hooks.json');
  assert.deepEqual(Object.keys(h), ['hooks']);
  assert.deepEqual(Object.keys(h.hooks).sort(), ['PreToolUse', 'SessionStart']);
  for (const groups of Object.values(h.hooks)) {
    for (const g of groups) {
      for (const hk of g.hooks) {
        assert.equal(hk.type, 'command');
        assert.match(hk.command, /^bash "\$\{CLAUDE_PLUGIN_ROOT\}\/lib\/hooks\/run\.sh" (pre-bash|session-start) "\$\{CLAUDE_PLUGIN_DATA\}"$/);
      }
    }
  }
  assert.ok(existsSync(RUN_SH));
  for (const s of ['code-review', 'differential-review']) assert.ok(existsSync(join(KIT, 'skills', s, 'SKILL.md')));
  assert.ok(!existsSync(join(KIT, 'bin')), 'a top-level bin/ stops claude.ai from installing the plugin');
  assert.ok(!existsSync(join(KIT, 'CLAUDE.md')), 'a CLAUDE.md at the plugin root is not loaded and draws a warning');
});

test('every layer path in layers.json exists', () => {
  const reg = readJson('layers.json');
  for (const [name, l] of Object.entries(reg.layers)) {
    for (const p of l.lib || []) assert.ok(existsSync(join(KIT, 'lib', p)), `${name}: lib/${p}`);
    for (const src of Object.keys(l.files || {})) assert.ok(existsSync(join(KIT, src)), `${name}: ${src}`);
    if (l.claudeMd) assert.ok(existsSync(join(KIT, l.claudeMd)), `${name}: ${l.claudeMd}`);
  }
  for (const [name, list] of Object.entries(reg.presets)) {
    for (const l of list) assert.ok(l === 'ci-auto' || reg.layers[l], `preset ${name}: ${l}`);
  }
});

// Throttles pre-seeded, so session-start makes no network call in tests.
function quietState() {
  const dir = tmp('kit-state-');
  const now = new Date().toISOString();
  writeFileSync(join(dir, 'review-skills.json'), JSON.stringify({ lastSuccessAt: now, lastResult: 'current' }));
  writeFileSync(join(dir, 'kit-update.json'), JSON.stringify({ lastTryAt: now, lastResult: 'current' }));
  return dir;
}
const plugin = (event, stdin, projectDir, state = quietState()) =>
  runHook(RUN_SH, event, stdin, { projectDir, env: { PROJECT_KIT_STATE: state, PROJECT_KIT_MODE: '' }, args: [state] });

test('double fire: in a repo WITHOUT the kit, the plugin guards Bash', () => {
  const r = makeRepo();
  const res = plugin('pre-bash', payload('git add -A', r), r);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /no-sweep-staging/);
});

test('double fire: in a repo WITH its own install, the plugin is silent and the repo copy blocks once', () => {
  const r = makeRepo();
  install({ target: r, preset: 'basic', log: () => {}, download: false });
  const viaPlugin = plugin('pre-bash', payload('git add -A', r), r);
  assert.equal(viaPlugin.status, 0);
  assert.equal(viaPlugin.stdout + viaPlugin.stderr, '');
  const start = plugin('session-start', '{}', r);
  assert.equal(start.status, 0);
  assert.equal(start.stdout + start.stderr, '');
  // from a subfolder of that repo too
  mkdirSync(join(r, 'sub'));
  assert.equal(plugin('pre-bash', payload('git add -A', join(r, 'sub')), join(r, 'sub')).status, 0);
  // the repo's own copy is the one that blocks
  const own = runHook(join(r, '.claude/kit/lib/hooks/run.sh'), 'pre-bash', payload('git add -A', r), { projectDir: r, env: { PROJECT_KIT_MODE: '' } });
  assert.equal(own.status, 2);
  assert.match(own.stderr, /no-sweep-staging/);
});

test('nudge: plugin session-start notes a repo without the kit, once a week, and can be silenced', () => {
  const r = makeRepo();
  const state = quietState();
  const first = plugin('session-start', '{}', r, state);
  assert.equal(first.status, 0);
  const out = JSON.parse(first.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /PROJECT KIT NOTE.*missing here: secret scanning, CI/s);
  assert.match(out.hookSpecificOutput.additionalContext, /install\.mjs" --target/);
  assert.equal(plugin('session-start', '{}', r, state).stdout, '', 'quiet for a week');
  const r2 = makeRepo();
  mkdirSync(join(r2, '.claude'));
  writeFileSync(join(r2, '.claude/project-kit.json'), '{"nudge": false}');
  assert.equal(plugin('session-start', '{}', r2).stdout, '');
});

test('run.sh fails open: unknown event and missing node exit 0 and are logged', () => {
  const r = makeRepo();
  const state = tmp('kit-state-');
  const unknown = runHook(RUN_SH, 'what', '{}', { projectDir: r, env: { PROJECT_KIT_STATE: state } });
  assert.equal(unknown.status, 0);
  // A PATH with bash, git and coreutils but no node.
  const bin = tmp('kit-bin-');
  for (const tool of ['bash', 'git', 'dirname', 'cat', 'date', 'mkdir']) {
    const at = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (at) symlinkSync(at, join(bin, tool));
  }
  const noNode = runHook(RUN_SH, 'pre-bash', payload('git add -A', r), { projectDir: r, env: { PROJECT_KIT_STATE: state, PATH: bin } });
  assert.equal(noNode.status, 0, noNode.stderr);
  const log = readFileSync(join(state, 'hook-errors.log'), 'utf8');
  assert.match(log, /unknown event 'what'/);
  assert.match(log, /node not found/);
});

test('repo githooks step: re-wires core.hooksPath on a fresh clone; a missing scanner is fetched at most daily', () => {
  const r = makeRepo();
  install({ target: r, preset: 'basic', log: () => {}, download: false });
  spawnSync('git', ['-C', r, 'config', '--unset', 'core.hooksPath']);
  const state = tmp('kit-state-');
  writeFileSync(join(state, 'gitleaks-download.json'), JSON.stringify({ at: new Date().toISOString() }));
  const t = Date.now();
  const res = runHook(join(r, '.claude/kit/lib/hooks/run.sh'), 'githooks', '{}', { projectDir: r, env: { PROJECT_KIT_STATE: state, PROJECT_KIT_MODE: '', PATH: process.env.PATH } });
  assert.equal(res.status, 0);
  assert.ok(Date.now() - t < 5000, 'no download attempt inside the day');
  assert.match(res.stderr, /core\.hooksPath -> \.githooks/);
  assert.doesNotMatch(res.stderr, /gitleaks/);
  assert.equal(spawnSync('git', ['-C', r, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).stdout.trim(), '.githooks');
});

// ---------------------------------------------------------------- what the kit may not contain
const HOME = ['bmwapplegeek', 'claude-project-kit'].join('/');
// Generic leaks only. A source repo that holds the kit can add its own names in its publish step, outside the kit.
const FORBIDDEN = [
  /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, /\b192\.168\.\d{1,3}\.\d{1,3}\b/, /\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/,
  /\/mnt\/workspaces\//, /\/home\/[a-z][a-z0-9_-]*\//, /\/Users\/[A-Za-z][A-Za-z0-9_-]*\//,
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z][A-Za-z.]+/g;
const EMAIL_OK = /@example\.com$/;

test('no private addresses, machine paths or personal emails anywhere in the kit', () => {
  const hits = [];
  for (const f of kitFiles()) {
    const text = readFileSync(join(KIT, f), 'utf8');
    for (const re of FORBIDDEN) if (re.test(text)) hits.push(`${f}: ${re}`);
    if (f.includes('/upstream/')) continue; // third-party files, verbatim
    for (const e of text.match(EMAIL) || []) if (!EMAIL_OK.test(e)) hits.push(`${f}: email ${e}`);
  }
  assert.deepEqual(hits, []);
});

test('the files that name the kit\'s home are exactly the known list (a move edits these)', () => {
  const naming = kitFiles().filter((f) => readFileSync(join(KIT, f), 'utf8').includes(HOME)).sort();
  assert.deepEqual(naming, ['.claude-plugin/plugin.json', 'INSTALL.md', 'README.md', 'kit.config.json']);
});
