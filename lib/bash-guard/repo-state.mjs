// Where does each command in a line run, and what state is that repo in? Used by the job-isolation
// rules. Kept outside rules/ so the dispatcher does not load it as a rule.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const TAKES_VALUE = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix']);

// A directory word we can resolve, or null when it depends on a variable, ~user, etc. Unknown
// directories make the rules allow the command (fail open) rather than guess.
function resolveDir(cur, word) {
  if (cur === null || word === undefined || /[$`*?]/.test(word)) return null;
  if (word === '~' || word.startsWith('~/')) {
    if (!process.env.HOME) return null;
    return resolve(process.env.HOME, word.slice(2));
  }
  if (word.startsWith('~')) return null;
  return isAbsolute(word) ? resolve(word) : resolve(cur, word);
}

// [{cmd, dir}] for every command, following `cd DIR` in order and `git -C DIR`. dir null = unknown.
export function withDirs(commands, cwd) {
  let cur = cwd || process.cwd();
  const out = [];
  for (const cmd of commands) {
    if (cmd.name === 'cd') {
      const target = cmd.args.find((a) => a !== '--' && !/^-[LPe@]+$/.test(a));
      cur = target === undefined ? resolveDir(cur, '~') : target === '-' ? null : resolveDir(cur, target);
      continue;
    }
    let dir = cur;
    if (cmd.name === 'git') {
      const a = cmd.args;
      for (let k = 0; k < a.length && a[k].startsWith('-'); k++) {
        if (a[k] === '-C') { dir = resolveDir(dir, a[k + 1]); k++; } else if (TAKES_VALUE.has(a[k])) k++;
      }
    }
    if (cmd.name === 'npm') {
      const i = cmd.args.findIndex((x) => x === '--prefix' || x === '-C');
      if (i >= 0) dir = resolveDir(dir, cmd.args[i + 1]);
    }
    out.push({ cmd, dir });
  }
  return out;
}

const gitOut = (dir, args) => execFileSync('git', ['-C', dir, ...args], {
  encoding: 'utf8', timeout: 1200, stdio: ['ignore', 'pipe', 'ignore'],
}).trim();

// {top, isMain, branch, dirty()} for the repo containing dir; null when dir is not in a work tree.
// Pass one Map per check() call so a command line that names the same dir twice asks git once.
export function repoState(dir, cache = new Map()) {
  if (!dir || !existsSync(dir)) return null;
  if (cache.has(dir)) return cache.get(dir);
  let state = null;
  let lines;
  try {
    lines = gitOut(dir, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel']).split('\n');
  } catch (e) {
    if (e.code === 'ETIMEDOUT') throw e; // a hang is an error (logged, allowed), not "not a repo"
    lines = null;
  }
  if (lines && lines.length === 3) {
    const [gitDir, commonDir, top] = lines;
    let branch;
    try { branch = gitOut(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']); } catch { branch = '(detached)'; }
    let dirty;
    state = {
      top, branch, isMain: gitDir === commonDir,
      dirty: () => (dirty ??= gitOut(top, ['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean)),
    };
  }
  cache.set(dir, state);
  return state;
}
