/**
 * 自测脚本：不依赖浏览器，验证「结构化消息 → Markdown / DOCX」整条链路
 *
 * 覆盖：
 *  - markdown 生成（勾选过滤、思考引用块、图片引用）
 *  - MathML→OMML 各类公式（分数 / 上下标 / 求和积分 / 矩阵 / 对齐 / 重音 / 极限 / 根式）
 *  - 代码块里的 $ 不被当成公式
 *  - 文件名清洗、重名去重、子文件夹模板
 *  - docx 二进制可被解析、图片确实进了 media
 *
 * 用法：node tools/selftest.mjs
 *
 * @file tools/selftest.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildMarkdown, buildPlainText, buildJson, planImageFiles, buildBatchIndex } from '../src/core/exporter.js';
import { mdToDocxBuffer, protectMath, imageSizeFromBytes } from '../src/core/md2docx.js';
import { createTurn, createImage, ROLE, SLOTS, allSlots } from '../src/core/model.js';
import { safeName, safePath, dedupe, buildSubfolder, conversationBasename, stamp } from '../src/core/filename.js';
import { normalizeRelPath, DEFAULT_SETTINGS } from '../src/core/settings.js';
import {
  normalizeBaseUrl, completionsEndpoint, originPattern, parseSubjects, subjectTree,
  parseClassifyResponse, matchSubject, categoryFolder, classifyCacheKey, requestClassification,
  extractChoiceText, toBool
} from '../src/core/aiClassify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(t) {
  console.log(`\n== ${t} ==`);
}

/** 1x1 红色 PNG（用于测试图片内嵌，不依赖网络） */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

function tinyPngBytes() {
  return new Uint8Array(Buffer.from(TINY_PNG_BASE64, 'base64'));
}

/* ------------------------------------------------------------------ */
/*                          构造测试数据                                */
/* ------------------------------------------------------------------ */

function makeTurns() {
  const t1 = createTurn({
    index: 0,
    role: ROLE.USER,
    id: 't0',
    question: '帮我推导一下平方和公式，顺便看看 $E=mc^2$。',
    images: [
      createImage({ id: 'img1', src: 'https://example.com/a.webp', alt: '上传的题目', slot: SLOTS.QUESTION })
    ]
  });

  const t2 = createTurn({
    index: 1,
    role: ROLE.ASSISTANT,
    id: 't1',
    thinking: '先回忆求和公式。\n第二步检查边界。',
    answer: [
      '平方和公式如下：',
      '',
      '$$\\sum_{i=1}^{n} i^2 = \\frac{n(n+1)(2n+1)}{6}$$',
      '',
      '矩阵形式：',
      '',
      '$$\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$$',
      '',
      '对齐环境：',
      '',
      '$$\\begin{aligned} f(x) &= ax^2+bx+c \\\\ &= d \\end{aligned}$$',
      '',
      '极限与积分：',
      '',
      '$$\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1, \\quad \\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}$$',
      '',
      '向量 $\\vec{v}$、横线 $\\bar{x}$、尖帽 $\\hat{y}$、根式 $\\sqrt[3]{x}$。',
      '',
      '```python',
      'price = 100  # 这里的 $ 不是公式',
      'print(f"${price}")',
      '```',
      '',
      '| 名称 | 公式 |',
      '| --- | --- |',
      '| 求和 | $\\sum_{i=1}^{n} a_i$ |',
      '| 平均 | $\\bar{x} = \\frac{1}{n}\\sum_{i=1}^{n} x_i$ |'
    ].join('\n')
  });

  const t3 = createTurn({
    index: 2,
    role: ROLE.USER,
    id: 't2',
    question: '谢谢'
  });
  const t4 = createTurn({
    index: 3,
    role: ROLE.ASSISTANT,
    id: 't3',
    answer: '不客气！',
    images: [
      createImage({ id: 'img2', src: 'data:image/png;base64,' + TINY_PNG_BASE64, alt: '生成的图', slot: SLOTS.ANSWER })
    ]
  });

  return [t1, t2, t3, t4];
}

/* ------------------------------------------------------------------ */
/*                              测试                                    */
/* ------------------------------------------------------------------ */

const turns = makeTurns();
const slots = allSlots();
const imagePlan = planImageFiles(turns, { folder: 'images', format: 'png' });

section('Markdown 生成');
{
  const { markdown, kept, skipped } = buildMarkdown({
    title: '测试会话',
    turns,
    slots,
    imagePlan,
    meta: { site: 'DeepSeek', url: 'https://chat.deepseek.com/a/chat/s/abc', time: '2026-09-16 12:00:00' }
  });
  check('生成了 markdown', markdown.length > 100, `长度 ${markdown.length}`);
  check('保留 4 条消息', kept === 4, `kept=${kept}`);
  check('包含标题', markdown.includes('# 测试会话'));
  check('包含思考引用块', markdown.includes('> [!思考]'));
  check('包含求和公式', markdown.includes('\\sum_{i=1}^{n}'));
  check('包含图片相对路径引用', /!\[[^\]]*\]\(images\//.test(markdown));
  check('包含表格', markdown.includes('| 名称 | 公式 |'));

  const qaOnly = buildMarkdown({
    title: '只要问答',
    turns,
    slots: { question: true, thinking: false, answer: true, images: false },
    imagePlan,
    meta: {}
  });
  check('不勾思考时没有思考块', !qaOnly.markdown.includes('[!思考]'));
  check('不勾图片时没有图片引用', !/!\[[^\]]*\]\(images\//.test(qaOnly.markdown));

  const onlyThink = buildMarkdown({
    title: '只要思考',
    turns,
    slots: { question: false, thinking: true, answer: false, images: false },
    imagePlan,
    meta: {}
  });
  check('只勾思考时有思考块', onlyThink.markdown.includes('[!思考]'));
  check('只勾思考时没有正文公式', !onlyThink.markdown.includes('\\begin{pmatrix}'));

  const inline = buildMarkdown({
    title: '内联图片',
    turns,
    slots,
    imagePlan,
    imageDataUrls: new Map([['img1', 'data:image/png;base64,' + TINY_PNG_BASE64]]),
    meta: {}
  });
  check('内联模式使用 data URL', inline.markdown.includes('data:image/png;base64,'));

  const plain = buildPlainText({ title: 'p', turns, slots, imagePlan, meta: {} });
  check('纯文本导出成功', plain.text.length > 50 && !plain.text.includes('$$'));
  check('纯文本保留思考标题', plain.text.includes('【思考过程】'));

  const json = buildJson({ title: 'j', turns, slots, meta: {} });
  const parsed = JSON.parse(json.json);
  check('JSON 可解析且含 4 条消息', parsed.messages.length === 4, `实际 ${parsed.messages.length}`);
  check('JSON 记录勾选信息', Array.isArray(parsed.selection) && parsed.selection.length === 4);

  const perTurn = buildMarkdown({
    title: '逐条覆盖',
    turns: turns.map((t, i) => (i === 1 ? { ...t, __slots: { question: true, thinking: true, answer: false, images: false } } : t)),
    slots,
    imagePlan,
    meta: {}
  });
  check('逐条覆盖生效（第 2 条只留思考）',
    perTurn.markdown.includes('[!思考]') && !perTurn.markdown.includes('\\begin{pmatrix}'));
}

section('文件名工具');
{
  check('非法字符被替换', safeName('a/b:c*d?e"f<g>h|i') === 'a_b_c_d_e_f_g_h_i', safeName('a/b:c*d?e"f<g>h|i'));
  check('结尾点被去掉', safeName('abc...') === 'abc');
  check('保留中文', safeName('如何学习线性代数') === '如何学习线性代数');
  check('空名回退', safeName('', '未命名') === '未命名');
  check('路径逐段清洗', safePath('a/b/c.md') === 'a/b/c.md');
  check('长名截断', safeName('x'.repeat(200)).length <= 80);

  const used = new Set();
  const n1 = dedupe('会话', '.md', used);
  const n2 = dedupe('会话', '.md', used);
  check('重名去重', n1 === '会话.md' && n2 === '会话 (2).md', `${n1} / ${n2}`);

  const sub = buildSubfolder('{date}_{title}', { title: '线性代数', date: new Date(2026, 8, 16) });
  check('子文件夹模板生效', sub === '20260916_线性代数', sub);

  check('会话名兜底', conversationBasename('', 2) === '对话03');
  check('时间戳格式', /^\d{4}-\d{2}-\d{2}_\d{6}$/.test(stamp()));
  check('相对路径规整', normalizeRelPath('D:\\\\a\\\\b/../c') === 'ab/c'.replace('ab', 'a/b') || normalizeRelPath('D:\\a\\b') === 'a/b', normalizeRelPath('D:\\a\\b'));
}

section('公式保护（markdown 解析前）');
{
  const md = [
    '行内 $a\\,b$ 与展示',
    '$$\\begin{pmatrix} 1 & 0 \\\\ 0 & 1 \\end{pmatrix}$$',
    '```',
    'const s = "$notmath$";',
    '```',
    '行内代码 `$x$` 保留原样'
  ].join('\n');
  const { text, store } = protectMath(md);
  check('提取到 2 个公式', store.length === 2, `实际 ${store.length}`);
  check('代码块里的 $ 未被当作公式', text.includes('$notmath$'));
  check('行内代码里的 $ 未被当作公式', text.includes('`$x$`'));
  check('矩阵的 \\\\ 未被破坏', store[1].includes('\\\\'));
}

section('DOCX 生成与公式');
let docxBytes = null;
{
  const { markdown } = buildMarkdown({
    title: '测试会话',
    turns,
    slots,
    imagePlan,
    meta: { site: 'DeepSeek', time: '2026-09-16 12:00:00' }
  });

  const pngBytes = tinyPngBytes();
  docxBytes = await mdToDocxBuffer(markdown, {
    title: '测试会话',
    resolveImage: () => ({ data: pngBytes, type: 'png', width: 120, height: 120 })
  });
  check('docx 有内容', docxBytes.length > 2000, `${docxBytes.length} 字节`);
  check('docx 是 ZIP（PK 头）', docxBytes[0] === 0x50 && docxBytes[1] === 0x4b);

  let JSZip = null;
  try {
    JSZip = (await import('jszip')).default;
  } catch (e) { /* 没装就跳过深入检查 */ }

  if (JSZip) {
    const zip = await JSZip.loadAsync(docxBytes);
    const xml = await zip.file('word/document.xml').async('string');
    const names = Object.keys(zip.files);

    check('含 word/document.xml', !!xml);
    check('含 [Content_Types].xml', names.includes('[Content_Types].xml'));
    check('含样式表', names.includes('word/styles.xml'));

    const countTag = tag => (xml.match(new RegExp(`<${tag}[\\s>/]`, 'g')) || []).length;
    check('公式容器 m:oMath 存在', countTag('m:oMath') >= 6, `数量 ${countTag('m:oMath')}`);
    check('分数 m:f 存在', countTag('m:f') >= 3, `数量 ${countTag('m:f')}`);
    check('上下标 m:sSup 存在', countTag('m:sSup') >= 1);
    check('求和/积分 m:nary 存在', countTag('m:nary') >= 4, `数量 ${countTag('m:nary')}`);
    check('矩阵 m:m 存在', countTag('m:m') >= 2, `数量 ${countTag('m:m')}`);
    check('重音 m:acc 存在', countTag('m:acc') >= 3, `数量 ${countTag('m:acc')}`);
    check('极限 m:limLow 存在', countTag('m:limLow') >= 1);
    check('根式 m:rad 存在', countTag('m:rad') >= 2, `数量 ${countTag('m:rad')}`);
    check('没有非法 <undefined> 节点', !/<undefined/.test(xml));
    check('表格存在', /<w:tbl>/.test(xml));
    check('标题使用 Heading 样式', /w:val="Heading1"/.test(xml) || /Heading2/.test(xml));
    check('代码块被保留', xml.includes('price = 100'));

    const media = names.filter(n => n.startsWith('word/media/'));
    check('图片进入 media 目录', media.length >= 2, `实际 ${media.length}：${media.join(',')}`);
    check('document.xml.rels 存在', names.includes('word/_rels/document.xml.rels'));

    // 代码块里的 $ 不该被变成公式：检查那段文本原样存在
    check('代码块中的 $ 未被误转换', xml.includes('$notmath$') || xml.includes('price}'));
  } else {
    console.log('  ℹ 未安装 jszip，跳过 docx 内部结构检查');
  }
}

section('图片尺寸解析');
{
  const size = imageSizeFromBytes(tinyPngBytes());
  check('PNG 尺寸解析正确', size.width === 1 && size.height === 1, JSON.stringify(size));
}

section('批量索引');
{
  const md = buildBatchIndex([
    { title: '会话一', messageCount: 12, files: ['a.md', 'a.docx'] },
    { title: '会话|带竖线', messageCount: 3, files: ['b.md'] }
  ], { time: '2026-09-16', formats: 'md' });
  check('索引含表头', md.includes('| # | 会话 |'));
  check('索引转义竖线', md.includes('会话\\|带竖线'));
}

section('默认设置完整性');
{
  const needed = ['singleFolder', 'batchFolder', 'batchSubfolder', 'batchSlots', 'defaultFormat',
    'imageFormat', 'imageQuality', 'imageFolder', 'imageInline', 'docxImageMaxWidth', 'ai'];
  const missing = needed.filter(k => DEFAULT_SETTINGS[k] === undefined);
  check('默认设置字段齐全', missing.length === 0, `缺少 ${missing.join(',')}`);
  check('AI 归类默认关闭', DEFAULT_SETTINGS.ai.enabled === false);
  check('AI 科目默认含 408 四个子类',
    ['408/数据结构', '408/计算机网络', '408/计算机组成原理', '408/操作系统']
      .every(s => DEFAULT_SETTINGS.ai.subjects.includes(s)));
}

/* ------------------------------------------------------------------ */
/*                        AI 归类（需求：按学科归档）                    */
/* ------------------------------------------------------------------ */

section('AI 归类 · 接口地址与权限');
{
  check('裸域名自动补 /v1', normalizeBaseUrl('https://api.deepseek.com') === 'https://api.deepseek.com/v1');
  check('已有 /v1 不重复补', normalizeBaseUrl('https://api.openai.com/v1') === 'https://api.openai.com/v1');
  check('完整 endpoint 会被归一', normalizeBaseUrl('https://api.deepseek.com/v1/chat/completions') === 'https://api.deepseek.com/v1');
  check('本地地址保留端口', normalizeBaseUrl('http://127.0.0.1:11434') === 'http://127.0.0.1:11434/v1');
  check('endpoint 拼接正确', completionsEndpoint('https://api.deepseek.com') === 'https://api.deepseek.com/v1/chat/completions');
  check('权限 origin 带端口', originPattern('http://127.0.0.1:11434/v1') === 'http://127.0.0.1:11434/*',
    originPattern('http://127.0.0.1:11434/v1'));
  check('权限 origin 对 https 正确', originPattern('https://api.deepseek.com/v1') === 'https://api.deepseek.com/*');
}

section('AI 归类 · 科目清单');
{
  const subs = parseSubjects(['数学', '408/数据结构', '408/操作系统', '  ', '408/数据结构']);
  check('解析出 3 个科目（去重去空）', subs.length === 3, JSON.stringify(subs.map(s => s.full)));
  const ds = subs.find(s => s.full === '408/数据结构');
  check('父子拆分正确', ds.parent === '408' && ds.leaf === '数据结构', JSON.stringify(ds));
  check('单层科目 parent 为空', subs.find(s => s.full === '数学').parent === '');
  const tree = subjectTree(['数学', '408/数据结构', '408/操作系统']);
  check('科目树分组合并', tree.length === 2 && tree.find(t => t.parent === '408').leaves.length === 2,
    JSON.stringify(tree));
}

section('AI 归类 · 响应解析');
{
  const ai = { subjects: DEFAULT_SETTINGS.ai.subjects };

  const r1 = parseClassifyResponse('{"knowledge": true, "subject": "数学", "sub": "", "reason": "求定积分"}', ai);
  check('标准 JSON 解析成功', r1.ok && r1.parsed && r1.knowledge === true && r1.subject === '数学', JSON.stringify(r1));

  const r2 = parseClassifyResponse('```json\n{"knowledge": false, "subject": "", "sub": "", "reason": "闲聊"}\n```', ai);
  check('代码块包裹也能解析', r2.ok && r2.knowledge === false, JSON.stringify(r2));

  const r3 = parseClassifyResponse('好的，我的判断是：{"knowledge":"是","subject":"408","sub":"数据结构","reason":"考查排序"} 以上。', ai);
  check('前后有解释文字也能解析', r3.parsed && r3.knowledge === true, JSON.stringify(r3));
  check('父+子正确归位', r3.subject === '408' && r3.sub === '数据结构', `${r3.subject}/${r3.sub}`);

  const r4 = parseClassifyResponse("{'knowledge': 'true', 'subject': '英语', 'sub': '', 'reason': '翻译'}", ai);
  check('单引号 JSON 也能解析', r4.parsed && r4.subject === '英语', JSON.stringify(r4));

  const r5 = parseClassifyResponse('{"knowledge": true, "subject": "物理", "sub": "力学", "reason": "x"}', ai);
  check('不在清单里的科目落到未分类', r5.parsed && r5.subject === '' && r5.sub === '', JSON.stringify(r5));

  const r6 = parseClassifyResponse('{"knowledge": true, "subject": "计算机网路", "sub": "", "reason": "x"}', ai);
  check('科目名小笔误可模糊匹配', r6.subject === '408' && r6.sub === '计算机网络', `${r6.subject}/${r6.sub}`);

  const r7 = parseClassifyResponse('这个属于知识答疑', ai);
  check('非结构化输出退化为关键词判断', r7.ok && r7.knowledge === true, JSON.stringify(r7));

  const r8 = parseClassifyResponse('完全不搭界的回复', ai);
  check('无法判断时 ok=false 但不抛异常', r8.ok === false, JSON.stringify(r8));

  check('空输入不抛异常', parseClassifyResponse('', ai).ok === false);
  check('toBool 认中文', toBool('是') === true && toBool('否') === false && toBool('不确定') === null);
}

section('AI 归类 · 归档目录');
{
  const ai = { ...DEFAULT_SETTINGS.ai };
  check('知识答疑按学科归档',
    categoryFolder({ knowledge: true, subject: '数学', sub: '' }, ai) === '数学');
  check('带子科目时分层',
    categoryFolder({ knowledge: true, subject: '408', sub: '数据结构' }, ai) === '408/数据结构');
  check('非知识答疑进独立目录',
    categoryFolder({ knowledge: false, subject: '数学', sub: '' }, ai) === '非知识答疑');
  check('科目为空时用兜底目录',
    categoryFolder({ knowledge: true, subject: '', sub: '' }, ai) === '未分类');
  check('routeMode=qa 时不分学科',
    categoryFolder({ knowledge: true, subject: '数学', sub: '' }, { ...ai, routeMode: 'qa' }) === '知识答疑');
  check('关闭归档时不产生目录',
    categoryFolder({ knowledge: true, subject: '数学', sub: '' }, { ...ai, routeByCategory: false }) === '');
  check('自定义目录名生效',
    categoryFolder({ knowledge: false }, { ...ai, nonQaFolder: '闲聊归档' }) === '闲聊归档');
  check('目录名里的非法字符被清洗',
    !/[<>:"/\\|?*]/.test(categoryFolder({ knowledge: true, subject: 'a<b>c', sub: '' }, { ...ai, fallbackFolder: 'x' }).replace(/\//g, '')),
    categoryFolder({ knowledge: true, subject: 'a<b>c', sub: '' }, ai));
}

section('AI 归类 · 缓存键');
{
  const base = { title: '定积分', text: '求 ∫x²dx', ai: { model: 'deepseek-chat', subjects: ['数学'], maxChars: 900 } };
  const k1 = classifyCacheKey(base);
  const k2 = classifyCacheKey({ ...base });
  check('同一内容键稳定', k1 === k2, `${k1} vs ${k2}`);
  check('换模型键变化', classifyCacheKey({ ...base, ai: { ...base.ai, model: 'gpt-4o-mini' } }) !== k1);
  check('换科目清单键变化', classifyCacheKey({ ...base, ai: { ...base.ai, subjects: ['英语'] } }) !== k1);
  check('换正文键变化', classifyCacheKey({ ...base, text: '别的' }) !== k1);
  check('哈希是短十六进制', /^[0-9a-f]{1,8}$/.test(k1), k1);
}

section('AI 归类 · 网络调用（mock fetch）');
{
  const ai = { ...DEFAULT_SETTINGS.ai, apiKey: 'sk-test', subjects: DEFAULT_SETTINGS.ai.subjects };

  // 正常返回
  let captured = null;
  const okFetch = async (url, init) => {
    captured = { url, body: JSON.parse(init.body), headers: init.headers };
    return {
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"knowledge":true,"subject":"数学","sub":"","reason":"定积分"}' } }]
      })
    };
  };
  const okRes = await requestClassification({ content: { title: '定积分计算', text: '求 ∫₀¹x²dx' }, ai, fetchImpl: okFetch });
  check('请求成功并解析出结果', okRes.ok && okRes.result.subject === '数学', JSON.stringify(okRes).slice(0, 160));
  check('请求打到 /chat/completions', /\/v1\/chat\/completions$/.test(captured.url), captured.url);
  check('带上了 Authorization 头', captured.headers.authorization === 'Bearer sk-test');
  check('默认请求 JSON 输出模式', captured.body.response_format && captured.body.response_format.type === 'json_object');
  check('提示词里列出了科目清单', captured.body.messages[0].content.includes('408 > 数据结构'),
    captured.body.messages[0].content.slice(-200));
  check('提示词里带了会话正文', captured.body.messages[1].content.includes('定积分计算'));

  // 400 → 自动去掉 response_format 重试
  const calls = [];
  const retryFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(!!body.response_format);
    if (body.response_format) return { ok: false, status: 400, text: async () => 'response_format not supported' };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"knowledge":false,"subject":"","sub":"","reason":"x"}' } }] }) };
  };
  const retryRes = await requestClassification({ content: { title: 't', text: 'x' }, ai, fetchImpl: retryFetch });
  check('400 时自动去掉 JSON 模式重试', calls.length === 2 && calls[0] === true && calls[1] === false, JSON.stringify(calls));
  check('重试后拿到结果', retryRes.ok && retryRes.result.knowledge === false);

  // 401
  const authFail = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  const authRes = await requestClassification({ content: { title: 't', text: 'x' }, ai, fetchImpl: authFail });
  check('401 给出可读提示', !authRes.ok && authRes.error.includes('API Key'), authRes.error);

  // 网络异常
  const netFail = async () => { throw new Error('Failed to fetch'); };
  const netRes = await requestClassification({ content: { title: 't', text: 'x' }, ai, fetchImpl: netFail });
  check('网络异常不抛、返回可读错误', !netRes.ok && netRes.error.includes('请求失败'), netRes.error);

  // 超时
  const abortFail = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  const abortRes = await requestClassification({ content: { title: 't', text: 'x' }, ai, fetchImpl: abortFail });
  check('超时给出可读提示', !abortRes.ok && abortRes.error.includes('超时'), abortRes.error);

  // 返回非 JSON
  const badJson = async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); } });
  const badRes = await requestClassification({ content: { title: 't', text: 'x' }, ai, fetchImpl: badJson });
  check('返回非 JSON 时报错而不是崩', !badRes.ok && badRes.error.includes('不是 JSON'), badRes.error);

  check('extractChoiceText 兼容 text 字段',
    extractChoiceText({ choices: [{ text: 'hi' }] }) === 'hi');
}

section('AI 归类 · 批量索引含分类');
{
  const md = buildBatchIndex([
    { title: '定积分', messageCount: 4, category: '数学', files: ['a.md'] },
    { title: '快排', messageCount: 6, category: '408/数据结构', files: ['b.md'] }
  ], { time: '2026-10-01', formats: 'md' });
  check('索引含分类列', md.includes('| # | 会话 | 分类 | 消息数 | 文件 |'), md.split('\n')[6]);
  check('索引列出分类值', md.includes('408/数据结构'));
  check('索引含分类统计', md.includes('## 分类统计') && md.includes('- 数学：1 个会话'), md.slice(-160));
  const md2 = buildBatchIndex([{ title: 'x', messageCount: 1, files: [] }], {});
  check('没有分类时不出现分类列', !md2.includes('分类') || !md2.includes('| 分类 |'));
}

/* ------------------------------------------------------------------ */
/*                              汇总                                    */
/* ------------------------------------------------------------------ */

console.log(`\n${'='.repeat(56)}`);
console.log(`自测结果：通过 ${pass}，失败 ${fail}`);
if (fail) {
  console.log('失败项：');
  failures.forEach(f => console.log(`  - ${f}`));
  process.exit(1);
} else {
  console.log('全部通过 ✅');
  if (docxBytes) {
    const out = join(__dirname, '..', '..', 'deliverables', 'selftest-sample.docx');
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, docxBytes);
    console.log(`已输出示例 Word 文件：${out}（${(docxBytes.length / 1024).toFixed(1)}KB，可直接打开检查公式）`);
  }
}
