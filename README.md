# paper-vault

本地论文库 + Claude Code 插件。

- **自动总结入库**：把论文 PDF 丢进 `inbox/`，后台 watcher 会抽出全文，交给 Claude 写一份中文总结（动机、方法、结果、用到的模型与数据、局限），然后和 PDF 一起归档。
- **凭细节找论文**：不用记标题。“我记得有篇用了 Qwen 的 VLA”“在 LIBERO 上测过、用 LoRA 微调”这类描述就能找到。
- **查相关工作**：说出你要做的事，先查本地库，再上网补充库里没有的论文，并标出最值得读的几篇。
- **论文小助手**（Ctrl+Alt+P 随时调出）：用一句描述调出论文，确定是哪篇就直接打开，不确定就列出候选让你点选；左边讲解论文、可以追问，右边是 PDF 原文与中文逐段对照，选中原文任意一段还能单独翻译。

论文 PDF 和总结只放在本地论文库目录里，不会进这个仓库。

## 安装

需要 Node.js ≥ 22.13 和已登录的 Claude Code（`claude` 在 PATH 上）。

```bash
git clone <本仓库> D:/paper-vault
cd D:/paper-vault
npm install
node bin/pv.mjs init D:/Papers          # 建论文库，配置写到 ~/.paper-vault.json
node bin/pv.mjs link                    # 作为 Claude Code 插件加载（~/.claude/skills/paper-vault 链接到本仓库）
node bin/pv.mjs autostart install       # 登录 Windows 时自动在后台运行（inbox watcher + 小助手服务）
wscript "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\paper-vault-watch.vbs"   # 现在就启动
node bin/pv.mjs assistant install       # 开始菜单快捷方式 + 全局快捷键 Ctrl+Alt+P（--hotkey 可改）
```

建议在 `~/.claude/settings.json` 的 `permissions.allow` 里加上下面两条，插件调用 CLI 时就不会每次都弹权限确认：

```json
"Bash(node C:/Users/<你>/.claude/skills/paper-vault/bin/pv.mjs:*)",
"PowerShell(node C:/Users/<你>/.claude/skills/paper-vault/bin/pv.mjs:*)"
```

## 日常使用

| 想做的事 | 怎么做 |
|---|---|
| 新论文入库 | 把 PDF 放进 `D:/Papers/inbox/`，约 1 分钟后出现在 `papers/` 里 |
| 手动入库（watcher 没开，或 PDF 在别处） | Claude Code 里 `/paper-vault:add [pdf 路径]` |
| 凭记忆找论文 | `/paper-vault:search 我记得有篇用 PaliGemma 的，能收桌子` |
| 查相关工作 | `/paper-vault:related 我想用世界模型给 VLA 做数据增强` |
| 命令行快速检索 | `node bin/pv.mjs search "Qwen LIBERO"` |
| 打开小助手读论文 | 按 **Ctrl+Alt+P**；或 Claude Code 里 `/paper-vault:open 那篇用 Qwen 的 VLA`；或 `node bin/pv.mjs open "描述"` |

插件的 skill 也会被自动触发：在任何 Claude Code 会话里说“论文库里有没有……”“帮我找相关工作”即可。

## 论文库目录

```
D:/Papers/
  inbox/                       放 PDF 的地方
    _failed/                   总结失败的 PDF + .log（修好后挪回 inbox 重试）
    _duplicates/               库里已有的 PDF
  papers/<id>/
    <id>.pdf                   例：2024-kim-openvla-open-source-vision.pdf
    summary.md                 YAML frontmatter + 中文总结
    .reader/                   小助手缓存：段落版面、逐页译文、讲解对话（删掉会重新生成）
  .staging/                    草稿、watch.log、watcher 锁
```

`summary.md` 是普通 Markdown，可以直接手改（比如补一行自己的笔记），检索每次都现读这些文件，不需要重建索引。Obsidian 等工具也能直接打开这个目录。

frontmatter 字段：`title authors year venue arxiv doi url tags models datasets methods tldr added pdf original_filename`。

## 工作原理

- **watcher**（`pv watch`）每 5 秒扫一次 `inbox/`。文件大小稳定后，用 pdfjs 抽出全文，连同 `prompts/summarize.md` 的写作要求一起交给 `claude -p`（默认 Sonnet，一篇约 40 秒、$0.04）。Claude 只拿到文字，**不开放任何工具**，所以 PDF 里藏的提示词注入没法让它读写文件或联网。总结校验通过后，PDF 和总结一起归档，同一篇论文（arXiv 号 / DOI / 标题相同）不会重复入库。
- 送 Claude 的是抽出的文字而不是 PDF 本身：有的 API 网关不支持 PDF 文档块，文字也更便宜。扫描版 PDF 抽不出字，会进 `_failed/`。
- **检索**（`pv search`）是 BM25：标题、模型、数据集、方法这些字段权重更高。中文按字的二元组切分，模型名会拆开（`Qwen2.5-VL` 也能被 `qwen`、`vl` 命中）。插件的 search skill 会把你的描述改写成多组关键词（中英文、模型名变体），再读候选论文的总结确认是否对得上。

## 论文小助手

一个本地网页（`http://127.0.0.1:7788`），由后台的 `pv serve` 提供，用 Edge 的应用窗口打开。

- **找论文**：先用关键词检索立刻给出初步列表，再让 Claude（默认 Haiku）读整个论文目录、按你的描述细筛并给出理由。能确定就直接打开第一篇。
- **讲解**：打开论文时自动讲解一次（默认 Sonnet，把总结和全文一起给它），之后可以追问；回答里的“第 N 页”可以点击跳转。对话保存在 `.reader/chat.json`，再次打开不会重新讲解；点“重新讲解”才会重来。
- **中英对照**：服务端用 pdfjs 把每页切成段落（处理双栏、去掉图表碎片、识别参考文献），滚动到哪页就翻译哪页（默认 Haiku，一页约 $0.001，首段 3-5 秒出现，之后逐段流式显示），并预取下一页。译文按原段落的高度排在页面右侧，鼠标移到译文上会在原文里高亮对应段落。译文缓存在 `.reader/`，下次打开直接显示。三种显示方式：对照 / 原文 / 译文。
- **划词翻译**：在原文里选中文字，点“翻译选中文字”。
- **费用参考**：讲解一篇约 $0.1-0.3（取决于论文长度）；追问时如果距上次超过几分钟，缓存过期，会重新读一遍全文，单次约 $0.2。想省钱可以把 `chatModel` 改成 `haiku`。
- **安全**：服务只监听本机；校验 Host 头、拒绝跨站请求、POST 需要自定义请求头，别的网页没法调用它。论文文字都在不开工具的 Claude 会话里处理。

## 配置（`~/.paper-vault.json`）

```json
{
  "library": "D:\\Papers",
  "model": "sonnet",
  "timeoutMinutes": 15,
  "chatModel": "sonnet",
  "translateModel": "haiku",
  "findModel": "haiku",
  "port": 7788,
  "hotkey": "Ctrl+Alt+P"
}
```

`model`（入库总结）、`chatModel`（讲解）、`translateModel`（翻译）、`findModel`（找论文）都可以是 `sonnet`、`opus`、`haiku` 或完整模型 ID；除 `library` 外都可省略。改了 `port` 或 `hotkey` 要重新运行 `pv assistant install`。临时换库可以设环境变量 `PAPER_VAULT_DIR`。

## CLI

```
node bin/pv.mjs help
```

`init where inbox ingest check list catalog search show text prompt watch serve open assistant link autostart`

## 开发

```bash
npm test
```
