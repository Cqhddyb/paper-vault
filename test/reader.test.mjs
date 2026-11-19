import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, markReferences, orderSegments, segmentsToParagraphs } from '../lib/layout.mjs';
import { parseNumbered } from '../lib/reader.mjs';
import { isAllowed } from '../lib/server.mjs';
import { autostartVbs, launcherVbs } from '../lib/desktop.mjs';

const seg = (text, x0, x1, y, h = 10) => ({ text, x0, x1, y, h });

test('two-column page reads left column before right, full-width title first', () => {
  const segs = [seg('Title spanning the page', 50, 560, 40, 16)];
  for (let i = 0; i < 6; i++) {
    segs.push(seg(`left line ${i} with words`, 50, 295, 100 + i * 12));
    segs.push(seg(`right line ${i} with words`, 318, 562, 100 + i * 12));
  }
  const order = orderSegments(segs, 612).map((s) => s.text);
  assert.equal(order[0], 'Title spanning the page');
  assert.ok(order.indexOf('left line 5 with words') < order.indexOf('right line 0 with words'));
});

test('lines merge into paragraphs and split at a short sentence-ending line', () => {
  const segs = [
    seg('This is the first line of a paragraph that is long and', 50, 300, 100),
    seg('repre- ', 50, 300, 112),
    seg('sentation continues here and ends.', 50, 180, 124),
    seg('A new paragraph starts on this line and keeps going on', 50, 300, 142),
  ].map((s) => ({ ...s, text: s.text.trim(), col: 'F' }));
  const paras = segmentsToParagraphs(segs);
  assert.equal(paras.length, 2);
  assert.match(paras[0].text, /representation continues/);
});

test('classify marks figure fragments, numbered headings and captions', () => {
  assert.equal(classify({ text: 'Llama 2 7B', lines: 1, h: 10 }, 10), 'frag');
  assert.equal(classify({ text: '3.2 Action Tokenization', lines: 1, h: 10 }, 10), 'heading');
  assert.equal(classify({ text: 'Figure 2: Overview of the model.', lines: 1, h: 9 }, 10), 'text');
  assert.equal(classify({ text: 'We train the policy on many robots and evaluate it.', lines: 2, h: 10 }, 10), 'text');
});

test('reference list is marked and ends at the appendix', () => {
  const p = (text, lines = 1, kind = 'text') => ({ text, lines, kind });
  const pages = [{ paras: [p('Body text here.', 5), p('References', 1, 'heading'), p('[1] A. Author. A paper. 2020.', 2), p('A Implementation Details', 1, 'heading'), p('We used 8 GPUs.', 3)] }];
  markReferences(pages);
  assert.deepEqual(pages[0].paras.map((x) => x.kind), ['text', 'heading', 'ref', 'heading', 'text']);
});

test('parseNumbered handles streaming chunks and continuation lines', () => {
  let { out, rest } = parseNumbered('[1] 第一段\n[2] 第二');
  assert.deepEqual(out, [{ k: 1, zh: '第一段' }]);
  ({ out } = parseNumbered(rest + '段\n续写\n[3] 第三段', true));
  assert.deepEqual(out, [{ k: 2, zh: '第二段续写' }, { k: 3, zh: '第三段' }]);
});

test('server only accepts same-origin requests on its own host', () => {
  const req = (headers, method = 'GET') => ({ method, headers: { host: '127.0.0.1:7788', ...headers } });
  assert.ok(isAllowed(req({}), 7788));
  assert.ok(isAllowed(req({ 'sec-fetch-site': 'same-origin', 'x-pv': '1' }, 'POST'), 7788));
  assert.ok(!isAllowed(req({ host: 'evil.example:7788' }), 7788));
  assert.ok(!isAllowed(req({ 'sec-fetch-site': 'cross-site' }), 7788));
  assert.ok(!isAllowed(req({}, 'POST'), 7788));
});

test('generated VBS scripts are pure ASCII', () => {
  for (const s of [launcherVbs(), autostartVbs()]) assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(s));
});
