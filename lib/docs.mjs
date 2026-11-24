// Markdown documents in the library: web articles (official blogs, technical
// write-ups) and the short notes that point at them.

import fs from 'node:fs';
import { extractTextOff } from './pdfpool.mjs';

const URL_RE = /https?:\/\/[^\s)<>\]"'，。；）]+/g;
const SOURCE_LINE = /(原始来源|原文链接|原文|来源|链接|source|url|link)\s*[:：]/i;

/**
 * Read a Markdown note. A "stub" is a short note (index card) that points at
 * the real article; its `sourceUrl` is the link on a "原始来源/source:" line,
 * or the only link in the note.
 */
export function parseNote(text) {
  const s = String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const title = s.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? '';
  let sourceUrl = '';
  for (const line of s.split('\n')) {
    if (SOURCE_LINE.test(line)) {
      const u = line.match(URL_RE)?.[0];
      if (u) {
        sourceUrl = u;
        break;
      }
    }
  }
  const urls = [...new Set(s.match(URL_RE) ?? [])];
  if (!sourceUrl && urls.length === 1) sourceUrl = urls[0];
  // Prose apart from headings and "- key: value" metadata lines.
  const prose = s
    .split('\n')
    .filter((l) => !/^\s*#/.test(l) && !/^\s*[-*]\s*[^:：]{1,12}[:：]/.test(l))
    .join('')
    .replace(/\s+/g, '');
  return { title, sourceUrl, isStub: prose.length < 1500, text: s };
}

/** Snapshot file content for a fetched article. */
export function snapshotText(article, fetchedAt = new Date()) {
  return `# ${article.title || '（无标题）'}\n\n来源：${article.url}\n${article.date ? `发布：${article.date}\n` : ''}抓取：${fetchedAt.toISOString().slice(0, 10)}\n\n${article.text}\n`;
}

/** Full text of a library document, for explanations and comparisons. */
export async function docText(paper) {
  if (paper.format !== 'markdown') return (await extractTextOff(paper.pdfPath)).text;
  const parts = [];
  if (paper.snapshotPath && fs.existsSync(paper.snapshotPath)) parts.push(`<article_snapshot>\n${fs.readFileSync(paper.snapshotPath, 'utf8')}\n</article_snapshot>`);
  if (paper.docPath && fs.existsSync(paper.docPath)) parts.push(`<user_note>\n${fs.readFileSync(paper.docPath, 'utf8')}\n</user_note>`);
  return parts.join('\n\n');
}

const cjkShare = (t) => (t.match(/[㐀-鿿]/g) ?? []).length / Math.max(1, t.replace(/\s/g, '').length);

/**
 * Paragraph "layout" for a Markdown document, shaped like the PDF layout
 * (pages of paragraphs) so translation and the reader can treat both alike.
 * Paragraphs already in Chinese get kind 'zh' and are not translated.
 */
export function markdownLayout(text, { perPage = 18 } = {}) {
  const paras = [];
  // Drop the header snapshotText() adds (title, 来源, 发布, 抓取): the reader
  // shows the source link itself, and the page repeats the title anyway.
  const body = String(text)
    .replace(/\r\n/g, '\n')
    .replace(/^# [^\n]*\n\n来源：[^\n]*\n(发布：[^\n]*\n)?抓取：[^\n]*\n+/, '');
  for (const block of body.split(/\n{2,}/)) {
    const b = block.trim();
    if (!b) continue;
    const head = b.match(/^(#{1,6})\s+(.*)$/s);
    // Keep list blocks together but one item per line.
    const t = (head ? head[2] : b).replace(/\n(?![-*]\s)/g, ' ').trim();
    if (!t) continue;
    const kind = head ? 'heading' : /^\[图：/.test(t) || t.length < 3 ? 'frag' : cjkShare(t) > 0.25 ? 'zh' : 'text';
    paras.push({ text: t, kind, level: head ? head[1].length : 0 });
  }
  const pages = [];
  for (let i = 0; i < paras.length; i += perPage) {
    pages.push({ page: pages.length + 1, paras: paras.slice(i, i + perPage).map((p) => (p.kind === 'heading' && cjkShare(p.text) > 0.25 ? { ...p, kind: 'zh' } : p)) });
  }
  return pages.length ? pages : [{ page: 1, paras: [] }];
}
