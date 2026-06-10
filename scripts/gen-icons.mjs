// 生成 PWA 图标，零依赖（用 zlib 直接拼 PNG）。
// 占位图：暖陶土底 + 居中奶油色圆点。想换更好看的图，替换 public/icon-*.png 即可。
//   node scripts/gen-icons.mjs
import zlib from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function png(size) {
  const w = size;
  const h = size;
  const bg = [0x1a, 0x1e, 0x2e, 0xff];
  const fg = [0x53, 0x4a, 0xb7, 0xff];
  const cx = w / 2;
  const cy = h / 2;
  const r = w * 0.26;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const dx = x - cx + 0.5;
      const dy = y - cy + 0.5;
      const c = dx * dx + dy * dy <= r * r ? fg : bg;
      raw[p++] = c[0];
      raw[p++] = c[1];
      raw[p++] = c[2];
      raw[p++] = c[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("public", { recursive: true });
writeFileSync("public/icon-192.png", png(192));
writeFileSync("public/icon-512.png", png(512));
console.log("wrote public/icon-192.png, public/icon-512.png");
