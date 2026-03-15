/**
 * cv.js — OpenCV.js image processing module for ClearCut
 *
 * Exports:
 *   detectMethodA(bgImg, itemsImg, options)  → contours[]
 *   detectMethodB(scanImg, pattern, options) → contours[]
 *   detectMethodC(img, bgColor, tolerance, options) → contours[]
 *   sampleColorAt(img, x, y)                → {r,g,b}
 *
 * A contour is an object: { points: [{x,y},...], bounds: {x,y,w,h}, area, enabled }
 */

const ClearCutCV = (() => {

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Load an HTMLImageElement (already decoded) into a cv.Mat, RGBA→BGR */
  function imgToMat(imgEl) {
    const canvas = document.createElement('canvas');
    canvas.width  = imgEl.naturalWidth  || imgEl.width;
    canvas.height = imgEl.naturalHeight || imgEl.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgEl, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const src = cv.matFromImageData(imageData);   // RGBA
    const mat = new cv.Mat();
    cv.cvtColor(src, mat, cv.COLOR_RGBA2BGR);
    src.delete();
    return mat;
  }

  /** Resize src to match dst size if they differ */
  function matchSize(src, dst) {
    if (src.cols === dst.cols && src.rows === dst.rows) return src;
    const out = new cv.Mat();
    cv.resize(src, out, new cv.Size(dst.cols, dst.rows), 0, 0, cv.INTER_LINEAR);
    return out;
  }

  /**
   * Post-process a binary mask:
   *   1. Morphological close  (fill small holes inside items)
   *   2. Morphological open   (remove small noise blobs)
   *   3. findContours
   *   4. Filter by area & approxPolyDP
   */
  function extractContours(mask, options = {}) {
    const {
      minArea        = 500,
      smoothEpsilon  = 2.0,   // approxPolyDP epsilon in pixels
      morphKernel    = 5,     // base kernel radius for open/close operations
    } = options;

    // Close small holes — kernel is 2× the base (fills gaps inside items)
    const closeSize = Math.max(3, morphKernel * 2 - 1) | 1;  // keep odd
    const kernel  = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(closeSize, closeSize));
    const closed  = new cv.Mat();
    cv.morphologyEx(mask, closed, cv.MORPH_CLOSE, kernel);

    // Remove noise — kernel is 1× the base
    const openSize  = Math.max(3, morphKernel) | 1;  // keep odd
    const kernel2 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(openSize, openSize));
    const opened  = new cv.Mat();
    cv.morphologyEx(closed, opened, cv.MORPH_OPEN, kernel2);

    const contoursMat = new cv.MatVector();
    const hierarchy   = new cv.Mat();
    cv.findContours(opened, contoursMat, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const results = [];
    for (let i = 0; i < contoursMat.size(); i++) {
      const c = contoursMat.get(i);
      const area = cv.contourArea(c);
      if (area < minArea) { c.delete(); continue; }

      // Smooth contour
      const approx = new cv.Mat();
      cv.approxPolyDP(c, approx, smoothEpsilon, true);

      // Extract points
      const pts = [];
      for (let j = 0; j < approx.rows; j++) {
        pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
      }

      if (pts.length >= 3) {
        const bounds = cv.boundingRect(approx);
        results.push({
          points:  pts,
          bounds:  { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height },
          area,
          enabled: true,
        });
      }

      c.delete();
      approx.delete();
    }

    kernel.delete(); kernel2.delete();
    closed.delete(); opened.delete();
    contoursMat.delete(); hierarchy.delete();

    // Sort by area descending
    results.sort((a, b) => b.area - a.area);
    return results;
  }

  // ── Method A: Two-Shot Subtraction ────────────────────────────────────────

  /**
   * Attempt ORB-based homography alignment.
   * Returns a warped version of bgMat aligned to itemsMat,
   * or null if alignment fails (too few matches).
   */
  function tryAlignImages(bgMat, itemsMat) {
    try {
      const bgGray    = new cv.Mat();
      const itemsGray = new cv.Mat();
      cv.cvtColor(bgMat, bgGray, cv.COLOR_BGR2GRAY);
      cv.cvtColor(itemsMat, itemsGray, cv.COLOR_BGR2GRAY);

      const orb   = new cv.ORB(500);
      const kp1   = new cv.KeyPointVector();
      const kp2   = new cv.KeyPointVector();
      const desc1 = new cv.Mat();
      const desc2 = new cv.Mat();
      const mask1 = new cv.Mat();
      const mask2 = new cv.Mat();

      orb.detectAndCompute(bgGray, mask1, kp1, desc1);
      orb.detectAndCompute(itemsGray, mask2, kp2, desc2);

      if (desc1.rows < 8 || desc2.rows < 8) {
        // Not enough features — clean up and signal failure
        [bgGray, itemsGray, desc1, desc2, mask1, mask2].forEach(m => m.delete());
        kp1.delete(); kp2.delete(); orb.delete();
        return null;
      }

      const bf      = new cv.BFMatcher(cv.NORM_HAMMING, true);
      const matches = new cv.DMatchVector();
      bf.match(desc1, desc2, matches);

      if (matches.size() < 8) {
        [bgGray, itemsGray, desc1, desc2, mask1, mask2].forEach(m => m.delete());
        kp1.delete(); kp2.delete(); orb.delete(); matches.delete(); bf.delete();
        return null;
      }

      // Collect src/dst point arrays for findHomography
      const srcPts = [];
      const dstPts = [];
      for (let i = 0; i < matches.size(); i++) {
        const m   = matches.get(i);
        const pt1 = kp1.get(m.queryIdx).pt;
        const pt2 = kp2.get(m.trainIdx).pt;
        srcPts.push(pt1.x, pt1.y);
        dstPts.push(pt2.x, pt2.y);
      }

      const srcMat = cv.matFromArray(matches.size(), 1, cv.CV_32FC2, srcPts);
      const dstMat = cv.matFromArray(matches.size(), 1, cv.CV_32FC2, dstPts);

      const H = cv.findHomography(srcMat, dstMat, cv.RANSAC, 3.0);

      if (!H || H.empty()) {
        [bgGray, itemsGray, desc1, desc2, mask1, mask2, srcMat, dstMat].forEach(m => m.delete());
        kp1.delete(); kp2.delete(); orb.delete(); matches.delete(); bf.delete();
        if (H) H.delete();
        return null;
      }

      const warped  = new cv.Mat();
      const dsize   = new cv.Size(itemsMat.cols, itemsMat.rows);
      cv.warpPerspective(bgMat, warped, H, dsize);

      [bgGray, itemsGray, desc1, desc2, mask1, mask2, srcMat, dstMat, H].forEach(m => m.delete());
      kp1.delete(); kp2.delete(); orb.delete(); matches.delete(); bf.delete();
      return warped;

    } catch (e) {
      console.warn('ClearCutCV: alignment failed:', e);
      return null;
    }
  }

  /**
   * Method A — Two-shot subtraction.
   * @param {HTMLImageElement} bgImgEl    – photo of empty background
   * @param {HTMLImageElement} itemsImgEl – photo with items on background
   * @param {object}           options
   * @returns {Array} contours
   */
  function detectMethodA(bgImgEl, itemsImgEl, options = {}) {
    const { threshold = 30, minArea = 500, smoothEpsilon = 2, morphKernel = 5 } = options;

    const bgMat    = imgToMat(bgImgEl);
    const itemsMat = imgToMat(itemsImgEl);

    // Resize bg to match items image if needed
    const bgResized = matchSize(bgMat, itemsMat);
    if (bgResized !== bgMat) bgMat.delete();

    // Try alignment
    let alignedBg = tryAlignImages(bgResized, itemsMat);
    let alignmentFailed = false;
    if (!alignedBg) {
      alignedBg = bgResized;
      alignmentFailed = true;
    }

    // Pixel-difference
    const diff = new cv.Mat();
    cv.absdiff(alignedBg, itemsMat, diff);

    const diffGray = new cv.Mat();
    cv.cvtColor(diff, diffGray, cv.COLOR_BGR2GRAY);

    // Threshold
    const mask = new cv.Mat();
    cv.threshold(diffGray, mask, threshold, 255, cv.THRESH_BINARY);

    const contours = extractContours(mask, { minArea, smoothEpsilon, morphKernel });

    // Clean up
    [bgResized, itemsMat, diff, diffGray, mask].forEach(m => {
      try { m.delete(); } catch (_) {}
    });
    if (alignedBg !== bgResized) {
      try { alignedBg.delete(); } catch (_) {}
    }

    if (alignmentFailed) {
      contours._alignmentWarning = true;
    }
    return contours;
  }

  // ── Method B: Printable Background ────────────────────────────────────────

  /**
   * Method B — Detect items placed on a known printable background.
   * Strategy: convert to grayscale, use adaptive threshold to isolate the
   * pattern, then mask out regions that DON'T match the expected frequency
   * (i.e. items interrupt the pattern).
   *
   * Simplified implementation: gaussian blur + local adaptive threshold +
   * frequency-domain low-pass filter to separate "pattern" from "items" layer.
   *
   * @param {HTMLImageElement} scanImgEl
   * @param {'stripes'|'checkerboard'|'dotgrid'} pattern
   * @param {object} options
   */
  function detectMethodB(scanImgEl, pattern, options = {}) {
    const { threshold = 30, minArea = 500, smoothEpsilon = 2, morphKernel = 5, blurRadius = 25 } = options;

    const src  = imgToMat(scanImgEl);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_BGR2GRAY);

    // Step 1: Adaptive threshold to create a binary image of the scanned content
    const binary = new cv.Mat();
    cv.adaptiveThreshold(gray, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 21, 8);

    // Step 2: Large Gaussian blur as a low-pass filter to separate background pattern from items.
    const blurred = new cv.Mat();
    const kernelSize = Math.max(11, blurRadius * 2 + 1) | 1;  // keep odd, minimum 11
    cv.GaussianBlur(binary, blurred, new cv.Size(kernelSize, kernelSize), 0);

    // Threshold the blurred result to isolate "item" regions (areas of high local density)
    const mask = new cv.Mat();
    cv.threshold(blurred, mask, threshold, 255, cv.THRESH_BINARY);

    const contours = extractContours(mask, { minArea, smoothEpsilon, morphKernel });

    [src, gray, binary, blurred, mask].forEach(m => { try { m.delete(); } catch (_) {} });
    return contours;
  }

  // ── Method C: Solid Color Background ─────────────────────────────────────

  /**
   * Method C — Solid color background subtraction via HSV thresholding.
   * @param {HTMLImageElement} imgEl
   * @param {{r,g,b}}          bgColor   – background color to remove
   * @param {number}           tolerance – HSV hue tolerance (0-180 scale)
   * @param {object}           options
   */
  function detectMethodC(imgEl, bgColor, tolerance, options = {}) {
    const { minArea = 500, smoothEpsilon = 2, morphKernel = 5 } = options;

    const src = imgToMat(imgEl);
    const hsv = new cv.Mat();
    cv.cvtColor(src, hsv, cv.COLOR_BGR2HSV);

    // Convert the picked RGB color to HSV
    const { h: bgH, s: bgS, v: bgV } = rgbToHsv(bgColor.r, bgColor.g, bgColor.b);

    // Hue tolerance (OpenCV uses 0-179)
    const hTol  = Math.max(5, Math.round(tolerance * 0.9));
    // Saturation tolerance — more lenient for near-white/near-black backgrounds
    const sTol  = Math.max(40, Math.round(tolerance * 1.2));
    const vTol  = Math.max(40, Math.round(tolerance * 1.2));

    let mask;

    if (bgS < 30) {
      // Near-achromatic (white/black/grey) — use only V channel
      const loV = Math.max(0,   bgV - vTol);
      const hiV = Math.min(255, bgV + vTol);
      const lo  = new cv.Mat(1, 1, cv.CV_8UC3);
      const hi  = new cv.Mat(1, 1, cv.CV_8UC3);
      lo.data[0] = 0;  lo.data[1] = 0;  lo.data[2] = loV;
      hi.data[0] = 179; hi.data[1] = 30; hi.data[2] = hiV;
      mask = new cv.Mat();
      cv.inRange(hsv, lo, hi, mask);
      lo.delete(); hi.delete();
    } else {
      // Chromatic background — use full HSV range
      const loH = Math.max(0,   bgH - hTol);
      const hiH = Math.min(179, bgH + hTol);
      const loS = Math.max(0,   bgS - sTol);
      const loV2 = Math.max(0,   bgV - vTol);
      const hiV2 = Math.min(255, bgV + vTol);

      if (loH < 0 || (bgH - hTol < 0 || bgH + hTol > 179)) {
        // Hue wraps around (reds) — need two ranges
        const lo1 = new cv.Mat(1, 1, cv.CV_8UC3);
        const hi1 = new cv.Mat(1, 1, cv.CV_8UC3);
        const lo2 = new cv.Mat(1, 1, cv.CV_8UC3);
        const hi2 = new cv.Mat(1, 1, cv.CV_8UC3);
        lo1.data[0] = 0;    lo1.data[1] = loS; lo1.data[2] = loV2;
        hi1.data[0] = hiH;  hi1.data[1] = 255; hi1.data[2] = hiV2;
        lo2.data[0] = (loH + 180) % 180; lo2.data[1] = loS; lo2.data[2] = loV2;
        hi2.data[0] = 179;               hi2.data[1] = 255; hi2.data[2] = hiV2;
        const m1 = new cv.Mat();
        const m2 = new cv.Mat();
        cv.inRange(hsv, lo1, hi1, m1);
        cv.inRange(hsv, lo2, hi2, m2);
        mask = new cv.Mat();
        cv.bitwise_or(m1, m2, mask);
        [lo1, hi1, lo2, hi2, m1, m2].forEach(m => m.delete());
      } else {
        const lo = new cv.Mat(1, 1, cv.CV_8UC3);
        const hi = new cv.Mat(1, 1, cv.CV_8UC3);
        lo.data[0] = loH; lo.data[1] = loS; lo.data[2] = loV2;
        hi.data[0] = hiH; hi.data[1] = 255; hi.data[2] = hiV2;
        mask = new cv.Mat();
        cv.inRange(hsv, lo, hi, mask);
        lo.delete(); hi.delete();
      }
    }

    // Invert: background mask → items mask
    const itemsMask = new cv.Mat();
    cv.bitwise_not(mask, itemsMask);

    const contours = extractContours(itemsMask, { minArea, smoothEpsilon, morphKernel });

    [src, hsv, mask, itemsMask].forEach(m => { try { m.delete(); } catch (_) {} });
    return contours;
  }

  // ── Color Sampling ─────────────────────────────────────────────────────

  /**
   * Sample the color at a given pixel coordinate from an HTMLImageElement.
   * Returns {r, g, b}.
   */
  function sampleColorAt(imgEl, x, y) {
    const canvas = document.createElement('canvas');
    canvas.width  = imgEl.naturalWidth  || imgEl.width;
    canvas.height = imgEl.naturalHeight || imgEl.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgEl, 0, 0);
    const px = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    return { r: px[0], g: px[1], b: px[2] };
  }

  // ── Utility: RGB → HSV (OpenCV 0-179/0-255/0-255 scale) ──────────────

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const diff = max - min;
    let h = 0;
    if (diff !== 0) {
      if (max === r) h = ((g - b) / diff) % 6;
      else if (max === g) h = (b - r) / diff + 2;
      else h = (r - g) / diff + 4;
      h = Math.round(h * 30);   // OpenCV H: 0-179 (multiply by 30 instead of 60)
      if (h < 0) h += 180;
    }
    const s = max === 0 ? 0 : Math.round((diff / max) * 255);
    const v = Math.round(max * 255);
    return { h, s, v };
  }

  // ── Public API ───────────────────────────────────────────────────────────

  return {
    detectMethodA,
    detectMethodB,
    detectMethodC,
    sampleColorAt,
    rgbToHsv,
  };

})();

window.ClearCutCV = ClearCutCV;
