// Minimal YAML-frontmatter reader/writer for summary.md files.
// Supports the subset the summaries use: `key: scalar`, `key: [a, b]` flow lists,
// and block lists (`key:` followed by `  - item` lines). No nesting.

const LIST_KEYS = new Set(['authors', 'tags', 'models', 'datasets', 'methods']);

function unquote(s) {
  s = s.trim();
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    const inner = s.slice(1, -1);
    return s[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner.replace(/''/g, "'");
  }
  return s;
}

function splitFlowList(s) {
  const inner = s.trim().replace(/^\[/, '').replace(/\]$/, '');
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',' || ch === '，') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(unquote).filter((x) => x !== '');
}

export function parseFrontmatter(text) {
  text = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!m) return { meta: {}, body: text, hasFrontmatter: false };
  const meta = {};
  let lastKey = null;
  for (const line of m[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && lastKey) {
      if (!Array.isArray(meta[lastKey])) meta[lastKey] = [];
      meta[lastKey].push(unquote(item[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    lastKey = key;
    const v = raw.trim();
    if (v.startsWith('[')) meta[key] = splitFlowList(v);
    else if (v === '') meta[key] = LIST_KEYS.has(key) ? [] : '';
    else meta[key] = unquote(v);
  }
  for (const k of LIST_KEYS) {
    if (typeof meta[k] === 'string') meta[k] = meta[k] ? splitFlowList(meta[k]) : [];
  }
  return { meta, body: text.slice(m[0].length), hasFrontmatter: true };
}

function quoteIfNeeded(s) {
  s = String(s);
  if (s === '' || /[:#\[\]{},"'&*!|>%@`]|^\s|\s$|^-/.test(s)) return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  return s;
}

export const FIELD_ORDER = [
  'id', 'title', 'authors', 'year', 'venue', 'arxiv', 'doi', 'url',
  'tags', 'models', 'datasets', 'methods', 'tldr', 'added', 'pdf', 'original_filename', 'sha256',
];

export function serializeFrontmatter(meta, body) {
  const keys = [...FIELD_ORDER.filter((k) => k in meta), ...Object.keys(meta).filter((k) => !FIELD_ORDER.includes(k))];
  const lines = keys.map((k) => {
    const v = meta[k];
    if (Array.isArray(v)) return `${k}: [${v.map(quoteIfNeeded).join(', ')}]`;
    return `${k}: ${quoteIfNeeded(v ?? '')}`;
  });
  return `---\n${lines.join('\n')}\n---\n\n${body.replace(/^\n+/, '')}`;
}
