import * as pdfjs from '/vendor/pdfjs/build/pdf.mjs';
import { marked } from '/vendor/marked/marked.esm.js';

pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.mjs';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};
const post = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json', 'x-pv': '1' }, body: JSON.stringify(body) });
const api = async (path, body, signal) => {
  const r = await fetch(path, body === undefined ? { signal } : { ...post(body), signal });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};

/** Read a text/event-stream response (fetch-based so POST works). */
async function* sseStream(path, body, signal) {
  const r = await fetch(path, body === undefined ? { signal } : { ...post(body), signal });
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

const LABELS = ['A', 'B', 'C', 'D', 'E'];
const MAX_COMPARE = 5;

const state = {
  papers: [], // library cards
  listed: [],
  sel: new Map(), // id -> card, papers ticked for comparison (in tick order)
  tabs: [], // open documents, see newPaperTab / newCompareTab
  active: null,
  mode: localStorage.getItem('pv.mode') || 'dual',
  zoom: Number(localStorage.getItem('pv.zoom') || 1),
  lastUserOpen: 0,
};

const cardOf = (id) => state.papers.find((p) => p.id === id) ?? state.listed.find((p) => p.id === id);

// ---- list, search, selection ------------------------------------------------

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
    const box = el('input', { type: 'checkbox', className: 'pick', checked: state.sel.has(p.id), title: '勾选 2 到 5 篇来对比方法' });
    box.setAttribute('aria-label', `选来对比：${p.title}`);
    box.onchange = () => toggleSel(p, box);
    const metaEl = el('span', { className: 'r-meta', textContent: metaLine(p) });
    if (p.format === 'markdown') metaEl.prepend(el('span', { className: 'r-badge', textContent: '网络文章' }));
    const b = el('button', { type: 'button', className: 'open' },
      el('span', { className: 'r-title', textContent: p.title || p.id }),
      metaEl,
    );
    if (reasons && p.reason) b.append(el('span', { className: 'r-why', textContent: p.reason }));
    else if (p.tldr) b.append(el('span', { className: 'r-tldr', textContent: p.tldr }));
    b.dataset.id = p.id;
    b.onclick = () => {
      state.lastUserOpen = Date.now();
      openPaper(p.id, { focusChat: false });
    };
    ol.append(el('li', {}, box, b));
  }
  markCurrent();
}

function markCurrent() {
  const cur = activeTab();
  const ids = cur?.kind === 'paper' ? [cur.id] : cur?.ids ?? [];
  for (const b of document.querySelectorAll('#results button.open')) b.setAttribute('aria-current', String(ids.includes(b.dataset.id)));
}

function toggleSel(p, box) {
  if (box.checked) {
    if (state.sel.size >= MAX_COMPARE) {
      box.checked = false;
      flashNote(`最多同时对比 ${MAX_COMPARE} 篇`);
      return;
    }
    state.sel.set(p.id, p);
  } else state.sel.delete(p.id);
  renderSelBar();
}

function renderSelBar() {
  const n = state.sel.size;
  $('#sel-bar').hidden = n === 0;
  $('#sel-count').textContent = n < 2 ? `已选 ${n} 篇，再选 ${2 - n} 篇即可对比` : `已选 ${n} 篇`;
  $('#sel-compare').disabled = n < 2;
}

let noteTimer;
function flashNote(msg) {
  const n = $('#sel-count');
  const old = n.textContent;
  n.textContent = msg;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => (n.textContent = old), 1800);
}

$('#sel-clear').onclick = () => {
  state.sel.clear();
  for (const b of document.querySelectorAll('#results .pick')) b.checked = false;
  renderSelBar();
};
$('#sel-compare').onclick = () => openCompare([...state.sel.keys()]);

function busy(note) {
  $('#list-note').textContent = note;
  $('#list-note').classList.add('busy');
}

let findSeq = 0;
async function find(q) {
  q = q.trim();
  if (!q) return renderList(state.papers, `库里共 ${state.papers.length} 篇，最近添加的在前`);
  selectSide('list');
  const seq = ++findSeq;
  const startedAt = Date.now();
  const quick = await api(`/api/search?q=${encodeURIComponent(q)}`).catch(() => []);
  if (seq !== findSeq) return;
  renderList(quick, '', {});
  busy(quick.length ? `关键词先找到 ${quick.length} 篇，正在按你的描述细筛` : '正在按你的描述细筛');
  try {
    const r = await api('/api/find', { q });
    if (seq !== findSeq) return;
    if (!r.results.length) {
      // Keep whatever keyword search found; only say "nothing" when both found nothing.
      if (quick.length) return renderList(quick, '没有找到更确定的结果，下面是关键词匹配：');
      return renderList([], '没找到符合描述的论文。换几个记得的细节试试，比如用到的模型、数据集或任务。');
    }
    // Never override a paper the user already picked while the refinement ran.
    const autoOpen = r.confident && state.lastUserOpen < startedAt;
    const note =
      r.by === 'title' ? (autoOpen ? '标题匹配，已经打开：' : `有 ${r.results.length} 篇标题匹配：`)
      : r.by !== 'claude' ? (r.error ? '细筛暂时不可用，下面是关键词匹配结果：' : '没有找到更确定的结果，下面是关键词匹配：')
      : autoOpen ? '最符合的一篇已经打开，其余备选：'
      : `找到 ${r.results.length} 篇可能符合的，点一篇打开：`;
    renderList(r.results, note, { reasons: true });
    if (autoOpen) openPaper(r.results[0].id, { focusChat: false });
  } catch (e) {
    if (seq !== findSeq) return;
    $('#list-note').textContent = quick.length ? `细筛失败（${e.message}），下面是关键词匹配结果。` : `连不上后台服务（${e.message}）。稍等几秒再试；如果一直这样，重新按 Ctrl+Alt+P 或从开始菜单打开论文小助手。`;
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

// ---- side panel ------------------------------------------------------------

function selectSide(name) {
  for (const t of document.querySelectorAll('#tabs button')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  $('#pane-list').hidden = name !== 'list';
  $('#pane-chat').hidden = name !== 'chat';
}
for (const t of document.querySelectorAll('#tabs button')) t.onclick = () => selectSide(t.dataset.tab);

// ---- document tabs -----------------------------------------------------------

const activeTab = () => state.tabs.find((t) => t.key === state.active) ?? null;

function addTab(tab) {
  tab.view.hidden = true;
  $('#views').append(tab.view);
  tab.button = el('div', { className: `doc-tab${{ compare: ' cmp', variants: ' var' }[tab.kind] ?? ''}`, role: 'tab', tabIndex: 0 });
  tab.label = el('span', { className: 'dt-label' });
  const close = el('button', { type: 'button', className: 'dt-close', textContent: '×', title: '关闭' });
  close.setAttribute('aria-label', '关闭这个标签页');
  close.onclick = (e) => {
    e.stopPropagation();
    closeTab(tab.key);
  };
  tab.button.append(tab.label, close);
  tab.button.onclick = () => activate(tab.key);
  tab.button.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') activate(tab.key);
  };
  tab.button.onauxclick = (e) => e.button === 1 && closeTab(tab.key);
  $('#doc-tabs').append(tab.button);
  state.tabs.push(tab);
  setTabTitle(tab, tab.title);
  return tab;
}

function setTabTitle(tab, title) {
  tab.title = title;
  tab.label.textContent = title;
  tab.button.title = title;
  if (state.active === tab.key) updateBar();
}

function activate(key) {
  const tab = state.tabs.find((t) => t.key === key);
  if (!tab) return;
  const prev = activeTab();
  if (prev && prev !== tab && prev.kind === 'paper') prev.scrollTop = prev.view.scrollTop;
  state.active = key;
  for (const t of state.tabs) {
    t.view.hidden = t !== tab;
    t.button.setAttribute('aria-selected', String(t === tab));
  }
  tab.button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  $('#empty').hidden = true;
  $('#bar').hidden = false;
  $('#tab-chat').disabled = false;
  $('#tab-chat').textContent = CHAT_TAB_LABEL[tab.kind];
  $('#chat-host').replaceChildren(tab.chatLog);
  renderQuick(tab);
  updateBar();
  markCurrent();
  if (tab.kind === 'paper') {
    history.replaceState(null, '', `?id=${encodeURIComponent(tab.id)}`);
    if (!tab.started) loadPaper(tab);
    else {
      relayoutTab(tab);
      tab.view.scrollTop = tab.scrollTop ?? 0;
    }
  } else if (!tab.started) (tab.kind === 'variants' ? loadVariants(tab) : loadCompare(tab));
}

function closeTab(key) {
  const i = state.tabs.findIndex((t) => t.key === key);
  if (i < 0) return;
  const tab = state.tabs[i];
  tab.closed = true;
  tab.abort?.abort();
  tab.observer?.disconnect();
  tab.task?.destroy();
  tab.view.remove();
  tab.button.remove();
  tab.chatLog.remove();
  state.tabs.splice(i, 1);
  if (state.active === key) {
    state.active = null;
    const next = state.tabs[i] ?? state.tabs[i - 1];
    if (next) activate(next.key);
    else {
      $('#empty').hidden = false;
      $('#bar').hidden = true;
      $('#tab-chat').disabled = true;
      $('#chat-host').replaceChildren();
      selectSide('list');
      history.replaceState(null, '', location.pathname);
      document.title = 'Paper Vault 论文小助手';
      markCurrent();
    }
  }
}

function updateBar() {
  const tab = activeTab();
  if (!tab) return;
  const isPaper = tab.kind === 'paper';
  $('#controls').hidden = !isPaper;
  if (isPaper) {
    const info = tab.info ?? cardOf(tab.id) ?? {};
    $('#paper-title').textContent = info.title ?? tab.title;
    $('#paper-sub').textContent = metaLine(info);
    document.title = `${info.title ?? tab.title} · Paper Vault`;
    updatePageInd();
  } else if (tab.kind === 'variants') {
    $('#paper-title').textContent = '类似做法';
    $('#paper-sub').textContent = `出自 ${cardOf(tab.paperId)?.title ?? tab.paperId}${tab.page ? ` 第 ${tab.page} 页` : ''}：${tab.passage.slice(0, 120)}`;
    document.title = '类似做法 · Paper Vault';
  } else {
    $('#paper-title').textContent = `方法对比：${tab.ids.length} 篇`;
    $('#paper-sub').textContent = tab.ids.map((id, k) => `${LABELS[k]} ${cardOf(id)?.title ?? id}`).join('；');
    document.title = `方法对比 · Paper Vault`;
  }
}

$('#hide-btn').onclick = () => api('/api/window', { action: 'hide' }).catch(() => {});

// ---- paper tabs -----------------------------------------------------------------

function newPaperTab(id, { autoExplain }) {
  const card = cardOf(id);
  return addTab({
    key: `p:${id}`,
    kind: 'paper',
    id,
    title: card?.title ?? id,
    view: el('div', { className: `pages mode-${state.mode}`, tabIndex: -1 }),
    chatLog: el('div', { className: 'chat-log' }),
    chat: { sessionId: null, busy: false },
    autoExplain,
    rows: [],
  });
}

/** Open (or switch to) a paper's tab. */
function openPaper(id, { autoExplain = true, focusChat = true } = {}) {
  const key = `p:${id}`;
  let tab = state.tabs.find((t) => t.key === key);
  if (!tab) tab = newPaperTab(id, { autoExplain });
  activate(key);
  if (focusChat) selectSide('chat');
  return tab;
}

async function loadPaper(tab) {
  tab.started = true;
  tab.view.replaceChildren(el('p', { className: 'loading', textContent: '正在打开…' }));
  tab.chatLog.replaceChildren();
  try {
    const [info, layout] = await Promise.all([api(`/api/paper/${tab.id}`), api(`/api/paper/${tab.id}/layout`)]);
    if (tab.closed) return;
    tab.info = info;
    tab.layout = layout;
    setTabTitle(tab, info.title);
    if (info.format === 'markdown') {
      buildArticle(tab);
      loadChat(tab);
      return;
    }
    tab.task = pdfjs.getDocument({ url: `/api/paper/${tab.id}/pdf`, isEvalSupported: false });
    tab.doc = await tab.task.promise;
    if (tab.closed) return;
    buildRows(tab);
    loadChat(tab);
  } catch (e) {
    if (tab.closed) return;
    tab.started = false; // let a later activation retry
    tab.view.replaceChildren(el('p', { className: 'loading err', textContent: `打开失败：${e.message}。关闭这个标签页后可以重试。` }));
  }
}

// ---- web articles: one row per paragraph, original | translation ----------------

function buildArticle(tab) {
  const host = tab.view;
  host.className = `pages article mode-${state.mode}`;
  host.style.setProperty('--az', state.zoom);
  const info = tab.info;
  const head = el('header', { className: 'a-head' });
  if (info.meta?.url) {
    head.append(el('a', { className: 'a-src', href: info.meta.url, target: '_blank', rel: 'noopener noreferrer', textContent: `原文：${info.meta.url}` }));
  }
  head.append(el('p', { className: 'a-note', textContent: info.meta?.snapshot ? '下面是入库时保存的原文副本，英文段落右侧是中文译文。' : '下面是你放进来的笔记原文。' }));
  host.replaceChildren(head);
  tab.observer = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) loadArticlePage(tab.rows[Number(e.target.dataset.page) - 1]);
  }, { root: host, rootMargin: '600px 0px' });
  tab.rows = tab.layout.pages.map((pg) => {
    const sec = el('section', { className: 'a-page' });
    sec.dataset.page = pg.page;
    const cells = new Map();
    pg.paras.forEach((p, i) => {
      if (p.kind === 'frag' && !p.text.startsWith('[图')) return;
      const en = el(p.kind === 'heading' ? `h${Math.min(p.level + 1, 4)}` : 'p', { className: 'a-en', textContent: p.text });
      const row = el('div', { className: `a-row k-${p.kind}` }, en);
      if (p.kind === 'text' || p.kind === 'heading') {
        const zh = el(p.kind === 'heading' ? `h${Math.min(p.level + 1, 4)}` : 'p', { className: 'a-zh wait', textContent: '…' });
        row.append(zh);
        cells.set(i, zh);
      }
      sec.append(row);
    });
    host.append(sec);
    tab.observer.observe(sec);
    return { tab, pg, sec, cells, zhState: null };
  });
  if (!tab.rows.some((r) => r.cells.size)) host.classList.add('native'); // already Chinese
  updatePageInd();
}

async function loadArticlePage(r) {
  if (!r || r.zhState || !r.cells.size) return;
  r.zhState = 'loading';
  try {
    for await (const { event, data } of sseStream(`/api/paper/${r.tab.id}/zh/${r.pg.page}`)) {
      if (r.tab.closed) return;
      if (event === 'para') {
        const c = r.cells.get(data.i);
        if (c) {
          c.textContent = data.zh;
          c.classList.remove('wait');
        }
      } else if (event === 'error') throw new Error(data.message);
    }
    r.zhState = 'done';
  } catch (e) {
    if (r.tab.closed) return;
    r.zhState = null;
    for (const c of r.cells.values()) if (c.classList.contains('wait')) c.textContent = `翻译失败：${e.message}（滚动回来会重试）`;
  }
}

function geometry(tab, pg) {
  const host = tab.view.clientWidth || $('#views').clientWidth;
  const avail = host - 48 - 16; // padding + scrollbar
  let zw = Math.min(760, avail);
  let target = Math.min(avail, 980);
  if (state.mode === 'dual') {
    zw = Math.round(Math.max(260, Math.min(600, (avail - 24) * 0.48)));
    target = avail - 24 - zw;
  }
  const scale = Math.max(0.4, Math.min(2.4, (target / pg.width) * state.zoom));
  return { scale, pw: Math.round(pg.width * scale), ph: Math.round(pg.height * scale), zw };
}

function sizeRow(r) {
  r.row.style.setProperty('--pw', `${r.g.pw}px`);
  r.row.style.setProperty('--ph', `${r.g.ph}px`);
  r.row.style.setProperty('--zw', `${r.g.zw}px`);
}

function buildRows(tab) {
  const host = tab.view;
  host.className = `pages mode-${state.mode}`;
  host.replaceChildren();
  host.scrollTop = 0;
  tab.observer = new IntersectionObserver((entries) => onVisible(tab, entries), { root: host, rootMargin: '800px 0px' });
  tab.rows = tab.layout.pages.map((pg) => {
    const page = el('div', { className: 'page' });
    page.append(el('span', { className: 'num', textContent: `第 ${pg.page} 页` }));
    const zh = el('div', { className: 'zh' });
    zh.dataset.page = pg.page;
    const row = el('div', { className: 'row' }, page, zh);
    row.dataset.page = pg.page;
    host.append(row);
    const r = { tab, pg, row, page, zh, g: geometry(tab, pg), rendered: null, zhState: null, zhData: new Map() };
    sizeRow(r);
    hookPageHover(r);
    tab.observer.observe(row);
    return r;
  });
  host.addEventListener('scroll', () => tab === activeTab() && updatePageInd(), { passive: true });
  updatePageInd();
}

function onVisible(tab, entries) {
  for (const e of entries) {
    const r = tab.rows[Number(e.target.dataset.page) - 1];
    if (!e.isIntersecting) {
      // Free canvases far from view so several open papers stay light.
      if (r.rendered) {
        r.rendered = null;
        r.page.querySelectorAll('canvas, .textLayer').forEach((n) => n.remove());
      }
      continue;
    }
    if (state.mode !== 'zh') renderPage(r);
    loadTranslation(r);
    const next = tab.rows[r.pg.page];
    if (next) loadTranslation(next); // prefetch one page ahead
  }
}

async function renderPage(r) {
  const key = `${r.g.scale}`;
  if (r.rendered === key) return;
  r.rendered = key;
  const tab = r.tab;
  const page = await tab.doc.getPage(r.pg.page);
  if (tab.closed || r.rendered !== key) return;
  const vp = page.getViewport({ scale: r.g.scale });
  const dpr = window.devicePixelRatio || 1;
  const canvas = el('canvas', { width: Math.floor(vp.width * dpr), height: Math.floor(vp.height * dpr) });
  const text = el('div', { className: 'textLayer' });
  r.page.style.setProperty('--total-scale-factor', r.g.scale);
  r.page.style.setProperty('--scale-factor', r.g.scale);
  await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
  if (tab.closed || r.rendered !== key) return;
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
  r.zh.querySelectorAll('.p.on').forEach((n) => n.classList.remove('on'));
  if (!on) return;
  const [x0, y0, x1, y1] = r.pg.paras[i].bbox;
  const s = r.g.scale;
  r.page.append(el('div', { className: 'hl', style: `left:${x0 * s - 3}px;top:${y0 * s - 2}px;width:${(x1 - x0) * s + 6}px;height:${(y1 - y0) * s + 4}px` }));
  r.zh.querySelector(`.p[data-i="${i}"]`)?.classList.add('on');
}

// Pointing at a paragraph on the page highlights it and its translation.
function hookPageHover(r) {
  let cur = -1;
  r.page.addEventListener('mousemove', (e) => {
    if (state.mode !== 'dual' || window.getSelection()?.toString()) return;
    const box = r.page.getBoundingClientRect();
    const x = (e.clientX - box.left) / r.g.scale;
    const y = (e.clientY - box.top) / r.g.scale;
    const i = r.pg.paras.findIndex((p) => (p.kind === 'text' || p.kind === 'heading') && x >= p.bbox[0] - 2 && x <= p.bbox[2] + 2 && y >= p.bbox[1] - 2 && y <= p.bbox[3] + 2);
    if (i === cur) return;
    cur = i;
    highlight(r, i, i >= 0);
  });
  r.page.addEventListener('mouseleave', () => {
    cur = -1;
    highlight(r, 0, false);
  });
}

// Each translation sits at the height of its source paragraph; a finished page
// gets the largest font (FONT_STEPS) at which its translations fit the page, and
// a backward pass pulls paragraphs up into free space so any misalignment is
// spread out instead of piling up at the bottom.
const FONT_STEPS = [[14, 1.7], [13.5, 1.65], [13, 1.6], [12.5, 1.55]];

function placeZh(r) {
  const GAP = 3;
  const nodes = [...r.zh.querySelectorAll('.p')];
  const heights = nodes.map((n) => n.offsetHeight); // read everything first, then write
  const want = nodes.map((n) => r.pg.paras[Number(n.dataset.i)].bbox[1] * r.g.scale);
  const tops = [];
  let bottom = 0;
  for (let k = 0; k < nodes.length; k++) {
    tops[k] = Math.max(want[k], k ? bottom + GAP : 0);
    bottom = tops[k] + heights[k];
  }
  let limit = r.g.ph;
  for (let k = nodes.length - 1; k >= 0; k--) {
    tops[k] = Math.max(0, Math.min(tops[k], limit - heights[k]));
    limit = tops[k] - GAP;
  }
  bottom = 0;
  for (let k = 0; k < nodes.length; k++) {
    tops[k] = Math.max(tops[k], k ? bottom + GAP : 0);
    bottom = tops[k] + heights[k];
  }
  nodes.forEach((n, k) => (n.style.top = `${tops[k]}px`));
  r.zh.style.height = `${Math.max(r.g.ph, bottom)}px`;
  return { bottom };
}

function setFont(r, step) {
  r.font = step;
  r.zh.style.setProperty('--zf', `${FONT_STEPS[step][0]}px`);
  r.zh.style.setProperty('--zl', FONT_STEPS[step][1]);
}

function layoutZh(r) {
  if (r.tab.view.hidden) return; // measured when the tab is shown again
  if (state.mode === 'zh') {
    r.zh.style.height = '';
    r.zh.style.removeProperty('--zf');
    r.zh.style.removeProperty('--zl');
    return;
  }
  if (r.font === undefined) setFont(r, 0);
  if (r.zhState !== 'done') return placeZh(r); // still streaming: keep the size steady
  for (let s = 0; s < FONT_STEPS.length; s++) {
    setFont(r, s);
    const { bottom } = placeZh(r);
    if (bottom <= r.g.ph + 4) return;
  }
}

function drawZh(r) {
  const items = r.pg.paras.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === 'text' || p.kind === 'heading');
  r.zh.replaceChildren(...items.map(({ i }) => paraNode(r, i)));
  const refs = r.pg.paras.filter((p) => p.kind === 'ref').length;
  if (refs) {
    const n = el('p', { className: 'p refs', textContent: `参考文献 ${refs} 条（不翻译）` });
    n.dataset.i = r.pg.paras.findIndex((p) => p.kind === 'ref');
    r.zh.append(n);
  }
  if (!items.length && !refs) r.zh.append(el('span', { className: 'status', textContent: '本页没有可翻译的正文' }));
  layoutZh(r);
}

async function loadTranslation(r) {
  if (r.zhState) return;
  r.zhState = 'loading';
  drawZh(r);
  const tab = r.tab;
  try {
    for await (const { event, data } of sseStream(`/api/paper/${tab.id}/zh/${r.pg.page}`)) {
      if (tab.closed) return;
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
    layoutZh(r);
  } catch (e) {
    if (tab.closed) return;
    r.zhState = null;
    r.zh.append(el('span', { className: 'status', textContent: `翻译失败：${e.message}（滚动回来会重试）` }));
  }
}

function relayoutTab(tab) {
  if (tab.kind !== 'paper' || !tab.rows.length || tab.view.hidden) return;
  if (tab.info?.format === 'markdown') {
    tab.view.classList.remove('mode-dual', 'mode-orig', 'mode-zh');
    tab.view.classList.add(`mode-${state.mode}`);
    tab.view.style.setProperty('--az', state.zoom);
    return;
  }
  tab.view.className = `pages mode-${state.mode}`;
  for (const r of tab.rows) {
    r.g = geometry(tab, r.pg);
    sizeRow(r);
    layoutZh(r);
  }
  // Re-render what is on screen at the new scale.
  tab.observer.disconnect();
  for (const r of tab.rows) tab.observer.observe(r.row);
}

for (const b of document.querySelectorAll('[data-mode]')) {
  b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
  b.onclick = () => {
    state.mode = b.dataset.mode;
    localStorage.setItem('pv.mode', state.mode);
    for (const x of document.querySelectorAll('[data-mode]')) x.setAttribute('aria-pressed', String(x === b));
    relayoutTab(activeTab());
  };
}
const zoom = (f) => {
  state.zoom = Math.max(0.6, Math.min(2, +(state.zoom * f).toFixed(2)));
  localStorage.setItem('pv.zoom', state.zoom);
  relayoutTab(activeTab());
};
$('#zoom-in').onclick = () => zoom(1.15);
$('#zoom-out').onclick = () => zoom(1 / 1.15);
let resizeT;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => activeTab() && relayoutTab(activeTab()), 150);
});

function updatePageInd() {
  const tab = activeTab();
  if (tab?.kind !== 'paper' || !tab.rows.length) return void ($('#page-ind').textContent = '');
  if (tab.info?.format === 'markdown') return void ($('#page-ind').textContent = '网络文章');
  const host = tab.view;
  const mid = host.scrollTop + host.clientHeight / 3;
  const r = tab.rows.find((x) => x.row.offsetTop + x.row.offsetHeight > mid) ?? tab.rows.at(-1);
  $('#page-ind').textContent = `${r.pg.page} / ${tab.rows.length} 页`;
}

function goPage(tab, n) {
  const go = () => tab.info?.format !== 'markdown' && tab.rows[n - 1]?.row.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (tab.rows.length) return go();
  // Not loaded yet (e.g. opened from a comparison): wait for it.
  const t = setInterval(() => {
    if (tab.closed) return clearInterval(t);
    if (tab.rows.length) {
      clearInterval(t);
      setTimeout(go, 50);
    }
  }, 200);
}

// ---- markdown & page links --------------------------------------------------------

const PAGE_RE = /第\s*(\d+)\s*(?:[-–~、,，至到和]\s*\d+\s*)*页/g;
const LABEL_PAGE_RE = /([A-E])\s*(?:的)?\s*第\s*(\d+)\s*(?:[-–~、,，至到和]\s*\d+\s*)*页/g;

/** Make "第 N 页" (paper tab) or "A 第 N 页" (comparison) clickable. */
function linkPages(root, tab) {
  const re = tab.kind === 'compare' ? LABEL_PAGE_RE : PAGE_RE;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const hits = [];
  while (walker.nextNode()) {
    re.lastIndex = 0;
    if (re.test(walker.currentNode.nodeValue)) hits.push(walker.currentNode);
  }
  for (const t of hits) {
    const frag = document.createDocumentFragment();
    let last = 0;
    const s = t.nodeValue;
    re.lastIndex = 0;
    for (const m of s.matchAll(re)) {
      frag.append(s.slice(last, m.index));
      const a = el('a', { className: 'pg', textContent: m[0], href: '#' });
      a.onclick = (e) => {
        e.preventDefault();
        if (tab.kind === 'compare') {
          const id = tab.ids[LABELS.indexOf(m[1])];
          if (!id) return;
          const pt = openPaper(id, { autoExplain: false, focusChat: false });
          goPage(pt, Number(m[2]));
        } else if (tab.kind === 'variants') {
          goPage(openPaper(tab.paperId, { autoExplain: false, focusChat: false }), Number(m[1]));
        } else goPage(tab, Number(m[1]));
      };
      frag.append(a);
      last = m.index + m[0].length;
    }
    frag.append(s.slice(last));
    t.replaceWith(frag);
  }
}

function renderMd(node, md, tab) {
  node.innerHTML = marked.parse(md, { async: false });
  // Model output is untrusted: drop anything executable that marked passed through.
  node.querySelectorAll('script, iframe, object, embed, style, link, form').forEach((n) => n.remove());
  node.querySelectorAll('*').forEach((n) => {
    for (const a of [...n.attributes]) if (/^on/i.test(a.name) || (/^(href|src)$/i.test(a.name) && /^\s*(javascript|data):/i.test(a.value))) n.removeAttribute(a.name);
  });
  node.querySelectorAll('table').forEach((t) => t.replaceWith(el('div', { className: 'table-wrap' }, t.cloneNode(true))));
  linkPages(node, tab);
}

// The variants search ends its answer with a ```json item list: never show that part.
const hideJson = (s) => s.replace(/```json[\s\S]*$/, '').trimEnd();

/** Stream an answer into `node`, re-rendering markdown at most once per frame. */
async function streamInto(node, tab, path, body, scroller, { onEvent } = {}) {
  let text = '';
  let raf = 0;
  tab.abort = new AbortController();
  try {
    for await (const { event, data } of sseStream(path, body, tab.abort.signal)) {
      if (tab.closed) return null;
      onEvent?.(event, data);
      if (event === 'delta') {
        text += data;
        if (!raf)
          raf = requestAnimationFrame(() => {
            raf = 0;
            const stick = scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
            renderMd(node, hideJson(text), tab);
            if (stick) scroller.scrollTop = scroller.scrollHeight;
          });
      } else if (event === 'done') {
        cancelAnimationFrame(raf);
        renderMd(node, hideJson(data.text ?? data.report ?? text), tab);
        if (data.cost) node.append(el('span', { className: 'cost', textContent: `本轮约 $${data.cost.toFixed(3)}` }));
        return data;
      } else if (event === 'error') throw new Error(data.message);
    }
    return null;
  } catch (e) {
    if (tab.closed || e.name === 'AbortError') return null;
    node.classList.add('err');
    node.textContent = `出错了：${e.message}`;
    return null;
  }
}

// ---- chat (per tab) -----------------------------------------------------------------

const QUICK = {
  paper: [
    ['方法细节', '核心方法具体是怎么做的？请把关键模块和训练目标讲细一点。'],
    ['关键结果', '实验部分最重要的结论是什么？有哪些数字值得记住？'],
    ['相关论文', '这篇论文和我库里哪些论文最相关？分别是什么关系？'],
  ],
  compare: [
    ['适用场景', '这几篇各自最适合什么场景？我在什么情况下该选哪一个？'],
    ['组合思路', '如果把这几篇的方法组合起来，最有希望的方案是什么？请给出具体设计和要验证的实验。'],
    ['共同基准', '这几篇有没有在相同的基准或任务上评测？把能直接比较的数字整理成一张表。'],
  ],
  variants: [
    ['再找最新的', '再搜一下最近一年的新工作（论文、博客、帖子都行），补充前面没列到的。'],
    ['找开源代码', '这些变体里哪些有开源代码或可直接用的实现？再搜一下补充代码库链接。'],
    ['帮我选', '如果要在原文论文的设定下改进这一步，你最推荐哪种变体？给出理由、实现要点和需要验证的实验。'],
  ],
};
const CHAT_TAB_LABEL = { paper: '讲解', compare: '对比追问', variants: '追问' };
const PLACEHOLDER = {
  paper: '追问这篇论文…（Enter 发送，Shift+Enter 换行）',
  compare: '追问这几篇论文的对比…（Enter 发送）',
  variants: '接着问，比如“只要用在灵巧手上的”…（Enter 发送）',
};

function renderQuick(tab) {
  const host = $('#chat-quick');
  host.replaceChildren(
    ...QUICK[tab.kind].map(([label, q]) => {
      const b = el('button', { type: 'button', textContent: label });
      b.onclick = () => ask(tab, q);
      return b;
    }),
  );
  const reset = el('button', { type: 'button', textContent: { compare: '重新对比', variants: '重新搜索', paper: '重新讲解' }[tab.kind], title: '清空重新生成' });
  reset.onclick = () => resetChat(tab);
  host.append(reset);
  $('#chat-input').placeholder = PLACEHOLDER[tab.kind];
}

function addMsg(tab, role, text) {
  const n = el('div', { className: `msg ${role}` });
  if (role === 'bot') renderMd(n, text, tab);
  else n.textContent = text;
  tab.chatLog.append(n);
  return n;
}

function summaryCard(tab) {
  return el('div', { className: 'summary-card' }, el('strong', { textContent: '一句话' }), document.createTextNode(tab.info?.tldr || '（无）'));
}

async function loadChat(tab) {
  tab.chatLog.replaceChildren(summaryCard(tab));
  const h = await api(`/api/paper/${tab.id}/chat`).catch(() => ({ sessionId: null, messages: [] }));
  if (tab.closed) return;
  tab.chat.sessionId = h.sessionId;
  for (const m of h.messages) addMsg(tab, m.role === 'user' ? 'user' : 'bot', m.content);
  if (h.messages.length) return;
  if (tab.autoExplain) ask(tab, '');
  else {
    const b = el('button', { type: 'button', className: 'explain-btn', textContent: '讲解这篇论文' });
    b.onclick = () => {
      b.remove();
      ask(tab, '');
    };
    tab.chatLog.append(b);
  }
}

async function ask(tab, message) {
  if (!tab || tab.chat.busy) return;
  if (tab.kind !== 'paper' && !tab.report) return; // the report comes first
  if (tab.kind === 'variants' && !message) return;
  tab.chat.busy = true;
  if (message) addMsg(tab, 'user', message);
  const bot = addMsg(tab, 'bot', '');
  bot.textContent = message ? (tab.kind === 'variants' ? '正在联网搜索…' : '思考中…') : '正在通读全文并准备讲解…';
  const path = { compare: '/api/compare', variants: '/api/variants', paper: '/api/chat' }[tab.kind];
  const body = {
    compare: { ids: tab.ids, sessionId: tab.chat.sessionId, message },
    variants: { key: tab.vkey, id: tab.paperId, message },
    paper: { id: tab.id, sessionId: tab.chat.sessionId, message },
  }[tab.kind];
  const r = await streamInto(bot, tab, path, body, $('#chat-host'));
  if (r?.sessionId) tab.chat.sessionId = r.sessionId;
  if (tab.kind === 'variants' && r?.items) {
    const had = new Set(tab.items.map(itemKey));
    const fresh = new Set(r.items.map(itemKey).filter((k) => !had.has(k)));
    renderItems(tab, r.items, fresh);
    bot.append(el('span', { className: 'cost', textContent: fresh.size ? `新增 ${fresh.size} 条，已加到右边列表（高亮的就是）` : '没有新条目' }));
  }
  tab.chat.busy = false;
}

async function resetChat(tab) {
  if (tab.chat.busy) return;
  if (tab.kind === 'variants') {
    tab.report = null;
    tab.chatLog.replaceChildren();
    runVariants(tab, { refresh: true });
  } else if (tab.kind === 'compare') {
    await api('/api/compare/reset', { ids: tab.ids });
    tab.chat.sessionId = null;
    tab.report = null;
    tab.chatLog.replaceChildren();
    runReport(tab);
  } else {
    await api(`/api/paper/${tab.id}/chat/reset`, {});
    tab.chat.sessionId = null;
    tab.chatLog.replaceChildren(summaryCard(tab));
    ask(tab, '');
  }
}

$('#chat-form').onsubmit = (e) => {
  e.preventDefault();
  const v = $('#chat-input').value.trim();
  const tab = activeTab();
  if (!v || !tab) return;
  $('#chat-input').value = '';
  ask(tab, v);
};
$('#chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#chat-form').requestSubmit();
  }
});

// ---- comparison tabs --------------------------------------------------------------

function openCompare(ids) {
  ids = ids.slice(0, MAX_COMPARE);
  if (ids.length < 2) return;
  const key = `c:${[...ids].sort().join('|')}`;
  let tab = state.tabs.find((t) => t.key === key);
  if (!tab) {
    tab = addTab({
      key,
      kind: 'compare',
      ids,
      title: `对比 ${ids.length} 篇`,
      view: el('div', { className: 'compare-view' }),
      chatLog: el('div', { className: 'chat-log' }),
      chat: { sessionId: null, busy: false },
    });
    // One tab per paper, loaded only when first shown and without an automatic explanation.
    for (const id of ids) if (!state.tabs.some((t) => t.key === `p:${id}`)) newPaperTab(id, { autoExplain: false });
  }
  activate(key);
  selectSide('chat');
}

function compareHeader(tab) {
  const list = el('ol', { className: 'cmp-papers' });
  tab.ids.forEach((id, k) => {
    const c = cardOf(id) ?? { title: id };
    const b = el('button', { type: 'button', className: 'cmp-paper' },
      el('span', { className: 'cmp-label', textContent: LABELS[k] }),
      el('span', { className: 'cmp-title', textContent: c.title }),
      el('span', { className: 'cmp-meta', textContent: metaLine(c) }),
    );
    b.title = '打开这篇论文';
    b.onclick = () => openPaper(id, { autoExplain: false, focusChat: false });
    list.append(el('li', {}, b));
  });
  return list;
}

async function loadCompare(tab) {
  tab.started = true;
  tab.reportNode = el('article', { className: 'msg bot report' });
  tab.view.replaceChildren(el('div', { className: 'cmp-inner' }, compareHeader(tab), tab.reportNode));
  const h = await api(`/api/compare?ids=${tab.ids.map(encodeURIComponent).join(',')}`).catch(() => ({ sessionId: null, messages: [] }));
  if (tab.closed) return;
  // A saved comparison keeps the A/B/C labels it was written with, whatever
  // order the papers were ticked in this time.
  if (h.messages?.length && Array.isArray(h.ids) && h.ids.length === tab.ids.length && h.ids.join() !== tab.ids.join()) {
    tab.ids = h.ids;
    tab.view.querySelector('.cmp-papers').replaceWith(compareHeader(tab));
    updateBar();
  }
  tab.chat.sessionId = h.sessionId;
  const [first, report, ...rest] = h.messages;
  if (report) {
    tab.report = report.content;
    renderMd(tab.reportNode, report.content, tab);
    for (const m of rest) addMsg(tab, m.role === 'user' ? 'user' : 'bot', m.content);
    if (!rest.length) tab.chatLog.append(el('p', { className: 'note', textContent: '对比报告在右边。可以在这里接着追问。' }));
  } else runReport(tab);
}

async function runReport(tab) {
  tab.chat.busy = true;
  tab.reportNode.classList.remove('err');
  tab.reportNode.textContent = `正在通读 ${tab.ids.length} 篇论文的全文并整理对比，通常需要一两分钟…`;
  tab.chatLog.replaceChildren(el('p', { className: 'note', textContent: '对比报告生成后可以在这里追问。' }));
  const r = await streamInto(tab.reportNode, tab, '/api/compare', { ids: tab.ids }, tab.view);
  if (r?.sessionId) {
    tab.chat.sessionId = r.sessionId;
    tab.report = r.text;
    tab.chatLog.replaceChildren(el('p', { className: 'note', textContent: '对比报告在右边。可以在这里接着追问。' }));
  }
  tab.chat.busy = false;
}

// ---- "who else does something like this?" tabs ----------------------------------

const KIND_LABEL = { paper: '论文', blog: '博客', news: '报道', post: '帖子', code: '代码', video: '视频' };
const itemKey = (it) => it.arxiv || it.url || it.title;
const pendingDownloads = new Map(); // inbox file name -> [{tab, key}]

function openVariants({ paperId, passage, page, question }) {
  const tab = addTab({
    key: `v:${Date.now()}`,
    kind: 'variants',
    paperId,
    passage,
    page,
    question,
    title: `类似做法：${passage.replace(/\s+/g, ' ').slice(0, 16)}…`,
    view: el('div', { className: 'compare-view' }),
    chatLog: el('div', { className: 'chat-log' }),
    chat: { sessionId: null, busy: false },
    items: [],
  });
  activate(tab.key);
  selectSide('chat');
}

function variantsHeader(tab) {
  const src = el('button', { type: 'button', className: 'v-src', textContent: `出自《${cardOf(tab.paperId)?.title ?? tab.paperId}》${tab.page ? ` 第 ${tab.page} 页` : ''}` });
  src.onclick = () => {
    const pt = openPaper(tab.paperId, { autoExplain: false, focusChat: false });
    if (tab.page) goPage(pt, tab.page);
  };
  return el('header', { className: 'v-head' },
    el('blockquote', { className: 'v-quote', textContent: tab.passage }),
    src,
    el('p', { className: 'v-question', textContent: `问：${tab.question}` }),
  );
}

async function loadVariants(tab) {
  tab.started = true;
  tab.reportNode = el('article', { className: 'msg bot report' });
  tab.itemsNode = el('section', { className: 'v-items' });
  tab.view.replaceChildren(el('div', { className: 'cmp-inner' }, variantsHeader(tab), tab.itemsNode, tab.reportNode));
  runVariants(tab);
}

async function runVariants(tab, { refresh = false } = {}) {
  tab.chat.busy = true;
  tab.reportNode.classList.remove('err');
  tab.reportNode.textContent = '正在联网搜集相关工作，并核对 arXiv 信息，通常需要 1-2 分钟…';
  if (!refresh) tab.itemsNode.replaceChildren();
  tab.chatLog.replaceChildren(el('p', { className: 'note', textContent: '搜索结果出来后可以在这里接着问，比如让它再找某一类变体。' }));
  const body = tab.vkey ? { key: tab.vkey, id: tab.paperId, refresh } : { id: tab.paperId, passage: tab.passage, page: tab.page, question: tab.question, refresh };
  const r = await streamInto(tab.reportNode, tab, '/api/variants', body, tab.view, {
    onEvent: (ev, data) => {
      if (ev === 'key') tab.vkey = data.key;
    },
  });
  if (r) {
    tab.report = r.report;
    tab.chat.sessionId = r.sessionId;
    renderItems(tab, r.items ?? []);
    tab.chatLog.replaceChildren(el('p', { className: 'note', textContent: r.cached ? '这是之前搜过的结果。点“重新搜索”会重新联网搜集。' : '结果在右边。可以在这里接着问。' }));
    for (const m of (r.messages ?? []).slice(2)) addMsg(tab, m.role === 'user' ? 'user' : 'bot', hideJson(m.content));
  }
  tab.chat.busy = false;
}

function renderItems(tab, items, fresh = new Set()) {
  tab.items = items;
  const grid = el('div', { className: 'v-grid' });
  for (const it of items) grid.append(itemCard(tab, it, fresh.has(itemKey(it))));
  const papers = items.filter((i) => i.kind === 'paper').length;
  tab.itemsNode.replaceChildren(
    el('h2', { className: 'v-h', textContent: `搜集到 ${items.length} 条（论文 ${papers} 篇）` }),
    grid,
  );
}

function itemCard(tab, it, isNew) {
  const card = el('article', { className: `v-card${isNew ? ' new' : ''}` });
  const top = el('div', { className: 'v-top' }, el('span', { className: `v-kind k-${it.kind}`, textContent: KIND_LABEL[it.kind] ?? it.kind }));
  if (it.variant) top.append(el('span', { className: 'v-variant', textContent: it.variant }));
  const title = it.url ? el('a', { className: 'v-title', href: it.url, target: '_blank', rel: 'noopener noreferrer', textContent: it.title || it.url }) : el('span', { className: 'v-title', textContent: it.title });
  const meta = [it.year, (it.authors ?? []).slice(0, 3).join(', ') + ((it.authors ?? []).length > 3 ? ' 等' : '')].filter(Boolean).join('，');
  card.append(top, title);
  if (meta) card.append(el('p', { className: 'v-meta', textContent: meta }));
  if (it.verified === true) card.append(el('p', { className: 'v-ok', textContent: `arXiv ${it.arxiv} 已核实` }));
  if (it.verified === false) card.append(el('p', { className: 'v-bad', textContent: `arXiv 上查不到 ${it.arxiv}，这条可能有误` }));
  if (it.note) card.append(el('p', { className: 'v-note', textContent: it.note }));
  const actions = el('div', { className: 'v-actions' });
  if (it.libraryId) {
    const b = el('button', { type: 'button', textContent: '已在库里，打开' });
    b.onclick = () => openPaper(it.libraryId, { focusChat: false });
    actions.append(b);
  } else if (it.downloadable) {
    const b = el('button', { type: 'button', className: 'primary', textContent: '下载到论文库' });
    b.onclick = () => download(tab, it, b);
    actions.append(b);
  }
  if (actions.childNodes.length) card.append(actions);
  return card;
}

async function download(tab, it, btn) {
  btn.disabled = true;
  btn.textContent = '下载中…';
  try {
    const r = await api('/api/download', { arxiv: it.arxiv || undefined, url: it.arxiv ? undefined : it.url, title: it.title });
    if (r.status === 'exists') {
      it.libraryId = r.id;
      btn.disabled = false;
      btn.className = '';
      btn.textContent = '已在库里，打开';
      btn.onclick = () => openPaper(r.id, { focusChat: false });
      return;
    }
    btn.textContent = '已下载，等待入库…';
    const list = pendingDownloads.get(r.file) ?? [];
    list.push({ tab, it, btn });
    pendingDownloads.set(r.file, list);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '重试下载';
    btn.title = e.message;
    btn.after(el('span', { className: 'v-err', textContent: e.message }));
  }
}

/** The inbox watcher reports progress; update matching download buttons. */
async function onLibraryEvent(e) {
  const waiting = pendingDownloads.get(e.file);
  if (e.type === 'added' || e.type === 'duplicate') {
    state.papers = await api('/api/papers').catch(() => state.papers);
    if (!$('#q').value.trim() && !state.listed.some((p) => p.reason)) renderList(state.papers, `库里共 ${state.papers.length} 篇，最近添加的在前`);
  }
  if (!waiting) return;
  for (const { it, btn } of waiting) {
    if (e.type === 'start') btn.textContent = '正在总结入库…';
    else if (e.type === 'added' || e.type === 'duplicate') {
      it.libraryId = e.id;
      btn.disabled = false;
      btn.className = '';
      btn.textContent = e.type === 'added' ? '已入库，打开' : '库里已有，打开';
      btn.onclick = () => openPaper(e.id, { focusChat: false });
    } else if (e.type === 'failed') {
      btn.textContent = '入库失败';
      btn.title = e.error ?? '';
    }
  }
  if (e.type !== 'start') pendingDownloads.delete(e.file);
}

// ---- selection: translate, or find similar approaches ---------------------------

const pop = $('#pop');
const DEFAULT_Q = '类似的做法还有谁做了？不要求完全一样，论文、博客、报道、帖子都可以。我想看看这一类做法有哪些变体，判断哪种最合适。';

function selectionSource(sel) {
  const a = sel?.anchorNode;
  const node = a?.nodeType === Node.ELEMENT_NODE ? a : a?.parentElement; // triple-click selects whole elements
  const inPage = node?.closest('.textLayer, .a-en');
  const inZh = node?.closest('.zh .p, .a-zh');
  if (!inPage && !inZh) return null;
  const tab = activeTab();
  if (tab?.kind !== 'paper') return null;
  // Articles have no real pages; only PDFs pass a page number on.
  const page = tab.info?.format === 'markdown' ? null : Number(node.closest('.row')?.dataset.page) || null;
  return { tab, page, original: !!inPage };
}

document.addEventListener('mouseup', (e) => {
  if (pop.contains(e.target)) return;
  setTimeout(() => {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    const src = text && text.length >= 2 ? selectionSource(sel) : null;
    if (!src) {
      pop.hidden = true;
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    pop.dataset.text = text;
    pop.source = src;
    $('#pop-out').textContent = '';
    $('#pop-actions').hidden = false;
    $('#pop-go').hidden = !src.original; // translating Chinese makes no sense
    $('#pop-ask').hidden = true;
    pop.hidden = false;
    pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 440))}px`;
    pop.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 200)}px`;
  });
});
$('#pop-similar').onclick = () => {
  $('#pop-actions').hidden = true;
  $('#pop-out').textContent = '';
  $('#pop-ask').hidden = false;
  $('#pop-q').value = DEFAULT_Q;
  $('#pop-q').focus();
  $('#pop-q').select();
};
$('#pop-ask').onsubmit = (e) => {
  e.preventDefault();
  const src = pop.source;
  if (!src) return;
  pop.hidden = true;
  openVariants({ paperId: src.tab.id, passage: pop.dataset.text, page: src.page, question: $('#pop-q').value.trim() || DEFAULT_Q });
};
$('#pop-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#pop-ask').requestSubmit();
  }
});
$('#pop-go').onclick = async () => {
  $('#pop-actions').hidden = true;
  $('#pop-out').textContent = '翻译中…';
  try {
    const tab = activeTab();
    const { zh } = await api('/api/translate', { text: pop.dataset.text, id: tab?.kind === 'paper' ? tab.id : undefined });
    $('#pop-out').textContent = zh;
  } catch (e) {
    $('#pop-out').textContent = `翻译失败：${e.message}`;
  }
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') pop.hidden = true;
  // Ctrl+W closes the current tab, like a browser.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w' && state.active) {
    e.preventDefault();
    closeTab(state.active);
  }
});

// ---- push channel: `pv open "..."` runs a search in this window ------------------

function listen() {
  const es = new EventSource('/api/events');
  es.addEventListener('find', (e) => {
    const { q } = JSON.parse(e.data);
    $('#q').value = q;
    find(q);
  });
  es.addEventListener('library', (e) => onLibraryEvent(JSON.parse(e.data)));
}

// ---- start --------------------------------------------------------------------

state.papers = await api('/api/papers');
renderSelBar();
const params = new URLSearchParams(location.search);
if (params.get('q')) {
  $('#q').value = params.get('q');
  find(params.get('q'));
} else {
  renderList(state.papers, `库里共 ${state.papers.length} 篇，最近添加的在前`);
}
if (params.get('id') && cardOf(params.get('id'))) openPaper(params.get('id'), { autoExplain: false });
listen();
$('#q').focus();
