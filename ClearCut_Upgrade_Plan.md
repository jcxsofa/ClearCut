# ClearCut — Crosshatch, Guidance, FFT Controls & Progress Indicator Plan

## 1. Crosshatch Background Pattern

### `backgrounds.js`
- Add `drawCrosshatch(ctx, w, h, hPitch, vPitch, lineWidth)` function
- Use Fibonacci-adjacent pitches **15px / 24px** (ratio ≈ 0.625, close to golden ratio) as defaults — safe for 600 DPI print/scan
- Make `crosshatch` the **default** pattern in `generateBackground()`
- Update the pattern `switch` statement to include the new case

### `index.html` / `app.js`
- Add `crosshatch` option to the pattern selector dropdown and the pattern card grid
- Mark it **(Recommended)** in the label
- Add a short hint explaining why two frequencies are better than one
- Update `localStorage` default to `crosshatch`

---

## 2. Printer / Scanner Settings Guidance

Add a collapsible `<details>` block inside the Method B card, placed **above** the upload zone.

### Content
```
📄 Recommended scan settings
  ├── Resolution:              600 DPI
  ├── Color mode:              Color (not Grayscale — preserves item colour)
  ├── File format:             PDF or JPEG
  ├── Auto-crop / Auto-rotate: OFF
  ├── Auto colour correction:  OFF
  └── Placement:               Items flat, no overlapping, no shadows
```

### Key points to emphasise
- **600 DPI** is the sweet spot — higher wastes processing time, lower loses FFT peak sharpness
- **Auto-corrections must be OFF** — scanner software "enhancing" the image destroys the periodic pattern the FFT relies on
- **Flat placement** — items must not overlap or cast shadows on each other

---

## 3. Expose FFT Variables

The following should be user-controllable in the Method B controls panel.  
Currently `fftPeakRadius` and `fftSensitivity` are already sliders — the rest need adding.

| Variable | Current default | UI type | Range | Label |
|---|---|---|---|---|
| `fftPeakRadius` | 12 | Slider (exists) | 5–40 | Peak suppression radius |
| `fftSensitivity` | 3 | Slider (exists) | 1–8 | Peak detection sensitivity |
| `morphKernel` | 5 | Slider | 2–15 | Cleanup radius |
| `minArea` | 500 | Number input | 50–5000 | Minimum shape size (px²) |
| `hPitch` | 15 | Read-only display | — | Pulled from background generator; shown for reference |
| `vPitch` | 24 | Read-only display | — | Pulled from background generator; shown for reference |
| `dcGuard` | 10 | Advanced/collapsed | 5–30 | DC guard radius (advanced users only) |

### Peak overlap warning
If `peakRadius > hPitch / 2` or `peakRadius > vPitch / 2`, show a visible warning:
> ⚠️ Suppression radius is larger than half the stripe pitch — circles may overlap and remove image content.

---

## 4. Progress Indicator

The most impactful UX change. OpenCV.js runs **synchronously on the main thread** so the UI currently freezes with no feedback.

### Pipeline stages and labels

**Method A** (Two Photos)
```
[1/4] Loading images…
[2/4] Aligning photos…
[3/4] Subtracting background…
[4/4] Finding shapes…
```

**Method B** (Printable Background)
```
[1/5] Loading image…
[2/5] Converting to greyscale…
[3/5] Running FFT — removing background pattern…
[4/5] Finding shapes…
[5/5] Done — N shapes found
```

**Method C** (Solid Color)
```
[1/3] Loading image…
[2/3] Masking background colour…
[3/3] Finding shapes…
```

### Implementation approach

#### `cv.js`
- Add an optional `onProgress(step, total, message)` callback parameter to `detectMethodA`,
  `detectMethodB`, `detectMethodC`
- Add a `yieldThen(fn)` async helper that forces a browser repaint between steps:
  ```javascript
  async function yieldThen(fn) {
    await new Promise(r => setTimeout(r, 0));
    return fn();
  }
  ```
- Wrap each major CV phase in `yieldThen()` so the browser can repaint between them
- Call `onProgress(step, total, message)` at the start of each phase

#### `index.html`
Add a progress block just above the canvas in `#section-preview`:
```html
<div id="detection-progress" class="detection-progress hidden">
  <div class="progress-bar-track">
    <div id="progress-fill" class="progress-bar-fill"></div>
  </div>
  <p id="progress-label" class="progress-label">Preparing…</p>
</div>
```

#### `app.js`
- On detect button click: show `#detection-progress`, set fill to 0%, label to first stage
- Pass a `progressCallback` to the detect function that updates `#progress-fill` width
  and `#progress-label` text
- On completion: set fill to 100%, label to "Done — N shapes found", then fade out after 1.5s
- On error: set label to the error message in red, keep visible

#### `style.css`
```css
.detection-progress { margin: 12px 0; }
.progress-bar-track {
  height: 6px;
  background: var(--border);
  border-radius: 3px;
  overflow: hidden;
}
.progress-bar-fill {
  height: 100%;
  background: var(--brand);
  border-radius: 3px;
  transition: width 0.2s ease;
  width: 0%;
}
.progress-label {
  font-size: .82rem;
  color: var(--text-muted);
  margin-top: 5px;
}
```

---

## Files to Change

| File | Changes |
|---|---|
| `backgrounds.js` | Add `drawCrosshatch`, update `generateBackground` switch, update default |
| `cv.js` | Add `yieldThen` helper, add `onProgress` param to all three detect functions, wrap major steps |
| `index.html` | Crosshatch pattern card, scan guidance panel, progress bar HTML, `dcGuard` advanced control |
| `app.js` | Wire up progress bar callback, pass new FFT/morph options, update pattern default |
| `style.css` | Progress bar styles, scan guidance panel styles |

---

## Out of Scope (Future)

- Multi-page PDF support
- Live preview re-detection on slider change (debounced)
- Exporting per-shape images
