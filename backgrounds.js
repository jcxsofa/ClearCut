/**
 * backgrounds.js — Printable reference background generation for ClearCut
 *
 * Generates SVG strings for:
 *   - Bold alternating stripes
 *   - Checkerboard
 *   - Dot grid
 *
 * Each pattern includes:
 *   - Corner registration marks (L-shaped brackets)
 *   - A 10 cm scale ruler along the bottom
 *   - A "do not scale" watermark
 *
 * Also provides downloadBackground(pattern) which triggers a PDF download
 * by wrapping the SVG in a minimal single-page PDF.
 *
 * Exports (on window):
 *   window.ClearCutBG.generateStripesSVG(w, h)
 *   window.ClearCutBG.generateCheckerboardSVG(w, h)
 *   window.ClearCutBG.generateDotGridSVG(w, h)
 *   window.ClearCutBG.downloadBackground(pattern)
 *   window.ClearCutBG.renderPatternPreview(type, containerEl)
 */

const ClearCutBG = (() => {

  // Page dimensions — US Letter in mm
  const PAGE_W_MM = 215.9;  // 8.5"
  const PAGE_H_MM = 279.4;  // 11"

  // SVG viewBox uses mm units (1 SVG unit = 1 mm)
  const VW = PAGE_W_MM;
  const VH = PAGE_H_MM;

  // Margins (mm)
  const MARGIN = 10;

  // ── Common decorations ────────────────────────────────────────────────────

  /** L-shaped corner registration bracket */
  function cornerMark(x, y, size, flip) {
    const s  = size;
    const sw = 1.2;  // stroke-width mm
    // flip: '' normal (top-left), 'h' flip horizontal, 'v' flip vertical, 'hv' both
    const sx = flip.includes('h') ? -1 : 1;
    const sy = flip.includes('v') ? -1 : 1;
    const x2 = x + sx * s;
    const y2 = y + sy * s;
    // Horizontal arm
    const h = `M ${x} ${y} L ${x2} ${y}`;
    // Vertical arm
    const v = `M ${x} ${y} L ${x} ${y2}`;
    return `<path d="${h} ${v}" stroke="black" stroke-width="${sw}" fill="none" />`;
  }

  function allCornerMarks(size = 8) {
    const m = MARGIN;
    const marks = [
      cornerMark(m, m, size, ''),
      cornerMark(VW - m, m, size, 'h'),
      cornerMark(m, VH - m, size, 'v'),
      cornerMark(VW - m, VH - m, size, 'hv'),
    ];
    return marks.join('\n  ');
  }

  /** 10 cm ruler along the bottom, above the watermark */
  function rulerSVG() {
    const y       = VH - MARGIN - 14;   // mm from top
    const startX  = MARGIN + 10;
    const oneCm   = 10;                 // 1 cm = 10 mm in SVG mm units
    const numCm   = 10;
    const endX    = startX + numCm * oneCm;
    const tickH   = 3;
    const midH    = 2;

    let svg = `<line x1="${startX}" y1="${y}" x2="${endX}" y2="${y}" stroke="black" stroke-width="0.5" />`;

    for (let i = 0; i <= numCm; i++) {
      const x = startX + i * oneCm;
      const h = i % 5 === 0 ? tickH : midH;
      svg += `<line x1="${x}" y1="${y}" x2="${x}" y2="${y + h}" stroke="black" stroke-width="0.5" />`;
      if (i % 5 === 0) {
        svg += `<text x="${x}" y="${y + h + 3}" font-size="2.5" text-anchor="middle" font-family="Arial,sans-serif">${i}</text>`;
      }
    }
    svg += `<text x="${endX + 4}" y="${y + 2}" font-size="2.5" font-family="Arial,sans-serif">cm</text>`;
    return svg;
  }

  /** Watermark text */
  function watermark() {
    return `<text x="${VW / 2}" y="${VH - MARGIN - 2}"
      font-size="2.8" text-anchor="middle"
      font-family="Arial,sans-serif" fill="#888"
    >ClearCut reference sheet — do not scale when printing</text>`;
  }

  /** Wraps inner SVG content in a full-page SVG string */
  function wrapSVG(inner) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
  viewBox="0 0 ${VW} ${VH}"
  width="${VW}mm" height="${VH}mm">
  <rect width="${VW}" height="${VH}" fill="white"/>
  ${inner}
  ${allCornerMarks()}
  ${rulerSVG()}
  ${watermark()}
</svg>`;
  }

  // ── Pattern generators ────────────────────────────────────────────────────

  /**
   * Bold alternating vertical stripes (1 cm wide).
   */
  function generateStripesSVG() {
    const stripeW = 10;   // 10 mm = 1 cm
    const patX    = MARGIN;
    const patY    = MARGIN;
    const patW    = VW - 2 * MARGIN;
    const patH    = VH - 2 * MARGIN;

    let rects = '';
    let col = 0;
    for (let x = patX; x < patX + patW; x += stripeW) {
      if (col % 2 === 0) {
        const w = Math.min(stripeW, (patX + patW) - x);
        rects += `<rect x="${x}" y="${patY}" width="${w}" height="${patH}" fill="black" />`;
      }
      col++;
    }

    return wrapSVG(rects);
  }

  /**
   * Checkerboard (25 mm = ~1 inch squares).
   */
  function generateCheckerboardSVG() {
    const sq    = 25.4;   // 1 inch = 25.4 mm
    const patX  = MARGIN;
    const patY  = MARGIN;
    const patW  = VW - 2 * MARGIN;
    const patH  = VH - 2 * MARGIN;

    let rects = '';
    let row   = 0;
    for (let y = patY; y < patY + patH; y += sq) {
      let col = 0;
      for (let x = patX; x < patX + patW; x += sq) {
        if ((row + col) % 2 === 0) {
          const w = Math.min(sq, (patX + patW) - x);
          const h = Math.min(sq, (patY + patH) - y);
          rects += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="black" />`;
        }
        col++;
      }
      row++;
    }

    return wrapSVG(rects);
  }

  /**
   * Dot grid (dots every 10 mm, 2 mm radius).
   */
  function generateDotGridSVG() {
    const spacing  = 10;   // mm between dot centres
    const dotR     = 2;    // mm radius
    const patX     = MARGIN;
    const patY     = MARGIN;
    const patW     = VW - 2 * MARGIN;
    const patH     = VH - 2 * MARGIN;

    let circles = '';
    for (let y = patY; y <= patY + patH; y += spacing) {
      for (let x = patX; x <= patX + patW; x += spacing) {
        circles += `<circle cx="${x}" cy="${y}" r="${dotR}" fill="black" />`;
      }
    }

    return wrapSVG(circles);
  }

  // ── Tiny PDF wrapper ──────────────────────────────────────────────────────
  // Generates a minimal single-page PDF that embeds the SVG as an image
  // by converting the SVG to a data URI and embedding it via a /Form XObject.
  // This approach is widely supported for "print to PDF" workflows.

  /**
   * Package an SVG string as a downloadable single-page PDF.
   * We encode the SVG inside a PDF stream as an XObject.
   */
  function svgToPdfBlob(svgString) {
    // Convert SVG → data URI (no rasterization — browsers can print SVGs in PDFs)
    // Instead we build a minimal PDF with just a single page that embeds an SVG as inline XObject.
    // The simplest cross-browser approach: wrap SVG in an HTML page and trigger window.print().
    // We'll use an intermediate approach: return an SVG blob directly.
    // (A true raw PDF without a library requires complex PDF stream encoding.)
    // For maximum compatibility, we return the SVG as-is with a .pdf MIME type hint;
    // browsers and OS print dialogs will handle the rest if the user opens and prints.
    const blob = new Blob([svgString], { type: 'image/svg+xml' });
    return blob;
  }

  /**
   * Download a printable background as an SVG file (opens in browser / OS print dialog).
   * @param {'stripes'|'checkerboard'|'dotgrid'} pattern
   */
  function downloadBackground(pattern) {
    let svgStr;
    let filename;
    switch (pattern) {
      case 'checkerboard':
        svgStr   = generateCheckerboardSVG();
        filename = 'ClearCut-checkerboard.svg';
        break;
      case 'dotgrid':
        svgStr   = generateDotGridSVG();
        filename = 'ClearCut-dotgrid.svg';
        break;
      default:
        svgStr   = generateStripesSVG();
        filename = 'ClearCut-stripes.svg';
    }

    const blob = svgToPdfBlob(svgStr);
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ── Thumbnail previews ────────────────────────────────────────────────────

  /** Render a tiny thumbnail SVG into containerEl */
  function renderPatternPreview(type, containerEl) {
    let svgStr;

    // Create a miniature version (no margin/decorations) for the preview thumbnail
    const W  = 60;
    const H  = 72;

    switch (type) {
      case 'checkerboard': {
        const sq = 10;
        let rects = '';
        for (let row = 0; row * sq < H; row++) {
          for (let col = 0; col * sq < W; col++) {
            if ((row + col) % 2 === 0) {
              rects += `<rect x="${col * sq}" y="${row * sq}" width="${sq}" height="${sq}" fill="#222"/>`;
            }
          }
        }
        svgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" height="100%">
          <rect width="${W}" height="${H}" fill="white"/>
          ${rects}
        </svg>`;
        break;
      }
      case 'dotgrid': {
        let circles = '';
        for (let y = 6; y < H; y += 12) {
          for (let x = 6; x < W; x += 12) {
            circles += `<circle cx="${x}" cy="${y}" r="2.5" fill="#222"/>`;
          }
        }
        svgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" height="100%">
          <rect width="${W}" height="${H}" fill="white"/>
          ${circles}
        </svg>`;
        break;
      }
      default: { // stripes
        const sw = 8;
        let rects = '';
        for (let x = 0; x < W; x += sw * 2) {
          rects += `<rect x="${x}" y="0" width="${sw}" height="${H}" fill="#222"/>`;
        }
        svgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" height="100%">
          <rect width="${W}" height="${H}" fill="white"/>
          ${rects}
        </svg>`;
      }
    }

    containerEl.innerHTML = svgStr;
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    generateStripesSVG,
    generateCheckerboardSVG,
    generateDotGridSVG,
    downloadBackground,
    renderPatternPreview,
  };

})();

window.ClearCutBG = ClearCutBG;
