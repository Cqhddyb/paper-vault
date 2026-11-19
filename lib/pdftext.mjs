// PDF -> plain text with pdfjs-dist, one "=== 第 N 页 ===" marker per page.
// The text goes to Claude instead of the PDF itself: some API gateways reject
// PDF document blocks, and text is cheaper than page images anyway.

import fs from 'node:fs';

export async function extractText(pdfPath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const task = pdfjs.getDocument({ data, useSystemFonts: true, disableFontFace: true, isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str;
        text += item.hasEOL ? '\n' : item.str && !item.str.endsWith(' ') ? ' ' : '';
      }
      pages.push(text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  const info = { pages: pages.length, chars: pages.reduce((s, p) => s + p.length, 0) };
  const text = pages.map((p, i) => `=== 第 ${i + 1} 页 ===\n${p}`).join('\n\n') + '\n';
  return { text, ...info };
}
