import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, isCode, isProse, markReferences, orderSegments, segmentsToParagraphs } from '../lib/layout.mjs';
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

test('figure labels, crowded lines and code are not translated; small-print prose is', () => {
  const m = { bodyH: 10, bodyW: 400 };
  const box = (text, o) => ({ text, lines: 2, h: 10, x0: 0, x1: 400, crowded: 0, ...o });
  // small font diagram labels (Voyager Fig. 4)
  assert.equal(classify(box('Mine Wood Log Make Crafting Table Craft Wooden Pickaxe Craft Stone Sword', { h: 5.5, x1: 46, lines: 4 }), m), 'frag');
  // caption continuation in small print stays translatable
  assert.equal(classify(box('controls; u3 gathers weighted sample gradients from the four orange segments and sums them using reduction primitives.', { h: 8, x1: 245 }), m), 'text');
  // body text wrapped beside a figure shares lines with labels but is prose
  assert.equal(classify(box('and learning rate schedules inspired by the literature on scalable vision transformer training [22, 97]. Our work is the first to', { crowded: 2 }), m), 'text');
  // table row
  assert.equal(classify(box('Skate (m/s) ↓ R-prec. ↑ FID ↓ Joint rot. (deg.) ↓ Joint pos. (m) ↓', { crowded: 2 }), m), 'frag');
  // code
  assert.ok(isCode('await bot.pathfinder.goto(goal); // move next to the block'));
  assert.equal(classify(box('async function craftItem(bot, name, count = 1) { const item = mcData.itemsByName[name]; }'), m), 'frag');
  assert.ok(!isCode('Policy gradient methods [Schulman et al. 2015; Teh et al. 2017] have emerged as the algorithms of choice.'));
  assert.ok(isProse('This is a sentence that has quite a few plain lowercase words in it.'));
});

test('numbered list items become separate paragraphs', () => {
  const segs = [
    seg('The input prompt to GPT-4 consists of several components:', 50, 300, 100),
    seg('(1) Directives encouraging diverse behaviors and imposing', 50, 300, 112),
    seg('constraints, such as the ultimate goal of the agent;', 50, 300, 124),
    seg('(2) The agent’s current state, including inventory and', 50, 300, 136),
  ].map((s) => ({ ...s, col: 'F' }));
  const paras = segmentsToParagraphs(segs);
  assert.deepEqual(paras.map((p) => p.text.slice(0, 3)), ['The', '(1)', '(2)']);
});

test('bibliography entries are marked even without a References heading', () => {
  const pages = [{ paras: [{ text: '[47] Sergey Levine, Chelsea Finn. End-to-end training of deep visuomotor policies. JMLR, 2016.', lines: 2, kind: 'text' }, { text: 'We train for 10 epochs.', lines: 1, kind: 'text' }] }];
  markReferences(pages);
  assert.deepEqual(pages[0].paras.map((p) => p.kind), ['ref', 'text']);
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

test('hotkey strings parse to RegisterHotKey modifiers and key codes', async () => {
  const { parseHotkey } = await import('../lib/desktop.mjs');
  assert.deepEqual(parseHotkey('Ctrl+Alt+P'), { mods: 3, vk: 0x50 });
  assert.deepEqual(parseHotkey('win+shift+f2'), { mods: 12, vk: 0x71 });
  assert.throws(() => parseHotkey('P'));
  assert.throws(() => parseHotkey('Ctrl+Alt+PageDown'));
});

test('comparisons are stored per set of papers, regardless of order', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-cmp-'));
  process.env.PAPER_VAULT_DIR = dir;
  const { loadCompare, saveCompare, compareKey } = await import('../lib/reader.mjs');
  assert.equal(compareKey(['b', 'a']), compareKey(['a', 'b']));
  saveCompare(['x', 'y'], { sessionId: 's1', messages: [{ role: 'assistant', content: 'r' }] });
  assert.equal(loadCompare(['y', 'x']).sessionId, 's1');
  assert.equal(loadCompare(['x', 'z']).sessionId, null);
  delete process.env.PAPER_VAULT_DIR;
});

test('PDF extraction off the main thread matches the direct result', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { extractTextOff } = await import('../lib/pdfpool.mjs');
  const { extractText } = await import('../lib/pdftext.mjs');
  const os = await import('node:os');
  // A minimal one-page PDF (pdfjs rebuilds the missing xref table).
  const sample = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pv-pdf-')), 'tiny.pdf');
  fs.writeFileSync(sample, [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
    '4 0 obj<</Length 50>>stream',
    'BT /F1 12 Tf 20 100 Td (Hello paper vault) Tj ET',
    'endstream endobj',
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
    'trailer<</Root 1 0 R>>',
    '%%EOF',
  ].join('\n'));
  const off = await extractTextOff(sample);
  assert.match(off.text, /Hello paper vault/);
  assert.deepEqual(off, await extractText(sample));
});

test('a title, arXiv id or DOI in the query finds the paper directly', async () => {
  const { directMatches } = await import('../lib/reader.mjs');
  const P = (id, title, extra = {}) => ({ meta: { id, title, ...extra } });
  const papers = [
    P('a', 'SuperMimic: Scaling Humanoid Whole-Body Control with One Differentiable World Model', { arxiv: '2610.28480' }),
    P('b', 'OpenVLA: An Open-Source Vision-Language-Action Model', { doi: '10.1000/xyz123' }),
    P('c', 'π0.5: a Vision-Language-Action Model with Open-World Generalization'),
  ];
  const ids = (q) => directMatches(q, papers).map((p) => p.meta.id);
  assert.deepEqual(ids('supermimic: scaling humanoid whole-body control with one differentiable world model'), ['a']);
  assert.deepEqual(ids('SuperMimic Scaling Humanoid Whole-Body Control'), ['a']); // a long piece of the title
  assert.deepEqual(ids('https://arxiv.org/abs/2610.28480v3'), ['a']);
  assert.deepEqual(ids('doi 10.1000/XYZ123'), ['b']);
  assert.deepEqual(ids('π0.5: a Vision-Language-Action Model with Open-World Generalization'), ['c']);
  assert.deepEqual(ids('OpenVLA'), []); // a single word is left to ranked search
  assert.deepEqual(ids('vision-language-action model'), ['b', 'c']); // a shared phrase lists all
});
