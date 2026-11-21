#!/usr/bin/env node
// project-kit installer: writes the kit into a git repository so its guardrails travel with the repo.
//
//   node install.mjs [--target <repo>] [--preset basic|phoenix] [--with core,jobs,phoenix,ci-node]
//                    [--dry-run] [--no-download] [--force]
//   node install.mjs --uninstall [--target <repo>] [--dry-run]
//   node install.mjs --list-layers
//
// Non-interactive and idempotent: re-running with the same layers changes nothing. Re-running with no
// --preset/--with keeps the layers already installed (this is also how an update is applied). Fresh default: basic.
//
// MERGE, NEVER CLOBBER
//   - Files the kit owns are tracked by sha256 in .claude/kit/installed.json. A file the repo changed after
//     install is left alone (reported as "kept"); --force overwrites it.
//   - .claude/settings.json: only the kit's hook entries are added/updated/removed; everything else is kept.
//   - CLAUDE.md, .gitignore and the pre-commit hook: the kit owns one marked block in each.
//   - .gitleaks.toml and the CI workflow: created only when absent.
// Nothing is committed: review `git status` / `git diff`, then commit on a branch and open a PR.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { preCommitBlock, upsertBlock, removeBlock, hookTarget, installGitleaks, BLOCK_START } from './lib/githooks/wiring.mjs';
import { kitCommands, userConfig } from './lib/kit-env.mjs';

const KIT = path.dirname(fileURLToPath(import.meta.url));
const HOOK_CMD = '.claude/kit/lib/hooks/run.sh';
const MD_START = '<!-- >>> project-kit (managed block: the installer rewrites it; edit outside it) >>> -->';
const MD_END = '<!-- <<< project-kit <<< -->';
const GI_START = '# >>> project-kit >>>';
const GI_END = '# <<< project-kit <<<';
const NEW_HOOK = (block) => `#!/usr/bin/env bash\n${block}\nexit 0\n`;
const GITLEAKS_TOML = '.gitleaks.toml';

class InstallError extends Error {}
const fail = (m) => { throw new InstallError(m); };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const posix = (p) => p.split(path.sep).join('/');

export const registry = () => JSON.parse(fs.readFileSync(path.join(KIT, 'layers.json'), 'utf8'));
export const kitVersion = () => fs.readFileSync(path.join(KIT, 'VERSION'), 'utf8').trim();

export function parseArgs(argv) {
  const o = { target: process.cwd(), preset: null, with: null, dryRun: false, download: true, force: false, uninstall: false, listLayers: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') o.target = argv[++i];
    else if (a === '--preset') o.preset = argv[++i];
    else if (a === '--with') o.with = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--no-download') o.download = false;
    else if (a === '--force') o.force = true;
    else if (a === '--uninstall') o.uninstall = true;
    else if (a === '--list-layers') o.listLayers = true;
    else fail(`unknown argument: ${a}`);
  }
  if (!o.target) fail('--target needs a directory');
  return o;
}

function gitTop(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}
const gitConfig = (root, args) => execFileSync('git', ['-C', root, 'config', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** Resolve presets, 'ci-auto' and validate names. core is always first. */
export function resolveLayers(o, root, previous) {
  const reg = registry();
  let wanted = o.with ? [...o.with] : o.preset ? reg.presets[o.preset] : previous;
  if (o.preset && !reg.presets[o.preset]) fail(`unknown preset "${o.preset}" (have: ${Object.keys(reg.presets).join(', ')})`);
  if (!wanted) wanted = reg.presets.basic;
  const out = ['core'];
  const notes = [];
  for (const l of wanted) {
    if (l === 'ci-auto') {
      const hit = Object.entries(reg.layers).find(([n, d]) => n.startsWith('ci-') && d.detect && fs.existsSync(path.join(root, d.detect)));
      if (hit) out.push(hit[0]); else notes.push('ci-auto: no CI template matches this repo\'s stack (see layers.json to add one)');
      continue;
    }
    if (!reg.layers[l]) fail(`unknown layer "${l}" (have: ${Object.keys(reg.layers).join(', ')})`);
    if (!out.includes(l)) out.push(l);
  }
  return { layers: out, notes };
}

function walkFiles(abs) {
  if (fs.statSync(abs).isFile()) return [abs];
  return fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => walkFiles(path.join(abs, e.name)));
}

/** Map of repo-relative path -> kit source file for every file the chosen layers own. */
export function plannedFiles(layers) {
  const reg = registry();
  const map = new Map();
  const add = (srcAbs, destRel) => map.set(posix(destRel), srcAbs);
  for (const l of layers) {
    const def = reg.layers[l];
    for (const p of def.lib || []) {
      const abs = path.join(KIT, 'lib', p);
      for (const f of walkFiles(abs)) add(f, path.join('.claude/kit/lib', path.relative(path.join(KIT, 'lib'), f)));
    }
    for (const [src, dest] of Object.entries(def.files || {})) add(path.join(KIT, src), dest);
  }
  add(path.join(KIT, 'kit.config.json'), '.claude/kit/kit.config.json');
  for (const f of walkFiles(path.join(KIT, 'skills'))) add(f, path.join('.claude/skills', path.relative(path.join(KIT, 'skills'), f)));
  return map;
}

// ---------------------------------------------------------------- settings.json

// `test ! -f || bash`: in a checkout that does not have the kit files yet (an old branch, a worktree cut before
// the install was merged) the hook exits 0 silently instead of erroring; otherwise run.sh's exit code (2 = block) stands.
const hookCmd = (event) => `test ! -f "$CLAUDE_PROJECT_DIR/${HOOK_CMD}" || bash "$CLAUDE_PROJECT_DIR/${HOOK_CMD}" ${event}`;
const isOurs = (g) => Array.isArray(g?.hooks) && g.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(HOOK_CMD));

export function desiredHooks() {
  return {
    SessionStart: [
      { hooks: [{ type: 'command', command: hookCmd('session-start'), timeout: 20 }] },
      { hooks: [{ type: 'command', command: hookCmd('githooks'), timeout: 120 }] },
    ],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: hookCmd('pre-bash'), timeout: 5 }] }],
  };
}

export function mergeSettings(settings, remove = false) {
  const s = settings && typeof settings === 'object' && !Array.isArray(settings) ? structuredClone(settings) : {};
  if (s.hooks !== undefined && (typeof s.hooks !== 'object' || Array.isArray(s.hooks))) fail('.claude/settings.json "hooks" is not an object; fix it by hand first');
  const want = remove ? {} : desiredHooks();
  s.hooks = s.hooks || {};
  for (const event of new Set([...Object.keys(s.hooks), ...Object.keys(want)])) {
    const arr = s.hooks[event];
    if (arr !== undefined && !Array.isArray(arr)) fail(`.claude/settings.json hooks.${event} is not an array; fix it by hand first`);
    const list = arr || [];
    const first = list.findIndex(isOurs);
    const kept = list.filter((g) => !isOurs(g));
    const ours = want[event] || [];
    const at = first < 0 ? kept.length : list.slice(0, first).filter((g) => !isOurs(g)).length;
    const next = [...kept.slice(0, at), ...ours, ...kept.slice(at)];
    if (next.length) s.hooks[event] = next; else delete s.hooks[event];
  }
  if (!Object.keys(s.hooks).length) delete s.hooks;
  return s;
}

// ---------------------------------------------------------------- marked text blocks

export function upsertMarked(text, start, end, body) {
  const block = `${start}\n${body.trimEnd()}\n${end}\n`;
  const re = new RegExp(`${esc(start)}[\\s\\S]*?${esc(end)}\\n?`);
  if (text && re.test(text)) return text.replace(re, block);
  if (!text) return block;
  return `${text.endsWith('\n') ? text : `${text}\n`}\n${block}`;
}

/** Exact inverse of upsertMarked: drops the block and the one blank line upsertMarked put before it. */
export function removeMarked(text, start, end) {
  if (!text) return text;
  const re = new RegExp(`\\n?${esc(start)}[\\s\\S]*?${esc(end)}\\n?`);
  return text.replace(re, '');
}

function claudeMdPath(root) {
  if (fs.existsSync(path.join(root, 'CLAUDE.md'))) return 'CLAUDE.md';
  if (fs.existsSync(path.join(root, '.claude', 'CLAUDE.md'))) return '.claude/CLAUDE.md';
  return 'CLAUDE.md';
}

/** The CLAUDE.md block for these layers. {{jobStart}}, {{jobFinish}} and {{predeployCheck}} name the kit's
 *  commands, or the repo's own ones from .claude/project-kit.json (see kitCommands in lib/kit-env.mjs). */
export function claudeMdBody(layers, root) {
  const reg = registry();
  const cmd = kitCommands(userConfig(root));
  return layers.map((l) => reg.layers[l].claudeMd).filter(Boolean)
    .map((t) => fs.readFileSync(path.join(KIT, t), 'utf8').trimEnd())
    .join('\n')
    .replace(/\{\{(jobStart|jobFinish|predeployCheck)\}\}/g, (_, k) => cmd[k]);
}

// ---------------------------------------------------------------- install / uninstall

function makeWriter(root, dryRun, log) {
  return {
    write(rel, content, mode) {
      const abs = path.join(root, rel);
      if (!dryRun) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
        if (mode) fs.chmodSync(abs, mode);
      }
    },
    remove(rel) {
      if (dryRun) return;
      fs.rmSync(path.join(root, rel), { force: true });
      // prune the parent dirs this removal left empty, up to (not including) the repo root
      let d = path.dirname(path.join(root, rel));
      while (d.startsWith(root + path.sep)) {
        try { if (fs.readdirSync(d).length) break; fs.rmdirSync(d); } catch { break; }
        d = path.dirname(d);
      }
    },
    log,
  };
}

export function install(opts) {
  const log = opts.log || console.log;
  const root = gitTop(opts.target);
  if (!root) fail(`${opts.target} is not inside a git work tree`);
  const rel = path.relative(KIT, path.resolve(opts.target));
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) fail('refusing to install the kit into its own source folder');
  const prev = JSON.parse(readText(path.join(root, '.claude/kit/installed.json')) || 'null');
  const { layers, notes } = resolveLayers(opts, root, prev?.layers);
  const version = kitVersion();
  const w = makeWriter(root, opts.dryRun, log);
  const report = { root, version, layers, added: [], updated: [], unchanged: [], kept: [], removed: [], merged: [], notes: [...notes] };
  const created = new Set(prev?.created || []);
  const files = {};

  // Plan settings.json first: invalid JSON aborts before anything is written.
  const settingsRel = '.claude/settings.json';
  const settingsText = readText(path.join(root, settingsRel));
  let settings = {};
  if (settingsText !== null) {
    try { settings = JSON.parse(settingsText); } catch { fail(`${settingsRel} is not valid JSON; fix it first (the kit never overwrites it)`); }
  }
  const nextSettings = mergeSettings(settings);

  // 1. owned files
  const planned = plannedFiles(layers);
  for (const [rel, src] of planned) {
    const want = fs.readFileSync(src);
    const wantSha = sha(want);
    const cur = fs.existsSync(path.join(root, rel)) ? fs.readFileSync(path.join(root, rel)) : null;
    const mode = rel.endsWith('.sh') ? 0o755 : undefined;
    const onceOnly = rel.startsWith('.github/');
    if (cur === null) { w.write(rel, want, mode); report.added.push(rel); files[rel] = wantSha; continue; }
    const curSha = sha(cur);
    if (curSha === wantSha) { report.unchanged.push(rel); files[rel] = wantSha; continue; }
    const ours = prev?.files?.[rel] === curSha;
    if ((ours && !onceOnly) || opts.force) { w.write(rel, want, mode); report.updated.push(rel); files[rel] = wantSha; continue; }
    report.kept.push(`${rel} (${ours ? 'repo-owned once installed' : prev?.files?.[rel] ? 'changed in this repo' : 'already existed, not the kit\'s'}; use --force to overwrite)`);
    if (prev?.files?.[rel]) files[rel] = prev.files[rel];
  }
  // files the kit owned before but no longer ships for these layers
  for (const [rel, oldSha] of Object.entries(prev?.files || {})) {
    if (planned.has(rel) || rel === GITLEAKS_TOML) continue; // the config is created once, below, and never swept
    const cur = readText(path.join(root, rel));
    if (cur !== null && sha(cur) === oldSha) { w.remove(rel); report.removed.push(rel); } else if (cur !== null) report.kept.push(`${rel} (no longer part of the kit, changed in this repo: left in place)`);
  }

  // 2. .gitleaks.toml: create only when absent
  if (!fs.existsSync(path.join(root, GITLEAKS_TOML))) {
    const t = fs.readFileSync(path.join(KIT, 'templates/gitleaks.toml'));
    w.write(GITLEAKS_TOML, t); report.added.push(GITLEAKS_TOML); created.add(GITLEAKS_TOML); files[GITLEAKS_TOML] = sha(t);
  } else if (prev?.files?.[GITLEAKS_TOML]) files[GITLEAKS_TOML] = prev.files[GITLEAKS_TOML];

  // 3. settings.json
  if (JSON.stringify(nextSettings) !== JSON.stringify(settings) || settingsText === null) {
    if (settingsText === null) created.add(settingsRel);
    w.write(settingsRel, `${JSON.stringify(nextSettings, null, 2)}\n`);
    report.merged.push(`${settingsRel} (kit hooks: SessionStart x2, PreToolUse Bash)`);
  }

  // 4. CLAUDE.md block
  const mdRel = claudeMdPath(root);
  const mdOld = readText(path.join(root, mdRel));
  const mdNew = upsertMarked(mdOld || '', MD_START, MD_END, claudeMdBody(layers, root));
  if (mdNew !== mdOld) { if (mdOld === null) created.add(mdRel); w.write(mdRel, mdNew); report.merged.push(`${mdRel} (project-kit block)`); }

  // 5. .gitignore block
  const giOld = readText(path.join(root, '.gitignore'));
  const giNew = upsertMarked(giOld || '', GI_START, GI_END, '# local state and the downloaded scanner of the project kit\n.claude/kit/state/\n.claude/kit/bin/');
  if (giNew !== giOld) { if (giOld === null) created.add('.gitignore'); w.write('.gitignore', giNew); report.merged.push('.gitignore (project-kit block)'); }

  // 6. pre-commit block
  const target = prev?.githooks?.kind === 'tracked' && prev.githooks.setHooksPath ? prev.githooks : hookTarget(root);
  const githooks = target.kind === 'tracked' ? { kind: 'tracked', dir: target.dir, setHooksPath: !!target.setHooksPath } : { kind: 'local' };
  const block = preCommitBlock(layers);
  if (target.kind === 'tracked') {
    const rel = `${target.dir}/pre-commit`;
    const old = readText(path.join(root, rel));
    const next = old === null ? NEW_HOOK(block) : upsertBlock(old, block);
    if (old === null) created.add(rel);
    if (next !== old) { w.write(rel, next, 0o755); report.merged.push(`${rel} (project-kit block)`); }
    if (target.setHooksPath && !opts.dryRun) {
      let cur = '';
      try { cur = gitConfig(root, ['--get', 'core.hooksPath']).trim(); } catch { /* unset */ }
      if (cur !== target.dir) { gitConfig(root, ['core.hooksPath', target.dir]); report.merged.push(`git config core.hooksPath ${target.dir} (this clone; new clones are wired at session start)`); }
    }
  } else {
    const old = readText(target.file) || '';
    const next = upsertBlock(old, block);
    if (next !== old && !opts.dryRun) { fs.mkdirSync(path.dirname(target.file), { recursive: true }); fs.writeFileSync(target.file, next, { mode: 0o755 }); }
    if (next !== old) report.merged.push(`${target.file} (local hook, not tracked: re-applied at every session start)`);
  }

  // 7. manifest (no timestamps: a re-run with the same inputs is byte-identical)
  const manifest = { kit: 'project-kit', version, layers, githooks, files: Object.fromEntries(Object.entries(files).sort()), created: [...created].sort() };
  const mText = `${JSON.stringify(manifest, null, 2)}\n`;
  if (readText(path.join(root, '.claude/kit/installed.json')) !== mText) w.write('.claude/kit/installed.json', mText);

  // 8. scanner binary (gitignored, per clone)
  if (opts.download && !opts.dryRun) {
    const out = installGitleaks(root, { quiet: true });
    if (out) report.notes.push(out);
  }
  return report;
}

export function uninstall(opts) {
  const log = opts.log || console.log;
  const root = gitTop(opts.target);
  if (!root) fail(`${opts.target} is not inside a git work tree`);
  const prev = JSON.parse(readText(path.join(root, '.claude/kit/installed.json')) || 'null');
  if (!prev) fail('the project kit is not installed here (no .claude/kit/installed.json)');
  const w = makeWriter(root, opts.dryRun, log);
  const report = { root, version: prev.version, layers: prev.layers, removed: [], kept: [], merged: [], notes: [] };
  const created = new Set(prev.created || []);

  for (const [rel, oldSha] of Object.entries(prev.files || {})) {
    const cur = readText(path.join(root, rel));
    if (cur === null) continue;
    if (sha(cur) === oldSha && (rel !== '.gitleaks.toml' || created.has(rel))) { w.remove(rel); report.removed.push(rel); }
    else report.kept.push(`${rel} (changed in this repo or not created by the kit)`);
  }
  const settingsRel = '.claude/settings.json';
  const st = readText(path.join(root, settingsRel));
  if (st !== null) {
    let s;
    try { s = JSON.parse(st); } catch { fail(`${settingsRel} is not valid JSON; fix it first`); }
    const next = mergeSettings(s, true);
    if (created.has(settingsRel) && !Object.keys(next).length) { w.remove(settingsRel); report.removed.push(settingsRel); }
    else if (JSON.stringify(next) !== JSON.stringify(s)) { w.write(settingsRel, `${JSON.stringify(next, null, 2)}\n`); report.merged.push(`${settingsRel} (kit hooks removed)`); }
  }
  for (const [rel, start, end] of [[claudeMdPath(root), MD_START, MD_END], ['.gitignore', GI_START, GI_END]]) {
    const old = readText(path.join(root, rel));
    if (old === null) continue;
    const next = removeMarked(old, start, end);
    if (created.has(rel) && !next.trim()) { w.remove(rel); report.removed.push(rel); }
    else if (next !== old) { w.write(rel, next); report.merged.push(`${rel} (project-kit block removed)`); }
  }
  const g = prev.githooks || {};
  const hookFile = g.kind === 'tracked' ? path.join(root, g.dir, 'pre-commit') : hookTarget(root).file;
  const hookRel = g.kind === 'tracked' ? `${g.dir}/pre-commit` : null;
  const old = hookFile ? readText(hookFile) : null;
  if (old !== null && old.includes(BLOCK_START)) {
    const next = removeBlock(old);
    if (hookRel && created.has(hookRel) && next.trim() === '#!/usr/bin/env bash\nexit 0') { w.remove(hookRel); report.removed.push(hookRel); }
    else if (!opts.dryRun) { fs.writeFileSync(hookFile, next); report.merged.push(`${hookRel || hookFile} (project-kit block removed)`); }
  }
  if (g.setHooksPath && !opts.dryRun) {
    try { if (gitConfig(root, ['--get', 'core.hooksPath']).trim() === g.dir) { gitConfig(root, ['--unset', 'core.hooksPath']); report.merged.push('git config --unset core.hooksPath'); } } catch { /* unset already */ }
  }
  if (!opts.dryRun) {
    for (const rel of ['.claude/kit/installed.json', '.claude/kit/state', '.claude/kit/bin']) fs.rmSync(path.join(root, rel), { recursive: true, force: true });
    w.remove('.claude/kit/.placeholder');
  }
  report.removed.push('.claude/kit/installed.json, local state and scanner');
  return report;
}

function print(report, opts, log = console.log) {
  const head = opts.uninstall ? 'project-kit uninstall' : `project-kit ${report.version} install`;
  log(`${head}${opts.dryRun ? ' (DRY RUN: nothing written)' : ''} -> ${report.root}`);
  log(`layers: ${report.layers.join(', ')}`);
  for (const k of ['added', 'updated', 'removed', 'merged', 'kept']) {
    const list = report[k] || [];
    if (list.length) log(`${k} (${list.length}):\n${list.map((x) => `  ${x}`).join('\n')}`);
  }
  if (report.unchanged?.length) log(`unchanged: ${report.unchanged.length} file(s)`);
  for (const n of report.notes) log(`note: ${n}`);
  if (!opts.dryRun) log('\nNothing is committed. Review `git status` and `git diff`, commit on a branch (stage files by name), and open a pull request.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.listLayers) {
      const reg = registry();
      for (const [n, d] of Object.entries(reg.layers)) console.log(`${n.padEnd(8)} ${d.description}`);
      for (const [n, l] of Object.entries(reg.presets)) console.log(`preset ${n}: ${l.join(', ')}`);
      process.exit(0);
    }
    print(opts.uninstall ? uninstall(opts) : install(opts), opts);
  } catch (e) {
    console.error(e instanceof InstallError ? `project-kit: ${e.message}` : e);
    process.exit(1);
  }
}
