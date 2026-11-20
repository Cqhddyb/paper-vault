// Run PDF text/layout extraction on a worker thread.
//
// pdfjs parses on the calling thread in Node, and a long paper can take a few
// seconds; in `pv serve` that would freeze the assistant's web server while the
// watcher summarizes a new paper. One background worker handles requests in
// order; it is unref'd so it never keeps a short CLI command alive.

import { Worker, isMainThread, parentPort } from 'node:worker_threads';

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL(import.meta.url));
  worker.unref();
  worker.on('message', ({ id, ok, value, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (pending.size === 0) worker.unref();
    ok ? p.resolve(value) : p.reject(new Error(error));
  });
  worker.on('error', (e) => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
    worker = null;
  });
  worker.on('exit', () => {
    worker = null;
  });
  return worker;
}

function call(kind, pdfPath) {
  const w = getWorker();
  w.ref(); // keep the process alive while a request is outstanding
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, kind, pdfPath });
  });
}

/** Same result as pdftext.extractText, computed off the main thread. */
export const extractTextOff = (pdfPath) => call('text', pdfPath);
/** Same result as layout.extractLayout, computed off the main thread. */
export const extractLayoutOff = (pdfPath) => call('layout', pdfPath);

if (!isMainThread) {
  const { extractText } = await import('./pdftext.mjs');
  const { extractLayout } = await import('./layout.mjs');
  parentPort.on('message', async ({ id, kind, pdfPath }) => {
    try {
      const value = kind === 'text' ? await extractText(pdfPath) : await extractLayout(pdfPath);
      parentPort.postMessage({ id, ok: true, value });
    } catch (e) {
      parentPort.postMessage({ id, ok: false, error: String(e?.message ?? e) });
    }
  });
}
