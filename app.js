/**
 * app.js — Core application logic for ClearCut
 *
 * Wires together cv.js, backgrounds.js, svg.js and the HTML UI.
 * Manages:
 *   - Method selection (A/B/C) with localStorage persistence
 *   - Image upload / drag-and-drop / camera capture
 *   - Detection pipeline (gated on OpenCV readiness)
 *   - Canvas preview & shape interaction (toggle, add rect)
 *   - SVG export
 *   - PWA install prompt
 */

(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────────────────
  const state = {
    method:     null,      // 'A' | 'B' | 'C'
    images:     {},        // { bg, items, scan, solid } — HTMLImageElements
    contours:   [],        // current detected contour objects
    previewRatio: 1,       // canvas px / image px
    activeImage: null,     // the primary image shown in the canvas
    isDetecting: false,
    addRectMode: false,
    rectStart:   null,
  };

  // ── DOM refs ─────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);

  const elMethodCards  = document.querySelectorAll('.method-card');
  const elMethodInputs = document.querySelectorAll('input[name="method"]');

  const elSectionA     = $('section-upload-a');
  const elSectionB     = $('section-upload-b');
  const elSectionC     = $('section-upload-c');
  const elSectionPreview = $('section-preview');
  const elSectionExport  = $('section-export');

  const elCanvas       = $('preview-canvas');
  const elShapeCount   = $('shape-count');
  const elCtxThreshold = $('ctrl-threshold');
  const elCtxThreshVal = $('ctrl-threshold-val');
  const elCtxPadding   = $('ctrl-padding');
  const elCtxPadVal    = $('ctrl-padding-val');
  const elCtxMinArea   = $('ctrl-min-area');
  const elCtxMinAreaVal = $('ctrl-min-area-val');

  const elBtnDetectA   = $('btn-detect-a');
  const elBtnDetectB   = $('btn-detect-b');
  const elBtnDetectC   = $('btn-detect-c');
  const elBtnRedetect  = $('btn-redetect');
  const elBtnAddRect   = $('btn-add-rect');
  const elBtnClearAll  = $('btn-clear-all');
  const elBtnDlSVG     = $('btn-download-svg');
  const elBtnDlBG      = $('btn-download-bg');

  const elSheetW       = $('sheet-width');
  const elSheetH       = $('sheet-height');
  const elSheetPreset  = $('sheet-preset');
  const elExportStatus = $('export-status');

  const elColorPick    = $('bg-color-pick');
  const elColorTol     = $('color-tolerance');
  const elColorTolVal  = $('color-tolerance-val');
  const elClickHint    = $('click-sample-hint');

  const elScanPattern  = $('scan-pattern-select');
  const elInstallWrap  = $('install-prompt-wrap');
  const elBtnInstall   = $('btn-install');

  // ── PWA install ──────────────────────────────────────────────────────────
  let deferredInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstallPrompt = e;
    elInstallWrap.classList.remove('hidden');
  });
  elBtnInstall.addEventListener('click', () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      deferredInstallPrompt.userChoice.then(() => {
        deferredInstallPrompt = null;
        elInstallWrap.classList.add('hidden');
      });
    }
  });

  // ── Service Worker registration ──────────────────────────────────────────
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(err => {
        console.warn('SW registration failed:', err);
      });
    });
  }

  // ── Method selection ──────────────────────────────────────────────────────
  function selectMethod(method) {
    state.method = method;
    localStorage.setItem('clearcut-method', method);

    // Update radio UI
    elMethodInputs.forEach(inp => {
      const card = inp.closest('.method-card');
      if (inp.value === method) {
        inp.checked = true;
        card.classList.add('selected');
      } else {
        inp.checked = false;
        card.classList.remove('selected');
      }
    });

    // Show/hide upload sections
    elSectionA.classList.toggle('hidden', method !== 'A');
    elSectionB.classList.toggle('hidden', method !== 'B');
    elSectionC.classList.toggle('hidden', method !== 'C');

    // Clear any previous detection results when switching
    state.contours   = [];
    state.activeImage = null;
    elSectionPreview.classList.add('hidden');
    elSectionExport.classList.add('hidden');

    // Method C — show sampling hint on canvas
    if (method === 'C') {
      elClickHint.classList.remove('hidden');
    } else {
      elClickHint.classList.add('hidden');
    }
  }

  elMethodInputs.forEach(inp => {
    inp.addEventListener('change', () => selectMethod(inp.value));
  });
  elMethodCards.forEach(card => {
    card.addEventListener('click', () => {
      const inp = card.querySelector('input[type="radio"]');
      if (inp) selectMethod(inp.value);
    });
  });

  // Restore saved method
  const savedMethod = localStorage.getItem('clearcut-method') || 'A';
  selectMethod(savedMethod);

  // ── Image upload helpers ──────────────────────────────────────────────────

  function loadImageFile(file) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type.startsWith('image/')) {
        reject(new Error('Not an image file.'));
        return;
      }
      const reader = new FileReader();
      reader.onload = e => {
        const img  = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Failed to decode image.'));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('Failed to read file.'));
      reader.readAsDataURL(file);
    });
  }

  function showImagePreview(imgEl, previewImgId, wrapId, zoneId) {
    const previewImg = $(previewImgId);
    const wrap       = $(wrapId) || previewImg?.parentElement;
    const zone       = $(zoneId);
    if (previewImg) {
      previewImg.src = imgEl.src;
    }
    if (wrap) wrap.classList.remove('hidden');
    if (zone) zone.classList.add('has-image');
  }

  function clearImagePreview(previewImgId, wrapId, zoneId, stateKey) {
    const previewImg = $(previewImgId);
    const wrap       = $(wrapId) || previewImg?.parentElement;
    const zone       = $(zoneId);
    if (previewImg) previewImg.src = '';
    if (wrap) wrap.classList.add('hidden');
    if (zone) zone.classList.remove('has-image');
    if (stateKey) delete state.images[stateKey];
    updateDetectButtons();
  }

  function updateDetectButtons() {
    const { images } = state;
    elBtnDetectA.disabled = !(images.bg && images.items);
    elBtnDetectB.disabled = !images.scan;
    elBtnDetectC.disabled = !images.solid;
  }

  // ── Generic drag-and-drop setup ──────────────────────────────────────────

  function setupDropZone(zoneId, fileInputId, stateKey, previewImgId, previewWrapId) {
    const zone  = $(zoneId);
    const input = $(fileInputId);
    if (!zone || !input) return;

    zone.addEventListener('dragover', e => {
      e.preventDefault();
      zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', async e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const file = e.dataTransfer?.files?.[0];
      if (file) await handleImageFile(file, stateKey, previewImgId, previewWrapId, zoneId);
    });

    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (file) {
        await handleImageFile(file, stateKey, previewImgId, previewWrapId, zoneId);
        input.value = '';
      }
    });

    // Clicking anywhere on the zone (except the button itself) opens file picker
    zone.addEventListener('click', e => {
      if (e.target.tagName === 'BUTTON') return;
      if (e.target.classList.contains('btn-clear-img')) return;
      if (e.target.tagName === 'IMG') return;
      input.click();
    });
  }

  async function handleImageFile(file, stateKey, previewImgId, previewWrapId, zoneId) {
    try {
      const img = await loadImageFile(file);
      state.images[stateKey] = img;
      showImagePreview(img, previewImgId, previewWrapId, zoneId);
      updateDetectButtons();
    } catch (e) {
      alert('Could not load image: ' + e.message);
    }
  }

  // Wiring up clear buttons
  document.querySelectorAll('.btn-clear-img').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const key = btn.dataset.clear;
      const map = {
        bg:    ['preview-bg',    null,             'drop-bg'],
        items: ['preview-items', null,             'drop-items'],
        scan:  ['preview-scan',  null,             'drop-scan'],
        solid: ['preview-solid', null,             'drop-solid'],
      };
      const [pImg, pWrap, zoneId] = map[key] || [];
      if (pImg) clearImagePreview(pImg, pWrap, zoneId, key);
    });
  });

  // Bind upload zones
  setupDropZone('drop-bg',    'input-bg',    'bg',    'preview-bg',    null);
  setupDropZone('drop-items', 'input-items', 'items', 'preview-items', null);
  setupDropZone('drop-scan',  'input-scan',  'scan',  'preview-scan',  null);
  setupDropZone('drop-solid', 'input-solid', 'solid', 'preview-solid', null);

  // ── Controls sliders ──────────────────────────────────────────────────────
  elCtxThreshold.addEventListener('input', () => {
    elCtxThreshVal.textContent = elCtxThreshold.value;
  });
  elCtxPadding.addEventListener('input', () => {
    elCtxPadVal.textContent = elCtxPadding.value + ' mm';
    if (state.activeImage && state.contours.length) renderPreview();
  });
  elCtxMinArea.addEventListener('input', () => {
    elCtxMinAreaVal.textContent = elCtxMinArea.value + ' px²';
  });
  elColorTol.addEventListener('input', () => {
    elColorTolVal.textContent = elColorTol.value;
  });

  // Sheet preset
  elSheetPreset.addEventListener('change', () => {
    const v = elSheetPreset.value;
    if (v === '8.5x11')    { elSheetW.value = '8.5';  elSheetH.value = '11'; }
    if (v === '8.27x11.69') { elSheetW.value = '8.27'; elSheetH.value = '11.69'; }
    if (v === '12x12')     { elSheetW.value = '12';   elSheetH.value = '12'; }
  });

  // ── Detection ─────────────────────────────────────────────────────────────

  function getDetectOptions() {
    return {
      threshold:    Number(elCtxThreshold.value),
      minArea:      Number(elCtxMinArea.value),
      smoothEpsilon: 2,
    };
  }

  async function runDetection() {
    if (state.isDetecting) return;
    if (!window.cvReady) {
      alert('OpenCV is still loading. Please wait a moment and try again.');
      return;
    }

    state.isDetecting = true;
    const activeBtn = { A: elBtnDetectA, B: elBtnDetectB, C: elBtnDetectC }[state.method];
    const origText  = activeBtn?.textContent;
    if (activeBtn) { activeBtn.textContent = '⏳ Processing…'; activeBtn.disabled = true; }

    try {
      let contours;
      const opts = getDetectOptions();

      if (state.method === 'A') {
        contours = ClearCutCV.detectMethodA(state.images.bg, state.images.items, opts);
        state.activeImage = state.images.items;
        if (contours._alignmentWarning) {
          console.warn('ClearCut: image alignment failed — using direct subtraction');
          showStatus('⚠️ Could not align the two photos. Results may be less accurate.');
        }
      } else if (state.method === 'B') {
        const pattern = elScanPattern.value;
        contours = ClearCutCV.detectMethodB(state.images.scan, pattern, opts);
        state.activeImage = state.images.scan;
      } else {
        const hex = elColorPick.value;
        const bgColor = hexToRgb(hex);
        const tolerance = Number(elColorTol.value);
        contours = ClearCutCV.detectMethodC(state.images.solid, bgColor, tolerance, opts);
        state.activeImage = state.images.solid;
      }

      state.contours = contours;
      updateShapeCount();
      renderPreview();

      elSectionPreview.classList.remove('hidden');
      elSectionExport.classList.remove('hidden');
      elSectionPreview.scrollIntoView({ behavior: 'smooth', block: 'start' });

    } catch (err) {
      console.error('Detection error:', err);
      alert('Detection failed: ' + err.message);
    } finally {
      state.isDetecting = false;
      if (activeBtn) {
        activeBtn.textContent = origText;
        activeBtn.disabled    = false;
        updateDetectButtons();
      }
    }
  }

  function showStatus(msg, isError = false) {
    elExportStatus.textContent = msg;
    elExportStatus.classList.remove('hidden', 'error');
    if (isError) elExportStatus.classList.add('error');
    setTimeout(() => elExportStatus.classList.add('hidden'), 5000);
  }

  elBtnDetectA.addEventListener('click', runDetection);
  elBtnDetectB.addEventListener('click', runDetection);
  elBtnDetectC.addEventListener('click', runDetection);
  elBtnRedetect.addEventListener('click', runDetection);

  // ── Preview rendering ────────────────────────────────────────────────────

  function getPaddingPx() {
    if (!state.activeImage) return 0;
    const mm = Number(elCtxPadding.value);
    if (mm <= 0) return 0;
    const imgW    = state.activeImage.naturalWidth || state.activeImage.width;
    const sheetWIn = Number(elSheetW.value) || 8.5;
    const pxPerIn  = imgW / sheetWIn;
    return (mm / 25.4) * pxPerIn;
  }

  function renderPreview() {
    if (!state.activeImage) return;
    const paddingPx = getPaddingPx();
    state.previewRatio = ClearCutSVG.drawPreview(
      elCanvas, state.activeImage, state.contours, paddingPx, state.hoverIdx ?? null
    );
  }

  function updateShapeCount() {
    const enabled = state.contours.filter(c => c.enabled).length;
    elShapeCount.textContent = enabled + ' / ' + state.contours.length;
  }

  // ── Canvas interactions ───────────────────────────────────────────────────

  function canvasToImageCoords(e) {
    const rect  = elCanvas.getBoundingClientRect();
    const scaleX = elCanvas.width  / rect.width;
    const scaleY = elCanvas.height / rect.height;
    const canvasX = (e.clientX - rect.left) * scaleX;
    const canvasY = (e.clientY - rect.top)  * scaleY;
    const imgX  = canvasX / state.previewRatio;
    const imgY  = canvasY / state.previewRatio;
    return { x: imgX, y: imgY };
  }

  /** Point-in-polygon (Ray casting) */
  function pointInPolygon(px, py, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const xi = points[i].x, yi = points[i].y;
      const xj = points[j].x, yj = points[j].y;
      const intersect = ((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  elCanvas.addEventListener('click', e => {
    if (!state.activeImage) return;
    const { x, y } = canvasToImageCoords(e);

    // Add-rect mode
    if (state.addRectMode) {
      if (!state.rectStart) {
        state.rectStart = { x, y };
        elCanvas.style.cursor = 'crosshair';
      } else {
        const rs = state.rectStart;
        const x0 = Math.min(rs.x, x);
        const y0 = Math.min(rs.y, y);
        const x1 = Math.max(rs.x, x);
        const y1 = Math.max(rs.y, y);
        state.contours.push({
          points: [
            { x: x0, y: y0 }, { x: x1, y: y0 },
            { x: x1, y: y1 }, { x: x0, y: y1 },
          ],
          bounds:  { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
          area:    (x1 - x0) * (y1 - y0),
          enabled: true,
        });
        state.rectStart  = null;
        state.addRectMode = false;
        elBtnAddRect.classList.remove('btn-primary');
        elCanvas.style.cursor = 'default';
        updateShapeCount();
        renderPreview();
      }
      return;
    }

    // Method C: click-to-sample background color
    if (state.method === 'C' && state.images.solid) {
      const imgX = Math.round(x);
      const imgY = Math.round(y);
      const img  = state.images.solid;
      const imgW = img.naturalWidth || img.width;
      const imgH = img.naturalHeight || img.height;
      if (imgX >= 0 && imgY >= 0 && imgX < imgW && imgY < imgH) {
        const { r, g, b } = ClearCutCV.sampleColorAt(img, imgX, imgY);
        elColorPick.value = rgbToHex(r, g, b);
        return;
      }
    }

    // Toggle shapes on/off
    for (let i = state.contours.length - 1; i >= 0; i--) {
      const c = state.contours[i];
      if (pointInPolygon(x, y, c.points)) {
        c.enabled = !c.enabled;
        updateShapeCount();
        renderPreview();
        break;
      }
    }
  });

  elCanvas.addEventListener('mousemove', e => {
    if (!state.activeImage || state.addRectMode) return;
    const { x, y } = canvasToImageCoords(e);
    let found = null;
    for (let i = state.contours.length - 1; i >= 0; i--) {
      if (pointInPolygon(x, y, state.contours[i].points)) { found = i; break; }
    }
    if (found !== state.hoverIdx) {
      state.hoverIdx = found;
      renderPreview();
    }
    elCanvas.style.cursor = found !== null ? 'pointer' : 'default';
  });
  elCanvas.addEventListener('mouseleave', () => {
    state.hoverIdx = null;
    renderPreview();
  });

  // Add rect toggle
  elBtnAddRect.addEventListener('click', () => {
    state.addRectMode = !state.addRectMode;
    state.rectStart   = null;
    elBtnAddRect.textContent = state.addRectMode ? '✕ Cancel Rect' : '＋ Add Rect';
    elCanvas.style.cursor    = state.addRectMode ? 'crosshair' : 'default';
  });

  // Clear all shapes
  elBtnClearAll.addEventListener('click', () => {
    if (confirm('Remove all detected shapes?')) {
      state.contours = [];
      updateShapeCount();
      renderPreview();
      elSectionExport.classList.add('hidden');
    }
  });

  // ── SVG Export ────────────────────────────────────────────────────────────

  elBtnDlSVG.addEventListener('click', () => {
    const enabled = state.contours.filter(c => c.enabled);
    if (!enabled.length) {
      showStatus('No shapes selected. Enable at least one shape first.', true);
      return;
    }
    if (!state.activeImage) {
      showStatus('No image loaded.', true);
      return;
    }

    const imgW    = state.activeImage.naturalWidth  || state.activeImage.width;
    const imgH    = state.activeImage.naturalHeight || state.activeImage.height;
    const sheetWIn = Number(elSheetW.value) || 8.5;
    const sheetHIn = Number(elSheetH.value) || 11;
    const paddingMm = Number(elCtxPadding.value) || 0;

    try {
      const svgStr = ClearCutSVG.generateSVG(
        state.contours, imgW, imgH, sheetWIn, sheetHIn, paddingMm
      );
      ClearCutSVG.downloadSVG(svgStr);
      showStatus(`✅ Downloaded SVG with ${enabled.length} shape${enabled.length !== 1 ? 's' : ''}.`);
    } catch (err) {
      showStatus('SVG export failed: ' + err.message, true);
    }
  });

  // ── Background download ───────────────────────────────────────────────────

  elBtnDlBG.addEventListener('click', () => {
    const pattern = document.querySelector('input[name="pattern"]:checked')?.value || 'stripes';
    ClearCutBG.downloadBackground(pattern);
    // Sync the detection pattern selector
    if (elScanPattern) elScanPattern.value = pattern;
  });

  // Pattern cards styling
  document.querySelectorAll('.pattern-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.pattern-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      const v = card.querySelector('input')?.value;
      if (v && elScanPattern) elScanPattern.value = v;
    });
  });

  // ── Background pattern thumbnails ─────────────────────────────────────────

  function initPatternPreviews() {
    const previewStripes  = $('preview-stripes');
    const previewChecker  = $('preview-checker');
    const previewDots     = $('preview-dots');
    if (previewStripes)  ClearCutBG.renderPatternPreview('stripes',       previewStripes);
    if (previewChecker)  ClearCutBG.renderPatternPreview('checkerboard',  previewChecker);
    if (previewDots)     ClearCutBG.renderPatternPreview('dotgrid',       previewDots);
  }
  initPatternPreviews();

  // ── OpenCV readiness gate ────────────────────────────────────────────────

  function onCvReady() {
    // Nothing to do beyond hiding the overlay (handled in index.html Module.onRuntimeInitialized)
    console.log('ClearCut: OpenCV ready');
  }

  if (window.cvReady) {
    onCvReady();
  } else {
    document.addEventListener('opencv-ready', onCvReady, { once: true });
  }

  // ── Utility ──────────────────────────────────────────────────────────────

  function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16),
    } : { r: 0, g: 180, b: 80 };
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  }

  // Resize canvas when window resizes
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.activeImage && state.contours.length) renderPreview();
    }, 200);
  });

})();
