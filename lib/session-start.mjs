#!/usr/bin/env node
// SessionStart hook for both modes.
//   node session-start.mjs            reminders: jobs STOP notice (repo, jobs layer), review skills (weekly),
//                                     kit update (weekly), "kit not installed here" note (plugin only)
//   node session-start.mjs githooks   repo mode only: re-apply git hook wiring and the pinned scanner
// Prints one JSON object for Claude Code when there is something to say; silent otherwise. ALWAYS exits 0.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gitTop, kitHome, layers, logHookError, mode, projectDir, readInstalled, readJson, stateDir } from './kit-env.mjs';

const DEADLINE_MS = 6000;
const DAY_MS = 24 * 60 * 60 * 1000;

const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

export async function collect({ home = kitHome(), dir = projectDir(), now = Date.now() } = {}) {
  const m = mode(home);
  const notes = [];
  let stop = false;
  const top = gitTop(dir);

  if (m === 'repo' && top && layers(home).includes('jobs')) {
    try {
      const { sessionCheck, mainRoot } = await import('./jobs/job.mjs');
      const r = sessionCheck(mainRoot(top));
      if (r.text) notes.push(r.text);
      stop = r.stop;
    } catch (e) { logHookError('session-start jobs', e); }
  }

  const tasks = [
    ['review-skills', import('./review-skills-check.mjs').then((x) => x.runHook({ now, timeoutMs: 4000, mode: m }))],
    ['update-check', import('./update-check.mjs').then((x) => x.runHook({ now, home, timeoutMs: 4000 }))],
  ];
  if (m === 'plugin') tasks.push(['nudge', import('./nudge.mjs').then((x) => x.runNudge({ now, dir, home }))]);
  const results = await Promise.all(tasks.map(([name, t]) =>
    within(t.catch((e) => { logHookError(`session-start ${name}`, e); return null; }), DEADLINE_MS)));
  for (const r of results) if (r) notes.push(r);
  return { notes, stop };
}

async function main(argv) {
  try {
    if (argv[0] === 'githooks') {
      const home = kitHome();
      if (mode(home) !== 'repo') return;
      const top = gitTop(projectDir());
      if (!top) return;
      const { ensureWired, gitleaksPresent } = await import('./githooks/wiring.mjs');
      // A missing scanner is fetched at most once a day: offline, or behind a network allowlist, a download
      // attempt at every session start would hold each start up for the curl timeout.
      const marker = join(stateDir(home), 'gitleaks-download.json');
      const last = Date.parse(readJson(marker, {})?.at ?? '');
      const download = !(Number.isFinite(last) && Date.now() - last < DAY_MS);
      if (download && !gitleaksPresent(top)) writeFileSync(marker, `${JSON.stringify({ at: new Date().toISOString() })}\n`);
      const fixed = ensureWired(top, readInstalled(home), { download });
      if (fixed.length) process.stderr.write(`project-kit githooks: ${fixed.join('; ')}\n`);
      return;
    }
    const { notes, stop } = await collect();
    if (!notes.length) return;
    const out = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: notes.join('\n\n') } };
    if (stop) out.systemMessage = 'project-kit: the main checkout holds work that is not this session\'s (see the STOP note).';
    process.stdout.write(JSON.stringify(out));
  } catch (e) { logHookError(`session-start ${argv[0] || 'notes'}`, e); /* a reminder must never break a session */ }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).finally(() => process.exit(0));
}
