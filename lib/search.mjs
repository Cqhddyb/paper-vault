// In-memory BM25 over the library's summary.md files. A personal library is
// hundreds to a few thousand papers, so re-reading every summary per query is
// fast enough and keeps the markdown files the only source of truth.
//
// Tokens: Latin/digit words (lowercased, with sub-parts split on . - _ / so that
// "Qwen2.5-VL" also matches "qwen" and "vl"), plus CJK character bigrams and
// unigrams so Chinese phrases match without a word segmenter.

const CJK = /[㐀-鿿豈-﫿]/;

export function tokenize(text) {
  const tokens = [];
  const lower = String(text).toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9._\-/+]*[a-z0-9+]|[a-z0-9]/g)) {
    const w = m[0];
    tokens.push(w);
    const parts = w.split(/[._\-/]+/).filter(Boolean);
    if (parts.length > 1) tokens.push(...parts);
    // "qwen2" -> "qwen", "2" ; "gpt4o" -> "gpt", "4o"
    for (const p of parts) {
      const sub = p.match(/^([a-z]+)(\d.*)$/);
      if (sub) tokens.push(sub[1], sub[2]);
    }
  }
  let run = '';
  const flush = () => {
    for (let i = 0; i < run.length; i++) {
      tokens.push(run[i]);
      if (i + 1 < run.length) tokens.push(run[i] + run[i + 1]);
    }
    run = '';
  };
  for (const ch of lower) {
    if (CJK.test(ch)) run += ch;
    else if (run) flush();
  }
  if (run) flush();
  return tokens;
}

// Field weights: things a user is likely to remember (title, models, datasets)
// count more than prose in the body.
const FIELDS = {
  title: 3,
  models: 3,
  datasets: 2.5,
  methods: 2.5,
  tags: 2,
  tldr: 2,
  authors: 1.5,
  venue: 1,
  year: 1,
  body: 1,
};

function fieldText(paper, field) {
  if (field === 'body') return paper.body;
  const v = paper.meta[field];
  return Array.isArray(v) ? v.join(' , ') : (v ?? '');
}

export function buildIndex(papers) {
  const docs = papers.map((p) => {
    const tf = new Map();
    let len = 0;
    for (const [field, w] of Object.entries(FIELDS)) {
      for (const t of tokenize(fieldText(p, field))) {
        tf.set(t, (tf.get(t) ?? 0) + w);
        len += w;
      }
    }
    return { paper: p, tf, len };
  });
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / Math.max(docs.length, 1);
  return { docs, df, avgLen, N: docs.length };
}

// Filler that shows up in how people describe a half-remembered paper
// ("我记得有篇论文用了…") but says nothing about which paper it is.
const QUERY_STOP = new Set([
  '用了', '使用', '我记', '记得', '有篇', '那篇', '一篇', '论文', '文章', '好像', '大概', '应该', '什么',
  '一个', '这个', '那个', '我们', '他们', '里面', '的是', '是用', '用的', '方法', '模型', '工作',
  'the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'for', 'with', 'to', 'used', 'using', 'paper', 'that', 'which',
]);

export function queryTokens(query) {
  return [...new Set(tokenize(query))].filter((t) => !QUERY_STOP.has(t));
}

export function search(index, query, { top = 20 } = {}) {
  const k1 = 1.2;
  const b = 0.6;
  const qTokens = queryTokens(query);
  const results = [];
  for (const d of index.docs) {
    let score = 0;
    const hits = [];
    for (const t of qTokens) {
      const f = d.tf.get(t);
      if (!f) continue;
      const n = index.df.get(t);
      const idf = Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / index.avgLen)));
      if (!(t.length === 1 && CJK.test(t))) hits.push(t);
    }
    if (score > 0) results.push({ paper: d.paper, score, hits });
  }
  results.sort((a, b2) => b2.score - a.score);
  // Papers matched only through stray single CJK characters are noise once
  // any paper matches a real word.
  const kept = results.some((r) => r.hits.length) ? results.filter((r) => r.hits.length) : results;
  return kept.slice(0, top);
}
