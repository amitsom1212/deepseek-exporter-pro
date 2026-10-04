# DeepSeek Chat 前端 DOM 契约侦察报告 (chat.deepseek.com)

**侦察时间**: 2026-09-16 · **构建版本**: `<meta name="commit-id" content="12196914">`, `appVersion: "2.5.0"`
**方法**: 匿名 HTTP 抓取（无登录、无私有 API）。**环境限制**：sandbox 内 `pwsh`/`curl.exe` 无 TLS 凭据（`schannel: SEC_E_NO_CREDENTIALS`），`raw.githubusercontent.com` 被 DNS 指向 127.0.0.1；实际抓取全部通过 Python 3.12 `urllib` 完成。

---

## (a) 抓取结果表 / Fetch results

| URL | HTTP | Size | 可匿名获取 | 说明 |
|---|---|---|---|---|
| `https://chat.deepseek.com/` | 200 | 10,071 B | ✅ | 仅 SPA 外壳 HTML，含 `#root` 与 asset 引用 |
| `https://chat.deepseek.com/a/chat/s/<uuid>` | 200 | 10,072 B | ✅ | 同一外壳（前端路由，非服务端渲染） |
| `https://chat.deepseek.com/share/<uuid>` | 200 → 302 | 10,124 B | ✅ | 无效 id 时前端跳转 `/share/invalid` |
| **`https://fe-static.deepseek.com/chat/static/main.7c490b0c22.js`** | **200** | **1,507,719 B** | ✅ | **主 bundle（本报告主要证据来源）** |
| **`https://fe-static.deepseek.com/chat/static/main.3208e09460.css`** | **200** | **288,474 B** | ✅ | **设计系统 CSS（`ds-*` 全量）** |
| `https://fe-static.deepseek.com/chat/static/default-vendors.73c732e189.js` | 200 | 1,031,417 B | ✅ | React 等 vendor |
| `https://fe-static.deepseek.com/chat/manifest.json` | 200 | 491 B | ✅ | PWA manifest |
| `https://chat.deepseek.com/chat/static/main.7c490b0c22.js` | 200 | 10,071 B | ⚠️ | **陷阱**：SPA catch-all，返回外壳 HTML 而非 JS |
| `https://chat.deepseek.com/api/v0/share/content?share_id=<uuid>` | 200 | 90 B | ✅ | JSON `biz_code:1 "share does not exist"` — 接口公开可达 |
| `https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=1` | 200 | 48 B | ❌ | `{"code":40003,"msg":"INVALID_TOKEN"}` |
| `https://chat.deepseek.com/api/v0/chat_session/fetch_page?count=1` | 200 | 48 B | ❌ | `{"code":40002,"msg":"Missing Token"}` |

**关键结论**：静态资源托管在 `fe-static.deepseek.com`，**无需认证即可下载完整 bundle**。`chat.deepseek.com/chat/static/*` 是 catch-all，会静默返回外壳 HTML（极易误判为"JS 抓取失败"）。首次 `Invoke-WebRequest` 会命中 AWS WAF（`x-amzn-waf-action: challenge`），但 `fe-static` 域名不受影响。

---

## 任务 1：目标字符串在 bundle 中的存在性

| 字符串 | CSS 命中 | main.js 命中 | 结论 |
|---|---|---|---|
| `.ds-message` | **0** | **1** | ⚠️ 存活但**无样式**：JS 硬编码 marker class |
| `.ds-markdown` | 211 | 23 | ✅ 存活，核心 |
| `.ds-think-content` | 50 | 2 | ✅ 存活 |
| `.ds-scroll-area` | 82 | 11 | ✅ 存活（含 `__content/__gutters/__vertical-bar`） |
| `.ds-skeleton` | 41 | 0 | ✅ 存活（纯 CSS 组件） |
| `.ds-icon-button` | **2** | **0** | ⚠️ 近乎废弃，勿依赖 |
| `_5cadb25` | **0** | **0** | ❌ **已死** |
| `_76cd190` | **0** | **0** | ❌ **已死** |
| `_608a995` | **0** | **0** | ❌ **已死** |
| `abbe3c45` | **0** | **0** | ❌ **已死** |
| `_25c7358` | 29 | 1 | ✅ **侧栏会话卡片行** |
| `_77cefa5` | 33 | 1 | ✅ **输入框容器** |
| `_519be07` | 18 | 1 | ✅ 侧栏面板 |
| `_27fc06b` / `_5d271a3` / `_24fad49` / `ec4f5d61` / `bf38813a` | 2/1/1/1/2 | 1 | ✅ 存活 |

`ds-message` 的**唯一**出现处（main.js @422999），证实它是 message 根节点上的 JS marker：
```js
className:(0,tS.A)(s,"ds-message",u&&um.he,l&&um.Ov,i&&um.i3,i&&!d&&um.YG),
style:{...a,"--panel-width":"".concat(c,"px")}
```

### 发现的 92 个新 `ds-*` 设计系统类（节选高价值）
`ds-assistant-message-main-content` · `ds-markdown-paragraph` · `ds-markdown-code-copy-button` · `ds-markdown-cite` · `ds-markdown-html` · `ds-markdown-math` / `-math-display` / `-math-svg` · `ds-markdown-task-list-item` · `ds-virtual-list` (+`-items`/`-visible-items`/`-empty`) · `ds-focus-ring` · `ds-textarea`

---

## (b) SELECTOR SPEC

| 目标 | 主选择器 | 回退 | 置信度 |
|---|---|---|---|
| **消息容器（每条消息根）** | `[data-virtual-list-item-key]` | `.ds-message` | **高** — 属性名来自源码常量 `nG="data-virtual-list-item-key"`，且应用自身即用 `listEl.querySelector('[data-virtual-list-item-key="'+id+'"]')` |
| **助手消息** | `[data-virtual-list-item-key] .ds-assistant-message-main-content` | `.ds-message .ds-markdown` | **高** — 两处独立源码引用 |
| **用户消息** | 含 `.ds-message` 但**不含** `.ds-assistant-message-main-content` 的 `[data-virtual-list-item-key]` | — | **中**（结构推断） |
| **深度思考折叠块** | `.ds-think-content` | `[data-virtual-list-item-key] .ds-think-content` | **高** — 源码内查询 `.ds-think-content` |
| **Markdown 正文** | `.ds-markdown` | `.ds-assistant-message-main-content` | **高** |
| **段落 / 代码复制 / 引用** | `.ds-markdown-paragraph` / `.ds-markdown-code-copy-button` / `.ds-markdown-cite` | — | **高** |
| **流式/停止控件** | 输入区内 `mode==="stop"` 的圆形 `ds-button`（`shape:"circle"`, `height:34px`） | 无稳定类名；建议按 `aria-label`/tooltip 文案（`chatInputStopButtonTooltip: "停止生成"`）定位 | **低** |
| **侧栏会话行** | `._25c7358` | 侧栏面板 `._519be07` 内的 `[tabindex="0"]` 卡片 | **中**（哈希类，会churn） |
| **侧栏面板** | `._519be07`（展开态含 `._27fc06b`） | `--sidebar-width` CSS 变量所在元素 | **中** |
| **输入框（composer）** | `._77cefa5 textarea` | `.ds-textarea` | **中高** |
| **输入框工具栏行** | `._77cefa5 .ec4f5d61` | — | **中** |
| **发送/停止按钮簇** | `._77cefa5 .bf38813a` | — | **中** |
| **滚动容器** | `.ds-scroll-area` | `.ds-virtual-list` | **高** |
| **加载骨架** | `.ds-skeleton` | — | **高** |

**会话 URL 形状**（源码路由常量 @23839，权威）：
```js
ROOT="/", AGENT="/a/:agentId", AGENT_SESSION="/a/:agentId/s/:sessionId",
SHARE="/share/:shareId", SHARE_MISSING="/share/missing", SHARE_INVALID="/share/invalid"
```
→ 打开的真实对话 URL 为 **`/a/chat/s/<sessionId>`**；分享页为 **`/share/<shareId>`**（源码含 `public:!0` 标记，即免登录）。

### 侧栏会话行是否携带 conversation id？
**不通过 `data-*` 或 `href`。** 全 bundle 中无 `data-...session...` 属性，无 `/a/chat` 字面量。会话列表由 `/api/v0/chat_session/fetch_page` 返回，映射为 `{key: e.id, ...}`（React key），session id **只存在于 React props 与 URL path**。因此可靠做法是从 `location.pathname` 解析 `/a/chat/s/(.+)`，而非从 DOM 读 id。

---

## 任务 3：LaTeX 渲染（**重要负面结论**）

KaTeX **确实存在**，但**不存在** `.katex annotation[encoding="application/x-tex"]` 这条恢复路径：
- `application/x-tex` 在全部三个 bundle 中命中 **0 次**；`annotation` 在 vendors 中仅 1 次，且属于 React 的 `annotation-xml` 命名空间白名单（与数学无关）。
- 实际调用（main.js @295364）：
```js
m.renderToString(I,{throwOnError:!0,strict:!1,displayMode:!n})
 .slice(ou[n?"inline":"displayMode"].length,-ou[n?"inlineEnd":"displayModeEnd"].length)
// ou.inline='<span class="katex">', ou.displayMode='<span class="katex-display"><span class="katex">'
```
  DeepSeek **剥掉外层 wrapper 后直接把 HTML 注入** DOM。
- **更关键**：存在第二套渲染器 `latexRenderer:["katex","wasm"]`（用户可切换），wasm 路径输出**内联 SVG**：
```js
"wasm"===l ? <span className="ds-markdown-math ds-markdown-math-svg ds-markdown-math-display" .../> : ...
```
  该路径下 LaTeX 源码**在 DOM 中不可恢复**。
- 另有个别 LaTeX 会被正则改写（`\cdotp`、`ordgroup`）后才渲染，原文与 DOM 已不一致。

**结论**：数学公式应从 API JSON 的 markdown 原文提取，**不要**从渲染后 DOM 反推。若必须走 DOM，只能尽力而为：`.ds-markdown-math .katex`（KaTeX 路径）；wasm 路径无解。

---

## 任务 4：图片

- 远端 src 生成器（main.js @341387）：
```js
lX="files.deepseeksvc.com", lJ="/api"
l8 = ({signedPath,type,fmt}) => "https://" + baseDomain + "/api" + signedPath + "?ty=" + type + (fmt?("&fmt="+fmt):"")
```
  → 形如 `https://files.deepseeksvc.com/api/<signed_path>?ty=p&fmt=jpeg`（`ty` 取值 `p`=预览/`t`=缩略图）。
- **上传前的本地预览**用 `blob:` URL：`URL.createObjectURL(e)` → `localThumbnailUrl`。
- **原始格式不可从 `img.src` 得知**：缩略图由客户端 canvas 统一重编码为 `image/webp`（`gJ="image/webp"`, `g0="webp"`），webp 不受支持时回退 `image/jpeg`；`l4` 逻辑据此追加 `fmt=jpeg`。原始文件名（含扩展名）只存在于应用状态 `file_name`，不在 DOM。
- 若要从 API 拿原图，需从 `history_messages` 返回的 `files[].signed_path` 自行拼接；`signed_path` 为签名路径，会过期。

---

## 任务 6：内部 JSON API（仅公开证据 / bundle 静态字符串，**未发起任何鉴权请求**）

从 bundle 提取的路由清单（节选）：
```
/api/v0/chat/history_messages        ← 加载某会话全部消息（query: chat_session_id）
/api/v0/chat/completion | continue | regenerate | edit_message | stop_stream | resume_stream
/api/v0/chat/create_pow_challenge    ← 发送前 PoW 挑战
/api/v0/chat_session/fetch_page      ← 侧栏会话分页列表
/api/v0/chat_session/create|delete|delete_all|update_title|batch_update_pinned
/api/v0/file/upload_file  ·  /api/v0/file/fetch_files
/api/v0/share/content?share_id=      ← 公开，无需 token（已实测 200）
/api/v0/share/create|fork|list|delete
/api/v0/export_all  ·  /api/v0/download_export_history   ← 官方自带导出
```
- **鉴权**：`Authorization: Bearer <token>`，由请求拦截器注入：
```js
onBeforeRequest:[e=>{ ... let{token:s,source:a}=y.getToken();
  return s && (e.headers.Authorization="Bearer ".concat(s)), e }]
```
- **localStorage key**：`userToken`（`d.create("userToken",null,null)`）；同族 key：`__appKit_userInfo`、`settingsJwt`、`__appKit_<id>_fg_*`、`__ds_remote_feature_store`。另有 `window.addEventListener("storage", ...)` 监听 `"userToken"` 变化以跨标签页登出——**这是 localStorage 存储的强证据**，但未登录无法 100% 实测。
- 实测未授权返回：`history_messages` → `INVALID_TOKEN`；`fetch_page` → `Missing Token`。

---

## (c) UNVERIFIED / 无法确认项

1. **未登录，无法观测真实渲染 DOM**——所有类名均来自 bundle 静态字符串，未在浏览器中验证实际节点层级/嵌套关系。
2. **`ds-message` 与 `[data-virtual-list-item-key]` 的嵌套关系未验证**（两者是否同一节点、或父子）。
3. **`.katex` 内是否有 `<annotation encoding="application/x-tex">`**：bundle 无此字符串，但 KaTeX 是在运行时加载的独立 chunk（`n.e(18372)`）；其内部字符串不在主 bundle 中，**无法确认也无法排除**。
4. **用户消息与助手消息的精确 class 区分**未验证（推断依据是 `.ds-assistant-message-main-content` 仅出现在助手分支）。
5. **发送/停止按钮无可依赖的稳定 class**，仅有运行时 mode 状态。
6. **`files.deepseeksvc.com` 图片 URL 未实测**（需真实 `signed_path`）。
7. **hash 类（`_25c7358` 等）与组件的对应关系**由 CSS 规则语义推断（尺寸/布局/交互态），非源码级确认。
8. `userToken` 是否真在 `localStorage`（而非 cookie/内存）——仅 bundle 推断。
9. **未验证**当前构建的 `main.*.js` 哈希何时变更；无构建历史对比。

---

## (d) 选择器稳定性建议

| 层级 | 选择器 | 稳定性 |
|---|---|---|
| ✅ **推荐** | `data-virtual-list-item-key` | **很稳**：应用内部硬依赖（`nG` 常量 + 自身 querySelector），改它等于改自己的滚动逻辑 |
| ✅ **推荐** | `.ds-*` 设计系统类（`ds-markdown`, `ds-assistant-message-main-content`, `ds-think-content`, `ds-markdown-paragraph`, `ds-scroll-area`, `ds-virtual-list`） | **很稳**：设计系统命名空间，非构建哈希，跨构建长寿命 |
| ⚠️ 可用 | `.ds-message`（无样式 marker） | 中：语义清晰但属内部标记，可能被重构移除 |
| ❌ **避免** | `._25c7358`, `_77cefa5`, `_519be07`, `ec4f5d61`, `bf38813a` 等哈希类 | **极易 churn**：每次构建由 CSS Modules 重新哈希；本次已确认 4 个（`_5cadb25`/`_76cd190`/`_608a995`/`abbe3c45`）**已失效** |
| ❌ **避免** | `.ds-icon-button` | 低：仅 2 处 CSS，近乎废弃 |
| ✅ 兜底 | `location.pathname` 解析 `/a/chat/s/([\w-]+)` | **很稳**：与 `ROUTE.AGENT_SESSION` 常量绑定 |

**核心建议**：
1. **优先走 API 而非 DOM** —— `history_messages` 返回结构化消息（`message_id`/`parent_id`/`role`/`fragments`/`files[].signed_path`），可完整还原 markdown 与 LaTeX 原文；DOM 抓取会丢失 wasm 路径的公式。
2. DOM 兜底时**只用 `ds-*` 命名空间 + `data-*` 属性**，完全禁用哈希类；可加"自愈"逻辑：优先 `ds-*`，失败再试哈希类并上报。
3. **不要硬编码资源路径**；用 `commit-id`（当前 `12196914`）与 bundle 哈希（`main.7c490b0c22.js`）做变更检测告警。
4. 分享页（`/share/<id>` + `/api/v0/share/content`）是**唯一免登录**数据入口，适合做无凭证自检用例。

---

### 复现
`python _recon/step2_download.py`（下载 bundle）→ `step4_grep.py`（命中统计）→ `step6_deep.py`（上下文抽取）→ `step9_probe.py`（端点可达性）。
产物：`_recon/dl/main.7c490b0c22.js`、`main.3208e09460.css`、`default-vendors.73c732e189.js`、`grep1.json`、`ctx1..7.txt`、`probe.json`
