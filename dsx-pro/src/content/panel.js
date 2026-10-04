/**
 * 页内主面板：单对话逐条勾选导出 + 批量会话导出
 *
 * 交互设计：
 * - 全局勾选「提问 / 思考 / 回答 / 图片」= 一次性设定；
 * - 每条消息还能单独展开改（覆盖全局），满足"只想导出某几条的某部分"的需求；
 * - 批量页列出侧边栏所有会话，支持全选 / 区间选择（Shift）/ 搜索。
 *
 * @file src/content/panel.js
 */

import { h, icon, createPanel, toast, clear, getRoot, createIsolatedHost, removeHost } from './ui.js';
import { getSettings, getSettingsSync, onSettingsChanged, normalizeRelPath } from '../core/settings.js';
import { SLOTS, SLOT_LABELS, ROLE, ROLE_LABELS, normalizeSlots } from '../core/model.js';
import { FORMATS, runExport, formatNow, writeBatchIndex } from './exportRunner.js';
import { buildMarkdown } from '../core/exporter.js';
import { sendToBackground } from '../core/imagePipeline.js';
import { categoryFolder, parseSubjects } from '../core/aiClassify.js';

/**
 * 创建面板控制器。
 * @param {object} opts { adapter, onOpenOptions }
 */
export function createPanelController(opts = {}) {
  let adapter = opts.adapter;
  let settings = null;
  let launcher = null;
  let panelEls = null;
  let open = false;
  let currentTab = 'current';
  let busy = false;

  /** 单对话页状态 */
  const cur = {
    loaded: false,
    loading: false,
    turns: [],
    slots: normalizeSlots(null),
    formats: [],
    perTurn: new Map(),   // turnId -> slots 覆盖
    excluded: new Set(),  // 被取消勾选的消息 id
    expanded: new Set(),
    showCount: 60,
    error: '',
    lastResult: null,     // 上一次导出的结果（重新渲染后仍然展示）
    /** AI 归类状态 */
    ai: {
      status: 'idle',     // idle | loading | done | error
      result: null,
      error: '',
      override: '',       // '' = 用 AI 结果；指定科目 = 手动归档；'__none__' = 不归档
      cached: false
    }
  };

  /** 批量页状态 */
  const bat = {
    scanned: false,
    scanning: false,
    sessions: [],
    selected: new Set(),
    lastClicked: -1,
    filter: '',
    running: false,
    progress: null,
    log: [],
    /** 会话 id → { result, folder }（批量归类结果，用于列表展示与索引） */
    categories: new Map()
  };

  /* ------------------------------------------------------------ */
  /*                          启动按钮                             */
  /* ------------------------------------------------------------ */

  function createLauncher() {
    if (launcher && launcher.isConnected) return launcher;

    // 按钮住在自己的 Shadow 宿主里：插进站点输入框区域也不会被站点样式影响
    const { host, root } = createIsolatedHost({ position: 'static', display: 'inline-block' }, 'dsx-launcher-host');
    const btn = h('button', {
      class: 'dsx-launcher',
      type: 'button',
      title: 'DeepSeek 对话导出 Pro',
      onClick: e => {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      }
    }, icon('logo', 15), h('span', { text: '导出对话' }));
    root.appendChild(btn);

    // 优先插到输入框附近，失败则固定右下角
    let inserted = false;
    try {
      const anchor = adapter && adapter.resolveUiAnchor ? adapter.resolveUiAnchor() : null;
      if (anchor && anchor.root) {
        anchor.root.insertBefore(host, anchor.before || null);
        inserted = (btn.getBoundingClientRect().height > 0) || (host.getBoundingClientRect().height > 0);
        if (!inserted) host.remove();
      }
    } catch (e) {
      if (host.parentElement) host.remove();
    }
    if (!inserted) {
      getRoot().appendChild(host);
      Object.assign(host.style, {
        position: 'fixed', right: '24px', bottom: '96px', zIndex: '2147483000'
      });
      btn.classList.add('dsx-floating');
    }
    launcher = host;
    return host;
  }

  /* ------------------------------------------------------------ */
  /*                            打开/关闭                          */
  /* ------------------------------------------------------------ */

  async function toggle() {
    if (open) close();
    else await show();
  }

  async function show() {
    settings = await getSettings(true);
    cur.slots = cur.loaded ? cur.slots : normalizeSlots(settings.singleSlots);
    if (!cur.formats.length) cur.formats = [settings.defaultFormat || 'md'];
    buildPanel();
    open = true;
    requestAnimationFrame(() => panelEls.panel.classList.add('dsx-open'));
    if (currentTab === 'current') loadTurns();
  }

  function close() {
    if (!panelEls) return;
    panelEls.panel.classList.remove('dsx-open');
    open = false;
  }

  function destroy() {
    close();
    setTimeout(() => {
      if (panelEls) panelEls.panel.remove();
      panelEls = null;
      // 宿主元素也要移除：否则页面里会留下一个空的 #dsx-panel-host
      removeHost();
    }, 240);
    if (launcher) {
      launcher.remove();
      launcher = null;
    }
  }

  /* ------------------------------------------------------------ */
  /*                            面板骨架                           */
  /* ------------------------------------------------------------ */

  function buildPanel() {
    if (panelEls) {
      // 已存在则只刷新内容
      renderTabs();
      renderBody();
      return;
    }
    panelEls = createPanel({
      title: 'DeepSeek 对话导出',
      subtitle: `${adapter ? adapter.siteLabel || adapter.label : ''} · v${chrome.runtime.getManifest().version}`,
      onClose: close,
      onOptions: () => sendToBackground({ type: 'DSX_OPEN_OPTIONS' })
    });
    renderTabs();
    renderBody();
  }

  function renderTabs() {
    const tabs = [
      { id: 'current', label: '当前对话' },
      { id: 'batch', label: '批量导出' }
    ];
    clear(panelEls.tabsEl);
    tabs.forEach(t => {
      panelEls.tabsEl.appendChild(h('button', {
        class: `dsx-tab${currentTab === t.id ? ' dsx-active' : ''}`,
        type: 'button',
        text: t.label,
        onClick: () => {
          currentTab = t.id;
          renderTabs();
          renderBody();
          if (t.id === 'current' && !cur.loaded) loadTurns();
          if (t.id === 'batch' && !bat.scanned) scanSessions();
        }
      }));
    });
  }

  function renderBody() {
    clear(panelEls.foot);
    if (currentTab === 'current') renderCurrentTab();
    else renderBatchTab();
  }

  /* ------------------------------------------------------------ */
  /*                        通用小部件                             */
  /* ------------------------------------------------------------ */

  function section(title, extra) {
    return h('div', { class: 'dsx-sec' },
      h('div', { class: 'dsx-sec-title' }, h('span', { text: title }), extra || null)
    );
  }

  /** 勾选块（chip 风格） */
  function chips(items, isOn, onToggle, opts = {}) {
    return h('div', { class: 'dsx-chips' },
      ...items.map(it => {
        const on = isOn(it);
        const disabled = opts.disabled && opts.disabled(it);
        return h('label', {
          class: `dsx-chip${on ? ' dsx-on' : ''}${disabled ? ' dsx-disabled' : ''}`,
          title: it.hint || '',
          style: disabled ? { opacity: '.45', cursor: 'not-allowed' } : null,
          onClick: e => {
            e.preventDefault();
            if (disabled) return;
            onToggle(it);
          }
        },
          h('span', { class: 'dsx-tick', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" width="11" height="11"><path d="M20 6L9 17l-5-5"/></svg>' }),
          h('span', { text: it.label })
        );
      })
    );
  }

  function logLine(text, kind) {
    bat.log.push({ text, kind, at: Date.now() });
  }

  /* ------------------------------------------------------------ */
  /*                       当前对话 Tab                            */
  /* ------------------------------------------------------------ */

  async function loadTurns(force = false) {
    if (cur.loading) return;
    if (cur.loaded && !force) return;
    cur.loading = true;
    cur.error = '';
    // 单会话页要读的是「当前打开的会话」，清掉批量导出可能残留的目标会话
    if (adapter && 'pendingSessionId' in adapter) adapter.pendingSessionId = '';
    renderBody();

    try {
      if (adapter.isGenerating && adapter.isGenerating()) {
        toast('AI 正在回复，等待生成结束后再读取', 'info', 3200);
        if (adapter.waitForSession) {
          await new Promise(r => setTimeout(r, 1500));
        }
      }
      const turns = await adapter.collectTurns({
        onProgress: (done, total) => {
          cur.loadHint = `已读取 ${done}/${total} 条消息`;
          const el = panelEls && panelEls.body.querySelector('.dsx-load-hint');
          if (el) el.textContent = cur.loadHint;
        }
      });
      cur.turns = turns;
      cur.perTurn.clear();
      cur.excluded.clear();
      cur.loaded = true;
      // 换了会话就清掉旧的归类结果
      cur.ai = { status: 'idle', result: null, error: '', override: '', cached: false };
    } catch (e) {
      cur.error = String(e && e.message || e);
    } finally {
      cur.loading = false;
      if (panelEls) renderBody();
      // 已开启 AI 归类的会话自动判一次（结果有缓存，重复打开不会重复计费）
      const aiCfg = (settings && settings.ai) || {};
      if (aiCfg.enabled && cur.turns.length && cur.ai.status === 'idle') {
        runClassifyCurrent();
      }
    }
  }

  function effectiveSlots(turn) {
    return cur.perTurn.get(turn.id) || cur.slots;
  }

  function renderCurrentTab() {
    const body = panelEls.body;
    const foot = panelEls.foot;
    clear(body);

    /* ---- 标题 + 刷新 ---- */
    body.appendChild(h('div', { class: 'dsx-sec-title' },
      h('span', { text: '会话' }),
      h('span', { class: 'dsx-count', text: adapter.getTitle ? ` · ${adapter.getTitle().slice(0, 28)}` : '' }),
      h('div', { class: 'dsx-spacer' }),
      h('button', {
        class: 'dsx-iconbtn', title: '重新读取对话',
        onClick: () => { cur.loaded = false; loadTurns(true); }
      }, icon('refresh', 14))
    ));

    if (cur.loading) {
      body.appendChild(h('div', { class: 'dsx-empty' },
        h('span', { class: 'dsx-spin' }),
        h('div', { class: 'dsx-load-hint', text: cur.loadHint || '正在读取对话…', style: { marginTop: '10px' } })
      ));
      clear(foot);
      return;
    }

    if (cur.error) {
      body.appendChild(h('div', { class: 'dsx-empty' },
        h('div', { class: 'dsx-hint dsx-err', text: `读取失败：${cur.error}` }),
        h('button', { class: 'dsx-btn dsx-sm', text: '重试', style: { marginTop: '10px' }, onClick: () => loadTurns(true) })
      ));
      clear(foot);
      return;
    }

    if (cur.turns.length === 0) {
      body.appendChild(h('div', { class: 'dsx-empty', text: '这个页面里没有读到消息。请打开一个已有内容的对话，或点右上角刷新。' }));
      clear(foot);
      return;
    }

    /* ---- 上次导出结果（放在最上面，重新渲染也不会丢） ---- */
    renderResultBox(body);

    /* ---- 数据来源提示 ---- */
    if (adapter.lastSource === 'api') {
      body.appendChild(h('div', { class: 'dsx-hint', text: `数据来源：站点接口（公式为 LaTeX 原文，分支结构已按当前对话还原）` }));
    } else {
      const why = adapter.lastError ? `（接口不可用：${adapter.lastError}）` : '';
      body.appendChild(h('div', { class: 'dsx-hint dsx-warn', text: `数据来源：页面 DOM 抓取${why}。若公式显示异常，请在设置页点「诊断当前标签页」把报告发我。` }));
    }

    /* ---- 想导出什么 ---- */
    const counts = countParts(cur.turns);
    const slotChips = SLOTS.map(s => ({
      id: s,
      label: `${SLOT_LABELS[s]}${counts[s] ? ` ${counts[s]}` : ''}`,
      hint: slotHint(s)
    }));
    const slotSec = section('导出内容', h('button', {
      class: 'dsx-btn dsx-sm dsx-ghost', text: '全部',
      onClick: () => { cur.slots = normalizeSlots({ question: true, thinking: true, answer: true, images: true }); cur.perTurn.clear(); renderBody(); }
    }));
    slotSec.appendChild(chips(slotChips, it => cur.slots[it.id], it => {
      cur.slots = { ...cur.slots, [it.id]: !cur.slots[it.id] };
      // 全局改动时清掉逐条覆盖，避免出现"看着勾了却没导出"
      cur.perTurn.clear();
      renderBody();
    }, { disabled: it => counts[it.id] === 0 && it.id !== 'question' }));
    slotSec.appendChild(h('div', { class: 'dsx-hint', text: '这一组是整段对话的默认值；下面每条消息还能单独改。' }));
    body.appendChild(slotSec);

    /* ---- 导出格式 ---- */
    const fmtSec = section('导出格式');
    fmtSec.appendChild(chips(
      Object.entries(FORMATS).map(([id, f]) => ({ id, label: f.label, hint: id === 'docx' ? '公式会转成 Word 可编辑公式' : '' })),
      it => cur.formats.includes(it.id),
      it => {
        const i = cur.formats.indexOf(it.id);
        if (i >= 0) {
          if (cur.formats.length === 1) { toast('至少保留一种格式'); return; }
          cur.formats.splice(i, 1);
        } else {
          cur.formats.push(it.id);
        }
        renderBody();
      }
    ));
    fmtSec.appendChild(h('div', { class: 'dsx-hint', text: 'Word 会把 $公式$ 转成可编辑的 Word 公式；纯文本会去掉 Markdown 标记。' }));
    body.appendChild(fmtSec);

    /* ---- 消息列表 ---- */
    const included = cur.turns.filter(t => !cur.excluded.has(t.id)).length;
    const msgSec = section('消息', h('span', { class: 'dsx-count', text: `已选 ${included}/${cur.turns.length}` }));
    const tools = h('div', { class: 'dsx-row', style: { marginBottom: '8px' } },
      h('button', { class: 'dsx-btn dsx-sm', text: '全选', onClick: () => { cur.excluded.clear(); renderBody(); } }),
      h('button', { class: 'dsx-btn dsx-sm', text: '全不选', onClick: () => { cur.turns.forEach(t => cur.excluded.add(t.id)); renderBody(); } }),
      h('button', { class: 'dsx-btn dsx-sm', text: '只看用户', onClick: () => { cur.turns.forEach(t => { if (t.role !== ROLE.USER) cur.excluded.add(t.id); else cur.excluded.delete(t.id); }); renderBody(); } }),
      h('button', { class: 'dsx-btn dsx-sm', text: '只看 AI', onClick: () => { cur.turns.forEach(t => { if (t.role === ROLE.USER) cur.excluded.add(t.id); else cur.excluded.delete(t.id); }); renderBody(); } })
    );
    msgSec.appendChild(tools);

    const list = h('div', { class: 'dsx-msgs' });
    const shown = cur.turns.slice(0, cur.showCount);
    shown.forEach(turn => list.appendChild(renderTurnRow(turn)));
    msgSec.appendChild(list);
    if (cur.turns.length > cur.showCount) {
      msgSec.appendChild(h('button', {
        class: 'dsx-btn dsx-sm dsx-block', style: { marginTop: '8px' },
        text: `显示更多（还有 ${cur.turns.length - cur.showCount} 条）`,
        onClick: () => { cur.showCount += 80; renderBody(); }
      }));
    }
    body.appendChild(msgSec);

    /* ---- AI 归类 ---- */
    renderAiSection(body);

    /* ---- 底部操作 ---- */
    clear(foot);
    const summary = summarize(cur);
    const cat = currentCategory();
    foot.appendChild(h('div', {
      style: { flex: '1', fontSize: '11.5px', color: 'var(--dsx-text-faint)', lineHeight: '1.4' },
      text: cat ? `${summary} · 归档到 ${cat}` : summary
    }));
    foot.appendChild(h('button', {
      class: 'dsx-btn dsx-sm', title: '把当前勾选的内容复制成 Markdown',
      onClick: () => copyCurrent()
    }, icon('copy', 13), h('span', { text: '复制' })));
    foot.appendChild(h('button', {
      class: 'dsx-btn dsx-sm dsx-primary',
      disabled: busy || included === 0,
      onClick: () => doExport()
    }, icon('download', 13), h('span', { text: '导出' })));
  }

  function slotHint(s) {
    return {
      question: '用户发出的问题',
      thinking: 'AI 的深度思考过程',
      answer: 'AI 的最终回答',
      images: '对话里上传/生成的图片'
    }[s] || '';
  }

  function countParts(turns) {
    const c = { question: 0, thinking: 0, answer: 0, images: 0 };
    turns.forEach(t => {
      if ((t.question || '').trim()) c.question++;
      if ((t.thinking || '').trim()) c.thinking++;
      if ((t.answer || '').trim()) c.answer++;
      c.images += (t.images || []).length;
    });
    return c;
  }

  /** 一条消息（含展开后的逐条勾选） */
  function renderTurnRow(turn) {
    const slots = effectiveSlots(turn);
    const overridden = cur.perTurn.has(turn.id);
    const checked = !cur.excluded.has(turn.id);
    const preview = (turn.answer || turn.question || turn.thinking || '').replace(/\s+/g, ' ').slice(0, 90);

    const head = h('div', { class: 'dsx-msg-head' },
      h('input', {
        class: 'dsx-check', type: 'checkbox', checked,
        onClick: e => {
          e.stopPropagation();
          if (cur.excluded.has(turn.id)) cur.excluded.delete(turn.id);
          else cur.excluded.add(turn.id);
          renderBody();
        }
      }),
      h('span', { class: `dsx-role${turn.role === ROLE.USER ? ' dsx-user' : ''}`, text: ROLE_LABELS[turn.role] || turn.role }),
      h('div', { class: `dsx-msg-text${preview ? '' : ' dsx-empty'}`, text: preview || '（无文本内容）' }),
      (turn.images || []).length
        ? h('span', { class: 'dsx-count', text: `🖼${turn.images.length}` })
        : null,
      h('span', {
        class: 'dsx-msg-toggle', text: cur.expanded.has(turn.id) ? '▾' : '▸',
        style: { color: 'var(--dsx-text-faint)', fontSize: '11px', marginTop: '2px' }
      })
    );
    head.addEventListener('click', e => {
      if (e.target.tagName === 'INPUT') return;
      if (cur.expanded.has(turn.id)) cur.expanded.delete(turn.id);
      else cur.expanded.add(turn.id);
      renderBody();
    });

    const wrap = h('div', { class: `dsx-msg${checked ? '' : ' dsx-off'}` }, head);

    if (cur.expanded.has(turn.id)) {
      const bodyWrap = h('div', { class: 'dsx-msg-body' });
      const available = {
        question: !!(turn.question || '').trim(),
        thinking: !!(turn.thinking || '').trim(),
        answer: !!(turn.answer || '').trim(),
        images: (turn.images || []).length > 0
      };
      // 只显示这条消息真正拥有的内容项：用户消息不该出现「思考/回答」，
      // 否则用户会以为勾了没生效
      const usable = SLOTS.filter(s => available[s]);
      if (usable.length === 0) {
        bodyWrap.appendChild(h('div', { class: 'dsx-hint', text: '这条消息没有可导出的内容。' }));
      } else {
        const parts = h('div', { class: 'dsx-msg-parts' },
          ...usable.map(s => {
            const on = !!slots[s];
            return h('label', {
              class: `dsx-chip dsx-mini${on ? ' dsx-on' : ''}`,
              title: slotHint(s),
              onClick: e => {
                e.preventDefault();
                e.stopPropagation();
                const next = { ...slots, [s]: !slots[s] };
                cur.perTurn.set(turn.id, next);
                renderBody();
              }
            },
              h('span', { class: 'dsx-tick', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" width="10" height="10"><path d="M20 6L9 17l-5-5"/></svg>' }),
              h('span', { text: SLOT_LABELS[s] })
            );
          })
        );
        bodyWrap.appendChild(parts);
      }
      if (overridden) {
        bodyWrap.appendChild(h('div', { class: 'dsx-row', style: { marginTop: '6px' } },
          h('span', { class: 'dsx-count', text: '这一条已单独设置' }),
          h('button', {
            class: 'dsx-btn dsx-sm dsx-ghost', text: '恢复跟随全局',
            onClick: e => { e.stopPropagation(); cur.perTurn.delete(turn.id); renderBody(); }
          })
        ));
      }
      const previewText = (turn.thinking ? `【思考】\n${turn.thinking}\n\n` : '') + (turn.answer || turn.question || '');
      if (previewText.trim()) {
        bodyWrap.appendChild(h('div', { class: 'dsx-preview', text: previewText.slice(0, 1200) }));
      }
      if ((turn.images || []).length) {
        const thumbs = h('div', { class: 'dsx-thumbs' });
        turn.images.forEach(img => {
          thumbs.appendChild(h('div', {
            class: `dsx-thumb${slots.images ? '' : ' dsx-thumb-off'}`,
            title: img.src.slice(0, 120)
          }, h('img', { src: img.src, loading: 'lazy', alt: img.alt || '图片' })));
        });
        bodyWrap.appendChild(thumbs);
      }
      wrap.appendChild(bodyWrap);
    }
    return wrap;
  }

  function summarize() {
    const turns = selectedTurns();
    const n = turns.length;
    const imgs = turns.reduce((a, t) => a + ((effectiveSlots(t).images ? (t.images || []).length : 0)), 0);
    const parts = [];
    parts.push(`本次将导出 ${n} 条消息`);
    if (imgs) parts.push(`${imgs} 张图片`);
    parts.push(`格式：${cur.formats.map(f => FORMATS[f].label).join(' + ')}`);
    return parts.join(' · ');
  }

  function selectedTurns() {
    return cur.turns
      .filter(t => !cur.excluded.has(t.id))
      .map(t => ({ ...t, __slots: effectiveSlots(t) }))
      .filter(t => SLOTS.some(s => t.__slots[s] && hasContent(t, s)));
  }

  function hasContent(turn, slot) {
    if (slot === 'images') return (turn.images || []).length > 0;
    return !!(turn[slot] || '').trim();
  }

  /* ------------------------------------------------------------ */
  /*                        AI 归类                                */
  /* ------------------------------------------------------------ */

  /** 取一段有代表性的正文送给分类模型：首个提问 + 首段回答 */
  function sampleTextForClassify(turns) {
    const q = (turns || []).find(t => t.role === ROLE.USER && (t.question || '').trim());
    const a = (turns || []).find(t => t.role === ROLE.ASSISTANT && (t.answer || '').trim());
    return [q && q.question, a && a.answer]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, (settings && settings.ai && settings.ai.maxChars) || 900);
  }

  /** 当前应当使用的归档目录（'' 表示不归档） */
  function currentCategory() {
    const ai = (settings && settings.ai) || {};
    if (!ai.enabled || ai.routeByCategory === false) return '';
    if (cur.ai.override === '__none__') return '';
    if (cur.ai.override) {
      if (cur.ai.override === '__nonqa__') return categoryFolder({ knowledge: false }, ai);
      const hit = parseSubjects(ai.subjects).find(s => s.full === cur.ai.override);
      if (hit) return categoryFolder({ knowledge: true, subject: hit.parent || hit.full, sub: hit.parent ? hit.leaf : '' }, ai);
      return '';
    }
    if (!cur.ai.result) return '';
    return categoryFolder(cur.ai.result, ai);
  }

  /** 调后台做分类（API Key 不经过内容脚本） */
  async function classifyTurns(turns, { silent = false } = {}) {
    const ai = (settings && settings.ai) || {};
    if (!ai.enabled) return { ok: false, error: 'AI 归类未开启', disabled: true };
    const title = adapter.getTitle ? adapter.getTitle() : '';
    const text = sampleTextForClassify(turns);
    if (!text) return { ok: false, error: '没有可用来判断的正文' };

    const resp = await sendToBackground({ type: 'DSX_AI_CLASSIFY', title, text });
    if (!resp || !resp.ok) {
      const err = (resp && resp.error) || '归类请求失败';
      if (resp && resp.error === 'NEED_PERMISSION') {
        return { ok: false, error: `缺少接口域名的访问权限（${resp.origin}）`, needPermission: true, origin: resp.origin };
      }
      if (!silent) logLine(`归类失败：${err}`, 'err');
      return { ok: false, error: err, noKey: !!(resp && resp.noKey) };
    }
    return { ok: true, result: resp.result, cached: !!resp.cached };
  }

  async function runClassifyCurrent() {
    if (cur.ai.status === 'loading') return;
    cur.ai.status = 'loading';
    cur.ai.error = '';
    renderBody();
    const r = await classifyTurns(cur.turns);
    if (r.ok) {
      cur.ai.status = 'done';
      cur.ai.result = r.result;
      cur.ai.cached = r.cached;
      cur.ai.override = '';
    } else {
      cur.ai.status = 'error';
      cur.ai.error = r.error;
      cur.ai.needPermission = r.needPermission;
    }
    renderBody();
  }

  /** 归类结果展示区（单对话页） */
  function renderAiSection(container) {
    const ai = (settings && settings.ai) || {};
    if (!ai.enabled) return;

    const sec = h('div', { class: 'dsx-sec' });
    sec.appendChild(h('div', { class: 'dsx-sec-title' },
      h('span', { text: 'AI 归类' }),
      h('div', { class: 'dsx-spacer' }),
      h('button', {
        class: 'dsx-btn dsx-sm dsx-ghost',
        text: cur.ai.status === 'loading' ? '判断中…' : (cur.ai.result ? '重新判断' : '开始判断'),
        disabled: cur.ai.status === 'loading',
        onClick: () => runClassifyCurrent()
      })
    ));

    if (cur.ai.status === 'error') {
      sec.appendChild(h('div', { class: 'dsx-hint dsx-err', text: `归类失败：${cur.ai.error}` }));
      if (cur.ai.needPermission) {
        sec.appendChild(h('div', { class: 'dsx-row', style: { marginTop: '6px' } },
          h('button', {
            class: 'dsx-btn dsx-sm', text: '去设置页授权',
            onClick: () => sendToBackground({ type: 'DSX_OPEN_OPTIONS' })
          })
        ));
      }
    } else if (cur.ai.result) {
      const r = cur.ai.result;
      const tag = r.knowledge === false ? '非知识答疑' : '知识答疑';
      const subject = [r.subject, r.sub].filter(Boolean).join(' / ') || '未分类';
      sec.appendChild(h('div', { class: 'dsx-hint' },
        h('span', { text: `${tag} · ${subject}` }),
        r.reason ? h('span', { text: `（${r.reason}）` }) : null,
        cur.ai.cached ? h('span', { text: ' · 来自缓存' }) : null
      ));
    } else {
      sec.appendChild(h('div', { class: 'dsx-hint', text: '点「开始判断」让模型判断这是否知识答疑、属于哪个科目，导出时会按结果分文件夹归档。' }));
    }

    // 手动覆盖
    const subjects = parseSubjects(ai.subjects);
    const sel = h('select', {
      class: 'dsx-input', style: { marginTop: '8px' },
      onChange: e => { cur.ai.override = e.target.value; renderBody(); }
    },
      h('option', { value: '', text: '自动（用 AI 判断结果）' }),
      h('option', { value: '__none__', text: '不归档（直接放根目录）' }),
      h('option', { value: '__nonqa__', text: '归到「非知识答疑」' }),
      ...subjects.map(s => h('option', { value: s.full, text: `指定为「${s.full.replace('/', ' / ')}」` }))
    );
    sel.value = cur.ai.override;
    sec.appendChild(sel);

    const cat = currentCategory();
    sec.appendChild(h('div', { class: 'dsx-pathbox', style: { marginTop: '8px' } },
      h('b', { text: '归档到：' }),
      cat || '（不归档，直接放在导出根目录）'
    ));
    container.appendChild(sec);
  }

  async function copyCurrent() {
    const turns = selectedTurns();
    if (!turns.length) { toast('没有可复制的内容', 'err'); return; }
    const { markdown } = buildMarkdown({
      title: adapter.getTitle ? adapter.getTitle() : '对话记录',
      turns,
      slots: cur.slots,
      meta: { site: adapter.siteLabel || adapter.label, url: location.href, time: formatNow() }
    });
    try {
      await navigator.clipboard.writeText(markdown);
      toast('已复制 Markdown 到剪贴板', 'ok');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = markdown;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('已复制 Markdown 到剪贴板', 'ok');
    }
  }

  async function doExport() {
    const turns = selectedTurns();
    if (!turns.length) { toast('没有勾选任何可导出的内容', 'err'); return; }
    busy = true;
    renderBusy('正在导出…');
    try {
      const aiCfg = (settings && settings.ai) || {};
      // 开了归类但还没判过 → 导出前先判一次
      if (aiCfg.enabled && aiCfg.routeByCategory && !cur.ai.result && !cur.ai.override) {
        renderBusy('正在判断归档分类…');
        const r = await classifyTurns(turns, { silent: true });
        if (r.ok) {
          cur.ai.result = r.result;
          cur.ai.status = 'done';
          cur.ai.cached = r.cached;
        } else {
          logLine(`归类失败，本次不归档：${r.error}`, 'err');
        }
      }
      const category = currentCategory();
      if (category) logLine(`归档目录：${category}`, 'ok');

      const result = await runExport({
        turns,
        slots: cur.slots,
        formats: cur.formats,
        title: adapter.getTitle ? adapter.getTitle() : '对话记录',
        site: adapter.siteLabel || adapter.label,
        url: location.href,
        sessionId: adapter.getSessionId ? adapter.getSessionId() : '',
        mode: 'single',
        category,
        onLog: (msg, kind) => logLine(msg, kind),
        onProgress: (done, total, label) => renderBusy(label, done / Math.max(1, total))
      });
      showResult(result);
      if (result.ok) {
        toast(result.usedDirHandle
          ? `已写入授权文件夹（${result.files.length} 个文件）`
          : `已开始下载 ${result.files.length} 个文件`, 'ok', 3600);
      }
    } catch (e) {
      toast(`导出失败：${e.message}`, 'err', 5000);
      logLine(`导出失败：${e.message}`, 'err');
    } finally {
      busy = false;
      if (panelEls) renderBody();
    }
  }

  function renderBusy(label, ratio) {
    if (!panelEls) return;
    clear(panelEls.foot);
    panelEls.foot.appendChild(h('div', { style: { flex: '1' } },
      h('div', { style: { fontSize: '12px', color: 'var(--dsx-text-dim)' }, text: label || '处理中…' }),
      h('div', { class: 'dsx-progress' },
        h('i', { style: { width: `${Math.round((ratio || 0) * 100)}%` } }))
    ));
  }

  function showResult(result) {
    // 结果先存进状态：紧接着的 renderBody() 会清空 body，
    // 只 insertBefore 的话用户根本看不到「导到哪里去了」
    cur.lastResult = result;
  }

  /** 渲染上一次导出结果（在每次 renderBody 时重建，保证不被冲掉） */
  function renderResultBox(container) {
    const result = cur.lastResult;
    if (!result) return;
    const box = h('div', { class: 'dsx-sec' });
    box.appendChild(h('div', { class: 'dsx-sec-title' },
      h('span', { text: result.ok ? '上次导出完成' : '上次导出未完成' }),
      h('div', { class: 'dsx-spacer' }),
      h('button', {
        class: 'dsx-btn dsx-sm dsx-ghost', text: '知道了',
        onClick: () => { cur.lastResult = null; renderBody(); }
      })
    ));
    box.appendChild(h('div', { class: 'dsx-pathbox' },
      h('b', { text: '目标位置：' }),
      result.usedDirHandle ? '已授权文件夹' : `浏览器下载目录 / ${result.baseFolder || ''}`
    ));
    if (result.files && result.files.length) {
      const list = h('div', { class: 'dsx-log' });
      result.files.slice(0, 40).forEach(f => {
        list.appendChild(h('div', {
          class: f.kind === 'image' ? '' : 'dsx-ok',
          text: `${f.kind === 'image' ? '🖼' : '📄'} ${f.path}${f.bytes ? `  (${fmtSize(f.bytes)})` : ''}`
        }));
      });
      box.appendChild(list);
    }
    (result.warnings || []).forEach(w => box.appendChild(h('div', { class: 'dsx-hint dsx-warn', text: w })));
    container.appendChild(box);
  }

  /* ------------------------------------------------------------ */
  /*                        批量导出 Tab                           */
  /* ------------------------------------------------------------ */

  async function scanSessions() {
    if (bat.scanning) return;
    bat.scanning = true;
    renderBody();
    try {
      const sessions = await adapter.listSessions({
        onProgress: n => {
          bat.scanHint = `已找到 ${n} 个会话…`;
          const el = panelEls && panelEls.body.querySelector('.dsx-load-hint');
          if (el) el.textContent = bat.scanHint;
        }
      });
      bat.sessions = sessions;
      bat.selected = new Set(sessions.map(s => s.id));
      bat.scanned = true;
    } catch (e) {
      bat.error = String(e && e.message || e);
    } finally {
      bat.scanning = false;
      if (panelEls) renderBody();
    }
  }

  function renderBatchTab() {
    const body = panelEls.body;
    const foot = panelEls.foot;
    clear(body);
    clear(foot);

    if (!settings) settings = getSettingsSyncSafe();

    // 批量页要显示「实际会写到哪里」：授权文件夹与下载目录是两套路径，别让用户猜
    const batchFolder = normalizeRelPath(settings.batchFolder);
    const dirBase = normalizeRelPath(settings.dirSubfolder || '');
    const subLine = settings.batchSubfolder
      ? h('div', { style: { marginTop: '4px' } }, `每个会话再建子文件夹：${settings.batchSubfolderPattern}`)
      : null;
    const info = h('div', { class: 'dsx-sec' },
      h('div', { class: 'dsx-sec-title' }, h('span', { text: '导出位置' })),
      h('div', { class: 'dsx-pathbox' },
        h('div', {}, h('b', { text: '已授权文件夹：' }),
          settings.useDirectoryHandle ? `（授权目录）${dirBase ? ' / ' + dirBase : ''}` : '未启用'),
        h('div', { style: { marginTop: '4px' } }, h('b', { text: '下载目录：' }), batchFolder || '(下载目录根)'),
        subLine
      ),
      h('div', { class: 'dsx-hint', text: '两套路径互不叠加：授权了真实文件夹时，只会在它内部建分类/会话子目录，不会再套一层「下载目录相对路径」。' })
    );
    info.appendChild(h('div', { class: 'dsx-row', style: { marginTop: '8px' } },
      h('button', {
        class: 'dsx-btn dsx-sm', text: '打开设置页',
        onClick: () => sendToBackground({ type: 'DSX_OPEN_OPTIONS' })
      })
    ));
    body.appendChild(info);

    if (bat.scanning) {
      body.appendChild(h('div', { class: 'dsx-empty' },
        h('span', { class: 'dsx-spin' }),
        h('div', { class: 'dsx-load-hint', text: bat.scanHint || '正在扫描侧边栏会话…', style: { marginTop: '10px' } }),
        h('div', { class: 'dsx-hint', text: '扫描时会自动滚动侧边栏以加载更多历史。', style: { marginTop: '8px' } })
      ));
      return;
    }

    if (bat.error) {
      body.appendChild(h('div', { class: 'dsx-empty' },
        h('div', { class: 'dsx-hint dsx-err', text: `扫描失败：${bat.error}` }),
        h('button', { class: 'dsx-btn dsx-sm', text: '重试', style: { marginTop: '10px' }, onClick: () => { bat.scanned = false; scanSessions(); } })
      ));
      return;
    }

    if (!bat.scanned) {
      body.appendChild(h('div', { class: 'dsx-empty' },
        h('button', { class: 'dsx-btn dsx-primary', text: '扫描会话列表', onClick: () => scanSessions() })
      ));
      return;
    }

    if (bat.sessions.length === 0) {
      body.appendChild(h('div', { class: 'dsx-empty', text: '没有扫描到会话。请确认左侧会话列表是展开状态，然后重试。' }));
      return;
    }

    /* 筛选 + 工具 */
    const filtered = bat.sessions.filter(s => !bat.filter || s.title.toLowerCase().includes(bat.filter.toLowerCase()));
    const sec = section('会话', h('span', { class: 'dsx-count', text: `已选 ${bat.selected.size}/${bat.sessions.length}` }));
    sec.appendChild(h('input', {
      class: 'dsx-input', type: 'search', placeholder: '搜索会话标题…', value: bat.filter,
      onInput: e => { bat.filter = e.target.value; renderBody(); }
    }));
    sec.appendChild(h('div', { class: 'dsx-row', style: { marginTop: '8px' } },
      h('button', { class: 'dsx-btn dsx-sm', text: '全选', onClick: () => { bat.sessions.forEach(s => bat.selected.add(s.id)); renderBody(); } }),
      h('button', { class: 'dsx-btn dsx-sm', text: '全不选', onClick: () => { bat.selected.clear(); renderBody(); } }),
      h('button', { class: 'dsx-btn dsx-sm', text: '仅选搜索结果', onClick: () => { filtered.forEach(s => bat.selected.add(s.id)); renderBody(); } }),
      h('button', { class: 'dsx-iconbtn', title: '重新扫描', onClick: () => { bat.scanned = false; scanSessions(); } }, icon('refresh', 14))
    ));

    const list = h('div', { class: 'dsx-msgs', style: { marginTop: '8px' } });
    filtered.slice(0, 400).forEach((s, idx) => {
      const realIdx = bat.sessions.indexOf(s);
      list.appendChild(h('div', {
        class: `dsx-sess${s.active ? ' dsx-cur' : ''}`,
        onClick: e => {
          if (e.shiftKey && bat.lastClicked >= 0) {
            const [a, b] = [bat.lastClicked, realIdx].sort((x, y) => x - y);
            for (let i = a; i <= b; i++) bat.selected.add(bat.sessions[i].id);
          } else {
            if (bat.selected.has(s.id)) bat.selected.delete(s.id);
            else bat.selected.add(s.id);
            bat.lastClicked = realIdx;
          }
          renderBody();
        }
      },
        h('input', {
          class: 'dsx-check', type: 'checkbox', checked: bat.selected.has(s.id),
          onClick: e => {
            e.stopPropagation();
            if (bat.selected.has(s.id)) bat.selected.delete(s.id);
            else bat.selected.add(s.id);
            bat.lastClicked = realIdx;
            renderBody();
          }
        }),
        h('span', { class: 'dsx-sess-idx', text: String(realIdx + 1) }),
        h('span', { class: 'dsx-sess-title', title: s.title, text: s.title }),
        (() => {
          const c = bat.categories.get(s.id);
          if (!c) return null;
          return h('span', { class: 'dsx-count', text: c.folder || '未分类' });
        })(),
        s.active ? h('span', { class: 'dsx-count', text: '当前' }) : null
      ));
    });
    sec.appendChild(list);
    sec.appendChild(h('div', { class: 'dsx-hint', text: '提示：按住 Shift 点一下可以选中一整段。' }));
    body.appendChild(sec);

    /* 本次批量使用的内容/格式（默认取设置页） */
    const useSec = section('本次导出内容');
    const useSlots = normalizeSlots(bat.slots || settings.batchSlots);
    bat.slots = useSlots;
    useSec.appendChild(chips(SLOTS.map(s => ({ id: s, label: SLOT_LABELS[s] })), it => useSlots[it.id], it => {
      useSlots[it.id] = !useSlots[it.id];
      renderBody();
    }));
    const useFmts = bat.formats || (settings.batchFormats || ['md']).slice();
    bat.formats = useFmts;
    useSec.appendChild(h('div', { class: 'dsx-row', style: { marginTop: '8px' } },
      ...Object.entries(FORMATS).map(([id, f]) => h('label', {
        class: `dsx-chip dsx-mini${useFmts.includes(id) ? ' dsx-on' : ''}`,
        onClick: e => {
          e.preventDefault();
          const i = useFmts.indexOf(id);
          if (i >= 0) { if (useFmts.length === 1) { toast('至少保留一种格式'); return; } useFmts.splice(i, 1); }
          else useFmts.push(id);
          renderBody();
        }
      },
        h('span', { class: 'dsx-tick', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" width="10" height="10"><path d="M20 6L9 17l-5-5"/></svg>' }),
        h('span', { text: f.label })
      ))
    ));
    useSec.appendChild(h('div', { class: 'dsx-hint', text: '这里的默认值来自设置页；临时改动不会保存。' }));
    body.appendChild(useSec);

    if (bat.log.length) {
      const logSec = section('进度');
      const logBox = h('div', { class: 'dsx-log' });
      bat.log.slice(-60).forEach(l => logBox.appendChild(h('div', { class: l.kind === 'err' ? 'dsx-err' : l.kind === 'ok' ? 'dsx-ok' : '', text: l.text })));
      logSec.appendChild(logBox);
      body.appendChild(logSec);
    }

    /* 底部 */
    const n = bat.selected.size;
    foot.appendChild(h('div', {
      style: { flex: '1', fontSize: '11.5px', color: 'var(--dsx-text-faint)' },
      text: bat.running ? (bat.progress || '导出中…') : `将导出 ${n} 个会话`
    }));
    if (bat.running) {
      foot.appendChild(h('button', { class: 'dsx-btn dsx-sm', text: '停止', onClick: () => { bat.cancel = true; toast('将在当前会话结束后停止'); } }));
    } else {
      foot.appendChild(h('button', {
        class: 'dsx-btn dsx-sm dsx-primary', disabled: n === 0,
        onClick: () => runBatch()
      }, icon('download', 13), h('span', { text: `导出 ${n} 个` })));
    }
  }

  async function runBatch() {
    if (bat.running) return;
    const chosen = bat.sessions.filter(s => bat.selected.has(s.id));
    if (!chosen.length) return;

    bat.running = true;
    bat.cancel = false;
    bat.log = [];
    renderBody();

    const entries = [];
    let okCount = 0;
    let failCount = 0;

    for (let i = 0; i < chosen.length; i++) {
      if (bat.cancel) {
        logLine('已被用户停止', 'err');
        break;
      }
      const s = chosen[i];
      bat.progress = `[${i + 1}/${chosen.length}] ${s.title}`;
      logLine(`开始：${s.title}`, 'ok');
      renderBody();

      try {
        const opened = await adapter.openSession(s);
        if (!opened) {
          throw new Error('打开会话超时');
        }
        const turns = await adapter.collectTurns({});
        if (!turns.length) {
          logLine(`  ↳ 没有读到消息，跳过`, 'err');
          failCount++;
          continue;
        }

        // AI 归类：失败不阻断导出，只是不归档
        let category = '';
        const aiCfg = (settings && settings.ai) || {};
        if (aiCfg.enabled && aiCfg.routeByCategory) {
          const cr = await classifyTurns(turns, { silent: true });
          if (cr.ok) {
            category = categoryFolder(cr.result, aiCfg);
            const tag = cr.result.knowledge === false ? '非知识答疑' : [cr.result.subject, cr.result.sub].filter(Boolean).join('/') || '未分类';
            logLine(`  ↳ 归类：${tag}${cr.cached ? '（缓存）' : ''}${category ? ` → ${category}` : ''}`, 'ok');
            bat.categories.set(s.id, { result: cr.result, folder: category });
          } else {
            logLine(`  ↳ 归类失败，本次不归档：${cr.error}`, 'err');
          }
        }

        const result = await runExport({
          turns,
          slots: bat.slots,
          formats: bat.formats,
          title: s.title || adapter.getTitle(),
          site: adapter.siteLabel || adapter.label,
          url: s.href || location.href,
          sessionId: s.id,
          mode: 'batch',
          batchIndex: i,
          category,
          keepSubfolder: aiCfg.enabled && category ? aiCfg.keepSessionSubfolder !== false : undefined,
          onLog: (m, k) => logLine(`  ↳ ${m}`, k)
        });
        if (result.ok) {
          okCount++;
          entries.push({
            title: s.title,
            messageCount: turns.length,
            category: category || '',
            files: result.files.map(f => f.path.split('/').pop())
          });
          logLine(`  ↳ 完成：${result.files.length} 个文件`, 'ok');
        } else {
          failCount++;
          logLine(`  ↳ 失败：${(result.warnings || []).join('；')}`, 'err');
        }
      } catch (e) {
        failCount++;
        logLine(`  ↳ 异常：${e.message}`, 'err');
      }
      renderBody();
      await sleep(300);
    }

    // 索引文件
    if (settings.batchIndex && entries.length) {
      try {
        const p = await writeBatchIndex(entries, settings, (m, k) => logLine(m, k));
        logLine(p ? `已生成索引文件：${p}` : '索引文件未生成', p ? 'ok' : 'err');
      } catch (e) {
        logLine(`索引生成失败：${e.message}`, 'err');
      }
    }

    bat.running = false;
    bat.progress = '';
    logLine(`全部结束：成功 ${okCount}，失败 ${failCount}`, okCount ? 'ok' : 'err');
    toast(`批量导出完成：成功 ${okCount}，失败 ${failCount}`, okCount ? 'ok' : 'err', 4200);
    renderBody();
  }

  /* ------------------------------------------------------------ */
  /*                          工具函数                             */
  /* ------------------------------------------------------------ */

  function fmtSize(bytes) {
    if (!bytes) return '0B';
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
  }

  function getSettingsSyncSafe() {
    const cached = getSettingsSync();
    return cached && cached.batchFolder !== undefined ? cached : (settings || {});
  }

  /* 监听设置变化，实时刷新 */
  onSettingsChanged(next => {
    settings = next;
    if (open && currentTab === 'batch') renderBody();
  });

  return {
    createLauncher,
    show,
    close,
    destroy,
    toggle,
    isOpen: () => open,
    /**
     * 启动按钮是否还在页面上。
     * 注意：悬浮降级时按钮在 Shadow DOM 里，document.getElementById 找不到它，
     * 所以这里用宿主引用 + light DOM 双重判断（否则页面轮询会以为按钮丢了而反复重建）。
     */
    hasLauncher() {
      if (launcher && launcher.isConnected) return true;
      if (document.getElementById('dsx-launcher-host')) return true;
      try {
        const host = document.getElementById('dsx-panel-host');
        return !!(host && host.shadowRoot && host.shadowRoot.getElementById('dsx-launcher-host'));
      } catch (e) {
        return false;
      }
    },
    setAdapter(a) { adapter = a; }
  };
}

/** 与 settings.js 的同步缓存对接：首帧用它兜底，避免面板闪空白 */

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
