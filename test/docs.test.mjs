import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { markdownLayout, parseNote, snapshotText } from '../lib/docs.mjs';
import { serializeFrontmatter } from '../lib/frontmatter.mjs';
import { ensureLayout, findDuplicate, ingest, listInbox, loadPapers, moveToFailed } from '../lib/library.mjs';
import { buildArticlePrompt } from '../lib/watch.mjs';
import { htmlToText } from '../lib/webpage.mjs';

const STUB = `# Introducing Helix 02: Full-Body Autonomy

- 机构：Figure AI
- 类型：官方技术博客 / 发布说明
- 日期：2026-01-27
- 原始来源：https://www.figure.ai/news/helix-02

## 阅读说明

官方技术博客。本文件是中文索引与简要说明，不是原文全文。
`;

const BODY = `## 一句话\n\n测试。\n\n## 动机\n\n${'动机说明。'.repeat(30)}\n\n## 方法\n\n${'方法说明。'.repeat(30)}\n\n## 实验与结果\n\n${'文中未给出定量结果。'.repeat(10)}\n`;
const summary = (meta) => serializeFrontmatter({ tldr: '一句话', authors: ['Figure AI'], year: 2026, ...meta }, BODY);
const lib = () => ensureLayout(fs.mkdtempSync(path.join(os.tmpdir(), 'pv-md-')));

test('a short note with a source line is a stub pointing at its article', () => {
  const n = parseNote(STUB);
  assert.equal(n.title, 'Introducing Helix 02: Full-Body Autonomy');
  assert.equal(n.sourceUrl, 'https://www.figure.ai/news/helix-02');
  assert.equal(n.isStub, true);
  assert.equal(parseNote(`# Long\n\n${'Real article text. '.repeat(200)}`).isStub, false);
});

test('markdown layout: headings, English paragraphs to translate, Chinese ones kept', () => {
  const pages = markdownLayout('# Title\n\nFirst English paragraph about robots.\n\n这一段本来就是中文，不需要翻译。\n\n[图：a figure]', { perPage: 2 });
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.flatMap((p) => p.paras.map((x) => x.kind)), ['heading', 'text', 'zh', 'frag']);
});

test('the article region is the main text, not a teaser card', () => {
  const html = `<html><head><meta property="og:title" content="Big &amp; Real"></head><body><nav>menu</nav>
    <article><h3>Related post</h3><p>Learn more</p></article>
    <div class="post"><h1>Big &amp; Real</h1>${Array.from({ length: 60 }, (_, i) => `<p>Real article paragraph ${i} with plenty of words in it.</p>`).join('')}</div>
    <script>var x = "<p>not text</p>";</script></body></html>`;
  const r = htmlToText(html);
  assert.equal(r.title, 'Big & Real');
  assert.match(r.text, /Real article paragraph/);
  assert.doesNotMatch(r.text, /not text|menu/);
});

test('a stub becomes a prompt with the fetched article; an unreachable page lets Claude fetch it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-art-'));
  const file = path.join(dir, 'Helix_02.md');
  fs.writeFileSync(file, STUB);
  const paras = Array.from({ length: 40 }, (_, i) => `<p>Paragraph ${i}: Helix 02 extends control to the entire robot body.</p>`).join('');
  const page = `<html><body><article><h1>Helix 02</h1>${paras}</article></body></html>`;
  const ok = await buildArticlePrompt(file, { fetchImpl: async () => new Response(page, { headers: { 'content-type': 'text/html' } }) });
  assert.deepEqual(ok.tools, []);
  assert.match(ok.prompt, /<article url="https:\/\/www.figure.ai\/news\/helix-02"/);
  assert.match(ok.prompt, /<user_note>/);
  assert.ok(ok.article.chars > 800);
  const fail = await buildArticlePrompt(file, { fetchImpl: async () => new Response('nope', { status: 503 }) });
  assert.deepEqual(fail.tools, ['WebFetch']);
  assert.match(fail.prompt, /WebFetch 打开 https:\/\/www.figure.ai\/news\/helix-02/);
  fs.writeFileSync(file, '# Only a title\n\nshort');
  await assert.rejects(buildArticlePrompt(file), /没法入库/);
});

test('Markdown docs are filed with their article snapshot and de-duplicated by source URL', () => {
  const d = lib();
  const f = path.join(d.inbox, 'Helix_02.md');
  fs.writeFileSync(f, STUB);
  assert.deepEqual(listInbox(d).map((p) => path.basename(p)), ['Helix_02.md']);
  const article = { title: 'Helix 02', url: 'https://www.figure.ai/news/helix-02', date: '', text: 'Body text.' };
  const r = ingest(f, summary({ title: 'Introducing Helix 02: Full-Body Autonomy' }), { d, snapshot: snapshotText(article), sourceUrl: article.url });
  assert.equal(r.status, 'added');
  const [p] = loadPapers(d);
  assert.equal(p.format, 'markdown');
  assert.equal(p.meta.url, 'https://www.figure.ai/news/helix-02');
  assert.equal(p.pdfPath, null);
  assert.ok(p.docPath.endsWith('.md') && fs.existsSync(p.docPath));
  assert.match(fs.readFileSync(p.snapshotPath, 'utf8'), /来源：https:\/\/www.figure.ai\/news\/helix-02/);
  assert.ok(findDuplicate({ format: 'markdown', title: 'Other title', url: 'http://figure.ai/news/helix-02/' }, loadPapers(d)));
});

test('a failed Markdown file keeps its content; the log goes next to it', () => {
  const d = lib();
  const f = path.join(d.inbox, 'note.md');
  fs.writeFileSync(f, STUB);
  const dst = moveToFailed(f, 'why it failed', d);
  assert.equal(fs.readFileSync(dst, 'utf8'), STUB);
  assert.equal(fs.readFileSync(path.join(d.failed, 'note.log'), 'utf8'), 'why it failed');
});

test('the snapshot header is not shown as article content', () => {
  const snap = snapshotText({ title: 'T', url: 'https://x.org/a', date: 'Jan 1', text: 'First real paragraph here.' });
  const paras = markdownLayout(snap).flatMap((p) => p.paras);
  assert.deepEqual(paras.map((p) => p.text), ['First real paragraph here.']);
});
