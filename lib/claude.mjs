// Run headless Claude Code (`claude -p`) with streaming JSON output.
//
// Every call is tool-less by default: the model only sees what we put in the
// prompt, so text from a PDF cannot make it read files, run commands or browse.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from './library.mjs';

// When started from inside a Claude Code session (e.g. the desktop app), that
// session's CLAUDE_* variables make a child `claude` expect host-managed auth
// and it reports "Not logged in". Drop them so the child authenticates from
// the user's own settings, same as at autostart.
export function childEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^CLAUDE(CODE$|_)/.test(k)));
}

let resolved;

/** Find the claude executable. Prefer a real .exe so we can spawn without a shell. */
export function resolveClaude() {
  if (resolved) return resolved;
  const cfg = readConfig();
  if (cfg.claudePath) return (resolved = { cmd: cfg.claudePath, shell: false });
  if (process.platform === 'win32') {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!dir) continue;
      const exe = path.join(dir, 'claude.exe');
      if (fs.existsSync(exe)) return (resolved = { cmd: exe, shell: false });
      const shim = path.join(dir, 'claude.cmd');
      const native = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (fs.existsSync(shim) && fs.existsSync(native)) return (resolved = { cmd: native, shell: false });
    }
    return (resolved = { cmd: 'claude', shell: true });
  }
  return (resolved = { cmd: 'claude', shell: false });
}

const MODEL_RE = /^[\w.\-\[\]]+$/;

/**
 * @param {object} o
 * @param {string} o.prompt            user message (sent over stdin)
 * @param {string} [o.model]
 * @param {string} [o.system]          replaces Claude Code's default system prompt
 * @param {string} [o.resume]          session id to continue
 * @param {boolean} [o.persist]        keep the session on disk so it can be resumed
 * @param {string} [o.cwd]
 * @param {number} [o.timeoutMs]
 * @param {(text: string) => void} [o.onDelta]  streamed text chunks
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{text: string, sessionId: string, cost: number}>}
 */
export function runClaude({ prompt, model, system, resume, persist = false, cwd, timeoutMs = 15 * 60_000, onDelta, signal }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--tools', '', '--strict-mcp-config'];
  if (!persist) args.push('--no-session-persistence');
  if (model) {
    if (!MODEL_RE.test(model)) throw new Error(`model 名不合法: ${model}`);
    args.push('--model', model);
  }
  if (system) args.push('--system-prompt', system);
  if (resume) {
    if (!/^[0-9a-f-]{36}$/i.test(resume)) throw new Error('session id 不合法');
    args.push('--resume', resume);
  }
  const { cmd, shell } = resolveClaude();
  if (shell && system) throw new Error('找不到 claude.exe，无法安全传递 system prompt；请在 ~/.paper-vault.json 里设置 claudePath');
  const argv = shell ? args.map((a) => (a === '' ? '""' : a)) : args;

  return new Promise((resolve, reject) => {
    const child = spawn(shell ? [cmd, ...argv].join(' ') : cmd, shell ? [] : argv, {
      cwd,
      shell,
      windowsHide: true,
      env: childEnv(),
    });
    let buf = '';
    let err = '';
    let text = '';
    let streamed = '';
    let result = null;
    let sessionId = '';
    const finish = (fn) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`claude 超时（${Math.round(timeoutMs / 1000)}s）`)));
    }, timeoutMs);
    const onAbort = () => {
      child.kill();
      finish(() => reject(Object.assign(new Error('已取消'), { name: 'AbortError' })));
    };
    signal?.addEventListener('abort', onAbort);

    const handle = (line) => {
      if (!line.trim()) return;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.session_id) sessionId = ev.session_id;
      if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta') {
        streamed += ev.event.delta.text;
        onDelta?.(ev.event.delta.text);
      } else if (ev.type === 'result') {
        result = ev;
      }
    };
    child.stdout.on('data', (b) => {
      buf += b;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        handle(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on('data', (b) => (err += b));
    child.on('error', (e) => finish(() => reject(e)));
    child.on('close', (code) => {
      handle(buf);
      if (signal?.aborted) return;
      finish(() => {
        if (!result || result.is_error || code !== 0) {
          const why = result?.result || err.slice(0, 2000) || `退出码 ${code}`;
          reject(new Error(`claude 调用失败: ${why}`));
          return;
        }
        text = typeof result.result === 'string' && result.result ? result.result : streamed;
        resolve({ text, sessionId: result.session_id || sessionId, cost: result.total_cost_usd ?? 0, usage: result.usage });
      });
    });
    child.stdin.end(prompt);
  });
}

/** Limit how many claude processes run at once. */
export function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}
