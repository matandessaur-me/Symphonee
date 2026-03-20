/**
 * Generate a DevOps Pilot PNG icon (256x256).
 * Design: Terminal prompt icon (matches the Lucide terminal-square style).
 */
const fs = require('fs');
const path = require('path');
const { deflateSync } = require('zlib');

const SIZE = 256;
const pixels = Buffer.alloc(SIZE * SIZE * 4, 0);

function setPixel(x, y, r, g, b, a) {
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  const srcA = a / 255;
  const dstA = pixels[i + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA === 0) return;
  pixels[i]     = Math.round((r * srcA + pixels[i]     * dstA * (1 - srcA)) / outA);
  pixels[i + 1] = Math.round((g * srcA + pixels[i + 1] * dstA * (1 - srcA)) / outA);
  pixels[i + 2] = Math.round((b * srcA + pixels[i + 2] * dstA * (1 - srcA)) / outA);
  pixels[i + 3] = Math.round(outA * 255);
}

function fillCircle(cx, cy, r, red, green, blue, alpha = 255) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (d <= r) {
        const a = Math.min(1, r - d) * (alpha / 255);
        setPixel(x, y, red, green, blue, Math.round(a * 255));
      }
    }
  }
}

function drawLine(x1, y1, x2, y2, width, r, g, b, a = 255) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.ceil(len * 2);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    fillCircle(x1 + dx * t, y1 + dy * t, width / 2, r, g, b, a);
  }
}

function fillRoundedRect(x1, y1, w, h, radius, r, g, b, a = 255) {
  for (let y = y1; y < y1 + h; y++) {
    for (let x = x1; x < x1 + w; x++) {
      let inside = true;
      const corners = [
        [x1 + radius, y1 + radius], [x1 + w - radius, y1 + radius],
        [x1 + radius, y1 + h - radius], [x1 + w - radius, y1 + h - radius],
      ];
      for (const [cx, cy] of corners) {
        const ddx = x < cx ? cx - x : x > cx ? x - cx : 0;
        const ddy = y < cy ? cy - y : y > cy ? y - cy : 0;
        if (ddx > 0 && ddy > 0 && ddx * ddx + ddy * ddy > radius * radius) { inside = false; break; }
      }
      if (inside) setPixel(x, y, r, g, b, a);
    }
  }
}

function strokeRoundedRect(x1, y1, w, h, radius, strokeW, r, g, b, a = 255) {
  // Top
  drawLine(x1 + radius, y1, x1 + w - radius, y1, strokeW, r, g, b, a);
  // Bottom
  drawLine(x1 + radius, y1 + h, x1 + w - radius, y1 + h, strokeW, r, g, b, a);
  // Left
  drawLine(x1, y1 + radius, x1, y1 + h - radius, strokeW, r, g, b, a);
  // Right
  drawLine(x1 + w, y1 + radius, x1 + w, y1 + h - radius, strokeW, r, g, b, a);
  // Corners (arcs via small circle segments)
  const corners = [
    [x1 + radius, y1 + radius, Math.PI, Math.PI * 1.5],
    [x1 + w - radius, y1 + radius, Math.PI * 1.5, Math.PI * 2],
    [x1 + radius, y1 + h - radius, Math.PI * 0.5, Math.PI],
    [x1 + w - radius, y1 + h - radius, 0, Math.PI * 0.5],
  ];
  for (const [cx, cy, startA, endA] of corners) {
    const steps = 40;
    for (let i = 0; i <= steps; i++) {
      const angle = startA + (endA - startA) * (i / steps);
      const px = cx + Math.cos(angle) * radius;
      const py = cy + Math.sin(angle) * radius;
      fillCircle(px, py, strokeW / 2, r, g, b, a);
    }
  }
}

// Colors
const BG = [26, 26, 24];        // #1a1a18
const ACCENT = [255, 255, 255];  // #ffffff (white)

// Background
fillRoundedRect(0, 0, SIZE, SIZE, 48, ...BG);

// Terminal box outline
strokeRoundedRect(40, 40, 176, 176, 24, 10, ...ACCENT);

// Chevron prompt: > shape at left
drawLine(80, 100, 120, 128, 10, ...ACCENT);
drawLine(120, 128, 80, 156, 10, ...ACCENT);

// Cursor line at right
drawLine(140, 156, 180, 156, 10, ...ACCENT);

// ── Encode as PNG ───────────────────────────────────────────────────────
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6;

const rawRows = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  rawRows[y * (SIZE * 4 + 1)] = 0;
  pixels.copy(rawRows, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const compressed = deflateSync(rawRows);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  pngChunk('IHDR', ihdr),
  pngChunk('IDAT', compressed),
  pngChunk('IEND', Buffer.alloc(0)),
]);

const outPath = path.join(__dirname, 'public', 'icon.png');
fs.writeFileSync(outPath, png);
console.log(`Icon written to ${outPath} (${png.length} bytes)`);
