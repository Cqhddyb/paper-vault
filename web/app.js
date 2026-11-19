import * as pdfjs from '/vendor/pdfjs/build/pdf.mjs';
import { marked } from '/vendor/marked/marked.esm.js';

pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.mjs';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};
const api = async (path, body) => {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-pv': '1' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};

/** Read a text/event-stream response (fetch-based so POST works). */
async function* sseStream(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-pv': '1' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = block.match(/^event: (.*)$/m)?.[1];
      const data = block.match(/^data: (.*)$/m)?.[1];
      if (ev) yield { event: ev, data: data ? JSON.parse(data) : null };
    }
  }
}

const state = {
  papers: [],
  listed: [],
  paper: null, // { id, meta, summary, layout, doc }
  mode: localStorage.getItem('pv.mode') || 'dual',
  zoom: Number(localStorage.getItem('pv.zoom') || 1),
  chat: { sessionId: null, busy: false },
  rows: [],
};

// ---- list & find ---------------------------------------------------------

function metaLine(p) {
  const authors = (p.authors || []).slice(0, 3).join(', ') + ((p.authors || []).length > 3 ? ' 等' : '');
  return [p.year, p.venue, authors].filter(Boolean).join('，');
}

function renderList(items, note, { reasons = false } = {}) {
  state.listed = items;
  $('#list-note').textContent = note;
  $('#list-note').classList.remove('busy');
  const ol = $('#results');
  ol.replaceChildren();
  for (const p of items) {
    const b = el('button', { type: 'button' },
      el('span', { className: 'r-title', textContent: p.title || p.id }),
      el('span', { className: 'r-meta', textContent: metaLine(p) }),
    );
    if (reasons && p.reason) b.append(el('span', { className: 'r-why', textContent: p.reason }));
    else if (p.tldr) b.append(el('span', { className: 'r-tldr', textContent: p.tldr }));
    if (state.paper?.id === p.id) b.setAttribute('aria-current', 'true');
    b.onclick = () => openPaper(p.id);
    ol.append(el('li', {}, b));
  }
}

function busy(note) {
  $('#list-note').textContent = note;
  $('#list-note').classList.add('busy');
}

let findSeq = 0;
async function find(q) {
  q = q.trim();
  if (!q) return renderList(state.papers, `库里共 ${state.papers.length} 篇，最近添加的在前`);
  selectTab('list');
  const seq = ++findSeq;
  const quick = await api(`/api/search?q=${encodeURIComponent(q)}`).catch(() => []);
  if (seq !== findSeq) return;
  renderList(quick, '', {});
  busy(quick.length ? `关键词先找到 ${quick.length} 篇，正在按你的描述细筛` : '正在按你的描述细筛');
  try {
    const r = await api('/api/find', { q });
    if (seq !== findSeq) return;
    if (!r.results.length) return renderList([], '没找到符合描述的论文。换几个记得的细节试试，比如用到的模型、数据集或任务。');
    renderList(r.results, r.by === 'claude' ? (r.confident ? '最符合的一篇已经打开，其余备选：' : `找到 ${r.results.length} 篇可能符合的，点一篇打开：`) : '细筛失败，下面是关键词匹配结果：', { reasons: true });
    if (r.confident) openPaper(r.results[0].id);
  } catch (e) {
    if (seq === findSeq) $('#list-note').textContent = `细筛失败（${e.message}），下面是关键词匹配结果。`;
    $('#list-note').classList.remove('busy');
  }
}

$('#find').onsubmit = (e) => {
  e.preventDefault();
  find($('#q').value);
};
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    find($('#q').value);
  }
});

// ---- tabs ---------------------------------------------------------------------

function selectTab(name) {
  for (const t of document.querySelectorAll('#tabs button')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  $('#pane-list').hidden = name !== 'list';
  $('#pane-chat').hidden = name !== 'chat';
}
for (const t of document.querySelectorAll('#tabs button')) t.onclick = () => selectTab(t.dataset.tab);

// ---- reader -------------------------------------------------------------------

function geometry(pg) {
  const avail = $('#pages').clientWidth - 48 - 16; // padding + scrollbar
  const mode = state.mode;
  let zw = Math.min(760, avail);
  let target = Math.min(avail, 980);
  if (mode === 'dual') {
    // Page gets ~55%, translation the rest (24px gap); zoom only grows the page.
    zw = Math.round(Math.max(260, Math.min(520, (avail - 24) * 0.45)));
    target = avail - 24 - zw;
  }
  const scale = Math.max(0.4, Math.min(2.4, (target / pg.width) * state.zoom));
  return { scale, pw: Math.round(pg.width * scale), ph: Math.round(pg.height * scale), zw };
}

let observer;
let renderGen = 0;

async function openPaper(id) {
  if (state.paper?.id === id) return selectTab('chat');
  const gen = ++renderGen;
  const [info, layout] = await Promise.all([api(`/api/paper/${id}`), api(`/api/paper/${id}/layout`)]);
  if (gen !== renderGen) return;
  state.paper?.doc?.destroy();
  const doc = await pdfjs.getDocument({ url: `/api/paper/${id}/pdf`, isEvalSupported: false }).promise;
  if (gen !== renderGen) return doc.destroy();
  state.paper = { id, info, layout, doc };
  history.replaceState(null, '', `?id=${encodeURIComponent(id)}`);
  document.title = `${info.title} · Paper Vault`;
  $('#empty').hidden = true;
  $('#bar').hidden = false;
  $('#paper-title').textContent = info.title;
  $('#paper-sub').textContent = metaLine(info);
  for (const b of document.querySelectorAll('#results button')) b.toggleAttribute('aria-current', false);
  [...document.querySelectorAll('#results li')].find((li, i) => state.listed[i]?.id === id)?.querySelector('button').setAttribute('aria-current', 'true');
  buildRows();
  $('#tab-chat').disabled = false;
  selectTab('chat');
  loadChat();
}

function buildRows() {
  const P = state.paper;
  const host = $('#pages');
  host.className = `mode-${state.mode}`;
  host.replaceChildren();
  host.scrollTop = 0;
  observer?.disconnect();
  observer = new IntersectionObserver(onVisible, { root: host, rootMargin: '600px 0px' });
  state.rows = P.layout.pages.map((pg) => {
    const g = geometry(pg);
    const page = el('div', { className: 'page' });
    page.append(el('span', { className: 'num', textContent: `第 ${pg.page} 页` }));
    const zh = el('div', { className: 'zh' });
    zh.dataset.page = pg.page;
    const row = el('div', { className: 'row' }, page, zh);
    row.dataset.page = pg.page;
    row.style.setProperty('--pw', `${g.pw}px`);
    row.style.setProperty('--ph', `${g.ph}px`);
    row.style.setProperty('--zw', `${g.zw}px`);
    host.append(row);
    observer.observe(row);
    return { pg, row, page, zh, g, rendered: null, zhState: null, zhData: new Map() };
  });
  updatePageInd();
}

function onVisible(entries) {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const r = state.rows[Number(e.target.dataset.page) - 1];
    if (state.mode !== 'zh') renderPage(r);
    loadTranslation(r);
    const next = state.rows[r.pg.page];
    if (next) loadTranslation(next); // prefetch one page ahead
  }
}

async function renderPage(r) {
  const key = `${r.g.scale}`;
  if (r.rendered === key) return;
  r.rendered = key;
  const gen = renderGen;
  const page = await state.paper.doc.getPage(r.pg.page);
  if (gen !== renderGen) return;
  const vp = page.getViewport({ scale: r.g.scale });
  const dpr = window.devicePixelRatio || 1;
  const canvas = el('canvas', { width: Math.floor(vp.width * dpr), height: Math.floor(vp.height * dpr) });
  const text = el('div', { className: 'textLayer' });
  r.page.style.setProperty('--total-scale-factor', r.g.scale);
  r.page.style.setProperty('--scale-factor', r.g.scale);
  await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
  if (gen !== renderGen || r.rendered !== key) return;
  r.page.querySelectorAll('canvas, .textLayer').forEach((n) => n.remove());
  r.page.prepend(canvas);
  r.page.append(text);
  await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport: vp }).render();
}

function paraNode(r, i) {
  const para = r.pg.paras[i];
  const zh = r.zhData.get(i);
  const n = el('p', { className: `p${para.kind === 'heading' ? ' head' : ''}${zh ? '' : ' wait'}` });
  n.textContent = zh ?? '…';
  n.title = para.text;
  n.dataset.i = i;
  n.onmouseenter = () => highlight(r, i, true);
  n.onmouseleave = () => highlight(r, i, false);
  n.onclick = () => r.page.scrollIntoView({ block: 'nearest' });
  return n;
}

function highlight(r, i, on) {
  r.page.querySelectorAll('.hl').forEach((n) => n.remove());
  if (!on) return;
  const [x0, y0, x1, y1] = r.pg.paras[i].bbox;
  const s = r.g.scale;
  r.page.append(el('div', { className: 'hl', style: `left:${x0 * s - 3}px;top:${y0 * s - 2}px;width:${(x1 - x0) * s + 6}px;height:${(y1 - y0) * s + 4}px` }));
}

function layoutZh(r) {
  const nodes = [...r.zh.querySelectorAll('.p')];
  if (state.mode === 'zh') {
    r.zh.style.height = '';
    return;
  }
  let bottom = 0;
  for (const n of nodes) {
    const y = r.pg.paras[Number(n.dataset.i)].bbox[1] * r.g.scale;
    const top = Math.max(y, bottom + 4);
    n.style.top = `${top}px`;
    bottom = top + n.offsetHeight;
  }
  r.zh.style.height = `${Math.max(r.g.ph, bottom)}px`;
}

function drawZh(r) {
  const items = r.pg.paras.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === 'text' || p.kind === 'heading');
  r.zh.replaceChildren(...items.map(({ i }) => paraNode(r, i)));
  const refs = r.pg.paras.filter((p) => p.kind === 'ref').length;
  if (refs) {
    const last = r.pg.paras.findIndex((p) => p.kind === 'ref');
    const n = el('p', { className: 'p refs', textContent: `参考文献 ${refs} 条（不翻译）` });
    n.dataset.i = last;
    r.zh.append(n);
  }
  if (!items.length && !refs) r.zh.append(el('span', { className: 'status', textContent: '本页没有可翻译的正文' }));
  layoutZh(r);
}

async function loadTranslation(r) {
  if (r.zhState) return;
  r.zhState = 'loading';
  drawZh(r);
  const gen = renderGen;
  try {
    for await (const { event, data } of sseStream(`/api/paper/${state.paper.id}/zh/${r.pg.page}`)) {
      if (gen !== renderGen) return;
      if (event === 'para') {
        r.zhData.set(data.i, data.zh);
        const n = r.zh.querySelector(`.p[data-i="${data.i}"]`);
        if (n) {
          n.textContent = data.zh;
          n.classList.remove('wait');
          layoutZh(r);
        }
      } else if (event === 'error') throw new Error(data.message);
    }
    r.zhState = 'done';
  } catch (e) {
    r.zhState = null;
    r.zh.append(el('span', { className: 'status', textContent: `翻译失败：${e.message}（滚动回来会重试）` }));
  }
}

function relayout() {
  if (!state.paper) return;
  $('#pages').className = `mode-${state.mode}`;
  for (const r of state.rows) {
    r.g = geometry(r.pg);
    r.row.style.setProperty('--pw', `${r.g.pw}px`);
    r.row.style.setProperty('--ph', `${r.g.ph}px`);
    r.row.style.setProperty('--zw', `${r.g.zw}px`);
    layoutZh(r);
  }
  // Re-render what is on screen at the new scale.
  observer.disconnect();
  for (const r of state.rows) observer.observe(r.row);
}

for (const b of document.querySelectorAll('[data-mode]')) {
  b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
  b.onclick = () => {
    state.mode = b.dataset.mode;
    localStorage.setItem('pv.mode', state.mode);
    for (const x of document.querySelectorAll('[data-mode]')) x.setAttribute('aria-pressed', String(x === b));
    relayout();
  };
}
const zoom = (f) => {
  state.zoom = Math.max(0.6, Math.min(2, +(state.zoom * f).toFixed(2)));
  localStorage.setItem('pv.zoom', state.zoom);
  relayout();
};
$('#zoom-in').onclick = () => zoom(1.15);
$('#zoom-out').onclick = () => zoom(1 / 1.15);
let resizeT;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(relayout, 150);
});

function updatePageInd() {
  if (!state.paper) return;
  const host = $('#pages');
  const mid = host.scrollTop + host.clientHeight / 3;
  const r = state.rows.find((x) => x.row.offsetTop + x.row.offsetHeight > mid) ?? state.rows.at(-1);
  $('#page-ind').textContent = `${r.pg.page} / ${state.rows.length} 页`;
}
$('#pages').addEventListener('scroll', updatePageInd, { passive: true });

function goPage(n) {
  state.rows[n - 1]?.row.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- chat --------------------------------------------------------------------

function linkPages(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const hits = [];
  while (walker.nextNode()) if (/第\s*\d+\s*(?:[-–~、,，至到和]\s*\d+\s*)*页/.test(walker.currentNode.nodeValue)) hits.push(walker.currentNode);
  for (const t of hits) {
    const frag = document.createDocumentFragment();
    let last = 0;
    const s = t.nodeValue;
    for (const m of s.matchAll(/第\s*(\d+)\s*(?:[-–~、,，至到和]\s*\d+\s*)*页/g)) {
      frag.append(s.slice(last, m.index));
      const a = el('a', { className: 'pg', textContent: m[0], href: '#' });
      a.onclick = (e) => {
        e.preventDefault();
        goPage(Number(m[1]));
      };
      frag.append(a);
      last = m.index + m[0].length;
    }
    frag.append(s.slice(last));
    t.replaceWith(frag);
  }
}

function renderMd(node, md) {
  node.innerHTML = marked.parse(md, { async: false });
  // Model output is untrusted: drop anything executable that marked passed through.
  node.querySelectorAll('script, iframe, object, embed, style, link').forEach((n) => n.remove());
  node.querySelectorAll('*').forEach((n) => {
    for (const a of [...n.attributes]) if (/^on/i.test(a.name) || (/^(href|src)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) n.removeAttribute(a.name);
  });
  linkPages(node);
}

function addMsg(role, text) {
  const n = el('div', { className: `msg ${role}` });
  if (role === 'bot') renderMd(n, text);
  else n.textContent = text;
  $('#chat-log').append(n);
  return n;
}

function summaryCard() {
  const i = state.paper.info;
  return el('div', { className: 'summary-card' }, el('strong', { textContent: '一句话' }), document.createTextNode(i.tldr || '（无）'));
}

async function loadChat() {
  const log = $('#chat-log');
  log.replaceChildren(summaryCard());
  const id = state.paper.id;
  const h = await api(`/api/paper/${id}/chat`);
  if (state.paper?.id !== id) return;
  state.chat.sessionId = h.sessionId;
  for (const m of h.messages) addMsg(m.role === 'user' ? 'user' : 'bot', m.content);
  if (!h.messages.length) ask('');
  else log.scrollTop = 0;
}

async function ask(message) {
  if (state.chat.busy || !state.paper) return;
  state.chat.busy = true;
  const id = state.paper.id;
  if (message) addMsg('user', message);
  const bot = addMsg('bot', '');
  bot.textContent = message ? '思考中…' : '正在通读全文并准备讲解…';
  let text = '';
  let raf = 0;
  const log = $('#chat-log');
  try {
    for await (const { event, data } of sseStream('/api/chat', { id, sessionId: state.chat.sessionId, message })) {
      if (state.paper?.id !== id) break;
      if (event === 'delta') {
        text += data;
        if (!raf)
          raf = requestAnimationFrame(() => {
            raf = 0;
            const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
            renderMd(bot, text);
            if (stick) log.scrollTop = log.scrollHeight;
          });
      } else if (event === 'done') {
        state.chat.sessionId = data.sessionId;
        cancelAnimationFrame(raf);
        renderMd(bot, data.text || text);
        if (data.cost) bot.append(el('span', { className: 'cost', textContent: `本轮约 $${data.cost.toFixed(3)}` }));
      } else if (event === 'error') throw new Error(data.message);
    }
  } catch (e) {
    bot.classList.add('err');
    bot.textContent = `讲解失败：${e.message}`;
  } finally {
    state.chat.busy = false;
  }
}

$('#chat-form').onsubmit = (e) => {
  e.preventDefault();
  const v = $('#chat-input').value.trim();
  if (!v) return;
  $('#chat-input').value = '';
  ask(v);
};
$('#chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#chat-form').requestSubmit();
  }
});
for (const b of document.querySelectorAll('#chat-quick [data-ask]')) b.onclick = () => ask(b.dataset.ask);
$('#chat-reset').onclick = async () => {
  if (!state.paper || state.chat.busy) return;
  await api(`/api/paper/${state.paper.id}/chat/reset`, {});
  state.chat.sessionId = null;
  $('#chat-log').replaceChildren(summaryCard());
  ask('');
};

// ---- selection translation -------------------------------------------------------

const pop = $('#pop');
document.addEventListener('mouseup', (e) => {
  if (pop.contains(e.target)) return;
  setTimeout(() => {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    const inPage = sel?.anchorNode && sel.anchorNode.parentElement?.closest('.textLayer');
    if (!text || text.length < 2 || !inPage) {
      pop.hidden = true;
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    pop.dataset.text = text;
    $('#pop-out').textContent = '';
    $('#pop-go').hidden = false;
    pop.hidden = false;
    pop.style.left = `${Math.min(rect.left, window.innerWidth - 440)}px`;
    pop.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 80)}px`;
  });
});
$('#pop-go').onclick = async () => {
  $('#pop-go').hidden = true;
  $('#pop-out').textContent = '翻译中…';
  try {
    const { zh } = await api('/api/translate', { text: pop.dataset.text, id: state.paper?.id });
    $('#pop-out').textContent = zh;
  } catch (e) {
    $('#pop-out').textContent = `翻译失败：${e.message}`;
  }
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') pop.hidden = true;
});

// ---- start --------------------------------------------------------------------

state.papers = await api('/api/papers');
const params = new URLSearchParams(location.search);
if (params.get('q')) {
  $('#q').value = params.get('q');
  find(params.get('q'));
} else {
  renderList(state.papers, `库里共 ${state.papers.length} 篇，最近添加的在前`);
}
if (params.get('id')) openPaper(params.get('id')).catch(() => {});
$('#q').focus();
