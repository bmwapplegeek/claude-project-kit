#!/usr/bin/env node
// Phoenix layer: the pre-deploy checklist as a script.
//   node .claude/kit/lib/phoenix/predeploy-check.mjs [--allow-branch <name>] [--ack-prerequisites]
//                                                    [--live <sha>] [--min-free-gb <n>] [--fast]
//
// Prints PASS / WARN / FAIL per item and exits 1 if anything FAILED. On success it writes
// .claude/kit/state/predeploy-stamp.json (gitignored) with HEAD's SHA and the time; the bash-guard rule
// deploy-needs-predeploy-stamp refuses the deploy call without a stamp for the current HEAD under 30 minutes old.
//
// THIS SCRIPT DOES NOT AUTHORISE A DEPLOY. Deploying still needs the owner's explicit yes. It never deploys
// and never changes anything outside .claude/kit/state/.
//
// Data sources: git, and the Phoenix Studio API ($STUDIO_API_BASE, token file $STUDIO_API_TOKEN_FILE; both are
// set in Studio agent sessions). Project checks: `predeploy.commands` in .claude/project-kit.json, or else
// `npm run typecheck` / `npm run lint` when package.json defines them.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git, repoRoot, stampPath, historyPath, STAMP_MAX_AGE_MS, mentionsPrerequisite } from './predeploy-lib.mjs';
import { readJson, userConfig } from '../kit-env.mjs';

const IN_FLIGHT = /^(pending|queued|running|building|deploying|in_progress|starting)$/i;
const FALLBACK_SCAN = 20;

export function parseArgs(argv) {
  const o = { allowBranch: null, ack: false, live: null, minFreeGb: null, fast: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--allow-branch') o.allowBranch = argv[++i] ?? '';
    else if (a === '--ack-prerequisites') o.ack = true;
    else if (a === '--live') o.live = argv[++i] ?? '';
    else if (a === '--min-free-gb') o.minFreeGb = Number(argv[++i]);
    else if (a === '--fast') o.fast = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (o.allowBranch === '' || o.live === '' || (o.minFreeGb !== null && !(o.minFreeGb > 0))) {
    throw new Error('A flag is missing its value (--allow-branch <name>, --live <sha>, --min-free-gb <n>).');
  }
  return o;
}

async function studio(path) {
  const base = process.env.STUDIO_API_BASE;
  const tokFile = process.env.STUDIO_API_TOKEN_FILE;
  if (!base || !tokFile) return { error: 'STUDIO_API_BASE / STUDIO_API_TOKEN_FILE not set' };
  try {
    const res = await fetch(`${base}/api/v1/ws/project/${path}`, {
      headers: { Authorization: `Bearer ${readFileSync(tokFile, 'utf8').trim()}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { data: await res.json() };
  } catch (e) {
    return { error: e.message };
  }
}

/** The live commit: --live, else the API's commit_sha, else the last stamp that preceded the last good deploy. */
export function findLive({ live, deployments, history, tryGit }) {
  if (live) {
    const full = tryGit(['rev-parse', '--verify', `${live}^{commit}`]);
    return full.ok ? { sha: full.out, how: 'given with --live' } : { error: `--live ${live} is not a commit in this repo` };
  }
  const list = Array.isArray(deployments) ? deployments : [];
  const good = list.find((d) => d && d.status === 'success');
  if (!good) return { error: 'no successful deploy recorded' };
  if (/^[0-9a-f]{40}$/.test(good.commit_sha || '')) return { sha: good.commit_sha, how: `deploy ${String(good.id).slice(0, 8)} reports it` };
  const t = Date.parse(good.created_at);
  const before = (Array.isArray(history) ? history : [])
    .filter((h) => /^[0-9a-f]{40}$/.test(h.sha) && Date.parse(h.at) <= t && t - Date.parse(h.at) <= STAMP_MAX_AGE_MS * 2)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  if (before && tryGit(['cat-file', '-e', `${before.sha}^{commit}`]).ok) {
    return { sha: before.sha, how: `the pre-deploy stamp that preceded deploy ${String(good.id).slice(0, 8)}` };
  }
  return { error: 'the deploy record has no commit and no earlier stamp matches it' };
}

export async function run(o, { root = repoRoot(), log = console.log } = {}) {
  const results = [];
  const add = (id, status, summary, lines = []) => results.push({ id, status, summary, lines });
  const tryGit = (args, timeout) => {
    try { return { ok: true, out: git(root, args, timeout) }; } catch (e) { return { ok: false, out: String(e.stderr || e.message || e).trim() }; }
  };
  const cfg = userConfig(root);
  const base = cfg?.jobs?.baseBranch || 'main';
  const minFreeGb = o.minFreeGb ?? cfg?.predeploy?.minFreeGb ?? 2;
  const head = git(root, ['rev-parse', 'HEAD']);

  // 1. branch
  const branch = tryGit(['branch', '--show-current']).out;
  const remote = tryGit(['ls-remote', 'origin', `refs/heads/${base}`], 20000);
  const remoteSha = remote.ok ? remote.out.split(/\s+/)[0] : '';
  const allowed = o.allowBranch && branch === o.allowBranch;
  if (branch === base && remoteSha === head) add('branch', 'PASS', `on ${base}, equal to origin/${base} (${head.slice(0, 8)})`);
  else if (allowed) add('branch', 'WARN', `deploying branch ${branch} (allowed with --allow-branch)`);
  else if (!remoteSha) add('branch', 'FAIL', `cannot read origin/${base}`, [remote.out.split('\n')[0]]);
  else add('branch', 'FAIL', `HEAD ${head.slice(0, 8)} on '${branch || '(detached)'}' is not origin/${base} (${remoteSha.slice(0, 8)})`, [
    `Merge first, then deploy ${base}. To deploy another branch on purpose (owner's yes): --allow-branch <name>.`,
  ]);

  // 2. tree
  const st = tryGit(['status', '--porcelain', '--untracked-files=all'], 30000);
  const rows = st.ok && st.out ? st.out.split('\n') : [];
  if (!st.ok) add('tree', 'FAIL', 'git status failed', [st.out]);
  else if (rows.length) add('tree', 'FAIL', `${rows.length} uncommitted path(s)`, [...rows.slice(0, 15), 'Anything in the tree ships. If it is not yours, stop and tell the owner.']);
  else add('tree', 'PASS', 'working tree clean, no untracked files');

  // 3. commits since live (prerequisite wording)
  const deps = await studio('deployments');
  const history = readJson(historyPath(root), []);
  const live = findLive({ live: o.live, deployments: deps.data, history, tryGit });
  let range;
  const lines = [];
  if (live.sha) {
    lines.push(`live ${live.sha.slice(0, 8)} (${live.how})`);
    range = live.sha === head ? null : `${live.sha}..${head}`;
    const dropped = tryGit(['rev-list', '--count', `${head}..${live.sha}`]).out;
    if (dropped && dropped !== '0' && !allowed) {
      add('commits', 'FAIL', `${dropped} live commit(s) are not in HEAD: deploying would take them off the app`, lines);
      range = undefined;
    }
  } else {
    lines.push(`live commit unknown (${deps.error || live.error}); scanning the last ${FALLBACK_SCAN} commits instead. Pass --live <sha> to be exact.`);
    range = `-n${FALLBACK_SCAN}`;
  }
  if (range === null) add('commits', 'PASS', 'HEAD is already live (a redeploy of the same commit)', lines);
  else if (range !== undefined) {
    const SEP = '\x1e';
    const raw = tryGit(['log', range, `--format=%H%x1f%B${SEP}`]).out;
    const commits = raw.split(SEP).map((s) => s.trim()).filter(Boolean).map((s) => {
      const [sha, ...rest] = s.split('\x1f');
      return { sha, message: rest.join('\x1f').trim() };
    });
    lines.push(`${commits.length} commit(s) checked:`);
    for (const c of commits.slice(0, 30)) lines.push(`  ${c.sha.slice(0, 8)} ${c.message.split('\n')[0].slice(0, 100)}`);
    const hits = commits.filter((c) => mentionsPrerequisite(c.message));
    for (const c of hits) lines.push('', `  !! ${c.sha} mentions a prerequisite / manual step:`, ...c.message.split('\n').map((l) => `  | ${l}`));
    const unknown = !live.sha;
    if (hits.length && !o.ack) add('commits', 'FAIL', `${hits.length} commit message(s) mention a prerequisite; do it, then re-run with --ack-prerequisites`, lines);
    else if (hits.length || unknown) add('commits', 'WARN', hits.length ? `${hits.length} prerequisite message(s) acknowledged` : 'live commit unknown', lines);
    else add('commits', 'PASS', `${commits.length} commit(s) since live, no prerequisite wording`, lines);
  }

  // 4. deploy in flight
  const last = Array.isArray(deps.data) ? deps.data[0] : null;
  if (deps.error) add('in-flight', 'WARN', `could not read the deployments list (${deps.error})`);
  else if (last && IN_FLIGHT.test(last.status || '')) add('in-flight', 'FAIL', `a deploy is already in flight (${last.status})`);
  else add('in-flight', 'PASS', last ? `latest deploy ${String(last.id).slice(0, 8)}: ${last.status}` : 'no deploys yet');

  // 5. disk and app health
  const res = await studio('resources');
  if (res.error) add('disk', 'WARN', `could not read workspace resources (${res.error})`);
  else {
    const free = (Number(res.data.disk_total) - Number(res.data.disk_used)) / 2 ** 30;
    const health = res.data.app_health ? `app health ${res.data.app_health}` : 'no app health reported';
    if (!Number.isFinite(free)) add('disk', 'WARN', `workspace reported no disk figures; ${health}`);
    else if (free < minFreeGb) add('disk', 'FAIL', `only ${free.toFixed(2)} GB free on the workspace (minimum ${minFreeGb}); ${health}`);
    else if (free < minFreeGb + 1) add('disk', 'WARN', `${free.toFixed(2)} GB free, close to the minimum ${minFreeGb}; ${health}`);
    else add('disk', 'PASS', `${free.toFixed(2)} GB free; ${health}`);
  }

  // 6. project checks
  let commands = cfg?.predeploy?.commands;
  if (!Array.isArray(commands)) {
    const pkg = readJson(join(root, 'package.json'), {});
    commands = ['typecheck', 'lint'].filter((s) => pkg?.scripts?.[s]).map((s) => `npm run ${s}`);
  }
  if (o.fast) add('checks', 'SKIP', '--fast: project checks skipped (no stamp will be written)');
  else if (!commands.length) add('checks', 'WARN', 'no project checks configured (set predeploy.commands in .claude/project-kit.json)');
  else {
    for (const c of commands) {
      const t0 = Date.now();
      const r = spawnSync('bash', ['-c', c], { cwd: root, encoding: 'utf8', timeout: 900000, maxBuffer: 64 << 20 });
      const secs = Math.round((Date.now() - t0) / 1000);
      if (r.status === 0) add('checks', 'PASS', `\`${c}\` green in ${secs}s`);
      else add('checks', 'FAIL', `\`${c}\` failed (exit ${r.status ?? r.signal}) after ${secs}s`, `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-25));
    }
  }

  const failed = results.some((r) => r.status === 'FAIL');
  for (const r of results) {
    log(`${r.status.padEnd(4)} ${r.id.padEnd(9)} ${r.summary}`);
    for (const l of r.lines) log(`          ${l}`);
  }
  if (!failed && !o.fast) {
    const stamp = { sha: head, at: new Date().toISOString(), branch, acked: o.ack };
    mkdirSync(dirname(stampPath(root)), { recursive: true });
    const tmp = `${stampPath(root)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(stamp, null, 2)}\n`);
    renameSync(tmp, stampPath(root));
    writeFileSync(historyPath(root), `${JSON.stringify([...(Array.isArray(history) ? history : []), stamp].slice(-50), null, 2)}\n`);
    log(`\nPASSED. Stamp written for ${head.slice(0, 8)}, valid ${STAMP_MAX_AGE_MS / 60000} min while the tree stays clean.`);
  } else {
    log(failed ? '\nFAILED. Fix the FAIL items; no stamp written.' : '\n--fast: no stamp written.');
  }
  log('This check does NOT authorise a deploy: that still needs the owner\'s explicit yes.');
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (o.help) { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 16).join('\n')); process.exit(0); }
  if (!existsSync(join(repoRoot(), '.git'))) console.error('note: not at a repository root; checks run in', repoRoot());
  run(o).then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
}
