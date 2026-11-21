#!/usr/bin/env node
// PreToolUse(Bash) guard. Reads the hook JSON on stdin; if a rule objects, prints the reason to stderr
// and exits 2 (Claude Code blocks the command and shows the reason to the agent).
//
// Rules live in rules/<layer>/*.mjs. rules/core/ always runs; another layer's folder runs only when that
// layer is installed (repo mode, .claude/kit/installed.json). The plugin runs core only.
//
// ADDING A RULE: drop a file in rules/<layer>/ exporting
//   export const name = 'my-rule';
//   export function check({ command, commands, cwd }) { return null /* allow */ || 'message' /* block */; }
// `commands` is [{name, args, words}] for every simple command in the line (see shell.mjs).
// Rules run layer by layer, files in name order; the first message wins. No registration needed.
//
// FAIL OPEN: a crash, bad input or rule error allows the command and appends a line to
// <state>/bash-guard-errors.log. A bug here must never stop an agent from working.
import { existsSync, readdirSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getCommands } from './shell.mjs';
import { layers as activeLayers, stateDir } from '../kit-env.mjs';

const RULES = join(dirname(fileURLToPath(import.meta.url)), 'rules');

function logError(msg) {
  try {
    appendFileSync(join(stateDir(), 'bash-guard-errors.log'), `${new Date().toISOString()} ${msg}\n`);
  } catch { /* nothing more we can do */ }
}

export function ruleFiles(layers = activeLayers()) {
  const out = [];
  for (const layer of layers) {
    const dir = join(RULES, layer);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs')).sort()) out.push(join(dir, f));
  }
  return out;
}

/** {rule, message} for the first rule that blocks `command`, else null. */
export async function evaluate(command, cwd = process.cwd(), layers = activeLayers()) {
  const commands = getCommands(command);
  for (const file of ruleFiles(layers)) {
    try {
      const mod = await import(pathToFileURL(file).href);
      const message = mod.check({ command, commands, cwd });
      if (message) return { rule: mod.name || file, message };
    } catch (e) {
      logError(`rule ${file} failed: ${e && e.stack ? e.stack.split('\n')[0] : e}`); // that rule fails open
    }
  }
  return null;
}

async function main() {
  const watchdog = setTimeout(() => { logError('watchdog timeout, allowing'); process.exit(0); }, 2500);
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    if (input.tool_name !== 'Bash' || typeof input.tool_input?.command !== 'string') process.exit(0);
    const hit = await evaluate(input.tool_input.command, input.cwd);
    if (hit) {
      process.stderr.write(`project-kit bash-guard [${hit.rule}]: ${hit.message}\n`);
      process.exit(2);
    }
  } catch (e) {
    logError(`hook error, allowing: ${e && e.message}`);
  }
  clearTimeout(watchdog);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
