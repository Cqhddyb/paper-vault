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
  for (const line of lines) {
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
        cur = { text: r.str, x0: r.x0, x1: r.x1, y: r.y, hmax: r.h, hs: [[r.h, r.str.length]] };
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
  if (!twoCol) {
    for (const s of segs) s.col = 'F';
    return [...segs].sort((p, q) => p.y - q.y || p.x0 - q.x0);
  }
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
      const prevEnds = /[.:!?。：！？]["”')]?$/.test(prev.text);
      const indentJump = Math.abs(s.x0 - prev.x0) > 4 * prev.h;
      join = sameSize && dy > 0 && dy <= 1.6 * prev.h && !(prevShort && prevEnds) && !indentJump;
    }
    if (join) {
      p.text = joinText(p.text, s.text);
      p.x0 = Math.min(p.x0, s.x0);
      p.x1 = Math.max(p.x1, s.x1);
      p.y1 = s.y + 0.25 * s.h;
      p.lines++;
    } else {
      p = { text: s.text, x0: s.x0, x1: s.x1, y0: s.y - s.h, y1: s.y + 0.25 * s.h, h: s.h, col: s.col, lines: 1 };
      paras.push(p);
    }
    prev = s;
  }
  return paras.filter((q) => q.text.length > 2 && !/^[\d\s.\-–—ivxlc]+$/i.test(q.text));
}

const REF_HEAD = /^(\d+\.?\s*|[IVX]+\.?\s*)?(references|bibliography|参考文献)$/i;
const AFTER_REF = /^(appendix|appendices|supplementary|[A-H](\.\d+)?\.?\s+[A-Z][A-Za-z\- ]{2,60}$)/i;

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
      if (inRefs && ((para.lines <= 2 && AFTER_REF.test(para.text.trim())) || (para.lines >= 6 && !/\b(19|20)\d\d\b/.test(para.text)))) inRefs = false;
      if (inRefs) para.kind = 'ref';
    }
  }
  return pages;
}

const round = (v) => Math.round(v * 10) / 10;

const NUMBERED_HEAD = /^((\d+(\.\d+)*|[IVX]+|[A-H](\.\d+)*)\.?)\s+[A-Z][^.]{1,80}$/;

/**
 * heading: larger font or "3.2 Method"-style line; frag: a short single line
 * that is not a sentence (figure labels, author lists, table cells) -- shown
 * but not translated; text: everything else.
 */
export function classify(q, bodyH) {
  const t = q.text.trim();
  if (q.lines <= 2 && t.length < 120 && (q.h > bodyH * 1.15 || NUMBERED_HEAD.test(t))) return 'heading';
  if (/^(Figure|Fig\.|Table|Algorithm)\s*\d+/i.test(t)) return 'text';
  if (q.lines === 1 && (t.length < 50 || !/[a-z]{3,}.*\s.*[a-z]{3,}/.test(t))) return 'frag';
  return 'text';
}

export async function extractLayout(pdfPath) {
  const { task, doc } = await openPdf(pdfPath);
  const pages = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const runs = itemsToRuns(content.items, vp.height);
      const bodyH = median(runs.map((r) => r.h));
      const paras = segmentsToParagraphs(orderSegments(runsToSegments(runs), vp.width)).map((q) => ({
        text: q.text,
        bbox: [round(q.x0), round(q.y0), round(q.x1), round(q.y1)],
        kind: classify(q, bodyH),
        lines: q.lines,
      }));
      pages.push({ page: i, width: round(vp.width), height: round(vp.height), paras });
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  markReferences(pages);
  for (const pg of pages) for (const para of pg.paras) delete para.lines;
  return pages;
}
