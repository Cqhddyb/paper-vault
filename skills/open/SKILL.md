---
name: open
description: 打开论文小助手窗口（paper-vault 的阅读界面：讲解论文 + PDF 中英对照）。用户说“打开论文小助手”“我要读那篇 xxx 论文”“把那篇用了 xxx 的论文打开给我看”“中英对照看一下这篇论文”时使用。参数是对论文的描述，可以为空。
argument-hint: "[对论文的描述]"
---

# 打开论文小助手

CLI：`node "${CLAUDE_SKILL_DIR}/../../bin/pv.mjs"`（下文记作 `pv`）。如果 `${CLAUDE_SKILL_DIR}` 没有被替换成真实路径，就用本 skill 所在目录往上两级的 `bin/pv.mjs`。

用户的描述：$ARGUMENTS

运行 `pv open "<描述>"`（没有描述就只运行 `pv open`）。它会在需要时启动后台服务，并打开一个 Edge 应用窗口；带描述时窗口会自动检索：能确定是哪篇就直接打开并开始讲解，不确定就列出候选让用户点选。

告诉用户窗口已经打开，以及之后随时可以按 Ctrl+Alt+P 调出它（`pv assistant status` 可以查看实际快捷键）。不要在对话里重复讲解论文，讲解在窗口里进行。
