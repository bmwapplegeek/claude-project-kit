// Shared by every kit script: where am I running, in which mode, with which layers?
//
// The same lib/ tree runs in two places:
//   repo mode   - copied into a repository at .claude/kit/lib/ by install.mjs; .claude/kit/installed.json
//                 sits next to it and records the version and the layers chosen at install time.
//   plugin mode - inside the Claude Code plugin (${CLAUDE_PLUGIN_ROOT}/lib/); no installed.json, core layer only.
// Dependency-free and fast: the PreToolUse hook has a budget of a few hundred milliseconds.
import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const LIB = dirname(fileURLToPath(import.meta.url));

/** The directory holding lib/: the plugin root, or <repo>/.claude/kit. */
export const kitHome = () => process.env.PROJECT_KIT_HOME || dirname(LIB);

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export const installedPath = (home = kitHome()) => join(home, 'installed.json');
export const readInstalled = (home = kitHome()) => readJson(installedPath(home));

export function mode(home = kitHome()) {
  if (process.env.PROJECT_KIT_MODE === 'repo' || process.env.PROJECT_KIT_MODE === 'plugin') return process.env.PROJECT_KIT_MODE;
  return existsSync(installedPath(home)) ? 'repo' : 'plugin';
}

/** Layers whose rules and checks are active. The plugin only ever runs the core layer. */
export function layers(home = kitHome()) {
  if (mode(home) !== 'repo') return ['core'];
  const inst = readInstalled(home);
  const l = Array.isArray(inst?.layers) ? inst.layers.filter((x) => /^[a-z0-9-]+$/.test(x)) : [];
  return ['core', ...l.filter((x) => x !== 'core')];
}

export function kitVersion(home = kitHome()) {
  if (mode(home) === 'repo') return readInstalled(home)?.version ?? null;
  try {
    return readFileSync(join(home, 'VERSION'), 'utf8').trim();
  } catch {
    return null;
  }
}

export const kitConfig = (home = kitHome()) => readJson(join(home, 'kit.config.json'), {});

/** The repository the session works in (not necessarily a git repo). */
export function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

export function gitTop(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/** Optional, owner-edited settings for one repository: <repo>/.claude/project-kit.json. */
export const userConfig = (dir = projectDir()) => readJson(join(dir, '.claude', 'project-kit.json'), {}) || {};

/**
 * Where throttles, stamps and error logs go. Never inside the plugin root (it moves on every update).
 *   repo mode:   <repo>/.claude/kit/state   (gitignored by the installer)
 *   plugin mode: ${CLAUDE_PLUGIN_DATA}, else ~/.local/state/project-kit
 */
export function stateDir(home = kitHome()) {
  const dir = process.env.PROJECT_KIT_STATE
    || (mode(home) === 'repo' ? join(home, 'state')
      : process.env.PROJECT_KIT_DATA || process.env.CLAUDE_PLUGIN_DATA
        || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'project-kit'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Hooks fail open; this is where they say what went wrong. Never throws. */
export function logHookError(source, err) {
  try {
    const msg = String(err?.stack?.split('\n')[0] ?? err?.message ?? err).replace(/\s+/g, ' ').slice(0, 300);
    appendFileSync(join(stateDir(), 'hook-errors.log'), `${new Date().toISOString()} ${source} ${msg}\n`);
  } catch { /* nothing more we can do */ }
}
