import { errorAt, type PrettifyResult } from './result';

/**
 * Puts XML and HTML one element per line, indented by depth. Tags are kept exactly as written
 * (attributes included); only the whitespace between them changes.
 *
 * - An element holding only text stays on one line with its text untouched: `<name>text</name>`.
 * - Text mixed with elements goes on its own line, with the whitespace around it trimmed.
 * - Comments, CDATA, `<!DOCTYPE …>` and `<?…?>` go on their own lines, unchanged.
 * - HTML: `<pre>`, `<textarea>`, `<script>` and `<style>` keep their contents exactly; void
 *   elements (`<br>`, `<img>`…) don't open a level; a missing `</li>`, `</p>`, `</td>`… is
 *   tolerated, as browsers do.
 * - XML is strict: a mismatched or missing end tag is an error, with its position.
 */
export function formatMarkup(text: string, html: boolean, indentUnit = '  '): PrettifyResult {
  const tokens = tokenize(text, html);
  if (!Array.isArray(tokens)) return tokens;
  const out: string[] = [];
  const stack: string[] = [];
  const emit = (s: string) => out.push(indentUnit.repeat(stack.length) + s);
  const same = (a: string, b: string) => (html ? a.toLowerCase() === b.toLowerCase() : a === b);

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    switch (t.type) {
      case 'text': {
        const trimmed = t.raw.trim();
        if (trimmed) emit(trimmed);
        break;
      }
      case 'open': {
        if (html) {
          // A new <li> closes the previous one, and so on, as browsers do.
          const closes = IMPLIED_END[t.name.toLowerCase()];
          const top = stack[stack.length - 1]?.toLowerCase();
          if (closes && top && closes.includes(top)) stack.pop();
        }
        if (t.selfClosing || (html && VOID.has(t.name.toLowerCase()))) {
          emit(t.raw);
          break;
        }
        if (t.rawContent !== undefined) {
          // <pre>, <script>… exactly as written, end tag included.
          emit(t.raw + t.rawContent + (t.rawEnd ?? ''));
          break;
        }
        // Only text inside (or nothing): keep it on one line, text untouched.
        const next = tokens[k + 1];
        const after = tokens[k + 2];
        if (next?.type === 'close' && same(next.name, t.name)) {
          emit(t.raw + next.raw);
          k += 1;
          break;
        }
        if (next?.type === 'text' && after?.type === 'close' && same(after.name, t.name)) {
          emit(t.raw + next.raw + after.raw);
          k += 2;
          break;
        }
        emit(t.raw);
        stack.push(t.name);
        break;
      }
      case 'close': {
        const at = findLast(stack, (s) => same(s, t.name));
        if (at < 0) {
          if (!html) return errorAt(text, t.offset, `Unexpected ${t.raw}`);
          emit(t.raw); // a stray end tag: shown where it is
          break;
        }
        if (!html && at !== stack.length - 1) return errorAt(text, t.offset, `Expected </${stack[stack.length - 1]}> but found ${t.raw}`);
        stack.length = at;
        emit(t.raw);
        break;
      }
      default:
        emit(t.raw.trim());
    }
  }
  if (!html && stack.length) return errorAt(text, text.length, `Missing </${stack[stack.length - 1]}> at the end`);
  return { ok: true, text: out.join('\n') + '\n' };
}

type Token =
  | { type: 'text'; raw: string }
  | { type: 'comment' | 'cdata' | 'declaration'; raw: string }
  | { type: 'open'; raw: string; name: string; selfClosing: boolean; rawContent?: string; rawEnd?: string }
  | { type: 'close'; raw: string; name: string; offset: number };

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/** HTML elements whose contents are kept exactly. */
const RAW = new Set(['pre', 'textarea', 'script', 'style']);
/** Opening one of these closes an open element of the listed kinds. */
const IMPLIED_END: Record<string, string[]> = {
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  tr: ['tr', 'td', 'th'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  option: ['option'],
  p: ['p'],
};

function tokenize(text: string, html: boolean): Token[] | PrettifyResult {
  const tokens: Token[] = [];
  /** Adds text, joining it to text just before (a stray "<" splits it otherwise). */
  const pushText = (raw: string) => {
    const last = tokens[tokens.length - 1];
    if (last?.type === 'text') last.raw += raw;
    else tokens.push({ type: 'text', raw });
  };
  let i = 0;
  const n = text.length;
  const until = (end: string, from: number, what: string): number | PrettifyResult => {
    const k = text.indexOf(end, from);
    return k < 0 ? errorAt(text, i, `Unterminated ${what}`) : k + end.length;
  };
  while (i < n) {
    if (text[i] !== '<') {
      const k = text.indexOf('<', i);
      const end = k < 0 ? n : k;
      pushText(text.slice(i, end));
      i = end;
      continue;
    }
    if (text.startsWith('<!--', i)) {
      const end = until('-->', i + 4, 'comment');
      if (typeof end !== 'number') return end;
      tokens.push({ type: 'comment', raw: text.slice(i, end) });
      i = end;
    } else if (text.startsWith('<![CDATA[', i)) {
      const end = until(']]>', i + 9, 'CDATA section');
      if (typeof end !== 'number') return end;
      tokens.push({ type: 'cdata', raw: text.slice(i, end) });
      i = end;
    } else if (text[i + 1] === '?' || text[i + 1] === '!') {
      const end = until(text[i + 1] === '?' ? '?>' : '>', i + 2, 'declaration');
      if (typeof end !== 'number') return end;
      tokens.push({ type: 'declaration', raw: text.slice(i, end) });
      i = end;
    } else if (text[i + 1] === '/') {
      const end = until('>', i + 2, 'end tag');
      if (typeof end !== 'number') return end;
      const raw = text.slice(i, end);
      tokens.push({ type: 'close', raw, name: raw.slice(2, -1).trim(), offset: i });
      i = end;
    } else if (/[A-Za-z_:]/.test(text[i + 1] ?? '')) {
      const end = tagEnd(text, i);
      if (end < 0) return errorAt(text, i, 'Unterminated tag');
      const raw = text.slice(i, end);
      const name = /^<([^\s/>]+)/.exec(raw)![1];
      const selfClosing = raw.endsWith('/>');
      const tok: Token & { type: 'open' } = { type: 'open', raw, name, selfClosing };
      i = end;
      if (html && !selfClosing && RAW.has(name.toLowerCase())) {
        const close = new RegExp(`</${name}\\s*>`, 'i');
        const m = close.exec(text.slice(i));
        const contentEnd = m ? i + m.index : n;
        tok.rawContent = text.slice(i, contentEnd);
        tok.rawEnd = m?.[0];
        i = m ? contentEnd + m[0].length : n;
      }
      tokens.push(tok);
    } else {
      // A "<" that starts no tag ("a < b" in HTML) is text.
      if (!html) return errorAt(text, i, 'Unexpected "<"');
      const k = text.indexOf('<', i + 1);
      const end = k < 0 ? n : k;
      pushText(text.slice(i, end));
      i = end;
    }
  }
  return tokens;
}

/** Index just past the ">" ending the tag at `start`, skipping quoted attribute values; or -1. */
function tagEnd(text: string, start: number): number {
  let quote = '';
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i + 1;
  }
  return -1;
}

function findLast<T>(list: T[], test: (item: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (test(list[i])) return i;
  return -1;
}
