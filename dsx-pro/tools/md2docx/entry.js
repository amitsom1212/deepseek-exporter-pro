/**
 * 独立版 markdown → docx 转换器的对外入口
 *
 * 打包成 IIFE（全局 MdToDocx）与 ESM 两种形态，
 * 供「离线单文件网页」与第三方脚本直接调用。
 *
 * @file tools/md2docx/entry.js
 */

export {
  mdToDocxBuffer,
  mdToDocxBase64,
  mdToDocxBlob,
  markdownToDocument,
  protectMath,
  mathmlToMathChildren,
  texToMathChildren,
  imageSizeFromBytes,
  bytesToBase64,
  DOCX_MIME
} from '../../src/core/md2docx.js';

import { mdToDocxBlob, mdToDocxBuffer, DOCX_MIME } from '../../src/core/md2docx.js';

/**
 * 最简调用：Markdown → Blob。
 * @param {string} markdown
 * @param {object} [opts] { title, baseSize, imageMaxWidth, resolveImage }
 * @returns {Promise<Blob>}
 */
export async function mdToDocx(markdown, opts = {}) {
  return mdToDocxBlob(markdown, opts);
}

/**
 * 浏览器里直接触发下载。
 * @param {string} markdown
 * @param {string} [filename]
 * @param {object} [opts]
 */
export async function downloadDocx(markdown, filename = 'document.docx', opts = {}) {
  const blob = await mdToDocxBlob(markdown, opts);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.docx') ? filename : `${filename}.docx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return blob;
}
