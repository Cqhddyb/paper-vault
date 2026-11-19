---
name: search
description: 在本地论文库（paper-vault）里按用户记得的零散细节找论文，不需要记得标题。用户说“我记得有篇论文用了 Qwen…”“找一下库里那篇在 LIBERO 上测的”“论文库里有没有讲 xxx 的”时使用。
argument-hint: "<你记得的细节>"
---

# 按细节检索论文

CLI：`node "${CLAUDE_SKILL_DIR}/../../bin/pv.mjs"`（下文记作 `pv`）。如果 `${CLAUDE_SKILL_DIR}` 没有被替换成真实路径，就用本 skill 所在目录往上两级的 `bin/pv.mjs`。

用户的描述：$ARGUMENTS

## 步骤

1. 把描述拆成可检索的线索，并为每条线索想几种写法，例如：
   - 模型名的变体：“Qwen” → `Qwen`, `Qwen2.5-VL`, `通义千问`；“GPT4” → `GPT-4`, `GPT-4o`
   - 中英文对照：“世界模型” ↔ `world model`；“扩散” ↔ `diffusion`
   - 用户的模糊说法换成论文里的术语：“让机器人看视频学” → `video pretraining`, `learning from human videos`
2. 运行 2-5 次 `pv search "<关键词组合>" --json --top 15`，每次换一组线索。结果按 BM25 分数排序，`hits` 是命中的词。
3. 库不大时（`pv catalog | wc -l` 少于 300 行）也通读一遍 `pv catalog`，补上关键词没命中但意思相符的论文。
4. 对排名靠前的候选，读 `summary` 字段指向的总结文件，判断是否真的符合用户的描述。
5. 回复用户一个列表（最相符的在前），每条包括：标题、年份/会议、为什么相符（对应用户记得的哪个细节）、总结文件和 PDF 的路径（写成 markdown 链接）。
   - 只有一篇明显吻合时直接给出，并附 tldr。
   - 都不太吻合时如实说，列出最接近的 2-3 篇，并问用户还记得哪些细节；也可以提议用 related skill 去网上找。
