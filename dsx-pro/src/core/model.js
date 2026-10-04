/**
 * 统一消息数据模型
 *
 * 全插件（内容脚本 / 后台 / 设置页 / 独立 md→docx 工具）共用这一份结构，
 * 站点适配器只负责把各自页面的 DOM 翻译成这里的 Turn。
 *
 * @file src/core/model.js
 */

/** 可勾选的内容槽位，顺序即 UI 展示顺序 */
export const SLOTS = ['question', 'thinking', 'answer', 'images'];

/** 槽位中文名 */
export const SLOT_LABELS = {
  question: '提问',
  thinking: '思考',
  answer: '回答',
  images: '图片'
};

/** 角色 */
export const ROLE = {
  USER: 'user',
  ASSISTANT: 'assistant',
  SYSTEM: 'system'
};

export const ROLE_LABELS = {
  user: '用户',
  assistant: 'AI',
  system: '系统'
};

/** 全部槽位都打开的选择状态（也用于「全选」按钮） */
export function allSlots() {
  return { question: true, thinking: true, answer: true, images: true };
}

/** 只保留提问与回答（无思考、无图片） */
export function qaOnlySlots() {
  return { question: true, thinking: false, answer: true, images: false };
}

/**
 * 归一化一个选择对象，补齐缺失字段并强制布尔。
 * @param {Partial<Record<string, boolean>>} [sel]
 * @returns {{question: boolean, thinking: boolean, answer: boolean, images: boolean}}
 */
export function normalizeSlots(sel) {
  const out = {};
  for (const s of SLOTS) out[s] = !!(sel && sel[s]);
  return out;
}

/** 该选择是否什么都没选 */
export function isEmptySelection(sel) {
  return SLOTS.every(s => !sel[s]);
}

/**
 * 新建一条消息。
 * @param {object} init
 * @returns {object} Turn
 */
export function createTurn(init = {}) {
  return {
    id: init.id || `t${init.index ?? 0}`,
    index: init.index ?? 0,
    role: init.role || ROLE.ASSISTANT,
    /** 用户提问（markdown） */
    question: init.question || '',
    /** 深度思考内容（markdown） */
    thinking: init.thinking || '',
    /** 最终回答（markdown） */
    answer: init.answer || '',
    /** 该消息中出现的图片资源 */
    images: init.images || [],
    /** 消息时间（若页面提供，ISO 字符串） */
    time: init.time || '',
    /** 用户在 UI 里对该条的单独选择；null 表示跟随全局 */
    selected: init.selected === undefined ? true : !!init.selected,
    /** 该条是否展开显示子选项 */
    expanded: false
  };
}

/**
 * 新建一个图片资源描述。
 * 注意：这里只保存「从哪里取图」，真正取字节/转码在导出阶段做（懒加载，
 * 避免打开面板就把几十张 webp 全解码一遍）。
 *
 * @param {object} init
 * @returns {object} ImageAsset
 */
export function createImage(init = {}) {
  return {
    id: init.id || `img${Math.random().toString(36).slice(2, 9)}`,
    /** 原始 src（可能是 https / blob: / data:） */
    src: init.src || '',
    /** 已知的 MIME（未知时导出阶段嗅探） */
    mime: init.mime || '',
    /** 文件名主干（不含扩展名），导出阶段按目标格式补扩展名 */
    basename: init.basename || '',
    /** 原始文件名/替代文本，用于回退命名 */
    alt: init.alt || '',
    /** 该图出现在哪一段内容里 */
    slot: init.slot || SLOTS.QUESTION,
    /** 懒加载时填充分辨率等 */
    el: init.el || null
  };
}

/**
 * 按槽位选择，把一条消息序列化成 markdown 片段。
 * @param {object} turn
 * @param {{question:boolean,thinking:boolean,answer:boolean,images:boolean}} slots
 * @param {object} [opts]
 * @param {(img: object, turn: object) => string} [opts.imageRef] 返回 markdown 图片链接
 * @param {boolean} [opts.roleHeading] 是否输出 `## 用户` / `## AI` 之类的小标题
 * @returns {string} markdown
 */
export function turnToMarkdown(turn, slots, opts = {}) {
  const { imageRef, roleHeading = true } = opts;
  const chunks = [];

  const pickImages = slot => {
    if (!slots.images) return [];
    return (turn.images || []).filter(img => (img.slot || SLOTS.QUESTION) === slot);
  };

  const withImages = (text, slot) => {
    const imgs = pickImages(slot);
    if (imgs.length === 0) return text;
    const refs = imgs.map(img => (imageRef ? imageRef(img, turn) : `![${img.alt || '图片'}](${img.src})`));
    const block = refs.join('\n\n');
    return text ? `${text}\n\n${block}` : block;
  };

  if (turn.role === ROLE.USER) {
    if (slots.question) {
      const body = withImages(turn.question || '', SLOTS.QUESTION);
      if (body) chunks.push(body);
    }
    if (slots.answer && turn.answer) chunks.push(turn.answer);
  } else {
    // AI 侧：思考与回答分开勾选；顺序固定为 思考 → 回答
    if (slots.thinking && turn.thinking) {
      chunks.push(formatThinking(turn.thinking));
    }
    if (slots.answer || slots.images) {
      const body = withImages(turn.answer || '', SLOTS.ANSWER);
      if (body) chunks.push(body);
    }
  }

  if (chunks.length === 0) return '';

  const head = roleHeading ? `## ${ROLE_LABELS[turn.role] || turn.role}\n\n` : '';
  return head + chunks.join('\n\n');
}

/** 思考过程默认包成引用块，视觉上与正文区分 */
export function formatThinking(text) {
  const quoted = String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => (line.trim() ? `> ${line}` : '>'))
    .join('\n');
  return `> [!思考]\n${quoted}`;
}

/**
 * 判断一条消息在给定选择下是否有可导出内容。
 * @param {object} turn
 * @param {object} slots
 * @returns {{empty: boolean, parts: string[]}} parts 为命中的槽位名
 */
export function turnContentInfo(turn, slots) {
  const parts = [];
  if (turn.role === ROLE.USER) {
    if (slots.question && (turn.question || '').trim()) parts.push('question');
    if (slots.answer && (turn.answer || '').trim()) parts.push('answer');
  } else {
    if (slots.thinking && (turn.thinking || '').trim()) parts.push('thinking');
    if (slots.answer && (turn.answer || '').trim()) parts.push('answer');
  }
  if (slots.images && (turn.images || []).length > 0) parts.push('images');
  return { empty: parts.length === 0, parts };
}
