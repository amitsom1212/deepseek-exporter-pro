/**
 * 生成扩展图标（16/32/48/128 PNG）
 *
 * 为什么要自己画：Chrome 的 manifest icons 只接受位图，不接受 SVG；
 * 而项目里又不想塞入来历不明的二进制素材。这里用 zlib 直接手写 PNG，
 * 图形 = 圆角方块 + 白色下载箭头，颜色跟随品牌蓝。
 *
 * 用法：node tools/make-icons.mjs
 *
 * @file tools/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'src', 'icons');

/** CRC32（PNG 每个 chunk 都要） */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * 把 RGBA 像素数组编码为 PNG。
 * @param {number} w
 * @param {number} h
 * @param {Uint8Array} rgba 长度 w*h*4
 */
function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  // 每行前面加一个 filter byte(0)
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4)
      .copy(raw, y * (w * 4 + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** 判断点是否落在圆角矩形内 */
function inRoundRect(x, y, w, h, r) {
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 点在三角形内（重心法），用于画箭头 */
function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(d) < 1e-9) return false;
  const a = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
  const b = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
  const c = 1 - a - b;
  return a >= 0 && b >= 0 && c >= 0;
}

function inRect(x, y, x0, y0, x1, y1) {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

/**
 * 画一枚图标。
 * @param {number} size
 * @returns {Buffer} PNG
 */
function drawIcon(size) {
  const S = size;
  const px = new Uint8Array(S * S * 4);
  const radius = S * 0.22;
  const scale = S / 128; // 以 128 为设计基准

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      if (!inRoundRect(x + 0.5, y + 0.5, S, S, radius)) {
        px[i + 3] = 0;
        continue;
      }
      // 背景：左上到右下的品牌蓝渐变
      const t = (x + y) / (2 * S);
      let r = Math.round(77 + t * 40);
      let g = Math.round(107 - t * 20);
      let b = Math.round(254 - t * 30);

      // 白色下载箭头：竖杆 + 三角 + 底部短横线
      const cx = S / 2;
      const shaftW = 15 * scale;
      const shaftTop = 26 * scale;
      const shaftBottom = 74 * scale;
      const triTop = 62 * scale;
      const triBottom = 92 * scale;
      const triHalf = 27 * scale;
      const barY = 100 * scale;
      const barH = 9 * scale;
      const barHalf = 30 * scale;

      const inShaft = inRect(x, y, cx - shaftW / 2, shaftTop, cx + shaftW / 2, shaftBottom);
      const inTri = inTriangle(x, y, cx, triBottom, cx - triHalf, triTop, cx + triHalf, triTop);
      const inBar = inRect(x, y, cx - barHalf, barY, cx + barHalf, barY + barH);

      if (inShaft || inTri || inBar) {
        r = 255; g = 255; b = 255;
      }
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
  }
  return encodePng(S, S, px);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const buf = drawIcon(size);
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, buf);
  console.log(`生成 ${file} (${buf.length} 字节)`);
}
console.log('图标生成完成');
