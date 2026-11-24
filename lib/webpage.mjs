// Fetch a web article (blog post, technical write-up) and turn it into plain
// Markdown-ish text: headings, paragraphs, list items. No dependencies; good
// enough for server-rendered blogs. Pages that render with JavaScript come back
// short, and callers fall back to letting Claude fetch them.

import { isPublicHttpsUrl } from './download.mjs';
import { fetchWithProxyFallback } from './net.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const MAX_BYTES = 6 * 1024 * 1024;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', times: '×', middot: '·', bull: '•', deg: '°' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function meta(html, names) {
  for (const n of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${n}["']`, 'i');
    const m = html.match(re);
    if (m) return decodeEntities(m[1] ?? m[2]).trim();
  }
  return '';
}

const textLen = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;

function blocks(html, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  return [...html.matchAll(re)].map((m) => m[1]);
}

/**
 * The part of the page that holds the article: the <article>/<main> block with
 * the most text, unless it holds only a small share of the page's text (then it
 * is a teaser card and the whole body is used).
 */
function articleRegion(html) {
  const body = blocks(html, 'body')[0] ?? html;
  const total = textLen(body);
  const best = [...blocks(html, 'article'), ...blocks(html, 'main')].map((h) => ({ h, n: textLen(h) })).sort((a, b) => b.n - a.n)[0];
  return best && best.n >= 1500 && best.n >= total * 0.3 ? best.h : body;
}

export function htmlToText(html) {
  const title = meta(html, ['og:title', 'twitter:title']) || decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
  const date = meta(html, ['article:published_time', 'date', 'publish-date', 'pubdate', 'citation_publication_date']);
  let body = html.replace(/<!--[\s\S]*?-->/g, '');
  body = body.replace(/<(script|style|noscript|svg|iframe|template|form|button|select|canvas)\b[\s\S]*?<\/\1>/gi, ' ');
  const region = articleRegion(body);
  let s = region.replace(/<(nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${'#'.repeat(Math.min(Number(n) + 1, 4))} ${t}\n\n`)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<img\b[^>]*alt=["']([^"']+)["'][^>]*>/gi, (_, a) => `\n[图：${a}]\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|li|ul|ol|blockquote|figure|figcaption|tr|table|pre|h[1-6])>/gi, '\n\n')
    .replace(/<(p|div|section|blockquote|figure|figcaption|tr|table|pre)\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s)
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n');
  // Drop exact repeats of short lines (menus, share buttons echoed twice).
  const seen = new Set();
  s = s
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n+/g, (m) => (m.length > 1 ? '\n' : ' ')).trim())
    .filter((p) => {
      if (!p || /^-\s*$/.test(p)) return false;
      if (p.length < 80) {
        if (seen.has(p)) return false;
        seen.add(p);
      }
      return true;
    })
    .join('\n\n');
  return { title, date, text: s.trim() };
}

/** Fetch and extract an article. Throws on non-public URLs, HTTP errors and non-HTML. */
export async function fetchArticle(url, { fetchImpl = fetch } = {}) {
  if (!isPublicHttpsUrl(url)) throw new Error(`只能抓取公网 https 链接: ${url}`);
  const res = await fetchWithProxyFallback(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000), headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' } }, { fetchImpl, maxBytes: MAX_BYTES });
  if (!res.ok) throw new Error(`抓取失败：HTTP ${res.status}`);
  if (res.url && !isPublicHttpsUrl(res.url)) throw new Error('页面跳转到了不允许的地址');
  const type = res.headers.get('content-type') ?? '';
  if (type && !/html|xml|text\/plain/i.test(type)) throw new Error(`不是网页（${type}）`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('网页太大');
  const html = buf.toString('utf8');
  const out = /text\/plain/i.test(type) ? { title: '', date: '', text: html.trim() } : htmlToText(html);
  return { ...out, url: res.url || url, chars: out.text.length };
}
