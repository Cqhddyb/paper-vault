// Fetch via the system proxy when a direct connection fails.
//
// Some sites (e.g. Google's) are only reachable through the proxy configured in
// Windows' Internet Settings, which Node's fetch ignores. Routing everything
// through the proxy would hurt other services (shared proxy IPs get
// rate-limited), so callers try a direct fetch first and fall back to curl.exe
// with the proxy.

import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from './library.mjs';

let cached;

/** Proxy URL from config, environment, or Windows Internet Settings; null if none. */
export function systemProxy() {
  if (cached !== undefined) return cached;
  const cfg = readConfig();
  let p = cfg.proxy ?? process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? null;
  if (!p && process.platform === 'win32') {
    const r = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { encoding: 'utf8', windowsHide: true });
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(r.stdout ?? '');
    const server = (r.stdout ?? '').match(/ProxyServer\s+REG_SZ\s+(\S+)/i)?.[1];
    if (enabled && server) {
      // "host:port" or "http=host:port;https=host:port"
      const https = server.match(/https=([^;]+)/i)?.[1] ?? server.match(/http=([^;]+)/i)?.[1] ?? (server.includes('=') ? null : server);
      if (https) p = /^https?:\/\//.test(https) ? https : `http://${https}`;
    }
  }
  cached = p && /^https?:\/\/[\w.\-]+(:\d+)?\/?$/i.test(p) ? p : null;
  return cached;
}

/**
 * GET through curl.exe with the proxy. Resolves to a minimal Response-like
 * object: { ok, status, url, headers: { get }, arrayBuffer() }.
 */
export function curlFetch(url, { proxy = systemProxy(), maxBytes = 6 * 1024 * 1024, timeoutSec = 40, userAgent } = {}) {
  if (!proxy) return Promise.reject(new Error('没有可用的代理'));
  const out = path.join(os.tmpdir(), `pv-curl-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const args = ['-sS', '-L', '--max-redirs', '5', '--proto', '=https', '--proto-redir', '=https', '--max-time', String(timeoutSec), '--max-filesize', String(maxBytes), '--proxy', proxy, '-o', out, '-w', '%{http_code}\t%{content_type}\t%{url_effective}'];
  if (userAgent) args.push('-A', userAgent);
  args.push('--', url);
  return new Promise((resolve, reject) => {
    execFile('curl.exe', args, { windowsHide: true, timeout: (timeoutSec + 10) * 1000 }, (err, stdout, stderr) => {
      let body = Buffer.alloc(0);
      try {
        body = fs.readFileSync(out);
      } catch {
        /* no body */
      }
      fs.rm(out, { force: true }, () => {});
      if (err) return reject(new Error(`代理抓取失败：${String(stderr || err.message).trim().slice(0, 200)}`));
      const [code, type, finalUrl] = String(stdout).split('\t');
      const status = Number(code);
      resolve({
        ok: status >= 200 && status < 300,
        status,
        url: finalUrl || url,
        headers: { get: (h) => (h.toLowerCase() === 'content-type' ? type || null : null) },
        arrayBuffer: async () => body,
      });
    });
  });
}

/** fetch() first; on a network-level failure retry through the system proxy. */
export async function fetchWithProxyFallback(url, opts = {}, { fetchImpl = fetch, maxBytes } = {}) {
  try {
    return await fetchImpl(url, opts);
  } catch (e) {
    if (!systemProxy()) throw e;
    return curlFetch(url, { maxBytes, userAgent: opts.headers?.['user-agent'] });
  }
}
