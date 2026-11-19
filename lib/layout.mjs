// Page -> paragraphs with positions, for side-by-side translation.
//
// pdfjs gives positioned text runs. We rebuild lines, split them at column
// gutters, order segments in reading order (two-column pages: full-width
// segments cut the page into bands; inside a band the left column comes before
// the right), then merge consecutive lines into paragraphs.
//
// Coordinates are PDF points at scale 1 with the origin at the TOP-left, so a
// client can multiply by its render scale.

import fs from 'node:fs';

async function openPdf(pdfPath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const task = pdfjs.getDocument({ data, useSystemFonts: true, disableFontFace: true, isEvalSupported: false, verbosity: 0 });
  return { task, doc: await task.promise };
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function joinText(a, b) {
  if (!a) return b;
  if (!b) return a;
  // De-hyphenate "repre-" + "sentation", keep "vision-" + "Language".
  if (/[a-z]-$/.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b;
  if (/\s$/.test(a) || /^\s/.test(b)) return a + b;
  if (/[㐀-鿿]$/.test(a) && /^[㐀-鿿]/.test(b)) return a + b;
  return a + ' ' + b;
}

export function itemsToRuns(items, pageHeight) {
  const runs = [];
  for (const it of items) {
    if (!('str' in it) || !it.str.trim()) continue;
    const [a, b, c, d, e, f] = it.transform;
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01) continue; // rotated text (axis labels, arXiv stamp)
    const h = Math.abs(d) || Math.hypot(c, d);
    if (h < 1) continue;
    runs.push({ str: it.str, x0: e, x1: e + it.width, y: pageHeight - f, h });
  }
  return runs;
}

export function runsToSegments(runs) {
  runs.sort((p, q) => p.y - q.y || p.x0 - q.x0);
  const lines = [];
  for (const r of runs) {
    const line = lines.at(-1);
    if (line && Math.abs(r.y - line.y) < 0.45 * Math.min(r.h, line.h)) line.runs.push(r);
    else lines.push({ y: r.y, h: r.h, runs: [r] });
  }
  const segs = [];
  for (const [li, line] of lines.entries()) {
    line.runs.sort((p, q) => p.x0 - q.x0);
    let cur = null;
    for (const r of line.runs) {
      const gap = cur ? r.x0 - cur.x1 : Infinity;
      if (cur && gap < Math.max(1.5 * Math.max(cur.hmax, r.h), 6)) {
        cur.text = gap > 0.15 * r.h ? joinText(cur.text, r.str) : cur.text + r.str;
        cur.x1 = Math.max(cur.x1, r.x1);
        cur.y = Math.max(cur.y, r.y);
        cur.hs.push([r.h, r.str.length]);
        cur.hmax = Math.max(cur.hmax, r.h);
      } else {
        cur = { text: r.str, x0: r.x0, x1: r.x1, y: r.y, hmax: r.h, hs: [[r.h, r.str.length]], li };
        segs.push(cur);
      }
    }
  }
  for (const s of segs) {
    s.text = s.text.replace(/\s+/g, ' ').trim();
    // Font size of the segment = the size most of its characters use, so a bold
    // "Abstract:" lead-in or a superscript does not make the line look different.
    const weight = new Map();
    for (const [h, n] of s.hs) weight.set(Math.round(h * 2) / 2, (weight.get(Math.round(h * 2) / 2) ?? 0) + n);
    s.h = [...weight.entries()].sort((a, b) => b[1] - a[1])[0][0];
    delete s.hs;
    delete s.hmax;
  }
  return segs.filter((s) => s.text);
}

export function orderSegments(segs, width) {
  const mid = width / 2;
  const tol = width * 0.03;
  for (const s of segs) s.col = s.x1 <= mid + tol ? 'L' : s.x0 >= mid - tol ? 'R' : 'F';
  const nL = segs.filter((s) => s.col === 'L').length;
  const nR = segs.filter((s) => s.col === 'R').length;
  const nF = segs.length - nL - nR;
  const twoCol = nL >= 5 && nR >= 5 && nL + nR > 1.5 * nF;
  if (!twoCol) for (const s of segs) s.col = 'F';
  // A line broken into several pieces inside one column is a table row or
  // figure labels, not prose (prose lines are one piece per column).
  const perLine = new Map();
  for (const s of segs) {
    const k = `${s.li}|${s.col}`;
    perLine.set(k, (perLine.get(k) ?? 0) + 1);
  }
  for (const s of segs) s.crowded = perLine.get(`${s.li}|${s.col}`) > 1 || (s.col === 'F' && twoCol && segs.some((o) => o !== s && o.li === s.li));
  if (!twoCol) return [...segs].sort((p, q) => p.y - q.y || p.x0 - q.x0);
  const out = [];
  let band = [];
  const flush = () => {
    out.push(...band.filter((s) => s.col === 'L'), ...band.filter((s) => s.col === 'R'));
    band = [];
  };
  for (const s of [...segs].sort((p, q) => p.y - q.y || p.x0 - q.x0)) {
    if (s.col === 'F') {
      flush();
      out.push(s);
    } else band.push(s);
  }
  flush();
  return out;
}

// A line that starts a list item: "(1) ...", "2) ...", "(b) ...", "• ...".
export const LIST_ITEM = /^(\(\d{1,2}\)|\d{1,2}\)\s|\([a-z]\)\s|[a-z]\)\s|[•●▪◦∙·‣■□]\s?|[–—]\s)/;

export function segmentsToParagraphs(segs) {
  const colRight = {};
  for (const s of segs) colRight[s.col] = Math.max(colRight[s.col] ?? 0, s.x1);
  const colLeft = {};
  for (const s of segs) colLeft[s.col] = Math.min(colLeft[s.col] ?? Infinity, s.x0);
  const paras = [];
  let p = null;
  let prev = null;
  for (const s of segs) {
    let join = false;
    if (p && prev && s.col === prev.col) {
      const dy = s.y - prev.y;
      const sameSize = Math.abs(s.h - prev.h) <= 0.2 * prev.h;
      const prevShort = prev.x1 < colRight[prev.col] - 0.12 * (colRight[prev.col] - colLeft[prev.col]);
      const prevEnds = /[.:!?;。：！？；]["”')]?$/.test(prev.text);
      const indentJump = Math.abs(s.x0 - prev.x0) > 4 * prev.h;
      const newItem = LIST_ITEM.test(s.text);
      join = sameSize && dy > 0 && dy <= 1.6 * prev.h && !(prevShort && prevEnds) && !indentJump && !newItem && !!s.crowded === !!prev.crowded;
    }
    if (join) {
      p.text = joinText(p.text, s.text);
      p.x0 = Math.min(p.x0, s.x0);
      p.x1 = Math.max(p.x1, s.x1);
      p.y1 = s.y + 0.25 * s.h;
      p.lines++;
      if (s.crowded) p.crowded++;
    } else {
      p = { text: s.text, x0: s.x0, x1: s.x1, y0: s.y - s.h, y1: s.y + 0.25 * s.h, h: s.h, col: s.col, lines: 1, crowded: s.crowded ? 1 : 0 };
      paras.push(p);
    }
    prev = s;
  }
  return paras.filter((q) => q.text.length > 2 && !/^[\d\s.\-–—ivxlc]+$/i.test(q.text));
}

/** Font size and line width of the document's body text (by character count). */
export function bodyMetrics(allSegs) {
  const weight = new Map();
  for (const s of allSegs) weight.set(s.h, (weight.get(s.h) ?? 0) + s.text.length);
  const bodyH = [...weight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
  const widths = allSegs.filter((s) => Math.abs(s.h - bodyH) < 0.6).map((s) => s.x1 - s.x0).sort((a, b) => a - b);
  const bodyW = widths[Math.floor(widths.length * 0.9)] ?? 300;
  return { bodyH, bodyW };
}

const REF_HEAD = /^(\d+\.?\s*|[IVX]+\.?\s*)?(references|references and notes|bibliography|literature cited|参考文献)$/i;
const AFTER_REF_WORD = /^(appendix|appendices|supplementary)/i;
const AFTER_REF_LETTER = /^[A-H](\.\d+)?\.?\s+[A-Z][A-Za-z\- ]{2,60}$/;
// One bibliography entry: "[12] A. Author, ...", "12. Z. Li, ...", with a year.
const REF_ENTRY = /^(\[\d{1,3}\]\s+\S|\d{1,3}\.\s+[A-Z][a-z]*\.?\s?[A-Z]?[a-z]*\.?,)/;
const YEAR = /\b(19|20)\d\d\b/;

/** Mark reference-list paragraphs (kind 'ref') so they are shown but not translated. */
export function markReferences(pages) {
  let inRefs = false;
  for (const pg of pages) {
    for (const para of pg.paras) {
      if (REF_HEAD.test(para.text.trim())) {
        inRefs = true;
        para.kind = 'heading';
        continue;
      }
      // Heading merged into the first entry: "References [1] A. Author, ..."
      if (/^(\d+\.?\s*|[IVX]+\.?\s*)?(references|bibliography)\s+(\[1\]|1\.\s|[A-Z][a-z]+,)/i.test(para.text)) {
        inRefs = true;
        para.kind = 'ref';
        continue;
      }
      // Leave the reference list at an appendix heading, or at a long paragraph
      // with no year in it (references always have one).
      const t = para.text.trim();
      const appendix = para.lines <= 2 && (AFTER_REF_WORD.test(t) || (para.kind === 'heading' && AFTER_REF_LETTER.test(t)));
      if (inRefs && (appendix || (para.lines >= 6 && !YEAR.test(t) && !REF_ENTRY.test(t)))) inRefs = false;
      if (inRefs || (REF_ENTRY.test(t) && YEAR.test(t) && para.kind !== 'heading')) para.kind = 'ref';
    }
  }
  return pages;
}

const round = (v) => Math.round(v * 10) / 10;

const NUMBERED_HEAD = /^((\d+(\.\d+)*|[IVX]+|[A-H](\.\d+)*)\.?)\s+[A-Z][^.]{1,80}$/;

const CAPTION = /^(Figure|Fig\.|Table|Tab\.|Algorithm|Listing)\s*[A-Z]?\d+/i;
const SENTENCE_END = /[.!?。！？]["”')\]]?$/;

/**
 * heading: larger font or "3.2 Method"-style line.
 * frag: figure labels, table cells, flow-chart boxes, author lists -- shown on
 *   the page but not translated. Signals: smaller font than the body, much
 *   narrower than a body line, or a line split into several pieces.
 * text: prose, captions, footnotes.
 * `m` is { bodyH, bodyW } from bodyMetrics (a bare number is taken as bodyH).
 */
/**
 * Running prose: at least 8 plain lowercase words making up most of the text.
 * Figure labels, code, table rows and hyper-parameter lists fail this.
 */
export function isProse(t) {
  const words = t.split(/\s+/).filter(Boolean);
  const plain = words.filter((w) => /^[(“"']?[a-z]{2,}[,.;:)”"']*$/.test(w)).length;
  return plain >= 8 && plain >= words.length * 0.5;
}

/** Source code / config listings: dense in code punctuation or code keywords. */
export function isCode(t) {
  const sym = (t.match(/[(){}\[\];=<>_]|=>|\/\/|\+\+|::/g) ?? []).length;
  const kw = (t.match(/\b(await|async|const|let|var|def|return|import|function|elif|lambda|self|None|null|true|false)\b/g) ?? []).length;
  return sym / Math.max(t.length, 1) > 0.06 || (kw >= 2 && sym >= 4) || /^\d{1,3}\s+(import|from|def|class|for|if|return)\b/.test(t);
}

export function classify(q, m) {
  const { bodyH, bodyW = 300 } = typeof m === 'number' ? { bodyH: m } : m;
  const t = q.text.trim();
  const w = (q.x1 ?? 0) - (q.x0 ?? 0) || bodyW;
  if (CAPTION.test(t)) return 'text';
  const prose = isProse(t);
  // Prose full of citations and math also looks symbol-heavy, so for prose
  // require unmistakable code (definitions, comments, arrows, awaits).
  if (isCode(t) && (!prose || /(^|\s)(def|function|class)\s+\w+\s*\(|\/\/ |=>|\bawait\s+\w+\s*\./.test(t))) return 'frag';
  // Text wrapped beside a figure shares lines with its labels; keep it if it reads as prose.
  if (q.crowded && q.crowded >= q.lines / 2 && !prose) return 'frag';
  // Small print: footnotes and caption continuations are prose; figure text is not.
  if (q.h < bodyH * 0.85) return prose ? 'text' : 'frag';
  if (q.lines <= 2 && t.length < 120 && (q.h > bodyH * 1.15 || NUMBERED_HEAD.test(t))) return 'heading';
  if (q.lines === 1 && (t.length < 50 || !/[a-z]{3,}.*\s.*[a-z]{3,}/.test(t))) return 'frag';
  // Body-size text in a narrow box that never forms a sentence: diagram labels.
  if (w < bodyW * 0.3 && !SENTENCE_END.test(t) && q.lines <= 4) return 'frag';
  return 'text';
}

export async function extractLayout(pdfPath) {
  const { task, doc } = await openPdf(pdfPath);
  const raw = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      raw.push({ page: i, width: vp.width, height: vp.height, segs: runsToSegments(itemsToRuns(content.items, vp.height)) });
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  // Body font/width are measured over the whole document: a page that is
  // mostly figure would otherwise make its labels look like body text.
  const metrics = bodyMetrics(raw.flatMap((r) => r.segs));
  const pages = raw.map((r) => ({
    page: r.page,
    width: round(r.width),
    height: round(r.height),
    paras: segmentsToParagraphs(orderSegments(r.segs, r.width)).map((q) => ({
      text: q.text,
      bbox: [round(q.x0), round(q.y0), round(q.x1), round(q.y1)],
      kind: classify(q, metrics),
      lines: q.lines,
    })),
  }));
  markReferences(pages);
  for (const pg of pages) for (const para of pg.paras) delete para.lines;
  return pages;
}
