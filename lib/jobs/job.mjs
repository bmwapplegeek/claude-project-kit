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
import { kitCommands, userConfig } from '../kit-env.mjs';

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
    else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (cur && line === 'detached') cur.branch = null;
  }
  return items.filter((w) => path.resolve(w.path) !== path.resolve(root));
}

// A repo whose own job script does more (links dependencies, prepares per-job test dirs) names it in
// .claude/project-kit.json (jobs.startCommand / jobs.finishCommand). Starting or finishing with this generic
// one there would skip those steps, so it refuses and names the repo's command.
function deferTo(root, key) {
  const c = kitCommands(userConfig(root));
  if (c.custom[key]) fail(`this repo ${key === 'jobStart' ? 'starts' : 'finishes'} jobs with \`${c[key]}\` (.claude/project-kit.json); use that.`);
}

export function start(branch, { log = console.log } = {}) {
  if (!BRANCH_RE.test(branch || '')) fail(`branch must look like feat/<slug> (feat|fix|chore|docs, lowercase): got "${branch}"`);
  const root = mainRoot();
  deferTo(root, 'jobStart');
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
  deferTo(root, 'jobFinish');
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

function readJob(wt) {
  try {
    return JSON.parse(fs.readFileSync(path.join(git(wt, ['rev-parse', '--path-format=absolute', '--git-dir']), 'job.json'), 'utf8'));
  } catch {
    return null;
  }
}
// Not through git(): its trim() would eat the first line's leading status column (" M a.txt").
// Reports failure instead of returning [] (a failed status must never read as "clean"), and refuses to count
// anything when HEAD does not resolve to a commit: on an unborn or unreadable HEAD `git status` lists every
// tracked file as added ("A "), which once produced a false "3,402 uncommitted changes" STOP note.
// Returns { ok: true, lines } or { ok: false, reason }.
export function readStatus(dir) {
  const head = tryGit(dir, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (!head.ok) return { ok: false, reason: 'HEAD does not resolve to a commit (unborn branch or unreadable refs)' };
  try {
    const lines = execFileSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=all'], {
      encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 << 20,
    }).split('\n').filter(Boolean);
    return { ok: true, lines };
  } catch (e) {
    const first = String(e?.stderr || e?.message || 'git status failed').split('\n').find((l) => l.trim()) || 'git status failed';
    return { ok: false, reason: `git status failed: ${first.trim()}` };
  }
}

/** Each job worktree's state, as seen from the main checkout. A path this machine cannot see is reported as such. */
export function describeJobs(root, b = base(root)) {
  return listWorktrees(root).map((w) => {
    if (!fs.existsSync(w.path)) return { ...w, visible: false };
    const job = readJob(w.path);
    const head = w.head || tryGit(w.path, ['rev-parse', 'HEAD']).out;
    const st = readStatus(w.path);
    return {
      ...w,
      visible: true,
      dirty: st.ok ? st.lines.length : 0,
      unreadable: st.ok ? null : st.reason,
      ahead: Number(tryGit(root, ['rev-list', '--count', `origin/${b}..${head}`]).out || 0),
      merged: !!head && tryGit(root, ['merge-base', '--is-ancestor', head, `origin/${b}`]).ok,
      hasCommits: job?.start ? job.start !== head : null, // null: no job record, cannot tell
      at: job?.at ?? null,
    };
  });
}

function age(iso) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '?';
  const h = (Date.now() - t) / 3600e3;
  return h < 48 ? `${h.toFixed(1)}h` : `${Math.round(h / 24)}d`;
}

export function jobLine(j, b) {
  if (!j.visible) return `- ${j.branch || '(detached)'}: ${j.path} (not visible from this machine)`;
  if (j.unreadable) return `- ${j.branch || '(detached)'}: state unreadable (${j.unreadable}) - ${j.path}`;
  const state = j.dirty ? `${j.dirty} uncommitted` : 'clean';
  const merge = !j.merged ? `${j.ahead} commit(s) not in origin/${b}`
    : j.hasCommits === false ? 'no commits yet' : j.hasCommits ? `merged into origin/${b}` : 'merged, or no commits yet';
  return `- ${j.branch || '(detached)'}: ${state}, ${merge}, age ${age(j.at)} - ${j.path}`;
}

/** SessionStart text: a STOP note when the main checkout holds someone else's work, and the job worktrees. */
export function sessionCheck(root = mainRoot()) {
  const b = base(root);
  const cmd = kitCommands(userConfig(root));
  const lines = [];
  const branch = tryGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).out || '(detached)';
  const status = readStatus(root);
  const dirty = status.ok ? status.lines : [];
  const off = branch !== b;
  const stop = status.ok && (off || dirty.length > 0);
  if (!status.ok) {
    // Deliberately no change count and no file list: an unreadable state is not evidence of anyone's work.
    lines.push(
      `NOTE (project-kit jobs): git state in the main checkout ${root} could not be read: ${status.reason}.`,
      'This is NOT evidence of uncommitted work. (An unborn HEAD makes `git status` list every tracked file as',
      'added, so the usual change count would be wrong; none is shown.) Do not stash, commit, reset, clean, switch or',
      'discard anything in the main checkout. If you have a shell, re-check with `git status` there; and do your own',
      `job in your own worktree: \`${cmd.jobStart} <feat|fix|chore|docs>/<slug>\`.`,
    );
  } else if (stop) {
    lines.push(
      `STOP (project-kit jobs): the main checkout ${root} is ${off ? `on branch '${branch}', not '${b}'` : `on '${b}'`}` +
        `${dirty.length ? `, with ${dirty.length} uncommitted change(s)` : ''}.`,
      'That is NOT your work: another session left it (possibly one that already ended). Do not build on it, and do',
      'not stash, commit, switch, reset, clean or discard it. Tell the owner what you found, then do your own job in',
      `your own worktree: \`${cmd.jobStart} <feat|fix|chore|docs>/<slug>\` (it branches from origin/${b} and does not`,
      'touch the main checkout, so it works even now).',
      ...dirty.slice(0, 15).map((l) => `    ${l}`),
      ...(dirty.length > 15 ? [`    ... and ${dirty.length - 15} more`] : []),
    );
  }
  const jobs = describeJobs(root, b);
  if (jobs.length) {
    lines.push('Job worktrees (each belongs to the session that created it; leave the others alone):', ...jobs.map((j) => jobLine(j, b)));
    const done = jobs.filter((j) => j.visible && !j.unreadable && j.merged && j.hasCommits && !j.dirty && j.branch);
    if (done.length) {
      lines.push(`Merged and clean, probably finished: ${done.map((j) => `\`${cmd.jobFinish} ${j.branch}\``).join(', ')} ` +
        '(it refuses unmerged or dirty worktrees). Mention it to the owner rather than cleaning up mid-job.');
    }
  }
  return { stop, unreadable: !status.ok, text: lines.join('\n') };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'start') start(rest[0]);
    else if (cmd === 'finish') finish(rest.find((a) => !a.startsWith('--')), { noCommitsOk: rest.includes('--no-commits-ok') });
    else if (cmd === 'list') {
      const root = mainRoot();
      const jobs = describeJobs(root);
      console.log(jobs.length ? jobs.map((j) => jobLine(j, base(root))).join('\n') : 'no job worktrees');
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
