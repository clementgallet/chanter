// one-off helper: rasterise the app icon to PNG with a tiny encoder (no dependencies)
'use strict';
const zlib = require('zlib');
const fs = require('fs');
function crc32(buf) { let c, crc = ~0; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(size, draw) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) { const [r, g, b, a] = draw(x / size, y / size); const o = y * (size * 4 + 1) + 1 + x * 4; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a; }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const BG = [31, 42, 36], GOLD = [232, 194, 106];
function ell(x, y, cx, cy, rx, ry, rot) { const c = Math.cos(rot), s = Math.sin(rot); const dx = x - cx, dy = y - cy; const u = dx * c + dy * s, v = -dx * s + dy * c; return (u * u) / (rx * rx) + (v * v) / (ry * ry) <= 1; }
function icon(scale, round) {
  return (x, y) => {
    // map to the inner design box
    const ux = (x - 0.5) / scale + 0.5, uy = (y - 0.5) / scale + 0.5;
    let inside = true;
    if (round) { const rx = Math.min(x, 1 - x), ry = Math.min(y, 1 - y), r = 0.19; if (rx < r && ry < r && (rx - r) ** 2 + (ry - r) ** 2 > r * r) inside = false; }
    if (!inside) return [0, 0, 0, 0];
    for (let i = 0; i < 5; i++) if (Math.abs(uy - (0.29 + i * 0.125)) < 0.008 && ux > 0.23 && ux < 0.77) return [...GOLD.map((v) => Math.round(BG[0] + (v - BG[0]) * 0.4)), 255].slice(0, 3).concat(255);
    if (ell(ux, uy, 0.37, 0.67, 0.066, 0.05, -0.35) || ell(ux, uy, 0.585, 0.48, 0.066, 0.05, -0.35)) return [...GOLD, 255];
    if (ux > 0.418 && ux < 0.446 && uy > 0.27 && uy < 0.66) return [...GOLD, 255];
    if (ux > 0.633 && ux < 0.661 && uy > 0.18 && uy < 0.47) return [...GOLD, 255];
    if (ux > 0.633 && ux < 0.76 && uy > 0.18 && uy < 0.25) return [...GOLD, 255];
    return [...BG, 255];
  };
}
fs.writeFileSync('public/icons/icon-192.png', png(192, icon(1, true)));
fs.writeFileSync('public/icons/icon-512.png', png(512, icon(1, true)));
fs.writeFileSync('public/icons/icon-180.png', png(180, icon(1, false)));
fs.writeFileSync('public/icons/icon-maskable-512.png', png(512, icon(0.78, false)));
console.log('icons written');
