// Generates OpenScout's PNG icons (app + tray) with a tiny dependency-free PNG encoder.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const outDir = path.resolve("assets");
fs.mkdirSync(outDir, { recursive: true });

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
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const lerp = (a, b, t) => a + (b - a) * t;
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const C1 = hex("#4f46e5");
const C2 = hex("#06b6d4");

function insideRoundRect(x, y, r) {
  const qx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
  const qy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  return Math.hypot(qx, qy) <= r;
}
function inDiamond(x, y, angle, hw, hh) {
  const dx = x - 0.5, dy = y - 0.5;
  const c = Math.cos(-angle), s = Math.sin(-angle);
  const rx = dx * c - dy * s, ry = dx * s + dy * c;
  return { inside: Math.abs(rx) / hw + Math.abs(ry) / hh <= 1, upper: ry < 0 };
}

// Returns premultiplied-free RGBA for a single sample point.
function sample(x, y, { tray }) {
  let col = [0, 0, 0, 0];
  const over = (rgb, a) => {
    const outA = a + col[3] * (1 - a);
    if (outA <= 0) return;
    col = [
      (rgb[0] * a + col[0] * col[3] * (1 - a)) / outA,
      (rgb[1] * a + col[1] * col[3] * (1 - a)) / outA,
      (rgb[2] * a + col[2] * col[3] * (1 - a)) / outA,
      outA,
    ];
  };
  if (insideRoundRect(x, y, tray ? 0.26 : 0.22)) {
    const t = Math.min(1, Math.max(0, (x + y) / 2));
    over([lerp(C1[0], C2[0], t), lerp(C1[1], C2[1], t), lerp(C1[2], C2[2], t)], 1);
  }
  const d = Math.hypot(x - 0.5, y - 0.5);
  const ringR = 0.3, ringW = tray ? 0.055 : 0.032;
  if (Math.abs(d - ringR) <= ringW / 2) over([255, 255, 255], 0.92);
  const needle = inDiamond(x, y, Math.PI / 4, tray ? 0.1 : 0.075, 0.25);
  if (needle.inside) over([255, 255, 255], needle.upper ? 1 : 0.55);
  if (d <= (tray ? 0.045 : 0.03)) over(hex("#4f46e5"), 1);
  return col;
}

function render(size, opts = {}) {
  const ss = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size, opts);
          r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
        }
      }
      const i = (py * size + px) * 4;
      const n = ss * ss;
      buf[i] = a ? Math.round(r / a) : 0;
      buf[i + 1] = a ? Math.round(g / a) : 0;
      buf[i + 2] = a ? Math.round(b / a) : 0;
      buf[i + 3] = Math.round((a / n) * 255);
    }
  }
  return encodePng(size, size, buf);
}

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

fs.writeFileSync(path.join(outDir, "icon.png"), render(256));
fs.writeFileSync(path.join(outDir, "icon-64.png"), render(64));
fs.writeFileSync(path.join(outDir, "tray.png"), render(32, { tray: true }));
fs.writeFileSync(path.join(outDir, "tray@2x.png"), render(64, { tray: true }));
fs.writeFileSync(path.join(outDir, "icon.ico"), encodeIco([16, 24, 32, 48, 64, 256].map((size) => ({ size, png: render(size, { tray: size <= 32 }) }))));
console.log("Icons written to", outDir);
