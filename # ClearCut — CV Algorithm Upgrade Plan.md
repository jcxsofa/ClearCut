# ClearCut — CV Algorithm Upgrade Plan

## Overview

This document describes the planned upgrades to the ClearCut computer vision
pipeline. The changes fall into three areas:

1. **FFT-based pattern removal** for Method B (printable background)
2. **GrabCut segmentation refinement** for all methods
3. **Dilation-based padding** replacing the current centroid-push offset

All processing remains 100% client-side. No new runtime dependencies are
required — `cv.dft()` / `cv.idft()` are already part of the loaded OpenCV.js
build, and `cv.grabCut()` is likewise already present.

---

## 1. FFT Pattern Removal (Method B)

### Problem with current approach
Method B currently uses a large Gaussian blur to approximate the background,
then subtracts it from the original. This is a rough heuristic — it fails when:
- Items have fine internal detail (the blur smears item edges into the
  background estimate)
- The printed pattern has low spatial frequency (wide stripes)
- Lighting is uneven across the sheet

### How FFT fixes this
A repeating pattern (stripes, dots, checkerboard) has a **discrete, predictable
signature in the frequency domain** — it shows up as sharp isolated spikes in
the 2D power spectrum. Items do not — their edges are broadband. By zeroing out
only those spike frequencies and inverse-transforming, we get the original image
with the pattern mathematically removed and item silhouettes intact.

### Implementation steps

#### Step 1 — Forward DFT
```
grayscale image
  → pad to optimal DFT size (cv.getOptimalDFTSize)
  → convert to CV_32F
  → create 2-channel complex mat [real | zeros]
  → cv.dft(complexMat, DFT_COMPLEX_OUTPUT)
```

#### Step 2 — Detect frequency peaks
```
complexMat
  → computeMagnitudeSpectrum()       // log-scaled magnitude
  → fftShift()                       // move DC to center
  → GaussianBlur (large kernel)      // estimate smooth background level
  → subtract blurred from magnitude  // residual = sharp peaks only
  → meanStdDev on residual
  → threshold at mean + N×stddev     // N = fftSensitivity slider
  → findContours on threshold        // each contour = one frequency peak
```

#### Step 3 — Suppress peaks
```
for each detected peak centroid:
  - skip if distance from DC < 10px  // don't suppress DC/low-freq
  - convert shifted coords → unshifted coords
  - cv.circle(complexMat, center, peakRadius, Scalar(0,0), FILLED)
  - also suppress conjugate-symmetric counterpart
```

#### Step 4 — Inverse DFT
```
cv.idft(complexMat, DFT_SCALE | DFT_REAL_OUTPUT)
  → split planes, take real channel
  → crop back to original dimensions
  → convert to CV_8U
  → cv.normalize (stretch contrast)
  → GaussianBlur(5×5) to reduce ringing artifacts
  → adaptiveThreshold → binary mask
```

### New controls exposed to UI
| Control | ID | Range | Default | Description |
|---|---|---|---|---|
| Use FFT toggle | `use-fft` | checkbox | ✅ on | Fall back to Gaussian blur when off |
| FFT suppression radius | `fft-peak-radius` | 4–40 px | 12 | Width of notch around each zeroed peak |
| FFT peak sensitivity | `fft-sensitivity` | 1–8 σ | 3 | Stddevs above mean to classify a spike as a pattern peak |

### Files changed
- `cv.js` — add `removePatternFFT()`, `suppressPeriodicPeaks()`,
  `fftShift()`, `computeMagnitudeSpectrum()`; update `detectMethodB()` to
  branch on `useFFT` option
- `index.html` — add FFT controls inside the existing Advanced panel,
  tagged with `[B]` badge so they hide on other methods
- `app.js` — read new control values in `getDetectionOptions()`
- `style.css` — add `.badge` style for method tags

---

## 2. GrabCut Segmentation Refinement

### Problem with current approach
All three detection methods produce contours from a binary mask. Mask quality
is limited by:
- Threshold sensitivity to lighting variation
- Morphological operations that round fine details
- JPEG compression artifacts creating false edges

The resulting cut paths can have jaggy or inaccurate edges, especially on
items with complex silhouettes (e.g. die-cut letters, irregular shapes).

### How GrabCut helps
GrabCut is an iterative graph-cut segmentation algorithm. Given a bounding
rectangle that contains one foreground object, it builds a Gaussian Mixture
Model of foreground and background colours and iteratively refines the
boundary until it converges. It operates on the **original full-colour image**,
not the thresholded mask, so it recovers edge detail that thresholding loses.

### Implementation steps

#### Per-shape refinement (`grabCutRefineShape`)
```
for each enabled shape:
  1. compute bounding box of existing contour points
  2. expand by `margin` pixels (grabcut-margin slider), clamp to image bounds
  3. convert source image to BGR (GrabCut requires 3-channel)
  4. cv.grabCut(bgr, mask, rect, bgModel, fgModel, iters, GC_INIT_WITH_RECT)
  5. build foreground mask: pixels where mask == GC_FGD or GC_PR_FGD
  6. morphological close + open on foreground mask (kernel 5×5)
  7. findContours → keep largest contour by area
  8. approxPolyDP (epsilon 2.0)
  9. offset contour points back to full-image coordinates (add rect.x, rect.y)
  10. replace shape.points if refined result has ≥ 3 points
```

#### Batch runner (`grabCutRefineAll`)
```
convert source mat to BGR once (avoid repeated conversion per shape)
map over shapes array:
  - skip disabled shapes
  - call grabCutRefineShape
  - call progressCb(current, total) for status bar updates
return new shapes array (immutable — original preserved until render)
```

### UX design
GrabCut is slow (hundreds of ms per shape). It must not block the main detect
loop. Design:
- GrabCut bar is **hidden until initial detection succeeds**
- It appears below the preview canvas as a separate card
- User explicitly clicks **"🔬 Refine with GrabCut"** — it is never automatic
- Status bar shows per-shape progress: "GrabCut: shape 3/7…"
- Button is disabled during processing, re-enabled on completion
- Result replaces `state.shapes` in-place; preview re-renders immediately

### New controls exposed to UI
| Control | ID | Range | Default | Description |
|---|---|---|---|---|
| Iterations | `grabcut-iters` | 1–10 | 5 | More iterations = better quality, slower |
| Margin px | `grabcut-margin` | 0–40 px | 10 | Extra pixels around bounding box for GrabCut context |
| Refine button | `grabcut-btn` | — | — | Triggers batch refinement |

### Files changed
- `cv.js` — add `grabCutRefineShape()`, `grabCutRefineAll()`; export both
  on `window.ClearCutCV`
- `index.html` — add `.grabcut-bar` section after preview canvas
- `app.js` — wire controls, `grabcutBtn` click handler, show bar after
  detection, call `grabCutRefineAll` with progress callback
- `style.css` — add `.grabcut-bar`, `.grabcut-info`, `.grabcut-controls`

---

## 3. Dilation-Based Padding

### Problem with current approach
The current padding implementation pushes each contour vertex **radially
outward from the shape's centroid**. This is incorrect for concave shapes:

```
Star point:           Centroid-push result:     Correct result:
    *                      *                         *
   / \                    /|\                       / \
  /   \        →         / | \          vs         /   \
 *-----*                *--+--*                   *-----*
       ↑ concave notch      ↑ vertex pushed inward!
```

Any vertex on the "wrong side" of the centroid gets pushed inward instead of
outward, collapsing fine features.

### How dilation fixes this
`cv.dilate()` expands a **binary mask** using a structuring element
(ellipse). Every pixel on the boundary is expanded outward in all directions
by exactly `paddingPx` pixels, regardless of shape concavity. This is the
morphologically correct definition of an outward offset.

### Implementation steps (`applyDilationPadding`)
```
for each shape:
  1. create blank CV_8U mask (imgW × imgH)
  2. drawContours(mask, contour, FILLED)         // rasterise shape
  3. build ellipse kernel: size = paddingPx*2+1
  4. cv.dilate(mask, dilated, kernel)            // expand outward
  5. findContours(dilated) → take largest
  6. approxPolyDP (epsilon 2.0)
  7. replace shape.points with refined vertices
```

### Where padding is applied
Padding is applied **after** detection and **after** GrabCut refinement
(if run), immediately before preview render and SVG export. The padding
slider triggers a re-run of `applyDilationPadding` on the last detected
(and optionally GrabCut-refined) shapes — it does not re-run the full
detection pipeline.

### Files changed
- `cv.js` — add `dilateMask()`, `applyDilationPadding()`; remove centroid-
  push logic from `extractContours()`; export both on `window.ClearCutCV`
- `app.js` — call `applyDilationPadding` after detection instead of inline
  centroid push; re-apply when padding slider changes without re-detecting

---

## 4. State Management Changes

To support GrabCut as a separate post-detection step, `app.js` state needs
a second shapes slot:

```javascript
state = {
  // ...existing fields...
  shapes:         [],   // current shapes shown in preview (may be GrabCut-refined)
  detectedShapes: [],   // raw shapes from detection (pre-GrabCut, pre-padding)
  itemsMat:       null, // source cv.Mat kept alive for GrabCut
}
```

- After detection: `detectedShapes` and `shapes` are both set to the raw result
- After GrabCut: only `shapes` is updated; `detectedShapes` is preserved so
  the user can re-detect without losing the original result
- `itemsMat` must be explicitly `delete()`d when a new image is loaded to
  avoid memory leaks

---

## 5. Testing Checklist

### FFT
- [ ] Method B detects items on stripe background with FFT on
- [ ] Method B detects items on dot-grid background with FFT on
- [ ] Toggling FFT off falls back to Gaussian blur path without error
- [ ] Very fine stripe pattern: increase `fft-peak-radius` suppresses pattern
- [ ] Very coarse stripe pattern: decrease `fft-sensitivity` catches peaks
- [ ] No false peak suppression on solid-colour images (no pattern)

### GrabCut
- [ ] GrabCut bar hidden before first detection
- [ ] GrabCut bar appears after successful detection
- [ ] Progress status updates per shape
- [ ] Button disabled during processing, re-enabled after
- [ ] Refined shapes visually tighter than original on a complex silhouette
- [ ] Disabled shapes are skipped (not refined, not moved)
- [ ] GrabCut on single-shape image produces valid result
- [ ] Memory: no OpenCV Mat leak after GrabCut run (check DevTools heap)

### Dilation padding
- [ ] Star shape: padding expands all points outward (no inward collapse)
- [ ] Letter "C": concave inner notch expands correctly
- [ ] Padding = 0: shapes unchanged
- [ ] Large padding on small shape: no crash, graceful degenerate contour
- [ ] Padding slider re-applies without re-running full detection

### Regression
- [ ] Method A still works end-to-end after changes
- [ ] Method C still works end-to-end after changes
- [ ] SVG export produces valid file after GrabCut refinement
- [ ] SVG export produces valid file with dilation padding applied
- [ ] Offline / service worker: app loads without network after first visit

---

## 6. File Change Summary

| File | Changes |
|---|---|
| `cv.js` | Add FFT functions, GrabCut functions, dilation padding; update `detectMethodB`, `extractContours`; update `ClearCutCV` exports |
| `app.js` | Add `getDetectionOptions()`, GrabCut button handler, dilation padding call, `state.detectedShapes`, `state.itemsMat` lifecycle |
| `index.html` | Add FFT controls in Advanced panel; add GrabCut bar after preview |
| `style.css` | Add `.grabcut-bar` styles, `.badge` style |
| `UPGRADE_PLAN.md` | This file |

---

## 7. Out of Scope (Future Work)

| Item | Notes |
|---|---|
| SAM (Segment Anything) | 375MB model — not offline-friendly yet |
| Chaikin / spline smoothing | SVG `C` curves instead of `L` lines — good follow-up |
| ArUco fiducial auto-scaling | Would replace manual sheet size input |
| FFT visualiser panel | Show magnitude spectrum in a debug canvas — useful for tuning |
| Per-shape GrabCut mask editor | Let user paint foreground/background hints before GrabCut |
| Video/webcam mode | MOG2 background subtraction on live feed |