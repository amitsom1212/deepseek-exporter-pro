/**
 * 插件 UI 样式（注入 Shadow DOM，与站点样式完全隔离）
 *
 * 所有类名以 dsx- 前缀，颜色走 CSS 变量，跟随系统深浅色。
 *
 * @file src/content/styles.js
 */

export const PANEL_CSS = /* css */ `
:host, .dsx-root {
  --dsx-bg: #ffffff;
  --dsx-bg-soft: #f5f6f8;
  --dsx-bg-elev: #ffffff;
  --dsx-border: #e3e5e9;
  --dsx-border-strong: #cfd3da;
  --dsx-text: #1b1d22;
  --dsx-text-dim: #6b7280;
  --dsx-text-faint: #9ca3af;
  --dsx-accent: #4d6bfe;
  --dsx-accent-soft: #eef1ff;
  --dsx-accent-text: #ffffff;
  --dsx-danger: #e5484d;
  --dsx-ok: #17803d;
  --dsx-warn: #b45309;
  --dsx-warn-soft: #fff7e6;
  --dsx-radius: 10px;
  --dsx-shadow: 0 12px 32px rgba(15, 23, 42, .18);
  --dsx-shadow-sm: 0 2px 8px rgba(15, 23, 42, .10);
  --dsx-font: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", "Source Han Sans SC", sans-serif;
  --dsx-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}

@media (prefers-color-scheme: dark) {
  :host, .dsx-root {
    --dsx-bg: #17181c;
    --dsx-bg-soft: #1f2126;
    --dsx-bg-elev: #23252b;
    --dsx-border: #303239;
    --dsx-border-strong: #3d4048;
    --dsx-text: #e8eaee;
    --dsx-text-dim: #a1a7b3;
    --dsx-text-faint: #7c8391;
    --dsx-accent: #6b83ff;
    --dsx-accent-soft: #262a45;
    --dsx-warn-soft: #2e2618;
    --dsx-shadow: 0 12px 32px rgba(0, 0, 0, .5);
    --dsx-shadow-sm: 0 2px 8px rgba(0, 0, 0, .35);
  }
}

.dsx-root, .dsx-root * {
  box-sizing: border-box;
  font-family: var(--dsx-font);
}

/* ---------------- 启动按钮 ---------------- */
.dsx-launcher {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  margin: 0 6px;
  border: 1px solid var(--dsx-border);
  border-radius: 999px;
  background: var(--dsx-bg-elev);
  color: var(--dsx-text);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: var(--dsx-shadow-sm);
  transition: background .15s, border-color .15s, transform .1s;
  user-select: none;
  white-space: nowrap;
  font-family: var(--dsx-font);
}
.dsx-launcher:hover { border-color: var(--dsx-accent); color: var(--dsx-accent); }
.dsx-launcher:active { transform: scale(.97); }
/* 悬浮模式只调整尺寸；定位交给外层宿主元素（否则两层 fixed 会叠加偏移） */
.dsx-launcher.dsx-floating {
  height: 40px;
  padding: 0 14px;
}
.dsx-launcher svg { width: 15px; height: 15px; flex: none; }

/* ---------------- 面板 ---------------- */
.dsx-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 400px;
  max-width: 96vw;
  z-index: 2147483001;
  display: flex;
  flex-direction: column;
  background: var(--dsx-bg);
  border-left: 1px solid var(--dsx-border);
  box-shadow: var(--dsx-shadow);
  color: var(--dsx-text);
  font-size: 13px;
  line-height: 1.55;
  transform: translateX(102%);
  transition: transform .22s cubic-bezier(.4, 0, .2, 1);
  visibility: hidden;
}
.dsx-panel.dsx-open { transform: translateX(0); visibility: visible; }

.dsx-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--dsx-border);
  flex: none;
}
.dsx-head-title { font-size: 14px; font-weight: 600; }
.dsx-head-sub { color: var(--dsx-text-faint); font-size: 11px; }
.dsx-spacer { flex: 1; }
.dsx-iconbtn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border: none; border-radius: 6px;
  background: transparent; color: var(--dsx-text-dim); cursor: pointer;
}
.dsx-iconbtn:hover { background: var(--dsx-bg-soft); color: var(--dsx-text); }
.dsx-iconbtn svg { width: 15px; height: 15px; }

.dsx-tabs {
  display: flex; gap: 2px; padding: 8px 10px 0; flex: none;
  border-bottom: 1px solid var(--dsx-border);
}
.dsx-tab {
  flex: 1; padding: 7px 8px; border: none; background: transparent;
  color: var(--dsx-text-dim); font-size: 13px; cursor: pointer;
  border-bottom: 2px solid transparent; border-radius: 6px 6px 0 0;
}
.dsx-tab:hover { color: var(--dsx-text); background: var(--dsx-bg-soft); }
.dsx-tab.dsx-active { color: var(--dsx-accent); border-bottom-color: var(--dsx-accent); font-weight: 600; }

.dsx-body { flex: 1; overflow: auto; padding: 12px 14px 20px; }
.dsx-foot {
  flex: none; display: flex; gap: 8px; align-items: center;
  padding: 10px 14px; border-top: 1px solid var(--dsx-border);
  background: var(--dsx-bg-soft);
}

/* ---------------- 区块 ---------------- */
.dsx-sec { margin-bottom: 14px; }
.dsx-sec-title {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; font-weight: 600; color: var(--dsx-text-dim);
  margin: 0 0 8px; text-transform: none;
}
.dsx-sec-title .dsx-count { color: var(--dsx-text-faint); font-weight: 400; }
.dsx-hint { color: var(--dsx-text-faint); font-size: 11px; margin-top: 6px; line-height: 1.5; }
.dsx-hint.dsx-warn { color: var(--dsx-warn); }
.dsx-hint.dsx-err { color: var(--dsx-danger); }

/* ---------------- 勾选块 ---------------- */
.dsx-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.dsx-chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 10px; border: 1px solid var(--dsx-border);
  border-radius: 999px; background: var(--dsx-bg-elev);
  color: var(--dsx-text-dim); font-size: 12px; cursor: pointer;
  user-select: none; transition: all .12s;
}
.dsx-chip:hover { border-color: var(--dsx-border-strong); }
.dsx-chip.dsx-on {
  background: var(--dsx-accent-soft); border-color: var(--dsx-accent);
  color: var(--dsx-accent); font-weight: 600;
}
.dsx-chip input { display: none; }
.dsx-chip .dsx-tick { width: 11px; height: 11px; opacity: .35; }
.dsx-chip.dsx-on .dsx-tick { opacity: 1; }
.dsx-chip.dsx-mini { padding: 3px 8px; font-size: 11px; }

/* ---------------- 消息列表 ---------------- */
.dsx-msgs { border: 1px solid var(--dsx-border); border-radius: var(--dsx-radius); overflow: hidden; }
.dsx-msg { border-bottom: 1px solid var(--dsx-border); background: var(--dsx-bg-elev); }
.dsx-msg:last-child { border-bottom: none; }
.dsx-msg-head {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 8px 10px; cursor: pointer;
}
.dsx-msg-head:hover { background: var(--dsx-bg-soft); }
.dsx-msg.dsx-off .dsx-msg-head { opacity: .5; }
.dsx-role {
  flex: none; padding: 1px 7px; border-radius: 5px; font-size: 11px; font-weight: 600;
  background: var(--dsx-bg-soft); color: var(--dsx-text-dim); margin-top: 1px;
}
.dsx-role.dsx-user { background: var(--dsx-accent-soft); color: var(--dsx-accent); }
.dsx-msg-text {
  flex: 1; min-width: 0; color: var(--dsx-text);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; word-break: break-word;
}
.dsx-msg-text.dsx-empty { color: var(--dsx-text-faint); font-style: italic; }
.dsx-msg-body { padding: 0 10px 10px 10px; border-top: 1px dashed var(--dsx-border); }
.dsx-msg-parts { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 8px; }
.dsx-preview {
  margin-top: 8px; padding: 8px; border-radius: 8px; background: var(--dsx-bg-soft);
  border: 1px solid var(--dsx-border); color: var(--dsx-text-dim);
  font-size: 11.5px; max-height: 220px; overflow: auto; white-space: pre-wrap;
  word-break: break-word; font-family: var(--dsx-mono);
}
.dsx-thumbs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.dsx-thumb {
  width: 62px; height: 62px; border-radius: 6px; overflow: hidden;
  border: 1px solid var(--dsx-border); background: var(--dsx-bg-soft);
  display: flex; align-items: center; justify-content: center;
}
.dsx-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.dsx-thumb.dsx-thumb-off img { filter: grayscale(1) opacity(.35); }

/* ---------------- 复选框 ---------------- */
.dsx-check {
  flex: none; width: 15px; height: 15px; margin-top: 2px;
  border: 1.5px solid var(--dsx-border-strong); border-radius: 4px;
  background: var(--dsx-bg); cursor: pointer; position: relative;
  transition: all .12s; appearance: none; -webkit-appearance: none;
}
.dsx-check:checked { background: var(--dsx-accent); border-color: var(--dsx-accent); }
.dsx-check:checked::after {
  content: ''; position: absolute; left: 4px; top: 1px; width: 4px; height: 8px;
  border: solid #fff; border-width: 0 1.5px 1.5px 0; transform: rotate(45deg);
}
.dsx-check:indeterminate { background: var(--dsx-accent); border-color: var(--dsx-accent); }
.dsx-check:indeterminate::after {
  content: ''; position: absolute; left: 3px; top: 6px; width: 7px; height: 1.5px; background: #fff;
}

/* ---------------- 会话列表（批量） ---------------- */
.dsx-sess {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px;
  border-bottom: 1px solid var(--dsx-border); background: var(--dsx-bg-elev);
  cursor: pointer;
}
.dsx-sess:hover { background: var(--dsx-bg-soft); }
.dsx-sess:last-child { border-bottom: none; }
.dsx-sess-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsx-sess.dsx-cur .dsx-sess-title { color: var(--dsx-accent); font-weight: 600; }
.dsx-sess-idx { flex: none; color: var(--dsx-text-faint); font-size: 11px; font-variant-numeric: tabular-nums; }

/* ---------------- 按钮 ---------------- */
.dsx-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  height: 32px; padding: 0 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--dsx-border); background: var(--dsx-bg-elev);
  color: var(--dsx-text); font-size: 13px; font-weight: 500;
  transition: all .12s; white-space: nowrap;
}
.dsx-btn:hover { border-color: var(--dsx-border-strong); }
.dsx-btn:disabled { opacity: .5; cursor: not-allowed; }
.dsx-btn.dsx-primary { background: var(--dsx-accent); border-color: var(--dsx-accent); color: var(--dsx-accent-text); }
.dsx-btn.dsx-primary:hover:not(:disabled) { filter: brightness(1.08); }
.dsx-btn.dsx-ghost { border-color: transparent; background: transparent; color: var(--dsx-text-dim); }
.dsx-btn.dsx-ghost:hover { background: var(--dsx-bg-soft); color: var(--dsx-text); }
.dsx-btn.dsx-sm { height: 27px; padding: 0 10px; font-size: 12px; }
.dsx-btn svg { width: 14px; height: 14px; }
.dsx-btn.dsx-block { width: 100%; }

.dsx-input {
  width: 100%; height: 30px; padding: 0 9px; font-size: 12.5px;
  border: 1px solid var(--dsx-border); border-radius: 7px;
  background: var(--dsx-bg); color: var(--dsx-text);
}
.dsx-input:focus { outline: none; border-color: var(--dsx-accent); }

.dsx-row { display: flex; align-items: center; gap: 8px; }
.dsx-row + .dsx-row { margin-top: 8px; }
.dsx-row label { color: var(--dsx-text-dim); font-size: 12px; }
.dsx-pathbox {
  font-family: var(--dsx-mono); font-size: 11.5px; color: var(--dsx-text-dim);
  background: var(--dsx-bg-soft); border: 1px solid var(--dsx-border);
  border-radius: 7px; padding: 6px 8px; word-break: break-all;
}
.dsx-pathbox b { color: var(--dsx-text); font-weight: 600; }

/* ---------------- 进度 / 提示 ---------------- */
.dsx-progress { height: 4px; background: var(--dsx-bg-soft); border-radius: 999px; overflow: hidden; margin-top: 8px; }
.dsx-progress > i { display: block; height: 100%; width: 0; background: var(--dsx-accent); transition: width .2s; }
.dsx-log {
  margin-top: 8px; max-height: 150px; overflow: auto;
  font-family: var(--dsx-mono); font-size: 11px; color: var(--dsx-text-faint);
  background: var(--dsx-bg-soft); border-radius: 7px; padding: 7px 8px;
}
.dsx-log div { white-space: pre-wrap; word-break: break-all; }
.dsx-log .dsx-ok { color: var(--dsx-ok); }
.dsx-log .dsx-err { color: var(--dsx-danger); }

.dsx-empty { padding: 22px 10px; text-align: center; color: var(--dsx-text-faint); font-size: 12px; }
.dsx-spin {
  display: inline-block; width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid var(--dsx-border-strong); border-top-color: var(--dsx-accent);
  animation: dsx-spin .8s linear infinite;
}
@keyframes dsx-spin { to { transform: rotate(360deg); } }

/* ---------------- Toast ---------------- */
.dsx-toast-wrap {
  position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%);
  z-index: 2147483002; display: flex; flex-direction: column; gap: 8px;
  align-items: center; pointer-events: none;
}
.dsx-toast {
  padding: 9px 16px; border-radius: 999px; font-size: 13px;
  background: rgba(24, 26, 32, .93); color: #fff; box-shadow: var(--dsx-shadow);
  max-width: 70vw; text-align: center; animation: dsx-in .18s ease-out;
}
.dsx-toast.dsx-err { background: rgba(190, 42, 46, .95); }
.dsx-toast.dsx-ok { background: rgba(19, 118, 62, .95); }
@keyframes dsx-in { from { opacity: 0; transform: translateY(6px); } }
`;
