// Wiring the kit's pre-commit checks into a repository WITHOUT replacing its own hooks.
//
// The kit owns only a marked block inside the pre-commit hook that is already in use:
//   - core.hooksPath set (e.g. .githooks, .husky): the block goes into <hooksPath>/pre-commit (tracked).
//   - no hooksPath but a local .git/hooks/pre-commit: the block goes into that local file (not tracked;
//     re-added on every session start, because local hooks do not travel with a clone).
//   - neither: the kit creates a tracked .githooks/pre-commit and sets core.hooksPath=.githooks.
// core.hooksPath is per clone (.git/config), so the session-start hook re-applies the wiring on new clones.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BLOCK_START = '# >>> project-kit >>>';
export const BLOCK_END = '# <<< project-kit <<<';
const HERE = path.dirname(fileURLToPath(import.meta.url));

const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
const tryGit = (root, args) => { try { return git(root, args); } catch { return ''; } };

export function preCommitBlock(layers) {
  const lines = [
    BLOCK_START,
    '# Managed by the project kit (.claude/kit). Edit outside this block; the installer rewrites it.',
    'KIT_HOOKS="$(git rev-parse --show-toplevel)/.claude/kit/lib/githooks"',
    'if [ -f "$KIT_HOOKS/scan-staged.sh" ]; then bash "$KIT_HOOKS/scan-staged.sh" || exit 1; fi',
  ];
  if (layers.includes('jobs')) lines.push('if [ -f "$KIT_HOOKS/main-dir-check.sh" ]; then bash "$KIT_HOOKS/main-dir-check.sh" || exit 1; fi');
  lines.push(BLOCK_END);
  return lines.join('\n');
}

const blockRe = () => new RegExp(`${BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`);

/** Insert the block right after the shebang (so it runs first), or replace an existing block in place. */
export function upsertBlock(text, block) {
  if (blockRe().test(text)) return text.replace(blockRe(), `${block}\n`);
  if (!text) return `#!/usr/bin/env bash\n${block}\nexit 0\n`;
  const nl = text.indexOf('\n');
  if (text.startsWith('#!')) {
    const first = nl < 0 ? `${text}\n` : text.slice(0, nl + 1);
    return `${first}${block}\n${nl < 0 ? '' : text.slice(nl + 1)}`;
  }
  return `${block}\n${text}`;
}

export function removeBlock(text) {
  return text.replace(blockRe(), '');
}

/** Where the active pre-commit hook lives and how the kit should treat it. */
export function hookTarget(root) {
  const hp = tryGit(root, ['config', '--get', 'core.hooksPath']);
  if (hp) {
    const abs = path.resolve(root, hp);
    const rel = path.relative(root, abs);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return { kind: 'tracked', dir: rel.split(path.sep).join('/'), setHooksPath: false };
    return { kind: 'local', file: path.join(abs, 'pre-commit') };
  }
  const local = path.resolve(root, tryGit(root, ['rev-parse', '--git-path', 'hooks']) || '.git/hooks', 'pre-commit');
  if (fs.existsSync(local)) return { kind: 'local', file: local };
  return { kind: 'tracked', dir: '.githooks', setHooksPath: true };
}

export function gitleaksPresent(root) {
  const main = path.dirname(tryGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']) || path.join(root, '.git'));
  if ([path.join(root, '.claude/kit/bin/gitleaks'), path.join(main, '.claude/kit/bin/gitleaks')].some((p) => fs.existsSync(p))) return true;
  return spawnSync('bash', ['-c', 'command -v gitleaks'], { stdio: 'ignore' }).status === 0;
}

export function installGitleaks(root, { quiet = true } = {}) {
  const r = spawnSync('bash', [path.join(HERE, 'install-gitleaks.sh'), path.join(root, '.claude', 'kit', 'bin'), ...(quiet ? ['--quiet'] : [])], { encoding: 'utf8', timeout: 90000 });
  return `${r.stdout || ''}${r.stderr || ''}`.trim();
}

/**
 * Re-apply the wiring recorded at install time (fresh clone, reset .git/config, missing scanner).
 * Silent when healthy; returns a list of what it fixed. Never throws.
 */
export function ensureWired(root, installed, { download = true } = {}) {
  const done = [];
  try {
    const g = installed?.githooks;
    if (!g) return done;
    if (g.kind === 'tracked' && g.setHooksPath && tryGit(root, ['config', '--get', 'core.hooksPath']) !== g.dir) {
      git(root, ['config', 'core.hooksPath', g.dir]);
      done.push(`core.hooksPath -> ${g.dir}`);
    }
    if (g.kind === 'tracked') {
      const f = path.join(root, g.dir, 'pre-commit');
      if (fs.existsSync(f)) fs.chmodSync(f, 0o755);
    }
    if (g.kind === 'local') {
      const t = hookTarget(root);
      if (t.kind === 'local') {
        const old = fs.existsSync(t.file) ? fs.readFileSync(t.file, 'utf8') : '';
        const next = upsertBlock(old, preCommitBlock(installed.layers || []));
        if (next !== old) {
          fs.mkdirSync(path.dirname(t.file), { recursive: true });
          fs.writeFileSync(t.file, next, { mode: 0o755 });
          done.push(`project-kit block added to ${t.file}`);
        }
      }
    }
    if (download && !gitleaksPresent(root)) {
      const out = installGitleaks(root);
      done.push(out || 'gitleaks install attempted');
    }
  } catch (e) {
    done.push(`githooks wiring error: ${e.message}`);
  }
  return done;
}
