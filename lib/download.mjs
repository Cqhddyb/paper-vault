// Download a paper PDF into the library inbox, where the watcher summarizes and
// files it. Only arXiv papers and direct https links to PDFs; never local or
// private-network addresses; the file must really be a PDF and not too large.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { dirs, loadPapers, normArxiv } from './library.mjs';

const MAX_BYTES = 80 * 1024 * 1024;

export function isPublicHttpsUrl(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const h = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.') && !net.isIP(h)) return false;
  if (net.isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false;
  }
  if (net.isIPv6(h)) return false; // keep it simple: no raw IPv6 hosts
  return true;
}

function safeName(s) {
  return String(s).normalize('NFKD').replace(/[^\w.\- ]+/g, ' ').trim().replace(/\s+/g, '_').slice(0, 80) || 'paper';
}

function uniqueInbox(inbox, name) {
  let p = path.join(inbox, name);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(inbox, name.replace(/\.pdf$/i, `_${i}.pdf`));
  return p;
}

/**
 * @param {{arxiv?: string, url?: string, title?: string}} req
 * @returns {Promise<{status: 'queued'|'exists', file?: string, id?: string}>}
 */
export async function downloadToInbox(req, { d = dirs(), fetchImpl = fetch } = {}) {
  const arxiv = normArxiv(req.arxiv);
  if (arxiv) {
    const have = loadPapers(d).find((p) => normArxiv(p.meta.arxiv) === arxiv);
    if (have) return { status: 'exists', id: have.meta.id };
  }
  const url = arxiv ? `https://arxiv.org/pdf/${arxiv}` : String(req.url ?? '');
  if (!isPublicHttpsUrl(url)) throw new Error('只能下载公网 https 链接或 arXiv 论文');
  const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(90_000), headers: { accept: 'application/pdf' } });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  if (res.url && !isPublicHttpsUrl(res.url)) throw new Error('下载链接跳转到了不允许的地址');
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error('文件太大');
  const chunks = [];
  let size = 0;
  for await (const c of res.body) {
    size += c.length;
    if (size > MAX_BYTES) throw new Error('文件太大');
    chunks.push(c);
  }
  const buf = Buffer.concat(chunks);
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('链接指向的不是 PDF（可能是网页），请在浏览器里打开手动下载');
  fs.mkdirSync(d.inbox, { recursive: true });
  const name = arxiv ? `${arxiv.replace('/', '_')}.pdf` : `${safeName(req.title || path.basename(new URL(url).pathname, '.pdf'))}.pdf`;
  const file = uniqueInbox(d.inbox, name);
  // Write under a temporary name first so the watcher never sees half a file.
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  return { status: 'queued', file: path.basename(file) };
}
