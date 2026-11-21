#!/usr/bin/env node
// Jobs layer: one git worktree per agent job, so jobs stop colliding in the shared main checkout.
//
//   node .claude/kit/lib/jobs/job.mjs start <feat|fix|chore|docs>/<slug>   new worktree + branch off a fresh origin/<base>
//   node .claude/kit/lib/jobs/job.mjs finish <branch>                     after the PR merged: remove worktree, then branch
//   node .claude/kit/lib/jobs/job.mjs list                                every job worktree and its state
//   node .claude/kit/lib/jobs/job.mjs session-check                       SessionStart output (silent when all is well)
//
// Worktrees live OUTSIDE the repo, in <repo>/../worktrees/<type>-<slug> (override: jobs.worktreesDir in
// .claude/project-kit.json, or JOB_WORKTREES_DIR). Outside, because some platforms (Phoenix Studio among
// them) copy the whole project directory into each release. Dependencies are NOT copied into a new
// worktree: install them there if the job needs them.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { userConfig } from '../kit-env.mjs';

export const BRANCH_RE = /^(feat|fix|chore|docs)\/[a-z0-9][a-z0-9._-]*$/;

class JobError extends Error {}
const fail = (msg) => { throw new JobError(msg); };

export function git(dir, args, timeout = 60000) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 << 20,
  }).trim();
}
const tryGit = (dir, args) => {
  try { return { ok: true, out: git(dir, args) }; } catch (e) { return { ok: false, out: '', err: String(e.stderr || e.message).trim() }; }
};

export const mainRoot = (from = process.cwd()) =>
  path.dirname(git(from, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
const base = (root) => userConfig(root)?.jobs?.baseBranch || 'main';
export const worktreesBase = (root) => process.env.JOB_WORKTREES_DIR
  || (userConfig(root)?.jobs?.worktreesDir ? path.resolve(root, userConfig(root).jobs.worktreesDir) : path.join(path.dirname(root), 'worktrees'));
export const slugOf = (branch) => branch.replace(/\//g, '-');

export function listWorktrees(root) {
  const out = git(root, ['worktree', 'list', '--porcelain']);
  const items = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9) }; items.push(cur); }
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (cur && line === 'detached') cur.branch = null;
  }
  return items.filter((w) => path.resolve(w.path) !== path.resolve(root));
}

export function start(branch, { log = console.log } = {}) {
  if (!BRANCH_RE.test(branch || '')) fail(`branch must look like feat/<slug> (feat|fix|chore|docs, lowercase): got "${branch}"`);
  const root = mainRoot();
  const b = base(root);
  const wt = path.join(worktreesBase(root), slugOf(branch));
  if (fs.existsSync(wt)) fail(`${wt} already exists. Resume it (it may belong to another session), or pick another name.`);
  const fetched = tryGit(root, ['fetch', '--quiet', 'origin', b]);
  if (!fetched.ok) log(`job: could not fetch origin/${b} (${fetched.err.split('\n')[0]}); using the local origin/${b}.`);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const exists = tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
  if (exists) git(root, ['worktree', 'add', wt, branch]);
  else git(root, ['worktree', 'add', '-b', branch, wt, `origin/${b}`]);
  const startSha = git(wt, ['rev-parse', 'HEAD']);
  const gitDir = git(wt, ['rev-parse', '--path-format=absolute', '--git-dir']);
  fs.writeFileSync(path.join(gitDir, 'job.json'), `${JSON.stringify({ branch, start: startSha, at: new Date().toISOString() }, null, 2)}\n`);
  log(`job: ${exists ? 'attached existing' : 'created'} ${branch} at ${wt} (from ${exists ? branch : `origin/${b}`} ${startSha.slice(0, 8)}).`);
  log('Work ONLY there: absolute paths for file edits, `cd <worktree> && ...` in the shell. The main checkout stays on', b);
  log(`Dependencies were not copied; install them in the worktree if the job needs them. When the PR is merged: node .claude/kit/lib/jobs/job.mjs finish ${branch}`);
  return wt;
}

export function finish(branch, { log = console.log, noCommitsOk = false } = {}) {
  const root = mainRoot();
  const b = base(root);
  const w = listWorktrees(root).find((x) => x.branch === branch);
  tryGit(root, ['fetch', '--quiet', '--prune', 'origin']);
  if (w) {
    const dirty = git(w.path, ['status', '--porcelain', '--untracked-files=all']);
    if (dirty) fail(`${w.path} has uncommitted changes; commit or discard them first.`);
  }
  const tip = git(root, ['rev-parse', `refs/heads/${branch}`]);
  const ahead = tryGit(root, ['rev-list', '--count', `origin/${b}..${tip}`]).out;
  if (ahead !== '0') fail(`${branch} has ${ahead || '?'} commit(s) not in origin/${b}: merge the PR first.`);
  const job = w ? (() => { try { return JSON.parse(fs.readFileSync(path.join(git(w.path, ['rev-parse', '--path-format=absolute', '--git-dir']), 'job.json'), 'utf8')); } catch { return null; } })() : null;
  if (job && job.start === tip && !noCommitsOk) fail(`${branch} has no commits of its own yet (it may be a job that just started). Use --no-commits-ok if it really is done.`);
  if (w) { git(root, ['worktree', 'remove', w.path]); log(`job: removed worktree ${w.path}`); }
  const st = git(root, ['status', '--porcelain']);
  if (git(root, ['branch', '--show-current']) === b && !st) {
    const ff = tryGit(root, ['merge', '--ff-only', `origin/${b}`]);
    log(ff.ok ? `job: main checkout fast-forwarded to origin/${b}` : `job: main checkout not fast-forwarded (${ff.err.split('\n')[0]})`);
  }
  git(root, ['branch', '-d', branch]);
  log(`job: deleted local branch ${branch}`);
  const remoteTip = tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
  if (remoteTip.ok && tryGit(root, ['merge-base', '--is-ancestor', remoteTip.out, `origin/${b}`]).ok) {
    const del = tryGit(root, ['push', 'origin', '--delete', branch]);
    log(del.ok ? `job: deleted remote branch ${branch}` : `job: remote branch not deleted (${del.err.split('\n')[0]})`);
  }
}

export function sessionCheck(root = mainRoot()) {
  const b = base(root);
  const lines = [];
  let stop = false;
  const branch = tryGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).out || '(detached)';
  const dirty = tryGit(root, ['status', '--porcelain', '--untracked-files=all']).out.split('\n').filter(Boolean);
  if (branch !== b) {
    stop = true;
    lines.push(`STOP (project-kit jobs): the main checkout ${root} is on '${branch}', not '${b}'. That is probably another session's branch. Do not switch, commit or reset it; tell the owner.`);
  }
  if (dirty.length) {
    stop = true;
    lines.push(`STOP (project-kit jobs): the main checkout has ${dirty.length} uncommitted change(s) that are not yours. Do not build on, stash or discard them; tell the owner.`);
  }
  const wts = listWorktrees(root);
  if (wts.length) {
    lines.push('Job worktrees (each belongs to the session that created it; leave the others alone):');
    for (const w of wts) lines.push(`  ${w.branch || '(detached)'}  ${w.path}`);
  }
  if (lines.length) lines.push(`Start your own job with: node .claude/kit/lib/jobs/job.mjs start <feat|fix|chore|docs>/<slug>`);
  return { stop, text: lines.join('\n') };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'start') start(rest[0]);
    else if (cmd === 'finish') finish(rest.find((a) => !a.startsWith('--')), { noCommitsOk: rest.includes('--no-commits-ok') });
    else if (cmd === 'list') {
      const w = listWorktrees(mainRoot());
      console.log(w.length ? w.map((x) => `${x.branch || '(detached)'}  ${x.path}`).join('\n') : 'no job worktrees');
    } else if (cmd === 'session-check') {
      const r = sessionCheck();
      if (r.text) console.log(r.text);
    } else {
      console.error('usage: job.mjs start <type>/<slug> | finish <branch> [--no-commits-ok] | list | session-check');
      return 2;
    }
    return 0;
  } catch (e) {
    console.error(e instanceof JobError ? `job: ${e.message}` : e);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
