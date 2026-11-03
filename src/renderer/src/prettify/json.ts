import { errorAt, type PrettifyResult } from './result';

/**
 * Re-indents JSON (and JSONC: comments and trailing commas) one value per line, keeping every
 * token exactly as written. Parsing into values and printing them again would quietly change
 * what's compared: `1.0` would become `1`, `1e3` would become `1000`, large integers would lose
 * digits and duplicate keys would vanish. Here only the whitespace between tokens changes.
 *
 * The structure is checked as it goes, so invalid JSON is reported with its position.
 */
export function formatJson(text: string, indentUnit = '  '): PrettifyResult {
  const out: string[] = [];
  let line = '';
  let depth = 0;
  const newline = () => {
    if (line) out.push(line);
    line = indentUnit.repeat(depth);
  };
  const atLineStart = () => line.trim() === '';

  /** What may come next in each open container. */
  type Expect = 'value' | 'key' | 'colon' | 'comma-or-close' | 'value-or-close' | 'key-or-close';
  const stack: { close: '}' | ']'; expect: Expect }[] = [];
  let topLevelDone = false;
  const top = () => stack[stack.length - 1];

  let i = 0;
  const n = text.length;
  const fail = (what: string, at = i) => errorAt(text, at, what);

  /** Records that a complete value was just written. */
  const valueDone = () => {
    const t = top();
    if (t) t.expect = 'comma-or-close';
    else topLevelDone = true;
  };
  const canTakeValue = () => {
    const t = top();
    return t ? t.expect === 'value' || t.expect === 'value-or-close' : !topLevelDone;
  };

  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\ufeff') {
      i++;
      continue;
    }
    // Comments (JSONC) go on their own line, exactly as written.
    if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      const end = text[i + 1] === '/' ? indexOrEnd(text, '\n', i) : text.indexOf('*/', i + 2);
      if (end < 0) return fail('Unterminated comment');
      const comment = text.slice(i, text[i + 1] === '/' ? end : end + 2).trimEnd();
      if (!atLineStart()) newline();
      line += comment;
      newline();
      i = text[i + 1] === '/' ? end : end + 2;
      continue;
    }
    const t = top();
    if (c === '{' || c === '[') {
      if (t?.expect === 'key' || t?.expect === 'key-or-close') return fail('Expected a property name');
      if (!canTakeValue()) return fail(`Unexpected "${c}"`);
      const close = c === '{' ? '}' : ']';
      // An empty container stays on one line.
      const next = skipSpace(text, i + 1);
      if (text[next] === close) {
        line += c + close;
        i = next + 1;
        valueDone();
        continue;
      }
      line += c;
      stack.push({ close, expect: c === '{' ? 'key-or-close' : 'value-or-close' });
      depth++;
      newline();
      i++;
      continue;
    }
    if (c === '}' || c === ']') {
      if (!t || t.close !== c) return fail(`Unexpected "${c}"`);
      // A trailing comma (JSONC) leaves the container expecting another entry; allow it.
      if (t.expect === 'colon' || (t.expect === 'value' && t.close === '}')) return fail(`Unexpected "${c}"`);
      stack.pop();
      depth--;
      if (!atLineStart()) newline();
      else line = indentUnit.repeat(depth);
      line += c;
      i++;
      valueDone();
      continue;
    }
    if (c === ',') {
      if (!t || t.expect !== 'comma-or-close') return fail('Unexpected ","');
      t.expect = t.close === '}' ? 'key-or-close' : 'value-or-close';
      line += ',';
      newline();
      i++;
      continue;
    }
    if (c === ':') {
      if (!t || t.expect !== 'colon') return fail('Unexpected ":"');
      t.expect = 'value';
      line += ': ';
      i++;
      continue;
    }
    if (c === '"') {
      const end = stringEnd(text, i);
      if (end < 0) return fail('Unterminated string');
      const token = text.slice(i, end);
      if (t && (t.expect === 'key' || t.expect === 'key-or-close')) {
        t.expect = 'colon';
      } else if (canTakeValue()) {
        valueDone();
      } else return fail('Unexpected string');
      line += token;
      i = end;
      continue;
    }
    // Numbers and the literals true, false and null.
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 400));
    if (m && !/[\w.]/.test(text[i + m[0].length] ?? '')) {
      if (!canTakeValue()) return fail(`Unexpected "${m[0]}"`);
      line += m[0];
      i += m[0].length;
      valueDone();
      continue;
    }
    return fail(`Unexpected "${c}"`);
  }
  if (stack.length) return fail(`Missing "${top()!.close}" at the end`, n);
  if (!topLevelDone) return fail('No JSON value found', n);
  if (line.trim()) out.push(line);
  return { ok: true, text: out.join('\n') + '\n' };
}

const indexOrEnd = (text: string, s: string, from: number) => {
  const k = text.indexOf(s, from);
  return k < 0 ? text.length : k;
};

function skipSpace(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/** Index just past the closing quote of the string starting at `start`, or -1. */
function stringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === '"') return i + 1;
    else if (c === '\n') return -1;
  }
  return -1;
}
