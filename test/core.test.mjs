import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseFrontmatter, serializeFrontmatter } from '../lib/frontmatter.mjs';
import { backfillHashes, ensureLayout, findDuplicate, ingest, loadPapers, makeId, normArxiv } from '../lib/library.mjs';
import { buildIndex, search, tokenize } from '../lib/search.mjs';
import { childEnv, extractSummary, processPdf } from '../lib/watch.mjs';

const BODY = `## 一句话\n\n测试。\n\n## 动机\n\n${'现有方法不够好。'.repeat(20)}\n\n## 方法\n\n${'我们用一个模型。'.repeat(20)}\n\n## 实验与结果\n\n${'成功率提升。'.repeat(20)}\n`;

function summary(meta) {
  return serializeFrontmatter({ tldr: '一句话总结', authors: ['Ada Lovelace'], year: 2025, ...meta }, BODY);
}

function tmpLib() {
  return ensureLayout(fs.mkdtempSync(path.join(os.tmpdir(), 'pv-')));
}

test('frontmatter round-trips lists, quotes and colons', () => {
  const meta = { title: 'X: a "quoted" title', authors: ['A B', 'C, D'], models: ['Qwen2.5-VL-7B', 'GPT-4o（评测用）'], tldr: 'ok' };
  const { meta: back, body } = parseFrontmatter(serializeFrontmatter(meta, 'hello'));
  assert.equal(back.title, meta.title);
  assert.deepEqual(back.authors, meta.authors);
  assert.deepEqual(back.models, meta.models);
  assert.equal(body.trim(), 'hello');
});

test('frontmatter accepts block lists and CRLF', () => {
  const { meta } = parseFrontmatter('---\r\ntitle: T\r\nmodels:\r\n  - A\r\n  - B\r\n---\r\nbody');
  assert.deepEqual(meta.models, ['A', 'B']);
});

test('tokenize splits model names and CJK', () => {
  const t = tokenize('Qwen2.5-VL 世界模型');
  for (const w of ['qwen2.5-vl', 'qwen', 'vl', '世界', '模型']) assert.ok(t.includes(w), w);
});

test('search finds a paper by a remembered detail', () => {
  const papers = [
    { meta: { id: 'a', title: 'Alpha', models: ['Qwen2-VL-2B'], tldr: '扩散专家' }, body: '叠衣服' },
    { meta: { id: 'b', title: 'Beta', models: ['PaliGemma'], tldr: 'flow matching' }, body: '收桌子' },
  ];
  const idx = buildIndex(papers);
  assert.equal(search(idx, '我记得有篇论文用了 qwen')[0].paper.meta.id, 'a');
  assert.equal(search(idx, 'flow matching 收桌子')[0].paper.meta.id, 'b');
  assert.deepEqual(search(idx, '我记得有篇论文用了 qwen').map((r) => r.paper.meta.id), ['a']);
});

test('ids are readable and unique', () => {
  const meta = { year: 2024, authors: ['Kevin Black'], title: 'π0: A Vision-Language-Action Flow Model' };
  assert.equal(makeId(meta, new Set()), '2024-black-pi0-vision-language-action');
  assert.equal(makeId(meta, new Set(['2024-black-pi0-vision-language-action'])), '2024-black-pi0-vision-language-action-2');
  assert.equal(normArxiv('arXiv:2406.09246v3'), '2406.09246');
});

test('ingest files a PDF from the inbox and detects duplicates', () => {
  const d = tmpLib();
  const pdf = path.join(d.inbox, 'x.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4 fake');
  const r = ingest(pdf, summary({ title: 'Some Paper Title', arxiv: '2501.00001v2' }), { d });
  assert.equal(r.status, 'added');
  assert.ok(!fs.existsSync(pdf), 'inbox PDF removed');
  const [p] = loadPapers(d);
  assert.equal(p.meta.arxiv, '2501.00001');
  assert.ok(fs.existsSync(p.pdfPath));

  assert.match(p.meta.sha256, /^[0-9a-f]{64}$/);

  const again = path.join(d.inbox, 'y.pdf');
  fs.writeFileSync(again, '%PDF-1.4 different bytes');
  const r2 = ingest(again, summary({ title: 'Different Title', arxiv: '2501.00001' }), { d });
  assert.equal(r2.status, 'duplicate');
  assert.ok(fs.existsSync(path.join(d.duplicates, 'y.pdf')));
  assert.equal(loadPapers(d).length, 1);
  assert.ok(findDuplicate({ title: 'some paper title' }, loadPapers(d)));
});

test('processPdf skips an identical PDF without calling Claude', async () => {
  const d = tmpLib();
  const first = path.join(d.inbox, 'a.pdf');
  fs.writeFileSync(first, '%PDF-1.4 same bytes');
  ingest(first, summary({ title: 'Hash Me' }), { d });
  const copy = path.join(d.inbox, 'a-copy.pdf');
  fs.writeFileSync(copy, '%PDF-1.4 same bytes');
  const r = await processPdf(copy, { d, cfg: { model: 'must-not-be-called!' } });
  assert.equal(r.status, 'duplicate');
  assert.ok(fs.existsSync(path.join(d.duplicates, 'a-copy.pdf')));
});

test('backfillHashes records hashes for papers that lack them', () => {
  const d = tmpLib();
  const pdf = path.join(d.inbox, 'b.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4 old');
  ingest(pdf, summary({ title: 'Old Paper' }), { d });
  const [p] = loadPapers(d);
  delete p.meta.sha256;
  fs.writeFileSync(p.summaryPath, serializeFrontmatter(p.meta, p.body));
  assert.equal(backfillHashes(d), 1);
  assert.equal(backfillHashes(d), 0);
});

test('ingest leaves PDFs outside the inbox in place and rejects bad summaries', () => {
  const d = tmpLib();
  const outside = path.join(d.root, 'elsewhere.pdf');
  fs.writeFileSync(outside, '%PDF-1.4 fake');
  assert.throws(() => ingest(outside, '---\ntitle: T\n---\n短', { d }), /不合格/);
  assert.equal(ingest(outside, summary({ title: 'Kept Outside' }), { d }).status, 'added');
  assert.ok(fs.existsSync(outside));
});

test('extractSummary strips preamble and fences', () => {
  assert.equal(extractSummary('好的：\n```markdown\n---\ntitle: T\n---\nbody\n```'), '---\ntitle: T\n---\nbody\n');
  assert.equal(extractSummary('no summary here'), null);
});

test('childEnv drops host-session variables only', () => {
  const env = childEnv({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_PID: '1', PATH: 'p', ANTHROPIC_BASE_URL: 'u' });
  assert.deepEqual(env, { PATH: 'p', ANTHROPIC_BASE_URL: 'u' });
});
