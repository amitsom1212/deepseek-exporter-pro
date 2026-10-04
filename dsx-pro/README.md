# DeepSeek 对话导出 Pro

一个 Chrome / Edge（Manifest V3）扩展：把 **chat.deepseek.com** 与 **DSH 本地界面**（`127.0.0.1:3080`）
的对话导出成 Markdown / **Word（公式可编辑）** / 纯文本 / JSON，支持逐条勾选、批量导出到指定文件夹、
以及图片自动转码（webp → PNG/JPEG）。

> 本扩展在 MIT 许可的 [sati0121/DeepSeek-Exporter](https://github.com/sati0121/DeepSeek-Exporter)
> 基础上重写并大幅扩展；接口契约参考了 MIT 许可的
> [agoramachina/deepseek-exporter](https://github.com/agoramachina/deepseek-exporter)；
> Markdown→DOCX 的数学映射参考了 MIT 许可的 [vace/markdown-docx](https://github.com/vace/markdown-docx)。
> 详见文末「许可与致谢」。

---

## 一、功能对照（对应需求清单）

| 需求 | 实现情况 | 说明 |
| --- | --- | --- |
| ① 逐条勾选「提问 / 思考 / 回答 / 图片」 | ✅ 已实现 | 面板里有全局勾选；每条消息还能展开单独覆盖 |
| ② 批量勾选会话 → 输出到指定文件夹 | ✅ 已实现 | 支持搜索、全选、Shift 区间选择、进度与逐条日志；支持「按会话建子文件夹」与索引文件 |
| ③ 导出 DOCX，数学公式正常转换 | ✅ 已实现 | 公式转成 **Word 原生公式（OMML，可编辑）**，不是图片 |
| ③-b 单独打包一份 md→docx | ✅ 已交付 | `deliverables/md2docx/`（库 + 离线单文件网页） |
| ④ 独立设置页面 | ✅ 已实现 | 默认单条/批量文件夹、批量是否建子文件夹、批量默认导出项与格式、图片选项、权限、诊断 |
| ⑤ 上传图片导出（webp→png/jpeg） | ✅ 已实现 | 默认 PNG；可切 JPEG/WEBP/保持原格式；可内联进 Markdown 或存 `images/` 子目录 |
| ⑥ DSH 也支持 | ✅ 已实现 | 同一份扩展内做了双站点适配（DSH 用 `data-chat-flow` 语义属性定位） |

**额外做的**：真实文件夹授权（绕过「下载目录」限制）、JSON 导出、索引文件、页面诊断、
接口优先取数（保留 LaTeX 原文与正确的分支结构）、正文内联图片也会转码内嵌进 Word、
**AI 归类归档**（按学科自动分文件夹）。

---

## 一·五、更新记录

### v1.1.3（当前）

**修复：图片选「内联进 Markdown」时，Word 里出现一整串 base64**

| 问题 | 根因 | 处理 |
| --- | --- | --- |
| Word 文档里显示一长串看不明白的字符（其实是 base64），图片没真的嵌进去 | 内联模式下 markdown 里的图片地址本身就是 `data:image/png;base64,…`，而 docx 的图片解析器只认「远端 URL」与「相对路径」两种形态；解析失败就按占位提示把**整串地址当普通文字**写进了文档 | ① 解析器**最前面**加 data URL 分支，直接解码嵌入，不必再回头取字节；② 占位提示改为「内联图片（data URL，未能嵌入）」并对超长地址一律截断——任何情况下都不会再往文档里灌 base64 |
| 内联模式下 `images/` 目录是空的，看着像图片丢了 | 内联模式的设计就是**单文件自包含**：图片以 base64 直接写进 `.md`，不再单独落文件；Word 则把图片嵌进文档自身 | 属预期行为，已在设置页与文档里写明。希望图片单独成文件请选「存到子目录（推荐）」 |

### v1.1.2

**修复：勾了「图片」却一张都没导出**

| 问题 | 根因 | 处理 |
| --- | --- | --- |
| 导出内容里明明勾了「图片」，但文档与 `images/` 子目录里都没有图片 | 图片检测只读了少数几个写死的字段（`files` / `file_list` / `attachments`），而站点已经把图片挪进了 `fragments`（如 `{type:'IMAGE', image:{...}}`）或改叫 `image_list`——和正文那次"字段搬家"是同一类问题，写死字段名必然漏 | 改成**深度扫描**整条消息对象：类名含 `image`、文件名/路径带图片扩展名都算图片，任意嵌套层级（`{image:{...}}`）与任意字段名都能命中；同时排除头像/图标一类装饰图 |
| 正文里以 markdown 链接形式出现的图片，`.md` 里留的是远端链接（会过期），只有 Word 里嵌了图 | 内联图片走的是另一条"只给 docx 用"的支路，没进过落盘流水线 | 内联图片与结构化附件**统一走同一条流水线**：都会落盘到 `images/`，并把正文里的远端链接**就地改写成本地相对路径**（位置不变，复习时不依赖网络） |
| 接口只给文字、不给上传图片的地址时，图彻底丢失 | 接口的 `chat_messages` 里不一定带图片字段（上传图有时只存在于页面 DOM） | 加**兜底**：接口一张图都没给时，从页面 DOM 按「同角色的第 n 条消息」对齐补一次图片；文字仍以接口为准（保 LaTeX 原文） |
| 出问题时无法判断图片到底藏在哪 | 诊断报告只报选择器命中，不报图片结构 | 诊断报告新增 `imageInfo`：接口里有多少条消息带图、样例地址，以及首条用户消息中"含 URL 的字段名"与嵌套数组路径 |

### v1.1.1

**修复：授权真实文件夹后目录重复嵌套**

| 问题 | 根因 | 处理 |
| --- | --- | --- |
| 授权了 `E:\考研\dsx笔记整理`，导出却落在 `E:\考研\dsx笔记整理\考研\dsx笔记整理\...` | 文件路径在设计上被拼成了「设置里的下载目录相对路径 + 分类/会话/文件名」，落盘时又把这一整串直接塞进授权目录，于是下载目录用的那串前缀被叠加上去了 | 重构路径拼装：**文件路径只表示「导出根目录内的相对路径」**，由落盘目标决定前缀——写下载目录时用 ① 里的相对路径，写授权文件夹时用新增的「授权文件夹内部子目录」（默认空 = 直接放在授权目录根下）。两套前缀**互不叠加** |
| 用户无从判断最终会写到哪里 | 界面与设置页都只描述了下载目录那一套 | 设置页 ② 新增「授权文件夹内部子目录」输入框 + **实际写入位置预览**（两种目标都显示）；批量面板的「导出位置」同时列出两个目标；索引文件名也改为回报真实落盘路径 |

**升级注意**：如果你之前为了"绕过重复嵌套"把 ① 里的相对路径清空了，现在可以按喜好填回（它只在写下载目录时生效）；授权文件夹的情况下请改用 ② 的新字段。

### v1.1.0

**修复**

| 问题 | 根因 | 处理 |
| --- | --- | --- |
| 面板能读到会话标题，但**消息正文全是空白** | DeepSeek 把正文从扁平的 `content` 字段挪到了 `fragments[]`（每段带 `type`），旧代码只读 `content`/`thinking_content` | 新增宽容解析：`fragments`（REQUEST/THINK/RESPONSE，大小写与字段名不限）+ 扁平字段 + `<think>` 标签三种形态全支持；并新增**兜底**——接口返回消息但解析不出任何文字时自动回退页面抓取，而不是给一个空白面板 |
| 诊断报告生成失败，且把**设置页自己**当成诊断目标 | 诊断用的是「当前活动标签页」，而用户是在设置页点的按钮 | 改为显式列出已打开的 DeepSeek / DSH 页面供选择，默认选最近访问的那个；本设置页不再可能成为目标 |
| 设置页初始化失败 `(selected \|\| []).slice is not a function` | 把「槽位对象」当成「id 数组」传给了 chip 渲染器 | 修正调用并给渲染器加了类型容错（设置页挂掉是最糟的失败模式） |
| 扩展装不上：`content/index.js 不是 UTF-8 编码格式` | 依赖 `marked` 的词法表里内嵌了字面量 `U+FFFF`，而 Chrome 的校验比标准 UTF-8 更严，会拒绝这个非字符 | 构建改用 `--charset=ascii`（非 ASCII 全部转义），并加**构建期校验**：产物含 Chrome 拒绝的字符就直接构建失败 |
| 加载扩展报 `Cannot load extension with file or directory name _cp.mjs` | 源码工程目录不是扩展目录（根层没有 manifest.json），且里面/`node_modules` 里有 `_` 开头的文件——Chrome 把 `_` 前缀视为系统保留 | 删除遗留临时脚本；构建期新增**保留名校验**（产物含 `_` 开头名字即构建失败）；产物内放《如何安装.txt》明确"选 dist、别选上级" |
| 页面已打开时扩展完全无响应 `Receiving end does not exist` | 消息监听器注册在「识别出站点之后」；且已打开的标签页不会自动获得内容脚本 | 监听器移到模块顶层始终注册；识别改为每秒重试；popup 与诊断在通信失败时用 `chrome.scripting` 主动注入 |
| DSH 页面识别不了 | 识别条件用了 `window.__DSH_BOOT__`（内容脚本在隔离世界，读不到页面全局变量）；且只在页面加载时判定一次 | 移除该条件；改为**端口 3080 直接认定**，其它端口回退 DOM 特征；本地其它端口不会被误判 |

**新增：AI 归类归档**（默认关闭，需自己填接口）

导出前把「会话标题 + 开头一段正文」发给**你自己配置的 OpenAI 兼容接口**，判断是否知识答疑、
属于哪个科目，并据此把文件归档到不同文件夹。详见下方「六、AI 归类归档」。

---

## 二、安装

1. 打开 `chrome://extensions/`（Edge 是 `edge://extensions/`）
2. 打开右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选择本仓库构建产物 **`dsx-pro/dist`** 目录
4. 打开 `chat.deepseek.com` 的任意对话，输入框附近会出现「**导出对话**」按钮

> 也可以直接用 `deliverables/deepseek-exporter-pro-v1.0.0.zip` 解压后的目录。

## 三、使用

### 单个对话

1. 点「导出对话」打开右侧面板
2. **导出内容**：勾选 提问 / 思考 / 回答 / 图片（括号里的数字是该内容的条数）
3. 想精细控制：点某条消息右侧的 `▸` 展开 → 单独勾选这条的四个部分（会显示「这一条已单独设置」）
4. **导出格式**：Markdown / Word / 纯文本 / JSON（可多选）
5. 点「导出」，文件会按设置页里的路径落盘

### 批量导出

1. 切到面板的「**批量导出**」标签，会自动扫描左侧所有会话（接口模式秒出；DOM 模式会自动滚动侧边栏加载更多）
2. 搜索、全选、或按住 <kbd>Shift</kbd> 点选一整段
3. 目标文件夹、默认导出内容与格式都取自设置页（这里可以临时改）
4. 点「导出 N 个」，底部会显示逐条进度与失败原因

### 设置页（④）

扩展图标 → 设置，或面板右上角齿轮。可配置：

- 默认单独导出 / 批量导出的文件夹（**只在写下载目录时生效**的相对路径）
- 批量导出是否为每个会话新建子文件夹 + 命名模板（`{date}` `{title}` `{index}` `{id}` `{time}`）
- 批量导出是否生成 `00-索引.md`
- **真实文件夹授权**：突破「只能写下载目录」的限制，可写任意盘符；另有「**授权文件夹内部子目录**」字段（默认空 = 直接放在授权目录根下）——它与上面那条相对路径是**两套互不叠加**的前缀，设置页有「实际写入位置预览」可以直接看到结果
- 单独 / 批量导出默认勾选的内容项与格式
- 图片格式（PNG / JPEG / WEBP / 保持原格式）、JPEG 质量、存子目录还是内联、Word 图片最大宽度
- 授予「任意网站访问权限」（提高跨域图片转码成功率）
- **诊断选中的页面**：输出选择器命中情况与接口连通性（排查问题时把它发我）

## 四、构建与测试

```bash
cd dsx-pro
npm install --ignore-scripts     # 见下方说明
npm run build                    # 生成 dist/ 与 deliverables/
npm test                         # 438 项自动化测试（见下）
npm run icons                    # 重新生成图标
node tools/verify-build.mjs      # 产物自检：确认关键能力真的被打包进 dist
```

> 维护者脚本 `tools/gh.mjs` 用于发布（建仓库 / 生成推送凭据 / 发 Release），
> 只用 node 自带的 fetch，不需要安装 gh CLI。token 从环境变量 `GH_TOKEN`
> 或仓库上一级的 `.gh-token.txt` 读取，**不会**出现在命令行里。

> `--ignore-scripts` 是必要的：esbuild 的安装脚本会以管道方式 spawn 子进程，
> 在某些受限环境（含 CI 沙箱）会因 EPERM 失败。esbuild 的平台二进制来自
> `optionalDependencies`，跳过脚本不影响使用。

### 五套自动化测试（共 438 项断言，全部不需要浏览器）

| 命令 | 项数 | 覆盖内容 |
| --- | --- | --- |
| `npm run test:unit` | 110 | markdown 生成与勾选过滤、MathML→OMML 各类公式、公式保护（`\\` 不被吃掉）、文件名与路径规则、**AI 归类的解析/匹配/归档目录/网络调用（mock fetch）** |
| `npm run test:dom` | 122 | **jsdom 仿真站点**：DeepSeek / DSH 真实 DOM 契约下的抽取、KaTeX 还原、DSH 懒渲染思考块、接口分支还原、`fragments` 结构回归、图片导出回归（附件 + 正文内联 + 接口无图时从 DOM 兜底 + **内联模式不再把 base64 灌进 Word**）、导出路径拼装、授权文件夹路径不叠加回归 |
| `npm run test:ui` | 45 | **面板交互**：启动按钮、打开/关闭、全局勾选、逐条覆盖、全选/全不选、触发导出与落盘、批量页选择、销毁清理 |
| `npm run test:options` | 75 | **设置页**：HTML id 与 JS 引用一致性、选项渲染与初始值、改动真正写入 storage、路径规范化、联动显隐、AI 区块与归档预览、授权文件夹路径预览回归、诊断目标选择 |
| `npm run test:content` | 86 | **内容脚本**（6 个页面场景）：DSH 按端口识别、本地其它端口不误判、消息监听在未识别站点时也已注册、诊断与面板开关 |

`test:dom` / `test:ui` / `test:options` / `test:content` 都是**加载真实文件在 jsdom 里跑起来**的，
所以「页面炸了 / 按钮不出来 / 收不到消息」这类问题在构建前就能发现，而不是等用户来反馈。

### 构建期编码校验

`build.mjs` 每次构建后会按 **Chrome 的规则**扫描产物。Chrome 对内容脚本的 UTF-8 校验
比标准解码更严：除代理对与过长编码外，还拒绝 `U+FFFE` / `U+FFFF` 两个「非字符」。
一旦命中会**直接构建失败**并指出文件与偏移——否则表现成「扩展装不上」这种最难排查的故障。
构建因此使用 `--charset=ascii`（所有非 ASCII 转义为 `\uXXXX`，运行时行为不变）。

## 五、代码结构

```
dsx-pro/
├── src/
│   ├── manifest.json            MV3 清单
│   ├── core/                    纯逻辑，可在 Node 里单测
│   │   ├── model.js             Turn / ImageAsset 数据模型与勾选组合
│   │   ├── domToMarkdown.js     DOM → Markdown 序列化（含 KaTeX 还原）
│   │   ├── md2docx.js           Markdown → DOCX（含 MathML→OMML 公式映射）
│   │   ├── exporter.js          Turn[] + 勾选 → md/txt/json 与图片文件计划
│   │   ├── imagePipeline.js     取字节 / 解码 / webp→png、jpeg 转码
│   │   ├── filename.js          文件名清洗、去重、子目录模板
│   │   ├── settings.js          设置读写与默认值
│   │   └── dirHandle.js         File System Access 句柄的持久化与写入
│   ├── adapters/                站点适配器
│   │   ├── index.js             注册表：按页面挑适配器
│   │   ├── shared/selectors.js  候选链查询、等待、稳定性工具
│   │   ├── deepseek.js          DeepSeek DOM 抽取 + 适配器
│   │   ├── deepseek.selectors.js 选择器注册表（已用线上 bundle 核对）
│   │   ├── deepseek.api.js      DeepSeek 内部接口客户端（分支还原）
│   │   ├── dsh.js               DSH DOM 抽取 + 适配器
│   │   └── dsh.api.js           DSH 本地 RPC 客户端
│   ├── content/                 内容脚本
│   │   ├── index.js             入口：识别站点、挂按钮、SPA 轮询
│   │   ├── panel.js             主面板（逐条勾选 + 批量导出）
│   │   ├── exportRunner.js      一次导出的编排（图片→各格式→落盘）
│   │   ├── ui.js                Shadow DOM 宿主、图标、Toast
│   │   └── styles.js            面板样式（注入 Shadow Root）
│   ├── background/index.js      下载落盘、跨域取字节代理、offscreen 调度
│   ├── offscreen/               写「已授权真实文件夹」的隐藏文档
│   ├── options/                 设置页
│   ├── popup/                   工具栏弹窗
│   └── icons/                   图标（由脚本生成，非外部素材）
├── tools/
│   ├── make-icons.mjs           手写 PNG 生成器（无第三方素材）
│   ├── selftest.mjs             56 项纯逻辑自测
│   ├── domtest.mjs              68 项 jsdom 仿真站点集成测试
│   ├── uitest.mjs               45 项面板交互测试
│   └── md2docx/                 独立版转换器入口与离线网页模板
├── build.mjs                    构建脚本（调用 esbuild CLI）
├── third_party/                 参考实现存档（MIT，仅作资料）
└── dist/                        可直接加载的扩展产物
```

## 六、AI 归类归档（v1.1.0 新增）

作用：导出前让模型读一遍会话开头，判断**是否属于知识答疑**、**属于哪个科目**，
然后按科目把文件归档到不同文件夹。默认**关闭**。

### 为什么是「可配置的 OpenAI 兼容接口」

扩展里跑不了云端的我，所以这个功能实现成通用客户端：既能用 DeepSeek 官方 API，
也能填任意 OpenAI 兼容服务，或者指向本机的 Ollama / LM Studio（`http://127.0.0.1:11434/v1`），
后者内容完全不出本机。设置页有一键填充的预设：DeepSeek 官方 / OpenAI / 本地 Ollama / 本地 LM Studio。

### 设置要点

- **科目清单**：每行一个，用 `/` 表示层级。默认已经按你的需求配好：
  ```
  数学
  英语
  政治
  408/数据结构
  408/计算机网络
  408/计算机组成原理
  408/操作系统
  ```
  模型只会从这份清单里选，不会自创目录；对不上的落进「未分类」。
- **归档方式**：`按学科归档`（`数学/`、`408/数据结构/`…）或 `只分知识答疑/非知识答疑`。
- **路径**：写下载目录时是 `下载目录 / <①里的相对目录> / <科目>/<子科目>/<会话>/文件`；
  已授权真实文件夹时是 `<授权文件夹> / <②里的内部子目录> / <科目>/<子科目>/<会话>/文件`。
  两套前缀不叠加（v1.1.1 修的就是这里）。
- **测试接口**：用一段固定的数学提问试跑，直接告诉你接口通不通、返回的分类能否解析。
- **缓存**：结果按「标题+正文+模型+科目清单」缓存，重复导出同一会话不再重复计费。
- 面板里可以**手动改**归档科目（下拉框），也可以用「重新判断」强制刷新。

### 隐私与成本

- 送出去的只有**会话标题 + 开头约 900 字**（可在设置页调），不是整段对话。
- API Key 只存在本机 `chrome.storage.local`，只有后台 Service Worker 读取，不经过页面。
- 未勾选「启用」时完全不发任何请求。

---

## 七、设计要点

### 为什么「接口优先」

DeepSeek 页面上有两个坑，直接抓 DOM 会踩到：

1. **公式可能拿不回原文**：DeepSeek 有两套公式渲染器（KaTeX / WASM 内联 SVG），
   切到 WASM 那套时 DOM 里**没有** `annotation[encoding="application/x-tex"]`，LaTeX 无法还原。
2. **消息列表是虚拟列表**：`[data-virtual-list-item-key]` 之外的节点会被回收，
   必须边滚边收，长对话容易漏消息。

内部接口（`/api/v0/chat/history_messages`）返回的是**原始 markdown + message_id/parent_id**，
既保住 LaTeX 原文，又能沿 `parent_id` 精确还原「当前分支」（正确处理重新生成 / 编辑提问）。
接口失败（未登录、改版、网络）会**自动回退**到 DOM 抓取，不会让功能不可用。
设置页可以关掉接口模式。

### 为什么数学公式要自己做

- `docx` 官方库有 Math 类，但**不接收 MathML**，也没有 `MathMatrix` / `MathAccent` / `MathBar`；
- `html-docx-js` / `html-to-docx` 走 altchunk 或直塞 HTML，Word/LibreOffice 都不认，公式会丢；
- `mammoth` 方向相反（docx→HTML）；
- `pandoc-wasm` 保真最好，但 wasm 体积 58MB 且 GPL-2.0 会传染，不适合塞进扩展。

所以本项目的做法是：`docx`（文档骨架 + 常用公式类）+ `KaTeX`（LaTeX→MathML）+
**自写 MathML→OMML 映射**（补齐矩阵 / 对齐 / 重音 / 极限等缺口）。已覆盖并自测通过：

分数、根式（含 `\sqrt[3]`）、上下标、**求和/积分（含上下限，走 `m:nary`）**、
矩阵与 `pmatrix`/`cases`/`aligned`（走 `m:m`）、希腊字母、重音（`\vec \bar \hat \dot \ddot \tilde`，走 `m:acc`）、
`\lim` 等极限式运算符（走 `m:limLow`）、`\overline`/`\underline`（走 `m:bar`）。

另一个容易踩的坑：**markdown 里的 `\\`（矩阵/对齐的换行符）会被 markdown 解析器当成转义吃掉**。
所以转换前会先「保护」公式（连同代码块、行内代码一起），再交给 `marked`。

### 图片转码

网页里复制下来的图多半是 webp，很多 Windows 程序打不开。取字节按以下顺序降级：

1. `fetch(src)`（同源或带 CORS）
2. 页面上已有的 `<img>` 画进 canvas（未被跨域污染时可用）
3. 交给后台 Service Worker 代理 fetch（扩展有 host 权限时不受 CORS 限制）
4. 都失败则保留原始链接，并在导出报告里明确列出哪几张失败

成功拿到字节后统一用 `OffscreenCanvas` 转码（PNG 无损 / JPEG 可调质量 / 保持原格式）。

### 落盘：两条路

| 方式 | 目标位置 | 需要授权 | 适用 |
| --- | --- | --- | --- |
| `chrome.downloads` | **下载目录**下的相对子路径 | 不需要 | 默认，永远可用 |
| File System Access | **任意真实文件夹**（如 `D:\笔记\DeepSeek`） | 设置页点一次「选择文件夹」 | 批量导出，真正自由 |

浏览器的下载接口无法写下载目录之外的位置，这是平台限制，不是扩展的取舍。
真实文件夹的句柄存在 IndexedDB 里，重启浏览器后权限可能需要重新点一次「重新授权」；
权限失效时导出会自动回退到下载目录并在面板上提示。

## 八、已知限制与风险（请务必看）

1. **真实站点尚未经登录态实测**。开发环境无法登录 `chat.deepseek.com`，
   适配器与面板逻辑已通过 jsdom 仿真测试（按线上 bundle 核对过的 DOM 契约造页面）验证，
   但线上页面的细微差异只能靠实测。已在设置页提供「**诊断选中的页面**」，
   把报告发我即可精准修正。
   已确认失效并被移除的旧类名：`_5cadb25`、`_76cd190`、`_608a995`、`abbe3c45`。
2. **接口结构变更是最大的长期风险**。已经踩过两次：正文从 `content` 搬到 `fragments[]`、
   图片藏进 `fragments` / 改名 `image_list`。现在文字与图片都是宽容解析 + 多层兜底
   （解析不出文字→回退 DOM 抓取；接口没给图→从 DOM 补图），
   诊断报告也会给出**实际字段名、片段类型与图片字段路径**，便于快速适配。
3. **DSH 的思考块是懒渲染**：折叠状态下 DOM 里只有摘要，扩展会先逐个点开再读；
   对话很长时这一步会慢一些（有 400 个折叠块的保护上限）。
4. **Word 里的矩阵/对齐环境**用 `m:m` 表达（Word 的公式矩阵），
   列对齐信息（`columnalign`）无法完全保留。
5. **图片取字节受跨域限制**：依次尝试 fetch → canvas → 后台代理 → 保留原链。
   全部失败时会在面板上明确列出是哪几张、为什么失败。
6. **PDF / Word / Excel 类附件**（DeepSeek 自己也不给预览的那些）不在导出范围内，
   它们依赖服务端的签名直链，扩展不去碰。
7. `useApi`（接口模式）依赖 `localStorage.userToken`。DeepSeek 改鉴权方式时会失效，
   此时自动回退 DOM 模式，功能不中断。
8. **AI 归类依赖第三方模型**，判断质量取决于你选的模型与科目清单的措辞。
   归类结果可以在面板里手动改；接口不可用时导出照常进行，只是不归档。

## 九、许可与致谢

本项目：**MIT**。

内置第三方依赖（均为 MIT，构建产物里保留了许可证注释）：

| 依赖 | 用途 |
| --- | --- |
| [docx](https://github.com/dolanmiu/docx) | 生成 OOXML 文档骨架与常用公式类 |
| [KaTeX](https://katex.org/) | LaTeX → MathML |
| [marked](https://github.com/markedjs/marked) | Markdown → token |
| [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) | 解析 KaTeX 的 MathML |
| [esbuild](https://esbuild.github.io/) | 构建（仅开发期） |

参考实现（仅借鉴思路 / 契约，代码为本项目重写，存档在 `third_party/`）：

| 项目 | 许可 | 借鉴内容 |
| --- | --- | --- |
| [sati0121/DeepSeek-Exporter](https://github.com/sati0121/DeepSeek-Exporter) | MIT | DeepSeek 选择器候选链与思考块抽取思路 |
| [agoramachina/deepseek-exporter](https://github.com/agoramachina/deepseek-exporter) | MIT | DeepSeek 内部接口契约与分支还原算法 |
| [vace/markdown-docx](https://github.com/vace/markdown-docx) | MIT | MathML→docx Math 的映射结构 |
| [dibrovnik/chatgpt-word-copier](https://github.com/dibrovnik/chatgpt-word-copier) | MIT | MathML→OMML 的元素覆盖清单 |
