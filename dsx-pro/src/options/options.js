/**
 * 设置页脚本
 *
 * @file src/options/options.js
 */

import { DEFAULT_SETTINGS, getSettings, saveSettings, resetSettings, normalizeRelPath } from '../core/settings.js';
import { SLOTS, SLOT_LABELS } from '../core/model.js';
import {
  pickDirectory, loadDirHandle, clearDirHandle, dirPermission, requestDirPermission
} from '../core/dirHandle.js';
import {
  AI_PRESETS, parseSubjects, categoryFolder, originPattern, normalizeBaseUrl
} from '../core/aiClassify.js';

const TICK_SVG = '<svg class="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

const FORMAT_LABELS = {
  md: 'Markdown (.md)',
  docx: 'Word (.docx，公式可编辑)',
  txt: '纯文本 (.txt)',
  json: 'JSON (.json)'
};

const IMAGE_FORMATS = [
  { id: 'png', label: 'PNG（推荐，无损）' },
  { id: 'jpeg', label: 'JPEG（体积小）' },
  { id: 'webp', label: 'WEBP（保持网页格式）' },
  { id: 'original', label: '保持原格式（不转码）' }
];

let state = null;
let saveTimer = null;

/* ------------------------------------------------------------------ */
/*                            启动                                      */
/* ------------------------------------------------------------------ */

init().catch(err => toast(`设置页初始化失败：${err.message}`, true));

async function init() {
  state = await getSettings(true);
  fillForm();
  bind();
  refreshDirStatus();
  refreshHostsStatus();
  document.getElementById('version-line').textContent =
    `扩展版本 ${chrome.runtime.getManifest().version} · 设置保存在浏览器本地（chrome.storage.local）`;
}

/* ------------------------------------------------------------------ */
/*                          表单填充                                    */
/* ------------------------------------------------------------------ */

function fillForm() {
  setVal('singleFolder', state.singleFolder);
  setVal('batchFolder', state.batchFolder);
  setChk('batchSubfolder', state.batchSubfolder);
  setVal('batchSubfolderPattern', state.batchSubfolderPattern);
  setChk('batchIndex', state.batchIndex);
  setChk('useDirectoryHandle', state.useDirectoryHandle);
  setVal('dirSubfolder', state.dirSubfolder || '');
  setVal('imageFolder', state.imageFolder);
  setVal('docxImageMaxWidth', state.docxImageMaxWidth);
  setVal('imageQuality', state.imageQuality);
  document.getElementById('quality-value').textContent = Number(state.imageQuality).toFixed(2);
  setChk('verbose', state.verbose);
  setChk('useApi', state.useApi !== false);

  renderChips('singleSlots', SLOTS.map(s => ({ id: s, label: SLOT_LABELS[s] })), slotsToIds(state.singleSlots), ids => {
    state.singleSlots = normalizeSlotsFrom(ids);
  });

  renderChips('batchSlots', SLOTS.map(s => ({ id: s, label: SLOT_LABELS[s] })), slotsToIds(state.batchSlots), ids => {
    state.batchSlots = normalizeSlotsFrom(ids);
    updateDocxHint();
  });

  renderChips('defaultFormat', Object.keys(FORMAT_LABELS).map(id => ({ id, label: FORMAT_LABELS[id] })),
    [state.defaultFormat], ids => {
      state.defaultFormat = ids[ids.length - 1] || 'md';
    }, true);

  renderChips('batchFormats', Object.keys(FORMAT_LABELS).map(id => ({ id, label: FORMAT_LABELS[id] })),
    state.batchFormats || ['md'], ids => {
      state.batchFormats = ids.length ? ids : ['md'];
      updateDocxHint();
    });

  renderChips('imageFormat', IMAGE_FORMATS, [state.imageFormat], ids => {
    state.imageFormat = ids[ids.length - 1] || 'png';
    toggleQualityField();
  }, true);

  renderChips('imageMode', [
    { id: 'folder', label: '存到子目录（推荐）' },
    { id: 'inline', label: '内联进 Markdown（单文件自包含）' }
  ], [state.imageInline ? 'inline' : 'folder'], ids => {
    state.imageInline = (ids[ids.length - 1] || 'folder') === 'inline';
    toggleImageFolderField();
  }, true);

  toggleSubfolderField();
  toggleQualityField();
  toggleImageFolderField();
  updateDocxHint();
  updateSubfolderPreview();
  updateDirPreview();
  fillAiForm();
}

/**
 * 「实际写入位置」预览。
 * 重点是讲清「两套前缀互不叠加」——历史上它们被叠加过，产生了重复嵌套目录。
 */
async function updateDirPreview() {
  const el = document.getElementById('dir-path-preview');
  if (!el) return;
  const useDir = document.getElementById('useDirectoryHandle').checked;
  const dirSub = normalizeRelPath(document.getElementById('dirSubfolder').value);
  const batchFolder = normalizeRelPath(document.getElementById('batchFolder').value) || '(下载目录根)';
  const singleFolder = normalizeRelPath(document.getElementById('singleFolder').value) || '(下载目录根)';
  const rows = [];
  rows.push('<div><b>批量导出</b> → ' + (useDir
    ? `已授权文件夹${dirSub ? ' / ' + escapeHtml(dirSub) : ''} / [分类] / [会话] / 文件`
    : `下载目录 / ${escapeHtml(batchFolder)} / [分类] / [会话] / 文件`) + '</div>');
  rows.push('<div style="margin-top:4px"><b>单独导出</b> → ' + (useDir
    ? `已授权文件夹${dirSub ? ' / ' + escapeHtml(dirSub) : ''} / 文件`
    : `下载目录 / ${escapeHtml(singleFolder)} / 文件`) + '</div>');

  if (useDir) {
    let handle = null;
    try {
      handle = await loadDirHandle();
    } catch (e) { /* 忽略 */ }
    if (!handle) {
      rows.push('<div style="margin-top:6px;color:var(--warn)">⚠ 还没有授权文件夹：请点「选择文件夹并授权」，否则导出会回退到下载目录。</div>');
    } else {
      const perm = await dirPermission(handle, 'readwrite').catch(() => 'denied');
      if (perm !== 'granted') {
        rows.push(`<div style="margin-top:6px;color:var(--warn)">⚠ 授权文件夹「${escapeHtml(handle.name)}」权限已失效，导出会回退到下载目录，请点「重新授权」。</div>`);
      } else {
        rows.push(`<div style="margin-top:6px">已授权：<b>${escapeHtml(handle.name)}</b></div>`);
      }
    }
  }
  el.innerHTML = rows.join('');
}

/* ------------------------------------------------------------------ */
/*                       AI 归类归档                                    */
/* ------------------------------------------------------------------ */
function fillAiForm() {
  // 老版本存的设置里没有 ai 字段，这里补齐，避免后面到处判空
  state.ai = { ...DEFAULT_SETTINGS.ai, ...(state.ai || {}) };
  const ai = state.ai;
  setChk('aiEnabled', ai.enabled);
  setVal('aiBaseUrl', ai.baseUrl);
  setVal('aiApiKey', ai.apiKey);
  setVal('aiModel', ai.model);
  setVal('aiNonQaFolder', ai.nonQaFolder);
  setVal('aiFallbackFolder', ai.fallbackFolder);
  setVal('aiMaxChars', ai.maxChars);
  setChk('aiRouteByCategory', ai.routeByCategory !== false);
  setChk('aiKeepSessionSubfolder', ai.keepSessionSubfolder !== false);
  document.getElementById('aiSubjects').value = (ai.subjects || []).join('\n');

  const cur = normalizeBaseUrl(ai.baseUrl);
  renderChips('aiPreset', AI_PRESETS.map(p => ({ id: p.id, label: p.label })),
    AI_PRESETS.filter(p => normalizeBaseUrl(p.baseUrl) === cur).map(p => p.id),
    ids => {
      const hit = AI_PRESETS.find(p => p.id === ids[ids.length - 1]);
      if (!hit) return;
      state.ai.baseUrl = hit.baseUrl;
      state.ai.model = hit.model;
      setVal('aiBaseUrl', hit.baseUrl);
      setVal('aiModel', hit.model);
      updateAiPreview();
    }, true);

  renderChips('aiRouteMode', [
    { id: 'subject', label: '按学科归档（如 408/数据结构）' },
    { id: 'qa', label: '只分「知识答疑 / 非知识答疑」' }
  ], [ai.routeMode || 'subject'], ids => {
    state.ai.routeMode = ids[ids.length - 1] || 'subject';
    updateAiPreview();
  }, true);

  updateAiPreview();
}

/** 把表单里的 AI 设置读出来（未保存也能用于测试） */
function collectAi() {
  return {
    enabled: document.getElementById('aiEnabled').checked,
    baseUrl: document.getElementById('aiBaseUrl').value.trim() || DEFAULT_SETTINGS.ai.baseUrl,
    apiKey: document.getElementById('aiApiKey').value.trim(),
    model: document.getElementById('aiModel').value.trim() || DEFAULT_SETTINGS.ai.model,
    nonQaFolder: document.getElementById('aiNonQaFolder').value.trim() || '非知识答疑',
    fallbackFolder: document.getElementById('aiFallbackFolder').value.trim() || '未分类',
    maxChars: Math.max(200, Math.min(4000, Number(document.getElementById('aiMaxChars').value) || 900)),
    routeByCategory: document.getElementById('aiRouteByCategory').checked,
    keepSessionSubfolder: document.getElementById('aiKeepSessionSubfolder').checked,
    subjects: document.getElementById('aiSubjects').value
      .split('\n').map(s => s.trim()).filter(Boolean),
    routeMode: (state.ai && state.ai.routeMode) || 'subject',
    jsonMode: (state.ai && state.ai.jsonMode) !== false,
    timeoutMs: (state.ai && state.ai.timeoutMs) || 20000,
    cacheLimit: (state.ai && state.ai.cacheLimit) || 500
  };
}

/** 归档路径预览：让用户一眼看清会生成哪些目录 */
function updateAiPreview() {
  const el = document.getElementById('ai-path-preview');
  if (!el) return;
  const ai = { ...(state.ai || {}), ...collectAi() };
  // 根目录按「实际落盘目标」显示：授权文件夹与下载目录是两套前缀，不叠加
  const useDir = document.getElementById('useDirectoryHandle').checked;
  const dirSub = normalizeRelPath(document.getElementById('dirSubfolder').value);
  const root = useDir
    ? `已授权文件夹${dirSub ? ' / ' + dirSub : ''}`
    : `下载目录 / ${normalizeRelPath(document.getElementById('batchFolder').value) || DEFAULT_SETTINGS.batchFolder}`;
  const sessionPart = document.getElementById('batchSubfolder').checked ? ' / <会话名>' : '';
  const rows = [];

  if (!ai.enabled) {
    el.innerHTML = '未启用 AI 归类 —— 文件直接放在：<b>' + escapeHtml(root) + sessionPart + '</b>';
    return;
  }
  if (ai.routeByCategory === false) {
    el.innerHTML = '已启用判断但不改路径（「按分类归档目录」已关闭）。';
    return;
  }

  const subjects = parseSubjects(ai.subjects);
  const sample = subjects.length ? subjects : [{ full: '数学' }];
  rows.push(`<div>根目录：<b>${escapeHtml(root)}</b>${escapeHtml(sessionPart)} / 文件</div>`);
  rows.push('<div style="margin-top:6px">会按下面这些分类建子目录：</div>');
  const seen = new Set();
  for (const s of sample) {
    const folder = categoryFolder(
      { knowledge: true, subject: s.parent || s.full, sub: s.parent ? s.leaf : '' },
      ai
    );
    if (!folder || seen.has(folder)) continue;
    seen.add(folder);
    rows.push(`<div>　<b>${escapeHtml(folder)}</b>/…</div>`);
  }
  const nonQa = categoryFolder({ knowledge: false }, ai);
  if (nonQa && !seen.has(nonQa)) rows.push(`<div>　<b>${escapeHtml(nonQa)}</b>/…（判断为非知识答疑时）</div>`);
  const fallback = categoryFolder({ knowledge: true, subject: '', sub: '' }, ai);
  if (fallback && !seen.has(fallback)) rows.push(`<div>　<b>${escapeHtml(fallback)}</b>/…（科目对不上时）</div>`);

  el.innerHTML = rows.join('');
}

async function onAiTest() {
  const status = document.getElementById('ai-status');
  const out = document.getElementById('ai-test-out');
  status.textContent = '测试中…';
  status.className = 'tag';
  out.hidden = false;
  out.textContent = '正在调用接口…';
  try {
    const config = collectAi();
    const resp = await chrome.runtime.sendMessage({ type: 'DSX_AI_TEST', config });
    if (resp && resp.ok) {
      status.textContent = '接口正常';
      status.className = 'tag ok';
      const r = resp.result || {};
      out.textContent = `✅ 接口可用
接口：${config.baseUrl}
模型：${config.model}
判断结果：${r.knowledge === false ? '非知识答疑' : '知识答疑'}
科目：${[r.subject, r.sub].filter(Boolean).join(' / ') || '（未分类）'}
理由：${r.reason || '（无）'}`;
    } else if (resp && resp.error === 'NEED_PERMISSION') {
      status.textContent = '缺少域名权限';
      status.className = 'tag warn';
      out.textContent = `接口可以访问，但扩展还没有 ${resp.origin} 的权限。\n请点「授予该接口域名的访问权限」，然后重试。`;
    } else {
      status.textContent = '接口异常';
      status.className = 'tag warn';
      out.textContent = `❌ ${(resp && resp.error) || '测试失败'}`;
    }
  } catch (e) {
    status.textContent = '测试失败';
    status.className = 'tag warn';
    out.textContent = `❌ ${e.message}`;
  }
}

async function onAiGrant() {
  const ai = collectAi();
  const origin = originPattern(ai.baseUrl);
  if (!origin) {
    toast('接口地址无效', true);
    return;
  }
  try {
    const ok = await chrome.permissions.request({ origins: [origin] });
    toast(ok ? `已授予 ${origin}` : '用户取消了授权', !ok);
    if (ok) await onAiTest();
  } catch (e) {
    toast(`授权失败：${e.message}`, true);
  }
}

async function onAiClearCache() {
  try {
    await chrome.runtime.sendMessage({ type: 'DSX_AI_CACHE_CLEAR' });
    toast('归类缓存已清空');
  } catch (e) {
    toast(`清空失败：${e.message}`, true);
  }
}

/** 勾选对象 → 选中项 id 数组（renderChips 要的是数组，不是 {slot:boolean} 对象） */
function slotsToIds(slots) {
  return SLOTS.filter(s => slots && slots[s]);
}

function normalizeSlotsFrom(ids) {
  const out = {};
  for (const s of SLOTS) out[s] = ids.includes(s);
  return out;
}

function setVal(id, v) {
  const el = document.getElementById(id);
  if (el) el.value = v == null ? '' : v;
}
function setChk(id, v) {
  const el = document.getElementById(id);
  if (el) el.checked = !!v;
}

/**
 * 渲染一组 chip 选择器。
 * @param {string} containerId
 * @param {Array<{id:string,label:string}>} items
 * @param {string[]|Record<string,boolean>} selected 选中项 id 数组，或 {id:boolean} 对象
 * @param {(ids:string[])=>void} onChange
 * @param {boolean} [single] 单选模式
 */
function renderChips(containerId, items, selected, onChange, single = false) {
  const box = document.getElementById(containerId);
  if (!box) return;
  // 容错：既接受 id 数组，也接受 {id:boolean} 对象。
  // 这里曾经因为传错类型导致整个设置页初始化失败——设置页挂掉是最糟的失败模式，
  // 所以宁可在这里做归一化，也不要让它抛异常。
  const initial = Array.isArray(selected)
    ? selected.slice()
    : (selected && typeof selected === 'object')
      ? items.filter(it => selected[it.id]).map(it => it.id)
      : [];
  let current = initial;
  box.innerHTML = '';
  const paint = () => {
    box.querySelectorAll('.chip').forEach(chip => {
      chip.classList.toggle('on', current.includes(chip.dataset.id));
    });
  };
  items.forEach(it => {
    const chip = document.createElement('label');
    chip.className = 'chip';
    chip.dataset.id = it.id;
    chip.innerHTML = TICK_SVG + `<span>${escapeHtml(it.label)}</span>`;
    chip.addEventListener('click', e => {
      e.preventDefault();
      if (single) {
        current = [it.id];
      } else if (current.includes(it.id)) {
        if (current.length === 1) {
          toast('至少保留一项');
          return;
        }
        current = current.filter(x => x !== it.id);
      } else {
        current = current.concat(it.id);
      }
      paint();
      onChange(current.slice());
      scheduleSave();
    });
    box.appendChild(chip);
  });
  paint();
}

/* ------------------------------------------------------------------ */
/*                          联动显示                                    */
/* ------------------------------------------------------------------ */

function toggleSubfolderField() {
  const on = document.getElementById('batchSubfolder').checked;
  document.getElementById('subfolder-field').style.display = on ? '' : 'none';
}

function toggleQualityField() {
  const on = state.imageFormat === 'jpeg';
  document.getElementById('quality-field').style.display = on ? '' : 'none';
}

function toggleImageFolderField() {
  const on = !state.imageInline;
  document.getElementById('image-folder-field').style.display = on ? '' : 'none';
}

function updateDocxHint() {
  const el = document.getElementById('slots-hint-docx');
  const usesDocx = (state.batchFormats || []).includes('docx') || state.defaultFormat === 'docx';
  el.textContent = usesDocx
    ? '提示：Word 文档里的数学公式会被转换成 Word 原生公式（可编辑）；图片会内嵌进文档，宽度受下面「Word 图片最大宽度」控制。'
    : '';
}

function updateSubfolderPreview() {
  const pattern = document.getElementById('batchSubfolderPattern').value || '{date}_{title}';
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const sample = pattern
    .replace(/\{date\}/g, `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`)
    .replace(/\{time\}/g, `${p(d.getHours())}${p(d.getMinutes())}`)
    .replace(/\{title\}/g, '如何学习线性代数')
    .replace(/\{index\}/g, '01')
    .replace(/\{id\}/g, 'abc123');
  const el = document.getElementById('subfolder-preview');
  el.innerHTML = `示例：<b>${escapeHtml(sample)}</b>`;
}

/* ------------------------------------------------------------------ */
/*                          事件绑定                                    */
/* ------------------------------------------------------------------ */

function bind() {
  const textIds = ['singleFolder', 'batchFolder', 'batchSubfolderPattern', 'imageFolder', 'docxImageMaxWidth', 'dirSubfolder'];
  textIds.forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      if (id === 'batchSubfolderPattern') updateSubfolderPreview();
      if (id === 'dirSubfolder' || id === 'singleFolder' || id === 'batchFolder') updateDirPreview();
      scheduleSave();
    });
  });

  const chkIds = ['batchSubfolder', 'batchIndex', 'useDirectoryHandle', 'verbose', 'useApi'];
  chkIds.forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
      if (id === 'batchSubfolder') toggleSubfolderField();
      if (id === 'useDirectoryHandle') updateDirPreview();
      scheduleSave();
    });
  });

  document.getElementById('imageQuality').addEventListener('input', e => {
    document.getElementById('quality-value').textContent = Number(e.target.value).toFixed(2);
    state.imageQuality = Number(e.target.value);
    scheduleSave();
  });

  document.getElementById('btn-save').addEventListener('click', () => saveNow(true));

  document.getElementById('btn-pick-dir').addEventListener('click', onPickDir);
  document.getElementById('btn-regrant').addEventListener('click', onRegrant);
  document.getElementById('btn-clear-dir').addEventListener('click', onClearDir);

  document.getElementById('btn-grant-hosts').addEventListener('click', () => requestHosts(true));
  document.getElementById('btn-revoke-hosts').addEventListener('click', () => requestHosts(false));

  document.getElementById('btn-diagnose').addEventListener('click', runDiagnose);
  document.getElementById('btn-copy-diag').addEventListener('click', copyDiagnose);
  document.getElementById('btn-refresh-tabs').addEventListener('click', () => {
    refreshDiagTabs().then(tabs => toast(tabs.length ? `找到 ${tabs.length} 个可诊断页面` : '没找到 DeepSeek / DSH 页面'));
  });

  /* AI 归类 */
  ['aiBaseUrl', 'aiApiKey', 'aiModel', 'aiNonQaFolder', 'aiFallbackFolder', 'aiMaxChars', 'aiSubjects']
    .forEach(id => {
      document.getElementById(id).addEventListener('input', () => {
        updateAiPreview();
        scheduleSave();
      });
    });
  ['aiEnabled', 'aiRouteByCategory', 'aiKeepSessionSubfolder'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
      updateAiPreview();
      scheduleSave();
    });
  });
  document.getElementById('btn-ai-test').addEventListener('click', onAiTest);
  document.getElementById('btn-ai-grant').addEventListener('click', onAiGrant);
  document.getElementById('btn-ai-clear-cache').addEventListener('click', onAiClearCache);

  document.getElementById('btn-export-settings').addEventListener('click', exportSettings);
  document.getElementById('btn-import-settings').addEventListener('click', () => {
    document.getElementById('import-file').click();
  });
  document.getElementById('import-file').addEventListener('change', importSettings);
  document.getElementById('btn-reset').addEventListener('click', onReset);
}

/* ------------------------------------------------------------------ */
/*                          保存                                        */
/* ------------------------------------------------------------------ */

function collect() {
  return {
    singleFolder: normalizeRelPath(document.getElementById('singleFolder').value),
    batchFolder: normalizeRelPath(document.getElementById('batchFolder').value),
    // 已授权文件夹内部的子目录：与上面两个是两套独立前缀，不叠加
    dirSubfolder: normalizeRelPath(document.getElementById('dirSubfolder').value),
    batchSubfolder: document.getElementById('batchSubfolder').checked,
    batchSubfolderPattern: document.getElementById('batchSubfolderPattern').value.trim() || DEFAULT_SETTINGS.batchSubfolderPattern,
    batchIndex: document.getElementById('batchIndex').checked,
    useDirectoryHandle: document.getElementById('useDirectoryHandle').checked,
    imageFolder: normalizeRelPath(document.getElementById('imageFolder').value) || 'images',
    docxImageMaxWidth: Math.max(120, Math.min(1400, Number(document.getElementById('docxImageMaxWidth').value) || 620)),
    imageQuality: Number(document.getElementById('imageQuality').value) || 0.92,
    verbose: document.getElementById('verbose').checked,
    useApi: document.getElementById('useApi').checked,
    singleSlots: state.singleSlots,
    batchSlots: state.batchSlots,
    defaultFormat: state.defaultFormat,
    batchFormats: state.batchFormats,
    imageFormat: state.imageFormat,
    imageInline: state.imageInline,
    // AI 归类的分类方式存在 state 里（chips 直接改它），字段值以表单为准
    ai: { ...collectAi(), routeMode: (state.ai && state.ai.routeMode) || 'subject' }
  };
}

function scheduleSave() {
  clearTimeout(saveTimer);
  setSaveState('未保存…', '');
  saveTimer = setTimeout(() => saveNow(false), 600);
}

async function saveNow(explicit) {
  clearTimeout(saveTimer);
  try {
    state = await saveSettings(collect());
    fillForm();
    setSaveState('已保存', 'ok');
    if (explicit) toast('设置已保存');
    setTimeout(() => setSaveState('', ''), 2200);
  } catch (e) {
    setSaveState('保存失败', 'err');
    toast(`保存失败：${e.message}`, true);
  }
}

function setSaveState(text) {
  const el = document.getElementById('save-state');
  el.textContent = text;
  el.style.color = text.includes('失败') ? 'var(--danger)' : 'var(--ok)';
}

/* ------------------------------------------------------------------ */
/*                        文件夹授权                                    */
/* ------------------------------------------------------------------ */

async function onPickDir() {
  try {
    const handle = await pickDirectory();
    const perm = await dirPermission(handle, 'readwrite');
    if (perm !== 'granted') {
      const granted = await requestDirPermission(handle, 'readwrite');
      if (granted !== 'granted') {
        toast('未获得写入权限，请重试', true);
      }
    }
    state.useDirectoryHandle = true;
    setChk('useDirectoryHandle', true);
    await saveNow(false);
    await refreshDirStatus();
    toast(`已授权文件夹：${handle.name}`);
  } catch (e) {
    if (String(e && e.name) === 'AbortError') return;
    toast(`选择文件夹失败：${e.message}`, true);
  }
}

async function onRegrant() {
  const handle = await loadDirHandle();
  if (!handle) {
    toast('还没有授权过文件夹，请先点「选择文件夹并授权」', true);
    return;
  }
  try {
    const res = await handle.requestPermission({ mode: 'readwrite' });
    await refreshDirStatus();
    toast(res === 'granted' ? '权限已恢复' : '权限未授予', res !== 'granted');
  } catch (e) {
    toast(`重新授权失败：${e.message}`, true);
  }
}

async function onClearDir() {
  await clearDirHandle();
  await refreshDirStatus();
  toast('已解除文件夹授权');
}

async function refreshDirStatus() {
  const el = document.getElementById('dir-status');
  const handle = await loadDirHandle();
  if (!handle) {
    el.textContent = '未授权。当前导出目标：浏览器下载目录';
    updateDirPreview();
    return;
  }
  const perm = await dirPermission(handle, 'readwrite');
  el.textContent = `已授权：${handle.name}（权限：${perm === 'granted' ? '可用' : perm === 'prompt' ? '待确认' : '已拒绝'}）`;
  if (perm !== 'granted') {
    el.textContent += '　→ 点「重新授权」恢复，否则导出会回退到下载目录';
  }
  updateDirPreview();
}

/* ------------------------------------------------------------------ */
/*                        主机权限                                      */
/* ------------------------------------------------------------------ */

async function refreshHostsStatus() {
  const el = document.getElementById('hosts-status');
  try {
    const has = await chrome.permissions.contains({ origins: ['*://*/*'] });
    el.textContent = has ? '已授予：任意网站' : '未授予（跨域图片可能无法转码）';
    el.className = `tag ${has ? 'ok' : 'warn'}`;
  } catch (e) {
    el.textContent = '无法查询权限';
    el.className = 'tag warn';
  }
}

async function requestHosts(grant) {
  try {
    if (grant) {
      const ok = await chrome.permissions.request({ origins: ['*://*/*'] });
      toast(ok ? '已授予权限，跨域图片可以正常下载转码了' : '用户取消了授权', !ok);
    } else {
      const ok = await chrome.permissions.remove({ origins: ['*://*/*'] });
      toast(ok ? '已撤销该权限' : '撤销失败');
    }
    await refreshHostsStatus();
  } catch (e) {
    toast(`权限操作失败：${e.message}`, true);
  }
}

/* ------------------------------------------------------------------ */
/*                          页面诊断                                    */
/* ------------------------------------------------------------------ */

let lastDiag = '';

/**
 * 能跑内容脚本的站点。
 * 诊断必须打到这些页面，而不是「当前活动标签页」——用户是在设置页点按钮的，
 * 活动标签页就是设置页自己（扩展页面跑不了内容脚本），于是永远诊断失败。
 */
const SUPPORTED_TAB_PATTERNS = [
  /^https?:\/\/chat\.deepseek\.com\//i,
  /^https?:\/\/[^/]*\.deepseek\.com\//i,
  /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i
];

function isSupportedUrl(url) {
  return !!url && SUPPORTED_TAB_PATTERNS.some(re => re.test(url));
}

/** 列出所有可诊断的标签页，最近访问的排前面 */
async function listSupportedTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    return [];
  }
  return tabs
    .filter(t => isSupportedUrl(t.url))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
}

/** 刷新「诊断目标」下拉框 */
async function refreshDiagTabs() {
  const sel = document.getElementById('diag-tab');
  if (!sel) return [];
  const tabs = await listSupportedTabs();
  const prev = sel.value;
  sel.innerHTML = '';
  if (tabs.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '（没找到 DeepSeek / DSH 页面，请先打开一个）';
    sel.appendChild(opt);
    return tabs;
  }
  for (const t of tabs) {
    const opt = document.createElement('option');
    opt.value = String(t.id);
    const title = (t.title || '').slice(0, 36);
    opt.textContent = `${title || '(无标题)'} — ${(t.url || '').replace(/^https?:\/\//, '').slice(0, 44)}`;
    sel.appendChild(opt);
  }
  if (prev && tabs.some(t => String(t.id) === prev)) sel.value = prev;
  return tabs;
}

/** 给内容脚本发消息；失败返回 null（不抛） */
function sendToTab(tabId, message) {
  return new Promise(resolve => {
    try {
      chrome.tabs.sendMessage(tabId, message, r => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(r || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 确保目标标签页里有内容脚本（没有就主动注入一次） */
async function ensureContentScriptInTab(tabId) {
  let resp = await sendToTab(tabId, { type: 'DSX_PING' });
  if (resp && resp.ok) return { injected: false };
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/index.js'] });
  await sleep(300);
  resp = await sendToTab(tabId, { type: 'DSX_PING' });
  if (!resp || !resp.ok) throw new Error('注入内容脚本后仍无法与页面通信');
  return { injected: true };
}

async function runDiagnose() {
  const status = document.getElementById('diag-status');
  const out = document.getElementById('diag-out');
  status.textContent = '正在诊断…';
  status.className = 'tag';
  try {
    const tabs = await refreshDiagTabs();
    const sel = document.getElementById('diag-tab');
    let tabId = sel && sel.value ? Number(sel.value) : null;
    let tab = tabs.find(t => t.id === tabId) || null;

    if (!tab && tabs.length > 0) {
      tab = tabs[0];
      tabId = tab.id;
      if (sel) sel.value = String(tabId);
    }
    if (!tab || !tabId) {
      throw new Error('没有找到 DeepSeek / DSH 页面。请先打开 chat.deepseek.com 的对话页或 DSH 界面（127.0.0.1:3080），回到本页点「刷新列表」后重试。');
    }

    const { injected } = await ensureContentScriptInTab(tabId);
    const resp = await sendToTab(tabId, { type: 'DSX_DIAGNOSE' });
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || '诊断请求无响应');

    const report = {
      ...resp.report,
      诊断目标: { id: tabId, title: tab.title || '', url: tab.url || '' },
      本次为主动注入: injected
    };
    lastDiag = JSON.stringify(report, null, 2);
    out.hidden = false;
    out.textContent = lastDiag;
    status.textContent = report.adapter ? `诊断完成（${report.adapter}）` : '已连接，但未识别站点';
    status.className = `tag ${report.adapter ? 'ok' : 'warn'}`;
  } catch (e) {
    status.textContent = `失败：${e.message}`;
    status.className = 'tag warn';
    out.hidden = false;
    out.textContent = `诊断失败：${e.message}

排查顺序：
1) 先在浏览器里打开 chat.deepseek.com 的对话页，或 DSH 界面（127.0.0.1:3080）
2) 回到本设置页 → 点「刷新列表」→ 在「诊断目标」里选中那个页面
3) 浏览器内置页面（chrome:// 等）不能作为诊断目标
4) 确认扩展已启用（chrome://extensions/）

说明：本设置页自己是扩展页面，跑不了内容脚本，所以旧版本的「诊断当前标签页」
会把目标错认成设置页并拿不到报告——现在改为显式选择目标页面。`;
  }
}

async function copyDiagnose() {
  if (!lastDiag) {
    toast('还没有诊断结果', true);
    return;
  }
  try {
    await navigator.clipboard.writeText(lastDiag);
    toast('诊断报告已复制到剪贴板');
  } catch (e) {
    toast('复制失败，请手动选中下方文本', true);
  }
}

/* ------------------------------------------------------------------ */
/*                        导入导出设置                                  */
/* ------------------------------------------------------------------ */

function exportSettings() {
  const data = JSON.stringify(state, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'dsx-settings.json';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 200);
}

async function importSettings(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const json = JSON.parse(text);
    state = await saveSettings(json);
    fillForm();
    toast('设置已导入');
  } catch (err) {
    toast(`导入失败：${err.message}`, true);
  } finally {
    e.target.value = '';
  }
}

async function onReset() {
  state = await resetSettings();
  fillForm();
  await refreshDirStatus();
  toast('已恢复默认设置');
}

/* ------------------------------------------------------------------ */
/*                          小工具                                      */
/* ------------------------------------------------------------------ */

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimer = null;
function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast show${isError ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2800);
}
