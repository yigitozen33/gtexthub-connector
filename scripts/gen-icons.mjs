// Generates the app and tray icons as PNG (no dependencies): a chat bubble
// on the Static Amethyst palette. Run: npm run icons
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const S = 4; // supersampling per axis
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++)
        for (let sx = 0; sx < S; sx++) {
          const [pr, pg, pb, pa] = pixel((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size);
          r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
        }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? Math.round(r / a) : 0;
      raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round((a / (S * S)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const AM900 = hex('#1715a3'), AM700 = hex('#3d36b4'), AM500 = hex('#7266cc'), WHITE = [255, 255, 255];

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function inTriangle(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const s = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  const t = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  if ((s < 0) !== (t < 0) && s !== 0 && t !== 0) return false;
  const d = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  return d === 0 || (d < 0) === (s + t <= 0);
}
// The bubble: a rounded body with a tail at the lower left.
function inBubble(x, y, inset = 0) {
  const body = inRoundRect(x, y, 0.2 + inset, 0.24 + inset, 0.8 - inset, 0.68 - inset, 0.14 - inset * 0.5);
  const tail = inset === 0 && inTriangle(x, y, [0.3, 0.6], [0.46, 0.66], [0.27, 0.8]);
  return body || tail;
}
function inDots(x, y) {
  return [0.37, 0.5, 0.63].some((cx) => (x - cx) ** 2 + (y - 0.46) ** 2 <= 0.045 ** 2);
}

const appIcon = (x, y) => {
  if (!inRoundRect(x, y, 0.06, 0.06, 0.94, 0.94, 0.2)) return [0, 0, 0, 0];
  if (inDots(x, y)) return [...AM700, 1];
  if (inBubble(x, y)) return [...WHITE, 1];
  const t = y; // simple vertical blend 900 -> 700
  return [0, 1, 2].map((i) => Math.round(AM900[i] * (1 - t) + AM700[i] * t)).concat(1);
};
// macOS template: black shape on transparent; the system tints it.
const trayTemplate = (x, y) => {
  if (inDots(x, y)) return [0, 0, 0, 0];
  return inBubble(x, y) ? [0, 0, 0, 1] : [0, 0, 0, 0];
};
const trayColor = (x, y) => {
  if (inDots(x, y)) return [...WHITE, 1];
  return inBubble(x, y) ? [...AM500, 1] : [0, 0, 0, 0];
};

// Scale shapes up for the tray (fill more of the small canvas).
const zoom = (f, k) => (x, y) => f(0.5 + (x - 0.5) / k, 0.5 + (y - 0.5) / k);

mkdirSync(path.join(root, 'build'), { recursive: true });
mkdirSync(path.join(root, 'assets'), { recursive: true });
writeFileSync(path.join(root, 'build/icon.png'), png(1024, appIcon));

// macOS .icns built directly from PNG entries (no iconutil / sips needed).
function icns(entries) {
  const parts = entries.map(([type, size]) => {
    const data = png(size, appIcon);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}
writeFileSync(
  path.join(root, 'build/icon.icns'),
  icns([['icp4', 16], ['icp5', 32], ['ic11', 32], ['ic12', 64], ['ic07', 128], ['ic13', 256], ['ic08', 256], ['ic14', 512], ['ic09', 512], ['ic10', 1024]]),
);
writeFileSync(path.join(root, 'assets/icon.png'), png(256, appIcon));
writeFileSync(path.join(root, 'assets/trayTemplate.png'), png(16, zoom(trayTemplate, 1.45)));
writeFileSync(path.join(root, 'assets/trayTemplate@2x.png'), png(32, zoom(trayTemplate, 1.45)));
writeFileSync(path.join(root, 'assets/tray.png'), png(32, zoom(trayColor, 1.45)));
console.log('icons written to build/ and assets/');
