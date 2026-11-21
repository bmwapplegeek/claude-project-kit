// Shared by the kit's tests. Node only; every repo is a throwaway under the OS temp dir.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RUN_SH = join(KIT, 'lib', 'hooks', 'run.sh');

// Never let a test write state into the kit folder or the real home.
process.env.PROJECT_KIT_STATE ??= mkdtempSync(join(tmpdir(), 'kit-test-state-'));

export const tmp = (prefix = 'kit-test-') => mkdtempSync(join(tmpdir(), prefix));

export const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A fresh repo on `main` with one commit. */
export function makeRepo(dir = tmp('kit-repo-')) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

export const payload = (command, cwd, tool_name = 'Bash') => JSON.stringify({ tool_name, tool_input: { command }, cwd });

/** Run a hook entry point (run.sh) the way Claude Code does. */
const BASH = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim() || 'bash';
export function runHook(runSh, event, stdin, { projectDir, env = {}, args = [] } = {}) {
  return spawnSync(BASH, [runSh, event, ...args], {
    input: stdin, encoding: 'utf8', cwd: projectDir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, ...env },
  });
}

export function hasGitleaks() {
  return spawnSync('bash', ['-c', 'command -v gitleaks'], { stdio: 'ignore' }).status === 0;
}
