/**
 * generate-icons.js
 * Generates PWA icons (192x192 and 512x512) as PNG files using Canvas API in Node.js.
 * Run once: node generate-icons.js
 * Requires: npm install canvas  (or uses built-in if available)
 *
 * Falls back to writing minimal valid PNGs directly if canvas is unavailable.
 */

const fs   = require('fs');
const path = require('path');

const ICON_DIR = path.join(__dirname, 'icons');
if (!fs.existsSync(ICON_DIR)) fs.mkdirSync(ICON_DIR);

// Try to use the `canvas` npm package; fall back to embedded minimal PNG
function tryGenerateWithCanvas() {
  try {
    const { createCanvas } = require('canvas');
    [192, 512].forEach(size => {
      const canvas = createCanvas(size, size);
      const ctx    = canvas.getContext('2d');
      drawIcon(ctx, size);
      const buffer = canvas.toBuffer('image/png');
      const outPath = path.join(ICON_DIR, `icon-${size}.png`);
      fs.writeFileSync(outPath, buffer);
      console.log(`Written: ${outPath}`);
    });
    return true;
  } catch (e) {
    return false;
  }
}

function drawIcon(ctx, size) {
  const s = size;
  const r = size * 0.18;  // corner radius

  // Background pill
  ctx.fillStyle = '#4A90D9';
  roundRect(ctx, 0, 0, s, s, r);
  ctx.fill();

  // Scissors blades — simplified ✂️ using paths
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle   = '#ffffff';
  ctx.lineWidth   = s * 0.045;
  ctx.lineCap     = 'round';

  const cx = s / 2;
  const cy = s / 2;
  const sc = s / 512;  // internal scale relative to 512px base

  // Left blade
  ctx.beginPath();
  ctx.moveTo(cx - 120 * sc, cy - 60 * sc);
  ctx.quadraticCurveTo(cx, cy + 10 * sc, cx - 60 * sc, cy + 140 * sc);
  ctx.stroke();

  // Right blade
  ctx.beginPath();
  ctx.moveTo(cx + 120 * sc, cy - 60 * sc);
  ctx.quadraticCurveTo(cx, cy + 10 * sc, cx + 60 * sc, cy + 140 * sc);
  ctx.stroke();

  // Handle circles
  ctx.beginPath();
  ctx.arc(cx - 130 * sc, cy - 80 * sc, 36 * sc, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx + 130 * sc, cy - 80 * sc, 36 * sc, 0, Math.PI * 2);
  ctx.stroke();

  // Center pivot dot
  ctx.beginPath();
  ctx.arc(cx, cy + 15 * sc, 10 * sc, 0, Math.PI * 2);
  ctx.fill();

  // "CC" text label under scissors
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font      = `bold ${Math.round(s * 0.16)}px Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('CC', cx, cy + 160 * sc);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ── Minimal PNG fallback ──────────────────────────────────────────────────────
// If canvas package isn't available, write a tiny solid-color PNG (1x1 tinted blue).
// The app will still work; icons just won't look great.

function writeFallbackPng(size, filepath) {
  // Minimal valid 1x1 blue PNG as base64
  // (A real implementation would embed a full-size PNG,
  //  but this keeps the script dependency-free.)
  const PNG_1x1_BLUE_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const buf = Buffer.from(PNG_1x1_BLUE_B64, 'base64');
  fs.writeFileSync(filepath, buf);
  console.log(`Written fallback PNG: ${filepath} (install npm package 'canvas' for proper icons)`);
}

if (!tryGenerateWithCanvas()) {
  console.log('canvas package not found — writing placeholder PNGs');
  writeFallbackPng(192, path.join(ICON_DIR, 'icon-192.png'));
  writeFallbackPng(512, path.join(ICON_DIR, 'icon-512.png'));
}
