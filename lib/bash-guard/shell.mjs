// Minimal, dependency-free shell lexer for the bash-guard hook.
//
// It is NOT a full shell parser. It splits a command line into simple commands
// (on && || ; | & newline and parentheses), strips quotes, skips heredoc bodies,
// and recurses into $(...), `...`, `bash -c "..."`, `eval ...` and heredocs fed
// to a shell. That is enough to tell "text that mentions git add -A" (one quoted
// word, or a heredoc body) from "an actual git add -A invocation".

const MAX_DEPTH = 6;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const LEADING_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'time',
  'command', 'builtin', 'exec', 'nohup', 'sudo', 'env', 'nice', 'setsid',
]);

// Index of the ")" matching an already-consumed "$(" starting the scan at `start`.
function matchParen(src, start) {
  let depth = 1;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); i = j < 0 ? src.length : j + 1; continue; }
    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') i += src[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
    i++;
  }
  return src.length;
}

function matchBacktick(src, start) {
  let i = start;
  while (i < src.length && src[i] !== '`') i += src[i] === '\\' ? 2 : 1;
  return i;
}

// Run command substitutions found inside plain text (an unquoted heredoc body).
function scanSubstitutions(text, depth, out) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '$' && text[i + 1] === '(') {
      const end = matchParen(text, i + 2);
      parseWords(text.slice(i + 2, end), depth + 1, out);
      i = end;
    } else if (text[i] === '`') {
      const end = matchBacktick(text, i + 1);
      parseWords(text.slice(i + 1, end), depth + 1, out);
      i = end;
    }
  }
}

// Returns raw word arrays (quotes removed) for every simple command in `src`.
export function parseWords(src, depth = 0, out = []) {
  if (depth > MAX_DEPTH) return out;
  const n = src.length;
  let i = 0;
  let words = [];
  let word = null; // null = no word in progress ("" is a real empty word)
  const heredocs = [];

  const endWord = () => { if (word !== null) { words.push(word); word = null; } };
  const endCmd = () => { endWord(); if (words.length) out.push(words); words = []; };
  const add = (s) => { word = (word ?? '') + s; };

  const readSubst = (open, closeFn, skip) => {
    const end = closeFn(src, i + skip);
    parseWords(src.slice(i + skip, end), depth + 1, out);
    add(src.slice(i, Math.min(end + 1, n)));
    i = end + 1;
    void open;
  };

  while (i < n) {
    const c = src[i];

    if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue; }
      add(src[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j < 0 ? n : j;
      add(src.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (c === '"') {
      add('');
      i++;
      while (i < n && src[i] !== '"') {
        const d = src[i];
        if (d === '\\') {
          const nx = src[i + 1] ?? '';
          add('$`"\\\n'.includes(nx) ? (nx === '\n' ? '' : nx) : '\\' + nx);
          i += 2;
        } else if (d === '$' && src[i + 1] === '(') {
          readSubst('$(', matchParen, 2);
        } else if (d === '`') {
          readSubst('`', matchBacktick, 1);
        } else {
          add(d);
          i++;
        }
      }
      i++; // closing quote
      continue;
    }
    if (c === '$' && src[i + 1] === '(') { readSubst('$(', matchParen, 2); continue; }
    if (c === '`') { readSubst('`', matchBacktick, 1); continue; }

    if (c === '#' && word === null) {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '\n') {
      endWord();
      i++;
      for (const h of heredocs) {
        const lines = [];
        while (i < n) {
          let e = src.indexOf('\n', i);
          if (e < 0) e = n;
          const line = src.slice(i, e);
          i = Math.min(e + 1, n);
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
          lines.push(line);
        }
        const body = lines.join('\n');
        const owner = normalize(h.owner);
        if (owner && SHELLS.has(owner.name)) parseWords(body, depth + 1, out);
        else if (!h.quoted) scanSubstitutions(body, depth, out);
      }
      heredocs.length = 0;
      endCmd();
      continue;
    }
    if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<' && src[i + 2] !== '(') {
      i += 2;
      const strip = src[i] === '-';
      if (strip) i++;
      while (src[i] === ' ' || src[i] === '\t') i++;
      let delim = '';
      let quoted = false;
      while (i < n && !/[\s;&|<>()]/.test(src[i])) {
        const d = src[i];
        if (d === "'" || d === '"') {
          quoted = true;
          const j = src.indexOf(d, i + 1);
          const end = j < 0 ? n : j;
          delim += src.slice(i + 1, end);
          i = end + 1;
        } else if (d === '\\') {
          quoted = true;
          delim += src[i + 1] ?? '';
          i += 2;
        } else { delim += d; i++; }
      }
      heredocs.push({ delim, strip, quoted, owner: words.concat(word === null ? [] : [word]) });
      continue;
    }
    if (c === '&' && src[i + 1] === '&') { endCmd(); i += 2; continue; }
    if (c === '|' && src[i + 1] === '|') { endCmd(); i += 2; continue; }
    if (c === '&' && ((word !== null && /[<>]$/.test(word)) || src[i + 1] === '>')) { add(c); i++; continue; }
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')') { endCmd(); i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; continue; }
    add(c);
    i++;
  }
  endCmd();
  return out;
}

// Strip leading keywords, wrappers and VAR=x assignments: {name, args, words}.
export function normalize(words) {
  let k = 0;
  let afterWrapper = false;
  while (k < words.length) {
    const w = words[k];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { k++; continue; }
    if (LEADING_KEYWORDS.has(w)) { afterWrapper = true; k++; continue; }
    if (afterWrapper && w.startsWith('-')) { k++; continue; }
    break;
  }
  if (k >= words.length) return null;
  return { name: words[k].split('/').pop(), args: words.slice(k + 1), words };
}

// All commands in `src`, normalised, including those inside bash -c / eval.
export function getCommands(src) {
  const result = [];
  const visit = (text, depth) => {
    for (const words of parseWords(text, 0, [])) {
      const cmd = normalize(words);
      if (!cmd) continue;
      result.push(cmd);
      if (depth >= MAX_DEPTH) continue;
      if (SHELLS.has(cmd.name)) {
        const idx = cmd.args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
        if (idx >= 0 && cmd.args[idx + 1] !== undefined) visit(cmd.args[idx + 1], depth + 1);
      } else if (cmd.name === 'eval') {
        visit(cmd.args.join(' '), depth + 1);
      }
    }
  };
  visit(src, 0);
  return result;
}

// For a `git ...` command: {sub, args} with global options (-C dir, -c k=v, ...) skipped.
export function gitInvocation(cmd) {
  if (!cmd || cmd.name !== 'git') return null;
  const a = cmd.args;
  const takesValue = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix']);
  let k = 0;
  while (k < a.length && a[k].startsWith('-')) k += takesValue.has(a[k]) ? 2 : 1;
  if (k >= a.length) return null;
  return { sub: a[k], args: a.slice(k + 1) };
}
