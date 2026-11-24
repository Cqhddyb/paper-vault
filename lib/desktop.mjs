// Windows desktop integration: open the assistant in an app-style window, a
// Start-menu shortcut with a global hotkey, and the login autostart entry.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from './library.mjs';
import { DEFAULT_PORT } from './server.mjs';
import { childEnv } from './claude.mjs';

const PV = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'pv.mjs');
const appData = () => process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
const localAppData = () => process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');

export const port = () => readConfig().port ?? DEFAULT_PORT;
export const baseUrl = () => `http://127.0.0.1:${port()}/`;
export const startupFile = () => path.join(appData(), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'paper-vault-watch.vbs');
export const shortcutFile = () => path.join(appData(), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Paper Vault 论文小助手.lnk');
export const launcherFile = () => path.join(localAppData(), 'paper-vault', 'assistant.vbs');

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
export const edgePath = () => EDGE.find((p) => fs.existsSync(p)) ?? null;

export async function isUp() {
  try {
    const r = await fetch(baseUrl() + 'api/ping', { signal: AbortSignal.timeout(800) });
    return r.ok && (await r.json()).app === 'paper-vault';
  } catch {
    return false;
  }
}

export async function ensureServer() {
  if (await isUp()) return true;
  spawn(process.execPath, [PV, 'serve'], { detached: true, stdio: 'ignore', windowsHide: true, env: childEnv() }).unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await isUp()) return true;
  }
  return false;
}

export function openWindow(url) {
  const edge = edgePath();
  if (edge) spawn(edge, [`--app=${url}`, '--window-size=1600,1000'], { detached: true, stdio: 'ignore' }).unref();
  else spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// ---- global hotkey + show/hide helper ------------------------------------------

const MODS = { ctrl: 2, control: 2, alt: 1, shift: 4, win: 8 };

/** "Ctrl+Alt+P" -> { mods, vk } for RegisterHotKey. */
export function parseHotkey(s) {
  const parts = String(s).split('+').map((x) => x.trim().toLowerCase()).filter(Boolean);
  let mods = 0;
  let vk = 0;
  for (const p of parts) {
    if (p in MODS) mods |= MODS[p];
    else if (/^[a-z0-9]$/.test(p)) vk = p.toUpperCase().charCodeAt(0);
    else if (/^f([1-9]|1[0-2])$/.test(p)) vk = 0x6f + Number(p.slice(1));
    else if (p === 'space') vk = 0x20;
    else if (p === '`' || p === 'backquote') vk = 0xc0;
    else throw new Error(`不认识的按键: ${p}`);
  }
  if (!vk || !mods) throw new Error(`快捷键需要至少一个修饰键加一个按键: ${s}`);
  return { mods, vk };
}

/**
 * Start the window helper (Windows only). Returns a function that sends it a
 * command ('show' | 'hide' | 'toggle') and reports whether it is running.
 */
export function startWindowHelper({ log = () => {} } = {}) {
  if (process.platform !== 'win32') return null;
  const cfg = readConfig();
  let hk;
  try {
    hk = parseHotkey(cfg.hotkey ?? 'Ctrl+Alt+P');
  } catch (e) {
    log(`快捷键配置有误：${e.message}`);
    return null;
  }
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'winctl.ps1');
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-Edge', edgePath() ?? '', '-Url', baseUrl(), '-Mods', String(hk.mods), '-Vk', String(hk.vk)],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  let alive = true;
  child.stdout.setEncoding('utf8').on('data', (s) => {
    for (const line of s.split(/\r?\n/).filter(Boolean)) {
      if (line === 'ready') log(`快捷键 ${cfg.hotkey ?? 'Ctrl+Alt+P'} 已注册：按一下呼出论文小助手，在前台时再按一下隐藏`);
      else if (line === 'hotkey-failed') log(`快捷键 ${cfg.hotkey ?? 'Ctrl+Alt+P'} 注册失败（可能被别的程序占用），可在 ~/.paper-vault.json 里换一个 hotkey`);
      else if (line.startsWith('error')) log(`窗口助手：${line}`);
    }
  });
  child.stderr.setEncoding('utf8').on('data', (s) => log(`窗口助手出错：${s.trim().slice(0, 300)}`));
  child.stdin.on('error', () => {}); // helper already gone: ignore, the exit handler logs it
  child.on('exit', (code) => {
    alive = false;
    log(`窗口助手已退出（${code}）`);
  });
  return (cmd) => {
    if (!alive) return false;
    child.stdin.write(cmd + '\n');
    return true;
  };
}

// Both VBS files must stay pure ASCII: wscript reads them in the ANSI code page.
const vq = (s) => `""${s}""`;

export function launcherVbs() {
  const edge = edgePath();
  const url = baseUrl();
  return [
    "' Paper Vault assistant launcher (generated by `pv assistant install`)",
    'Option Explicit',
    'Dim sh, i',
    'Set sh = CreateObject("WScript.Shell")',
    'If Not Alive() Then',
    `  sh.Run "${vq(process.execPath)} ${vq(PV)} serve", 0, False`,
    '  For i = 1 To 60',
    '    WScript.Sleep 250',
    '    If Alive() Then Exit For',
    '  Next',
    'End If',
    "' The server's window helper shows (or opens) the window; fall back to doing it here.",
    'For i = 1 To 12',
    '  If ShowViaServer() Then WScript.Quit',
    '  WScript.Sleep 250',
    'Next',
    'If sh.AppActivate("Paper Vault") Then WScript.Quit',
    edge ? `sh.Run "${vq(edge)} --app=${url} --window-size=1600,1000", 1, False` : `sh.Run "${url}", 1, False`,
    '',
    'Function ShowViaServer()',
    '  Dim x',
    '  On Error Resume Next',
    '  Set x = CreateObject("MSXML2.ServerXMLHTTP.6.0")',
    '  x.setTimeouts 500, 500, 1500, 1500',
    `  x.Open "POST", "${url}api/window", False`,
    '  x.setRequestHeader "content-type", "application/json"',
    '  x.setRequestHeader "x-pv", "1"',
    '  x.Send "{""action"":""show""}"',
    '  ShowViaServer = (Err.Number = 0 And x.Status = 200 And InStr(x.responseText, """ok"":true") > 0)',
    'End Function',
    '',
    'Function Alive()',
    '  Dim x',
    '  On Error Resume Next',
    '  Set x = CreateObject("MSXML2.ServerXMLHTTP.6.0")',
    '  x.setTimeouts 500, 500, 800, 800',
    `  x.Open "GET", "${url}api/ping", False`,
    '  x.Send',
    '  Alive = (Err.Number = 0 And x.Status = 200)',
    'End Function',
    '',
  ].join('\r\n');
}

export function autostartVbs() {
  return `' paper-vault: inbox watcher + assistant server - delete this file to stop autostart\r\nCreateObject("WScript.Shell").Run "${vq(process.execPath)} ${vq(PV)} serve", 0, False\r\n`;
}

function powershell(script) {
  const enc = Buffer.from(script, 'utf16le').toString('base64');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`PowerShell 失败: ${r.stderr || r.stdout}`);
  return r.stdout;
}

const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

// The hotkey itself is registered by the window helper that `pv serve` runs
// (so it can also hide the window); the Start-menu shortcut gets no hotkey,
// otherwise Explorer would grab the same key combination first.
export function installAssistant(hotkey = readConfig().hotkey ?? 'Ctrl+Alt+P') {
  parseHotkey(hotkey); // validate
  const vbs = launcherFile();
  fs.mkdirSync(path.dirname(vbs), { recursive: true });
  fs.writeFileSync(vbs, launcherVbs());
  const lnk = shortcutFile();
  const icon = edgePath();
  powershell(
    [
      '$sh = New-Object -ComObject WScript.Shell',
      `$s = $sh.CreateShortcut(${psq(lnk)})`,
      `$s.TargetPath = ${psq(path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'wscript.exe'))}`,
      `$s.Arguments = ${psq(`"${vbs}"`)}`,
      "$s.Hotkey = ''",
      `$s.Description = ${psq('Paper Vault 论文小助手：找论文、讲解、中英对照阅读')}`,
      icon ? `$s.IconLocation = ${psq(icon + ',0')}` : '',
      '$s.Save()',
    ].filter(Boolean).join('; '),
  );
  return { launcher: vbs, shortcut: lnk, hotkey };
}

export function removeAssistant() {
  for (const f of [shortcutFile(), launcherFile()]) if (fs.existsSync(f)) fs.unlinkSync(f);
}
