// Local web server for the paper assistant (http://127.0.0.1:<port>).
//
// Only reachable from this machine. Requests are also rejected unless they come
// from the assistant's own page: the Host header must be ours (blocks DNS
// rebinding), cross-site fetches are refused via Sec-Fetch-Site, and POSTs need
// a custom header (forces a CORS preflight we never approve).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirs, readConfig } from './library.mjs';
import { COMPARE_LABELS, cachedPage, chat, compare, findPapers, getLayout, getPaper, loadCompare, paperCard, quickSearch, saveCompare, translatePage, translateSnippet } from './reader.mjs';
import { loadPapers } from './library.mjs';
import { DEFAULT_Q, findVariants, loadVariants, markLibrary, saveVariants, variantKey } from './variants.mjs';
import { downloadToInbox } from './download.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC = {
  '/web/': path.join(ROOT, 'web'),
  '/vendor/pdfjs/': path.join(ROOT, 'node_modules', 'pdfjs-dist'),
  '/vendor/marked/': path.join(ROOT, 'node_modules', 'marked', 'lib'),
};
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.map': 'application/json',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

export const DEFAULT_PORT = 7788;

function chatFile(paper) {
  const dir = path.join(paper.dir, '.reader');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'chat.json');
}

function loadChat(paper) {
  try {
    return JSON.parse(fs.readFileSync(chatFile(paper), 'utf8'));
  } catch {
    return { sessionId: null, messages: [] };
  }
}

function saveChat(paper, data) {
  fs.writeFileSync(chatFile(paper), JSON.stringify(data, null, 1));
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function sendFile(res, file, extraHeaders = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'content-length': st.size, ...extraHeaders });
    fs.createReadStream(file).pipe(res);
  });
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function isAllowed(req, port) {
  const host = String(req.headers.host ?? '');
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-pv'] !== '1') return false;
  return true;
}

export function startServer({ port = readConfig().port ?? DEFAULT_PORT, windowControl = null } = {}) {
  const pages = new Set(); // SSE emitters of open assistant pages
  const server = http.createServer(async (req, res) => {
    try {
      if (!isAllowed(req, port)) return send(res, 403, { error: 'forbidden' });
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const p = url.pathname;

      if (p === '/' || p === '/index.html') return sendFile(res, path.join(ROOT, 'web', 'index.html'));
      for (const [prefix, dir] of Object.entries(STATIC)) {
        if (!p.startsWith(prefix)) continue;
        const file = path.resolve(dir, '.' + decodeURIComponent(p.slice(prefix.length - 1)));
        if (!file.startsWith(dir + path.sep)) return send(res, 403, { error: 'forbidden' });
        return sendFile(res, file, { 'cache-control': prefix === '/web/' ? 'no-store' : 'max-age=86400' });
      }

      if (p === '/api/ping') return send(res, 200, { ok: true, app: 'paper-vault' });
      if (p === '/api/papers') {
        const papers = loadPapers(dirs()).sort((a, b) => String(b.meta.added).localeCompare(String(a.meta.added)) || String(b.meta.id).localeCompare(String(a.meta.id)));
        return send(res, 200, papers.map((x) => paperCard(x)));
      }
      if (p === '/api/search') return send(res, 200, quickSearch(url.searchParams.get('q') ?? ''));
      if (p === '/api/find' && req.method === 'POST') {
        const { q } = await readBody(req);
        if (!q?.trim()) return send(res, 400, { error: '空查询' });
        return send(res, 200, await findPapers(q.trim()));
      }
      if (p === '/api/translate' && req.method === 'POST') {
        const { text, id } = await readBody(req);
        if (!text?.trim()) return send(res, 400, { error: '空文本' });
        return send(res, 200, { zh: await translateSnippet(text, id ? getPaper(id) : null) });
      }
      if (p === '/api/chat' && req.method === 'POST') {
        const { id, sessionId, message } = await readBody(req);
        const paper = getPaper(id);
        if (!paper) return send(res, 404, { error: '没有这篇论文' });
        const emit = sse(res);
        const ac = new AbortController();
        res.on('close', () => ac.abort());
        try {
          const r = await chat({ paper, sessionId, message, signal: ac.signal, onDelta: (t) => emit('delta', t) });
          const hist = loadChat(paper);
          const fresh = !sessionId || hist.sessionId !== sessionId;
          saveChat(paper, {
            sessionId: r.sessionId,
            messages: [...(fresh ? [] : hist.messages), { role: 'user', content: message?.trim() || '讲解这篇论文' }, { role: 'assistant', content: r.text }],
          });
          emit('done', { sessionId: r.sessionId, cost: r.cost, text: r.text });
        } catch (e) {
          if (e.name !== 'AbortError') emit('error', { message: String(e.message) });
        }
        return res.end();
      }

      // Push channel to open pages (used to run a search in the existing window).
      if (p === '/api/events') {
        const emit = sse(res);
        emit('hello', {});
        pages.add(emit);
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        res.on('close', () => {
          clearInterval(ping);
          pages.delete(emit);
        });
        return;
      }
      if (p === '/api/window' && req.method === 'POST') {
        const { action, q } = await readBody(req);
        if (!['show', 'hide', 'toggle'].includes(action)) return send(res, 400, { error: 'bad action' });
        if (q && pages.size) {
          for (const emit of pages) emit('find', { q: String(q).slice(0, 500) });
          return send(res, 200, { ok: windowControl?.send?.('show') ?? false, routed: true });
        }
        if (q) {
          windowControl?.open?.(`http://127.0.0.1:${port}/?q=${encodeURIComponent(String(q).slice(0, 500))}`);
          return send(res, 200, { ok: !!windowControl?.open, opened: true });
        }
        return send(res, 200, { ok: windowControl?.send?.(action) ?? false });
      }

      // "Who else does something like this?" from a selected passage.
      if (p === '/api/variants' && req.method === 'GET') {
        const saved = loadVariants(url.searchParams.get('key') ?? '');
        return send(res, 200, saved ?? { messages: [], items: [] });
      }
      if (p === '/api/variants' && req.method === 'POST') {
        const { key, id, passage, page, question, message, refresh } = await readBody(req);
        const paper = getPaper(id);
        if (!paper) return send(res, 404, { error: '没有这篇论文' });
        const k = key ?? (passage ? variantKey(id, passage, question) : null);
        let saved = k ? loadVariants(k) : null;
        if (!saved && !passage?.trim()) return send(res, 400, { error: '没有选中的文字' });
        const emit = sse(res);
        emit('key', { key: k });
        // Same passage and question as before: show the saved result.
        if (saved && !message?.trim() && !refresh) {
          emit('done', { key: k, cached: true, sessionId: saved.sessionId, report: saved.messages[1]?.content ?? '', items: markLibrary(saved.items), messages: saved.messages });
          return res.end();
        }
        const prev = saved;
        if (refresh) saved = null;
        const src = { passage: passage ?? prev?.passage, page: page ?? prev?.page, question: question ?? prev?.question };
        const ac = new AbortController();
        res.on('close', () => ac.abort());
        try {
          const followUp = !!(saved?.sessionId && message?.trim());
          const r = await findVariants({
            paper,
            passage: src.passage,
            page: src.page,
            question: src.question,
            sessionId: followUp ? saved.sessionId : undefined,
            message: followUp ? message : undefined,
            signal: ac.signal,
            onDelta: (t) => emit('delta', t),
          });
          const base = followUp ? saved : { paperId: id, passage: src.passage, page: src.page, question: src.question || DEFAULT_Q, messages: [], items: [] };
          const known = new Set(base.items.map((i) => i.arxiv || i.url));
          const items = markLibrary([...base.items, ...r.items.filter((i) => !known.has(i.arxiv || i.url))]);
          saveVariants(k, {
            ...base,
            sessionId: r.sessionId,
            items,
            messages: [...base.messages, { role: 'user', content: followUp ? message.trim() : base.question }, { role: 'assistant', content: r.report }],
          });
          emit('done', { key: k, sessionId: r.sessionId, cost: r.cost, report: r.report, items, newItems: r.items });
        } catch (e) {
          if (e.name !== 'AbortError') emit('error', { message: String(e.message) });
        }
        return res.end();
      }
      if (p === '/api/download' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          return send(res, 200, await downloadToInbox(body));
        } catch (e) {
          return send(res, 400, { error: String(e.message) });
        }
      }

      if (p.startsWith('/api/compare')) {
        const isPost = req.method === 'POST';
        const body = isPost ? await readBody(req) : {};
        const ids = isPost ? body.ids : (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
        if (!Array.isArray(ids) || ids.length < 2 || ids.length > COMPARE_LABELS.length) return send(res, 400, { error: '对比需要 2-5 篇论文' });
        const papers = ids.map((id) => getPaper(id));
        if (papers.some((x) => !x)) return send(res, 404, { error: '有论文不在库里' });
        if (p === '/api/compare' && !isPost) return send(res, 200, loadCompare(ids));
        if (p === '/api/compare/reset' && isPost) {
          saveCompare(ids, { sessionId: null, messages: [] });
          return send(res, 200, { ok: true });
        }
        if (p === '/api/compare' && isPost) {
          const { sessionId, message } = body;
          const emit = sse(res);
          const ac = new AbortController();
          res.on('close', () => ac.abort());
          try {
            const r = await compare({ papers, sessionId, message, signal: ac.signal, onDelta: (t) => emit('delta', t) });
            const hist = loadCompare(ids);
            const fresh = !sessionId || hist.sessionId !== sessionId;
            saveCompare(ids, {
              sessionId: r.sessionId,
              messages: [...(fresh ? [] : hist.messages), { role: 'user', content: message?.trim() || '对比这几篇论文的方法' }, { role: 'assistant', content: r.text }],
            });
            emit('done', { sessionId: r.sessionId, cost: r.cost, text: r.text });
          } catch (e) {
            if (e.name !== 'AbortError') emit('error', { message: String(e.message) });
          }
          return res.end();
        }
        return send(res, 404, { error: 'not found' });
      }

      const m = p.match(/^\/api\/paper\/([\w.\-]+)(?:\/(pdf|layout|chat|chat\/reset|zh\/(\d+)))?$/);
      if (m) {
        const paper = getPaper(m[1]);
        if (!paper) return send(res, 404, { error: '没有这篇论文' });
        if (m[2] === 'chat') return send(res, 200, loadChat(paper));
        if (m[2] === 'chat/reset' && req.method === 'POST') {
          saveChat(paper, { sessionId: null, messages: [] });
          return send(res, 200, { ok: true });
        }
        if (!m[2]) return send(res, 200, { ...paperCard(paper), meta: paper.meta, summary: paper.body, pdfPath: paper.pdfPath, summaryPath: paper.summaryPath });
        if (m[2] === 'pdf') return sendFile(res, paper.pdfPath, { 'cache-control': 'max-age=3600' });
        if (m[2] === 'layout') return send(res, 200, await getLayout(paper));
        const n = Number(m[3]);
        const emit = sse(res);
        const cached = cachedPage(paper, n);
        if (cached) {
          for (const it of cached.paras) emit('para', it);
          emit('done', { cached: true });
          return res.end();
        }
        const job = translatePage(paper, n);
        for (const it of job.items) emit('para', it);
        const onPara = (it) => emit('para', it);
        const onDone = (d) => {
          emit('done', d);
          cleanup();
          res.end();
        };
        const onErr = (e) => {
          emit('error', { message: String(e.message) });
          cleanup();
          res.end();
        };
        const cleanup = () => {
          job.off('para', onPara);
          job.off('done', onDone);
          job.off('error', onErr);
        };
        job.on('para', onPara);
        job.once('done', onDone);
        job.once('error', onErr);
        res.on('close', cleanup); // the translation keeps going and is cached
        return;
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: String(e.message) });
      else res.end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    const broadcast = (event, data) => {
      for (const emit of pages) emit(event, data);
    };
    server.listen(port, '127.0.0.1', () => resolve({ server, port, url: `http://127.0.0.1:${port}/`, broadcast }));
  });
}
