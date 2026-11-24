#!/usr/bin/env node
// paper-vault command line. Run `node pv.mjs help` for usage.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_PATH, UserError, dirs, ensureLayout, ingest, listInbox, loadPapers,
  readConfig, validateSummary, writeConfig,
} from '../lib/library.mjs';
import { buildIndex, search } from '../lib/search.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const HELP = `paper-vault — 本地论文库

用法: node pv.mjs <命令> [参数]

  init <目录>               创建论文库并写入配置 (${CONFIG_PATH})
  where                     打印论文库目录、配置和各子目录
  inbox                     列出 inbox 里待处理的 PDF
  ingest <pdf> <总结.md>    校验总结并把 PDF+总结归档入库（inbox 里的 PDF 会被移走）
  check <总结.md>           只校验总结格式，不入库
  list [--json]             列出全部论文
  catalog                   每篇一行的紧凑目录（给 agent 通读用）
  search <描述> [--top N] [--json]
                            按描述检索（标题/模型/数据集/方法/正文）
  show <id>                 打印某篇论文的总结
  text <pdf>                抽取 PDF 文字到 .staging/<名>.txt（给 agent 读）
  prompt <pdf>              打印总结写作要求（不含论文文字）
  watch [--once]            监听 inbox，自动总结入库（--once 处理完现有文件就退出）
  serve                     后台服务：论文小助手网页 + inbox 监听（开机自启运行的就是它）
  open [描述]               打开论文小助手窗口（带描述时直接检索）
  assistant install [--hotkey Ctrl+Alt+P] | remove | status
                            开始菜单快捷方式 + 全局快捷键调出论文小助手
  link [remove]             把本仓库链接到 ~/.claude/skills，作为 Claude Code 插件加载
  autostart install|remove|status
                            开机自动运行 watcher（Windows 启动文件夹）
`;

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

function opt(args, name, dflt) {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

const list = (v) => (Array.isArray(v) ? v.join(', ') : v ?? '');

function paperRow(p) {
  const m = p.meta;
  return {
    id: m.id,
    title: m.title,
    year: m.year,
    venue: m.venue,
    authors: m.authors,
    models: m.models,
    datasets: m.datasets,
    tags: m.tags,
    tldr: m.tldr,
    summary: p.summaryPath,
    pdf: p.pdfPath,
  };
}

const startupDir = () => path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const startupFile = () => path.join(startupDir(), 'paper-vault-watch.vbs');

const commands = {
  help() {
    console.log(HELP);
  },

  init(args) {
    const dir = args[0];
    if (!dir) throw new UserError('用法: init <目录>');
    const root = path.resolve(dir);
    ensureLayout(root);
    writeConfig({ ...readConfig(), library: root });
    console.log(`论文库: ${root}\n配置: ${CONFIG_PATH}\n把 PDF 放进 ${path.join(root, 'inbox')} 即可。`);
  },

  where() {
    const d = dirs();
    console.log(JSON.stringify({ config: CONFIG_PATH, ...d, cli: path.join(HERE, 'pv.mjs'), prompt: path.join(HERE, '..', 'prompts', 'summarize.md') }, null, 2));
  },

  inbox() {
    const files = listInbox();
    console.log(files.length ? files.join('\n') : '(inbox 为空)');
  },

  check(args) {
    if (!args[0]) throw new UserError('用法: check <总结.md>');
    return import('../lib/frontmatter.mjs').then(({ parseFrontmatter }) => {
      const { meta, body, hasFrontmatter } = parseFrontmatter(fs.readFileSync(args[0], 'utf8'));
      if (!hasFrontmatter) throw new UserError('没有 YAML frontmatter');
      const r = validateSummary(meta, body);
      console.log(JSON.stringify({ ok: !r.errors.length, ...r, parsed: meta }, null, 2));
      if (r.errors.length) process.exitCode = 1;
    });
  },

  ingest(args) {
    const [pdf, summary] = args;
    if (!pdf || !summary) throw new UserError('用法: ingest <pdf> <总结.md>');
    const r = ingest(pdf, fs.readFileSync(summary, 'utf8'), { d: ensureLayout(dirs().root) });
    if (r.status === 'added') fs.unlinkSync(summary);
    console.log(JSON.stringify(r, null, 2));
    if (r.status === 'duplicate') process.exitCode = 3;
  },

  list(args) {
    const json = flag(args, '--json');
    const papers = loadPapers().sort((a, b) => String(b.meta.added).localeCompare(String(a.meta.added)));
    if (json) return console.log(JSON.stringify(papers.map(paperRow), null, 2));
    for (const p of papers) console.log(`${p.meta.id}  ${p.meta.title}`);
    console.log(`共 ${papers.length} 篇`);
  },

  catalog() {
    for (const p of loadPapers()) {
      const m = p.meta;
      console.log(`${m.id} | ${m.title} | ${m.year ?? ''} ${m.venue ?? ''} | models: ${list(m.models)} | data: ${list(m.datasets)} | tags: ${list(m.tags)} | ${m.tldr ?? ''}`);
    }
  },

  search(args) {
    const json = flag(args, '--json');
    const top = Number(opt(args, '--top', 15));
    const query = args.join(' ').trim();
    if (!query) throw new UserError('用法: search <描述>');
    const hits = search(buildIndex(loadPapers()), query, { top });
    if (json) return console.log(JSON.stringify(hits.map((h) => ({ score: +h.score.toFixed(2), hits: h.hits, ...paperRow(h.paper) })), null, 2));
    if (!hits.length) return console.log('(没有命中)');
    for (const h of hits) {
      const m = h.paper.meta;
      console.log(`${h.score.toFixed(1).padStart(6)}  ${m.id}\n        ${m.title}\n        ${m.tldr ?? ''}\n        命中: ${h.hits.slice(0, 12).join(' ')}`);
    }
  },

  show(args) {
    const id = args[0];
    const p = loadPapers().find((x) => x.meta.id === id) ?? loadPapers().find((x) => x.meta.id.startsWith(id ?? '\0'));
    if (!p) throw new UserError(`没有 id 为 ${id} 的论文`);
    console.log(`# ${p.summaryPath}\n# PDF: ${p.pdfPath}\n`);
    console.log(fs.readFileSync(p.summaryPath, 'utf8'));
  },

  async text(args) {
    if (!args[0]) throw new UserError('用法: text <pdf>');
    const pdf = path.resolve(args[0]);
    const { extractText } = await import('../lib/pdftext.mjs');
    const r = await extractText(pdf);
    const d = ensureLayout(dirs().root);
    const out = path.join(d.staging, path.basename(pdf).replace(/\.pdf$/i, '') + '.txt');
    fs.writeFileSync(out, r.text);
    console.log(JSON.stringify({ text: out, pages: r.pages, chars: r.chars, scanned: r.chars < 2000 }, null, 2));
  },

  async prompt(args) {
    if (!args[0]) throw new UserError('用法: prompt <pdf>');
    const { summarizeInstructions } = await import('../lib/watch.mjs');
    console.log(summarizeInstructions(path.resolve(args[0])));
  },

  async watch(args) {
    const { watch } = await import('../lib/watch.mjs');
    await watch({ once: flag(args, '--once') });
  },

  async serve(args) {
    // One background process for everything: the assistant web server plus
    // the inbox watcher (the watcher exits quietly if another one holds the lock).
    const d = ensureLayout(dirs().root);
    const log = (msg) => {
      const line = `[${new Date().toISOString()}] ${msg}`;
      console.log(line);
      fs.appendFileSync(path.join(d.staging, 'watch.log'), line + '\n');
    };

    // Supervisor: run the real service as a child and restart it if it crashes,
    // so one unexpected error does not stop the inbox and the assistant until
    // the next login. Exit code 0 (e.g. "already running") is not restarted.
    if (!process.env.PV_SERVE_CHILD && !flag(args, '--no-supervisor')) {
      const { spawn } = await import('node:child_process');
      const crashes = [];
      for (;;) {
        const code = await new Promise((resolve) => {
          const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], { env: { ...process.env, PV_SERVE_CHILD: '1' }, stdio: 'ignore', windowsHide: true });
          child.on('exit', (c) => resolve(c ?? 1));
        });
        if (code === 0) return;
        const now = Date.now();
        crashes.push(now);
        while (crashes.length && now - crashes[0] > 10 * 60_000) crashes.shift();
        if (crashes.length > 5) {
          log('服务 10 分钟内崩溃超过 5 次，不再自动重启；请看上面的错误信息');
          process.exit(1);
        }
        log(`服务意外退出（退出码 ${code}），5 秒后自动重启`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    // Record why we die, so a crash can be diagnosed from watch.log.
    process.on('uncaughtException', (e) => {
      try {
        log(`未捕获的错误，服务将重启：${e?.stack ?? e}`);
      } finally {
        process.exit(1);
      }
    });
    process.on('unhandledRejection', (e) => log(`未处理的 Promise 错误（服务继续运行）：${e?.stack ?? e}`));

    const { startServer } = await import('../lib/server.mjs');
    const desktop = await import('../lib/desktop.mjs');
    // Port first: a second `serve` must not start a second hotkey helper.
    let send = null;
    const windowControl = { send: (cmd) => (send ? send(cmd) : false), open: desktop.openWindow };
    let broadcast;
    try {
      const started = await startServer({ windowControl });
      broadcast = started.broadcast;
      log(`论文小助手: ${started.url}`);
    } catch (e) {
      if (e.code === 'EADDRINUSE') {
        console.log('论文小助手已在运行。');
        return;
      }
      throw e;
    }
    send = desktop.startWindowHelper({ log });
    const { watch } = await import('../lib/watch.mjs');
    await watch({ onEvent: (e) => broadcast('library', e) });
  },

  async open(args) {
    const { ensureServer, baseUrl } = await import('../lib/desktop.mjs');
    if (!(await ensureServer())) throw new UserError('论文小助手没能启动，运行 node pv.mjs serve 看报错');
    const q = args.join(' ').trim();
    // Reuse the open window when there is one (the search runs there); otherwise a new one opens.
    const r = await fetch(baseUrl() + 'api/window', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pv': '1' },
      body: JSON.stringify({ action: 'show', ...(q ? { q } : {}) }),
    }).then((x) => x.json());
    console.log(JSON.stringify(r));
  },

  async assistant(args) {
    const d = await import('../lib/desktop.mjs');
    const sub = args[0] ?? 'status';
    if (sub === 'install') {
      const hotkey = opt(args, '--hotkey', undefined);
      if (hotkey) writeConfig({ ...readConfig(), hotkey });
      const r = d.installAssistant(hotkey);
      console.log(`已创建开始菜单快捷方式: ${r.shortcut}\n快捷键: ${r.hotkey}（由后台服务注册：按一下呼出，窗口在前台时再按一下隐藏；改了快捷键要重启服务）\n启动脚本: ${r.launcher}`);
    } else if (sub === 'remove') {
      d.removeAssistant();
      console.log('已删除快捷方式和启动脚本。');
    } else {
      console.log(JSON.stringify({ url: d.baseUrl(), running: await d.isUp(), shortcut: fs.existsSync(d.shortcutFile()) ? d.shortcutFile() : null, hotkey: readConfig().hotkey ?? 'Ctrl+Alt+P' }, null, 2));
    }
  },

  link(args) {
    // Expose this checkout to Claude Code as a skills-dir plugin. A junction
    // (no admin rights needed on Windows) keeps node_modules next to the skills.
    const target = path.join(os.homedir(), '.claude', 'skills', 'paper-vault');
    const repo = path.resolve(HERE, '..');
    if (args[0] === 'remove') {
      if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) fs.unlinkSync(target);
      return console.log(`已移除 ${target}`);
    }
    if (fs.existsSync(target)) {
      const real = fs.realpathSync(target);
      if (path.resolve(real) === repo) return console.log(`已链接: ${target} -> ${repo}`);
      throw new UserError(`${target} 已存在且指向 ${real}，请先手动处理`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(repo, target, 'junction');
    console.log(`已链接: ${target} -> ${repo}\n新开的 Claude Code 会话里即可使用 /paper-vault:add、/paper-vault:search、/paper-vault:related`);
  },

  async autostart(args) {
    const sub = args[0] ?? 'status';
    const file = startupFile();
    if (sub === 'install') {
      dirs(); // fail early if the library is not configured
      // Runs `pv serve` hidden (window style 0): inbox watcher + assistant server.
      const { autostartVbs } = await import('../lib/desktop.mjs');
      fs.writeFileSync(file, autostartVbs());
      console.log(`已写入 ${file}\n下次登录自动运行。现在就启动可执行: wscript "${file}"`);
    } else if (sub === 'remove') {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      console.log(`已删除 ${file}（正在运行的 watcher 不受影响）`);
    } else {
      const lock = path.join(dirs().staging, 'watch.lock');
      console.log(JSON.stringify({ autostart: fs.existsSync(file) ? file : null, watcherPid: fs.existsSync(lock) ? fs.readFileSync(lock, 'utf8') : null }, null, 2));
    }
  },
};

const [cmd = 'help', ...rest] = process.argv.slice(2);
const fn = commands[cmd];
if (!fn) {
  console.error(`未知命令: ${cmd}\n\n${HELP}`);
  process.exit(2);
}
try {
  await fn(rest);
} catch (e) {
  if (e instanceof UserError) {
    console.error('错误: ' + e.message);
    process.exit(1);
  }
  throw e;
}
