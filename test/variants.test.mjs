import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanAuthor, cleanItems, cleanTitle, enrich, splitAnswer, verifyArxiv } from '../lib/variants.mjs';
import { downloadToInbox, isPublicHttpsUrl } from '../lib/download.mjs';
import { ensureLayout } from '../lib/library.mjs';

test('LaTeX in titles and "Last, First" author names are cleaned', () => {
  assert.equal(cleanTitle('$\\pi_0$: A Vision-Language-Action Flow Model'), 'π0: A Vision-Language-Action Flow Model');
  assert.equal(cleanTitle('$\\pi_{0.5}$ meets $\\alpha$'), 'π0.5 meets α');
  assert.deepEqual(['Kim, Moo Jin', 'NVIDIA', ':', 'Johan Bjorck'].map(cleanAuthor), ['Moo Jin Kim', 'NVIDIA', null, 'Johan Bjorck']);
});

test('the answer splits into report and items; items are cleaned and de-duplicated', () => {
  const text = '## 这一类做法\n离散化动作。\n\n```json\n{"items":[{"title":"FAST","kind":"paper","url":"https://arxiv.org/abs/2501.09747v2","year":"2025"},{"title":"FAST again","arxiv":"2501.09747"},{"title":"Blog","kind":"weird","url":"javascript:alert(1)"},{"title":"Code","kind":"code","url":"https://github.com/x/y"}]}\n```';
  const { report, items } = splitAnswer(text);
  assert.equal(report, '## 这一类做法\n离散化动作。');
  const clean = cleanItems(items);
  assert.equal(clean.length, 3);
  assert.equal(clean[0].arxiv, '2501.09747');
  assert.equal(clean[0].year, 2025);
  assert.equal(clean[1].url, ''); // javascript: links are dropped
  assert.equal(clean[1].kind, 'blog');
  assert.equal(clean[2].kind, 'code');
  // a truncated JSON block still leaves the report usable
  assert.equal(splitAnswer('报告\n```json\n{"items":[{"ti').report, '报告');
});

test('arXiv ids are verified; unknown ids are flagged; library papers are recognised', async () => {
  const fakeFetch = async (url, opts) => {
    if (url.includes('semanticscholar')) {
      const ids = JSON.parse(opts.body).ids;
      return new Response(JSON.stringify(ids.map((id) => (id === 'ARXIV:2501.09747' ? { title: 'FAST: Efficient Action Tokenization', year: 2025, authors: [{ name: 'Karl Pertsch' }] } : null))));
    }
    if (url.endsWith('2609.18487')) return new Response('<meta name="citation_title" content="ActionPiece" /><meta name="citation_date" content="2026/09/20" /><meta name="citation_author" content="Lian, Shijie" />');
    return new Response('not found', { status: 404 });
  };
  const m = await verifyArxiv(['2501.09747', '2609.18487', '2609.99999'], { fetchImpl: fakeFetch });
  assert.equal(m.get('2501.09747').title, 'FAST: Efficient Action Tokenization');
  assert.deepEqual(m.get('2609.18487'), { title: 'ActionPiece', year: 2026, authors: ['Shijie Lian'] });
  assert.equal(m.get('2609.99999'), null);

  const papers = [{ meta: { id: 'local-fast', title: 'FAST: Efficient Action Tokenization', arxiv: '2501.09747' } }];
  const out = await enrich(cleanItems([{ title: 'x', arxiv: '2501.09747' }, { title: 'y', arxiv: '2609.99999' }, { title: 'z', arxiv: '2609.18487' }]), { papers, fetchImpl: fakeFetch });
  assert.equal(out[0].libraryId, 'local-fast');
  assert.equal(out[0].downloadable, false);
  assert.equal(out[1].verified, false);
  assert.equal(out[1].downloadable, false); // a non-existent arXiv id is not offered for download
  assert.equal(out[2].verified, true);
  assert.equal(out[2].downloadable, true);
});

test('downloads only go to public https addresses', () => {
  for (const ok of ['https://arxiv.org/pdf/2501.09747', 'https://openreview.net/pdf?id=abc']) assert.ok(isPublicHttpsUrl(ok), ok);
  for (const bad of ['http://arxiv.org/pdf/1', 'https://localhost/x.pdf', 'https://127.0.0.1/x.pdf', 'https://192.168.1.5/a.pdf', 'https://10.0.0.1/a.pdf', 'https://intranet/a.pdf', 'https://[::1]/a.pdf', 'file:///C:/x.pdf', 'javascript:alert(1)']) {
    assert.ok(!isPublicHttpsUrl(bad), bad);
  }
});

test('downloadToInbox writes a real PDF to the inbox and refuses web pages', async () => {
  const d = ensureLayout(fs.mkdtempSync(path.join(os.tmpdir(), 'pv-dl-')));
  const pdf = async () => new Response('%PDF-1.4 fake paper', { headers: { 'content-type': 'application/pdf' } });
  const r = await downloadToInbox({ arxiv: '2501.09747v2' }, { d, fetchImpl: pdf });
  assert.deepEqual(r, { status: 'queued', file: '2501.09747.pdf' });
  assert.equal(fs.readFileSync(path.join(d.inbox, '2501.09747.pdf'), 'latin1').slice(0, 5), '%PDF-');
  const r2 = await downloadToInbox({ arxiv: '2501.09747' }, { d, fetchImpl: pdf });
  assert.equal(r2.file, '2501.09747_2.pdf'); // never overwrites a file waiting in the inbox
  const html = async () => new Response('<html>project page</html>');
  await assert.rejects(downloadToInbox({ url: 'https://example.com/paper', title: 'X' }, { d, fetchImpl: html }), /不是 PDF/);
  await assert.rejects(downloadToInbox({ url: 'https://127.0.0.1/x.pdf' }, { d, fetchImpl: pdf }), /公网/);
  assert.deepEqual(fs.readdirSync(d.inbox).filter((f) => f.endsWith('.part')), []);
});
