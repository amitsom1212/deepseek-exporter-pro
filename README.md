# DeepSeek 对话导出 Pro

把 **chat.deepseek.com** 与 **DSH 本地界面**（`127.0.0.1:3080`）的对话导出成
Markdown / **Word（公式可编辑）** / 纯文本 / JSON 的 Chrome / Edge 扩展（Manifest V3）。

为"把 AI 答疑整理成能长期离线复习的笔记"而做：公式是**可编辑的 Word 原生公式**，
图片会**真的落盘**，还能按学科自动归类到不同文件夹。

---

## 功能

| 能力 | 说明 |
| --- | --- |
| 逐条勾选导出 | 单条消息级别可分别勾选/取消 **提问 / 思考 / 回答 / 图片** |
| 批量导出 | 扫描侧边栏全部会话，勾选后一键导出到指定文件夹，支持搜索、区间选择、索引文件 |
| DOCX 公式 | 数学公式转成 **Word 原生公式（OMML，可编辑）**，不是图片；支持求和/积分/矩阵/对齐/极限/重音/根式 |
| 图片 | 上传图片自动导出并转码（webp → PNG/JPEG）；可选存 `images/` 子目录或内联进 Markdown |
| 真实文件夹 | 授权任意磁盘目录（突破浏览器"只能写下载目录"的限制），也可只用下载目录 |
| AI 归类归档 | 可选：判断是否知识答疑、属于哪个科目，按 `数学` / `英语` / `政治` / `408/数据结构` … 自动分目录 |
| 双站点 | 同一份扩展同时支持 DeepSeek 网页与 DSH 本地界面 |
| 独立 md→docx | 单独的 Markdown→Word 转换库 + 离线单文件网页，可给别的项目用 |

---

## 安装（30 秒）

1. 下载本仓库（`git clone` 或右上角 **Code → Download ZIP**）
2. 打开 `chrome://extensions/`（Edge 是 `edge://extensions/`）
3. 打开右上角 **开发者模式**
4. 点 **加载已解压的扩展程序**，选择仓库里的 **`dsx-pro/dist`** 目录

> ⚠️ 只能选 `dsx-pro/dist`——**根目录直接有 `manifest.json` 的那一层**。
> 不要选仓库根目录或 `dsx-pro`：它们没有 `manifest.json`，而且 `node_modules` 里存在
> `_stream_duplex.js` 这类以下划线开头的文件，Chrome 把 `_` 前缀视为系统保留，会直接拒绝加载。

装好后打开任意 DeepSeek 对话，输入框旁会出现「导出对话」按钮。

---

## 从源码构建

```bash
cd dsx-pro
npm install --ignore-scripts     # 必须：esbuild 的安装脚本会在受限环境里失败
npm run build                    # 产出 dist/（可直接加载的扩展）与 deliverables/
npm test                         # 438 项自动化测试，全部不需要浏览器
```

构建脚本自带两道自检：产物**编码**必须是 Chrome 接受的合法 UTF-8，
产物**文件名**不得出现 Chrome 保留的下划线前缀，命中直接构建失败。

---

## 测试

| 套件 | 项数 | 覆盖 |
| --- | --- | --- |
| `test:unit` | 110 | markdown 生成与勾选过滤、MathML→OMML 公式映射、公式保护、文件名/路径规则、AI 归类解析 |
| `test:dom` | 122 | jsdom 仿真站点：DeepSeek / DSH 真实 DOM 契约下的抽取、KaTeX 还原、接口分支还原、`fragments` 结构、图片导出（附件/内联/DOM 兜底） |
| `test:ui` | 45 | 面板交互全链路（含真实落盘断言） |
| `test:options` | 75 | 设置页渲染、保存、路径预览、诊断目标选择 |
| `test:content` | 86 | 内容脚本在 6 种页面场景下的识别与消息处理 |

---

## 目录结构

```
dsx-pro/            扩展源码与构建
  src/core/         纯逻辑：数据模型、markdown 序列化、md→docx、图片流水线、设置
  src/adapters/     站点适配器（DeepSeek / DSH）与内部接口封装
  src/content/      内容脚本：面板 UI（Shadow DOM）、导出编排
  src/background/   后台 Service Worker、offscreen、设置页、popup
  tools/            5 套自动化测试
  docs/             站点侦察记录与 DOM 契约报告
  third_party/      MIT 参考实现存档（含各自 LICENSE）
deliverables/       现成分发文件（zip 请从 Releases 下载）
```

详细说明、设计取舍与已知限制见 **[dsx-pro/README.md](dsx-pro/README.md)**。

---

## 已知限制

- 真实站点的细微改版只能靠实测；扩展内置**诊断**功能（设置页 → 权限与诊断），
  一键输出选择器命中情况与接口字段名，便于快速适配。
- 导出依赖站点内部接口；接口结构变更时扩展会**自动回退页面抓取**，不会给你空白面板。
- PDF / Word / Excel 类附件不在导出范围内（依赖服务端签名直链）。
- AI 归类需要你自己填一个 OpenAI 兼容接口（也可指向本地 Ollama，内容不出本机）。

---

## 许可

本项目 **MIT**。基于下列 MIT 项目重写并扩展，出处与许可见
[dsx-pro/README.md 的「许可与致谢」](dsx-pro/README.md#九许可与致谢)：

[sati0121/DeepSeek-Exporter](https://github.com/sati0121/DeepSeek-Exporter) ·
[agoramachina/deepseek-exporter](https://github.com/agoramachina/deepseek-exporter) ·
[vace/markdown-docx](https://github.com/vace/markdown-docx) ·
[dibrovnik/chatgpt-word-copier](https://github.com/dibrovnik/chatgpt-word-copier)
