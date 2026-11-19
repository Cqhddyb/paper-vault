// Library layout and operations. The library is a plain folder:
//
//   <library>/inbox/                 drop PDFs here; the watcher picks them up
//   <library>/inbox/_failed/         PDFs whose summary failed (+ .log)
//   <library>/inbox/_duplicates/     PDFs already in the library
//   <library>/papers/<id>/<id>.pdf   the paper
//   <library>/papers/<id>/summary.md the summary (YAML frontmatter + markdown)
//   <library>/.staging/              drafts, logs, watcher lock

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.mjs';

export const CONFIG_PATH = path.join(os.homedir(), '.paper-vault.json');

export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

export function libraryRoot() {
  const dir = process.env.PAPER_VAULT_DIR || readConfig().library;
  if (!dir) {
    throw new UserError(`未配置论文库目录。先运行: node pv.mjs init <目录>（配置写在 ${CONFIG_PATH}）`);
  }
  return path.resolve(dir);
}

export class UserError extends Error {}

export function dirs(root = libraryRoot()) {
  return {
    root,
    inbox: path.join(root, 'inbox'),
    failed: path.join(root, 'inbox', '_failed'),
    duplicates: path.join(root, 'inbox', '_duplicates'),
    papers: path.join(root, 'papers'),
    staging: path.join(root, '.staging'),
  };
}

export function ensureLayout(root) {
  const d = dirs(root);
  for (const p of [d.inbox, d.failed, d.duplicates, d.papers, d.staging]) fs.mkdirSync(p, { recursive: true });
  return d;
}

export function listInbox(d = dirs()) {
  if (!fs.existsSync(d.inbox)) return [];
  return fs
    .readdirSync(d.inbox, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.pdf'))
    .map((e) => path.join(d.inbox, e.name));
}

export function loadPapers(d = dirs()) {
  if (!fs.existsSync(d.papers)) return [];
  const papers = [];
  for (const e of fs.readdirSync(d.papers, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(d.papers, e.name);
    const summaryPath = path.join(dir, 'summary.md');
    if (!fs.existsSync(summaryPath)) continue;
    const { meta, body } = parseFrontmatter(fs.readFileSync(summaryPath, 'utf8'));
    meta.id ||= e.name;
    papers.push({
      meta,
      body,
      dir,
      summaryPath,
      pdfPath: meta.pdf ? path.join(dir, meta.pdf) : null,
    });
  }
  return papers;
}

// ---- identity helpers -------------------------------------------------------

export function normArxiv(s) {
  if (!s) return '';
  const m = String(s).match(/(\d{4}\.\d{4,5})(v\d+)?/) || String(s).match(/([a-z\-]+(?:\.[A-Z]{2})?\/\d{7})/i);
  return m ? m[1].toLowerCase() : '';
}

export function normDoi(s) {
  if (!s) return '';
  return String(s).trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/^doi:\s*/, '');
}

export function normTitle(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9㐀-鿿]+/g, '');
}

export function hashFile(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// Make sure every paper records its PDF's sha256 so an exact re-download can be
// recognised before paying for a summary. Returns how many were filled in.
export function backfillHashes(d = dirs()) {
  let n = 0;
  for (const p of loadPapers(d)) {
    if (p.meta.sha256 || !p.pdfPath || !fs.existsSync(p.pdfPath)) continue;
    p.meta.sha256 = hashFile(p.pdfPath);
    fs.writeFileSync(p.summaryPath, serializeFrontmatter(p.meta, p.body));
    n++;
  }
  return n;
}

export function findByHash(sha, papers) {
  return papers.find((p) => p.meta.sha256 === sha);
}

export function fileDuplicate(pdfPath, d = dirs()) {
  const dst = uniquePath(path.join(d.duplicates, path.basename(pdfPath)));
  moveFile(pdfPath, dst);
  return dst;
}

export function findDuplicate(meta, papers) {
  const ax = normArxiv(meta.arxiv);
  const doi = normDoi(meta.doi);
  const t = normTitle(meta.title);
  return papers.find(
    (p) =>
      (ax && normArxiv(p.meta.arxiv) === ax) ||
      (doi && normDoi(p.meta.doi) === doi) ||
      (t.length > 10 && normTitle(p.meta.title) === t),
  );
}

const STOP = new Set(['a', 'an', 'the', 'of', 'for', 'and', 'on', 'in', 'to', 'with', 'via', 'towards', 'toward', 'from', 'by', 'at', 'is', 'are']);

const GREEK = { α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', θ: 'theta', λ: 'lambda', μ: 'mu', π: 'pi', σ: 'sigma', τ: 'tau', φ: 'phi', ψ: 'psi', ω: 'omega' };

function ascii(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[α-ω]/g, (c) => GREEK[c] ?? '');
}

export function makeId(meta, taken) {
  const year = String(meta.year ?? '').match(/\d{4}/)?.[0] ?? 'nd';
  const first = Array.isArray(meta.authors) && meta.authors.length ? meta.authors[0] : '';
  const surname = ascii(first).replace(/[^a-z\s\-]/g, ' ').trim().split(/\s+/).filter(Boolean).at(-1) ?? '';
  const words = ascii(meta.title).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)).slice(0, 4);
  let base = [year, surname, ...words].filter(Boolean).join('-').slice(0, 60).replace(/-+$/, '');
  if (base === year) base = `${year}-paper`;
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

// ---- validation & ingest ----------------------------------------------------

const REQUIRED = ['title', 'tldr'];
const SECTIONS = ['动机', '方法', '结果'];

export function validateSummary(meta, body) {
  const errors = [];
  const warnings = [];
  for (const k of REQUIRED) if (!meta[k] || !String(meta[k]).trim()) errors.push(`frontmatter 缺少 ${k}`);
  if (!Array.isArray(meta.authors) || !meta.authors.length) warnings.push('authors 为空');
  if (!meta.year) warnings.push('year 为空');
  if (!Array.isArray(meta.models) || !meta.models.length) warnings.push('models 为空（论文确实没用模型时可忽略）');
  for (const s of SECTIONS) if (!body.includes(s)) warnings.push(`正文里没有「${s}」小节`);
  const len = body.replace(/\s/g, '').length;
  if (len < 300) errors.push(`正文过短（${len} 字）`);
  if (len > 4000) warnings.push(`正文偏长（${len} 字），目标 800-2000 字`);
  return { errors, warnings };
}

function moveFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(src, dst);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(src, dst);
    fs.unlinkSync(src);
  }
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const { dir, name, ext } = path.parse(p);
  for (let i = 2; ; i++) {
    const c = path.join(dir, `${name} (${i})${ext}`);
    if (!fs.existsSync(c)) return c;
  }
}

/**
 * Validate a draft summary and file the PDF + summary into the library.
 * `summaryText` is the full markdown (frontmatter + body).
 * Returns { status: 'added' | 'duplicate', id, dir, warnings }.
 */
export function ingest(pdfPath, summaryText, { d = dirs(), today = new Date() } = {}) {
  pdfPath = path.resolve(pdfPath);
  if (!fs.existsSync(pdfPath)) throw new UserError(`找不到 PDF: ${pdfPath}`);
  const { meta, body, hasFrontmatter } = parseFrontmatter(summaryText);
  if (!hasFrontmatter) throw new UserError('总结没有 YAML frontmatter（文件需以 --- 开头）');
  const { errors, warnings } = validateSummary(meta, body);
  if (errors.length) throw new UserError('总结不合格: ' + errors.join('; '));

  const papers = loadPapers(d);
  const sha256 = hashFile(pdfPath);
  const dup = findByHash(sha256, papers) ?? findDuplicate(meta, papers);
  if (dup) {
    const inInbox = path.dirname(pdfPath) === d.inbox;
    return { status: 'duplicate', id: dup.meta.id, dir: dup.dir, movedTo: inInbox ? fileDuplicate(pdfPath, d) : null, warnings };
  }

  const id = makeId(meta, new Set(papers.map((p) => p.meta.id)));
  const dir = path.join(d.papers, id);
  const pdfName = `${id}.pdf`;
  delete meta.id;
  const out = {
    id,
    ...meta,
    added: meta.added || today.toISOString().slice(0, 10),
    pdf: pdfName,
    original_filename: path.basename(pdfPath),
    sha256,
  };
  if (out.arxiv) out.arxiv = normArxiv(out.arxiv) || out.arxiv;
  fs.mkdirSync(dir, { recursive: true });
  // Copy first, write summary, then remove the source: a crash midway leaves the
  // inbox PDF in place instead of losing it.
  fs.copyFileSync(pdfPath, path.join(dir, pdfName));
  fs.writeFileSync(path.join(dir, 'summary.md'), serializeFrontmatter(out, body));
  if (path.dirname(pdfPath) === d.inbox) fs.unlinkSync(pdfPath);
  return { status: 'added', id, dir, warnings };
}

export function moveToFailed(pdfPath, log, d = dirs()) {
  const dst = uniquePath(path.join(d.failed, path.basename(pdfPath)));
  moveFile(pdfPath, dst);
  fs.writeFileSync(dst.replace(/\.pdf$/i, '.log'), log);
  return dst;
}
