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
   * Yield control to the browser so the UI can repaint, then run fn().
   * Returns a Promise resolving to fn()'s return value.
   */
  async function yieldThen(fn) {
    await new Promise(r => setTimeout(r, 0));
    return fn();
  }

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
   * @param {Function}         [onProgress(step, total, message)]
   * @returns {Promise<Array>} contours
   */
  async function detectMethodA(bgImgEl, itemsImgEl, options = {}, onProgress = null) {
    const { threshold = 30, minArea = 500, smoothEpsilon = 2, morphKernel = 5 } = options;
    const prog = onProgress || (() => {});

    prog(1, 4, '[1/4] Loading images…');
    const bgMat    = await yieldThen(() => imgToMat(bgImgEl));
    const itemsMat = imgToMat(itemsImgEl);

    // Resize bg to match items image if needed
    const bgResized = matchSize(bgMat, itemsMat);
    if (bgResized !== bgMat) bgMat.delete();

    prog(2, 4, '[2/4] Aligning photos…');
    let alignedBg = await yieldThen(() => tryAlignImages(bgResized, itemsMat));
    let alignmentFailed = false;
    if (!alignedBg) {
      alignedBg = bgResized;
      alignmentFailed = true;
    }

    prog(3, 4, '[3/4] Subtracting background…');
    const diff = await yieldThen(() => {
      const d = new cv.Mat();
      cv.absdiff(alignedBg, itemsMat, d);
      return d;
    });

    const diffGray = new cv.Mat();
    cv.cvtColor(diff, diffGray, cv.COLOR_BGR2GRAY);

    // Threshold
    const mask = new cv.Mat();
    cv.threshold(diffGray, mask, threshold, 255, cv.THRESH_BINARY);

    prog(4, 4, '[4/4] Finding shapes…');
    const contours = await yieldThen(() => extractContours(mask, { minArea, smoothEpsilon, morphKernel }));

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

  // ── FFT Helpers ──────────────────────────────────────────────────────────

  /**
   * Rearrange quadrants of a 2D DFT magnitude image so the DC component
   * moves from the top-left corner to the centre.
   * Works in-place on a single-channel floating-point Mat.
   */
  function fftShift(mat) {
    const cx = Math.floor(mat.cols / 2);
    const cy = Math.floor(mat.rows / 2);
    // Swap quadrants: TL ↔ BR and TR ↔ BL
    const q0 = mat.roi(new cv.Rect(0,  0,  cx, cy));
    const q1 = mat.roi(new cv.Rect(cx, 0,  mat.cols - cx, cy));
    const q2 = mat.roi(new cv.Rect(0,  cy, cx, mat.rows - cy));
    const q3 = mat.roi(new cv.Rect(cx, cy, mat.cols - cx, mat.rows - cy));
    const tmp = new cv.Mat();
    q0.copyTo(tmp);  q3.copyTo(q0);  tmp.copyTo(q3);
    q1.copyTo(tmp);  q2.copyTo(q1);  tmp.copyTo(q2);
    tmp.delete();
    q0.delete(); q1.delete(); q2.delete(); q3.delete();
  }

  /**
   * Compute the log-scaled magnitude spectrum of a 2-channel complex DFT Mat.
   * Returns a new CV_32F single-channel Mat (caller must delete).
   */
  function computeMagnitudeSpectrum(complexMat) {
    const planes = new cv.MatVector();
    cv.split(complexMat, planes);
    const real = planes.get(0);
    const imag = planes.get(1);
    const mag  = new cv.Mat();
    cv.magnitude(real, imag, mag);
    // Log-scale: log(1 + mag)
    const ones = cv.Mat.ones(mag.rows, mag.cols, cv.CV_32F);
    cv.add(mag, ones, mag);
    cv.log(mag, mag);
    real.delete(); imag.delete(); ones.delete();
    planes.delete();
    return mag;
  }

  /**
   * Zero-out isolated frequency peaks in a 2-channel complex DFT Mat,
   * excluding the DC region.  Peaks are detected on the shifted magnitude
   * spectrum and converted back to unshifted coordinates for suppression.
   *
   * @param {cv.Mat} complexMat   – modified in-place (2-channel CV_32F, unshifted)
   * @param {number} peakRadius   – radius of the zeroing circle around each peak
   * @param {number} sensitivity  – stddevs above mean to classify as a peak
   * @param {number} dcGuard      – radius around DC to leave untouched
   */
  function suppressPeriodicPeaks(complexMat, peakRadius = 12, sensitivity = 3, dcGuard = 10) {
    const W = complexMat.cols;
    const H = complexMat.rows;
    const cx = Math.floor(W / 2);
    const cy = Math.floor(H / 2);

    // Build shifted log-magnitude
    const mag = computeMagnitudeSpectrum(complexMat);
    fftShift(mag);

    // Estimate smooth background via large Gaussian blur
    const bgEst = new cv.Mat();
    const bkSize = (Math.min(W, H) / 4) | 1;   // ~25% of image size, keep odd
    const bkSizeOdd = bkSize % 2 === 0 ? bkSize + 1 : bkSize;
    cv.GaussianBlur(mag, bgEst, new cv.Size(bkSizeOdd, bkSizeOdd), 0);

    // Residual = mag - background
    const residual = new cv.Mat();
    cv.subtract(mag, bgEst, residual);

    // Threshold residual
    const mean   = new cv.Mat();
    const stddev = new cv.Mat();
    cv.meanStdDev(residual, mean, stddev);
    const mu    = mean.data64F[0];
    const sigma = stddev.data64F[0];
    const thresh = mu + sensitivity * sigma;

    const binMask = new cv.Mat();
    cv.threshold(residual, binMask, thresh, 255, cv.THRESH_BINARY);
    const binU8 = new cv.Mat();
    binMask.convertTo(binU8, cv.CV_8U);

    // Find peak contours
    const contourVec = new cv.MatVector();
    const hierarchy  = new cv.Mat();
    cv.findContours(binU8, contourVec, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const zeroScalar = new cv.Scalar(0, 0, 0, 0);

    for (let i = 0; i < contourVec.size(); i++) {
      const c = contourVec.get(i);
      const m = cv.moments(c);
      if (m.m00 === 0) { c.delete(); continue; }

      // Shifted-space centroid
      const sx = Math.round(m.m10 / m.m00);
      const sy = Math.round(m.m01 / m.m00);

      // Skip if too close to DC (centre in shifted coords)
      const distFromDC = Math.sqrt((sx - cx) ** 2 + (sy - cy) ** 2);
      if (distFromDC < dcGuard) { c.delete(); continue; }

      // Convert to unshifted coordinates
      const ux = (sx + cx) % W;
      const uy = (sy + cy) % H;

      // Suppress this peak and its conjugate-symmetric counterpart
      cv.circle(complexMat, new cv.Point(ux, uy), peakRadius, zeroScalar, -1);
      const conjX = (W - ux) % W;
      const conjY = (H - uy) % H;
      cv.circle(complexMat, new cv.Point(conjX, conjY), peakRadius, zeroScalar, -1);

      c.delete();
    }

    // Cleanup
    [mag, bgEst, residual, mean, stddev, binMask, binU8, contourVec, hierarchy].forEach(m => {
      try { m.delete(); } catch (_) {}
    });
  }

  /**
   * Render the log-magnitude spectrum of a complex DFT Mat to an HTMLCanvasElement.
   * DC component is shifted to the centre. Rendered as a greyscale heatmap.
   *
   * @param {cv.Mat}           complexMat – 2-channel CV_32F unshifted DFT result
   * @param {HTMLCanvasElement} canvas
   */
  function renderSpectrumToCanvas(complexMat, canvas) {
    const mag = computeMagnitudeSpectrum(complexMat);  // log-scaled CV_32F
    fftShift(mag);

    // Normalise to 0-255 CV_8U
    const norm = new cv.Mat();
    cv.normalize(mag, norm, 0, 255, cv.NORM_MINMAX, cv.CV_8U);

    // Convert to RGBA for ImageData
    const rgba = new cv.Mat();
    cv.cvtColor(norm, rgba, cv.COLOR_GRAY2RGBA);

    canvas.width  = rgba.cols;
    canvas.height = rgba.rows;
    const ctx = canvas.getContext('2d');
    const imgData = new ImageData(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows);
    ctx.putImageData(imgData, 0, 0);

    mag.delete(); norm.delete(); rgba.delete();
  }

  /**
   * Remove a periodic background pattern from a grayscale image via FFT.
   * Returns a CV_8U binary mask where items are white.
   *
   * @param {cv.Mat} grayMat        – single-channel CV_8U source
   * @param {number} peakRadius     – zeroing radius around each frequency peak
   * @param {number} sensitivity    – stddev sensitivity for peak detection
   * @param {HTMLCanvasElement} [debugCanvasBefore] – if provided, receives the pre-suppression spectrum
   * @param {HTMLCanvasElement} [debugCanvasAfter]  – if provided, receives the post-suppression spectrum
   * @returns {cv.Mat} binary mask (caller must delete)
   */
  function removePatternFFT(grayMat, peakRadius = 12, sensitivity = 3,
                            debugCanvasBefore = null, debugCanvasAfter = null,
                            dcGuard = 10) {
    // Pad to optimal DFT size
    const optW = cv.getOptimalDFTSize(grayMat.cols);
    const optH = cv.getOptimalDFTSize(grayMat.rows);

    const padded = new cv.Mat();
    cv.copyMakeBorder(grayMat, padded, 0, optH - grayMat.rows, 0, optW - grayMat.cols,
                      cv.BORDER_CONSTANT, new cv.Scalar(0));

    // Convert to float
    const floatMat = new cv.Mat();
    padded.convertTo(floatMat, cv.CV_32F);

    // Build 2-channel complex mat [real | zeros]
    const zeros  = cv.Mat.zeros(floatMat.rows, floatMat.cols, cv.CV_32F);
    const planes = new cv.MatVector();
    planes.push_back(floatMat);
    planes.push_back(zeros);
    const complexMat = new cv.Mat();
    cv.merge(planes, complexMat);

    // Forward DFT
    cv.dft(complexMat, complexMat, cv.DFT_COMPLEX_OUTPUT);

    // Debug: render pre-suppression spectrum
    if (debugCanvasBefore) {
      renderSpectrumToCanvas(complexMat, debugCanvasBefore);
    }

    // Suppress periodic peaks
    suppressPeriodicPeaks(complexMat, peakRadius, sensitivity, dcGuard);

    // Debug: render post-suppression spectrum
    if (debugCanvasAfter) {
      renderSpectrumToCanvas(complexMat, debugCanvasAfter);
    }

    // Inverse DFT — cv.idft is not exposed in OpenCV.js; use cv.dft with DFT_INVERSE instead
    const iDft = new cv.Mat();
    cv.dft(complexMat, iDft, cv.DFT_INVERSE | cv.DFT_SCALE | cv.DFT_REAL_OUTPUT);

    // Crop back to original size
    const cropped = iDft.roi(new cv.Rect(0, 0, grayMat.cols, grayMat.rows));
    const croppedCopy = new cv.Mat();
    cropped.copyTo(croppedCopy);

    // Normalize to 0-255
    const normalized = new cv.Mat();
    cv.normalize(croppedCopy, normalized, 0, 255, cv.NORM_MINMAX, cv.CV_8U);

    // Smooth to reduce ringing artifacts
    cv.GaussianBlur(normalized, normalized, new cv.Size(5, 5), 0);

    // Adaptive threshold → binary mask
    const mask = new cv.Mat();
    cv.adaptiveThreshold(normalized, mask, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C,
                         cv.THRESH_BINARY_INV, 21, 8);

    // Cleanup intermediates
    [padded, floatMat, zeros, complexMat, iDft, croppedCopy, normalized].forEach(m => {
      try { m.delete(); } catch (_) {}
    });
    planes.delete();
    cropped.delete();

    return mask;
  }

  // ── Method B: Printable Background ────────────────────────────────────────

  /**
   * Method B — Detect items placed on a known printable background.
   *
   * When useFFT is true (default), uses FFT-based periodic pattern removal
   * which is more accurate for striped/dotted/checkered backgrounds.
   * Falls back to Gaussian blur heuristic when useFFT is false.
   *
   * @param {HTMLImageElement} scanImgEl
   * @param {'stripes'|'checkerboard'|'dotgrid'|'crosshatch'} pattern
   * @param {object} options
   * @param {Function} [onProgress(step, total, message)]
   */
  async function detectMethodB(scanImgEl, pattern, options = {}, onProgress = null) {
    const {
      threshold      = 30,
      minArea        = 500,
      smoothEpsilon  = 2,
      morphKernel    = 5,
      blurRadius     = 25,
      useFFT         = true,
      fftPeakRadius  = 12,
      fftSensitivity = 3,
      dcGuard        = 10,
      fftDebugCanvasBefore = null,
      fftDebugCanvasAfter  = null,
    } = options;

    const prog = onProgress || (() => {});

    prog(1, 5, '[1/5] Loading image…');
    const src  = await yieldThen(() => imgToMat(scanImgEl));

    prog(2, 5, '[2/5] Converting to greyscale…');
    const gray = await yieldThen(() => {
      const g = new cv.Mat();
      cv.cvtColor(src, g, cv.COLOR_BGR2GRAY);
      return g;
    });

    let mask;

    if (useFFT) {
      prog(3, 5, '[3/5] Running FFT — removing background pattern…');
      mask = await yieldThen(() =>
        removePatternFFT(gray, fftPeakRadius, fftSensitivity,
                         fftDebugCanvasBefore, fftDebugCanvasAfter, dcGuard)
      );
    } else {
      prog(3, 5, '[3/5] Masking background pattern (Gaussian fallback)…');
      mask = await yieldThen(() => {
        const binary = new cv.Mat();
        cv.adaptiveThreshold(gray, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 21, 8);
        const blurred = new cv.Mat();
        const kernelSize = Math.max(11, blurRadius * 2 + 1) | 1;
        cv.GaussianBlur(binary, blurred, new cv.Size(kernelSize, kernelSize), 0);
        const m = new cv.Mat();
        cv.threshold(blurred, m, threshold, 255, cv.THRESH_BINARY);
        binary.delete();
        blurred.delete();
        return m;
      });
    }

    prog(4, 5, '[4/5] Finding shapes…');
    const contours = await yieldThen(() => extractContours(mask, { minArea, smoothEpsilon, morphKernel }));

    prog(5, 5, '[5/5] Done.');
    [src, gray, mask].forEach(m => { try { m.delete(); } catch (_) {} });
    return contours;
  }

  // ── Method C: Solid Color Background ─────────────────────────────────────

  /**
   * Method C — Solid color background subtraction via HSV thresholding.
   * @param {HTMLImageElement} imgEl
   * @param {{r,g,b}}          bgColor   – background color to remove
   * @param {number}           tolerance – HSV hue tolerance (0-180 scale)
   * @param {object}           options
   * @param {Function}         [onProgress(step, total, message)]
   */
  async function detectMethodC(imgEl, bgColor, tolerance, options = {}, onProgress = null) {
    const { minArea = 500, smoothEpsilon = 2, morphKernel = 5 } = options;
    const prog = onProgress || (() => {});

    prog(1, 3, '[1/3] Loading image…');
    const src = await yieldThen(() => imgToMat(imgEl));
    const hsv = new cv.Mat();
    cv.cvtColor(src, hsv, cv.COLOR_BGR2HSV);

    prog(2, 3, '[2/3] Masking background colour…');
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

    prog(3, 3, '[3/3] Finding shapes…');
    const contours = await yieldThen(() => extractContours(itemsMask, { minArea, smoothEpsilon, morphKernel }));

    [src, hsv, mask, itemsMask].forEach(m => { try { m.delete(); } catch (_) {} });
    return contours;
  }

  // ── GrabCut Segmentation Refinement ──────────────────────────────────────

  /**
   * Refine a single shape's contour using GrabCut segmentation.
   * Operates on an already-converted BGR source Mat to avoid repeated
   * colour-space conversion when processing many shapes.
   *
   * @param {cv.Mat}  bgrMat  – full-image BGR source (not deleted here)
   * @param {object}  shape   – shape object with .points and .bounds
   * @param {number}  margin  – extra pixels to expand bounding box for context
   * @param {number}  iters   – GrabCut iterations (more = better quality, slower)
   * @returns {object} refined shape (or original if refinement fails / degenerates)
   */
  function grabCutRefineShape(bgrMat, shape, margin = 10, iters = 5) {
    try {
      const imgW = bgrMat.cols;
      const imgH = bgrMat.rows;
      const b    = shape.bounds;

      // Expand bounding box by margin, clamped to image bounds
      const rx = Math.max(0,    b.x - margin);
      const ry = Math.max(0,    b.y - margin);
      const rx2 = Math.min(imgW, b.x + b.w + margin);
      const ry2 = Math.min(imgH, b.y + b.h + margin);
      const rw  = rx2 - rx;
      const rh  = ry2 - ry;

      if (rw < 4 || rh < 4) return shape;   // too small to refine

      // GrabCut requires a 3-channel BGR image cropped to the ROI
      const roiRect = new cv.Rect(rx, ry, rw, rh);
      const roi     = bgrMat.roi(roiRect);
      const roiCp   = new cv.Mat();
      roi.copyTo(roiCp);
      roi.delete();

      const gcMask  = cv.Mat.zeros(rh, rw, cv.CV_8UC1);
      const bgModel = cv.Mat.zeros(1, 65, cv.CV_64FC1);
      const fgModel = cv.Mat.zeros(1, 65, cv.CV_64FC1);

      // The rect passed to grabCut must be in ROI-local coordinates
      const gcRect = new cv.Rect(0, 0, rw, rh);
      cv.grabCut(roiCp, gcMask, gcRect, bgModel, fgModel, iters, cv.GC_INIT_WITH_RECT);

      // Build foreground binary mask: GC_FGD (1) or GC_PR_FGD (3)
      const fgBin  = new cv.Mat();
      const tmp1   = new cv.Mat();
      const tmp2   = new cv.Mat();
      const fgdMat  = new cv.Mat(rh, rw, cv.CV_8UC1, new cv.Scalar(cv.GC_FGD));
      const prFgdMat = new cv.Mat(rh, rw, cv.CV_8UC1, new cv.Scalar(cv.GC_PR_FGD));
      cv.compare(gcMask, fgdMat,   tmp1, cv.CMP_EQ);
      cv.compare(gcMask, prFgdMat, tmp2, cv.CMP_EQ);
      cv.bitwise_or(tmp1, tmp2, fgBin);
      fgdMat.delete(); prFgdMat.delete();

      // Morphological cleanup on the foreground mask
      const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
      const cleaned = new cv.Mat();
      cv.morphologyEx(fgBin, cleaned, cv.MORPH_CLOSE, kernel);
      cv.morphologyEx(cleaned, cleaned, cv.MORPH_OPEN, kernel);

      // Find contours in the refined mask
      const contourVec = new cv.MatVector();
      const hierarchy  = new cv.Mat();
      cv.findContours(cleaned, contourVec, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      // Keep largest contour by area
      let bestIdx = -1;
      let bestArea = 0;
      for (let i = 0; i < contourVec.size(); i++) {
        const area = cv.contourArea(contourVec.get(i));
        if (area > bestArea) { bestArea = area; bestIdx = i; }
      }

      let result = shape;
      if (bestIdx >= 0) {
        const best   = contourVec.get(bestIdx);
        const approx = new cv.Mat();
        cv.approxPolyDP(best, approx, 2.0, true);

        const pts = [];
        for (let j = 0; j < approx.rows; j++) {
          // Offset points back into full-image coordinates
          pts.push({
            x: approx.data32S[j * 2]     + rx,
            y: approx.data32S[j * 2 + 1] + ry,
          });
        }

        if (pts.length >= 3) {
          const newBounds = cv.boundingRect(approx);
          result = {
            ...shape,
            points: pts,
            bounds: {
              x: newBounds.x + rx,
              y: newBounds.y + ry,
              w: newBounds.width,
              h: newBounds.height,
            },
            area: bestArea,
          };
        }
        approx.delete();
        best.delete();
      }

      // Cleanup
      [roiCp, gcMask, bgModel, fgModel, fgBin, tmp1, tmp2, kernel, cleaned, contourVec, hierarchy].forEach(m => {
        try { m.delete(); } catch (_) {}
      });

      return result;
    } catch (e) {
      console.warn('ClearCutCV: grabCutRefineShape failed:', e);
      return shape;
    }
  }

  /**
   * Run GrabCut refinement on all enabled shapes.
   * Converts the source image to BGR once and reuses it for each shape.
   *
   * @param {HTMLImageElement} imgEl      – source image
   * @param {Array}            shapes     – array of shape objects
   * @param {object}           options    – { margin, iters }
   * @param {Function}         progressCb – called with (current, total) after each shape
   * @returns {Array} new shapes array with refined contours
   */
  function grabCutRefineAll(imgEl, shapes, options = {}, progressCb = null) {
    const { margin = 10, iters = 5 } = options;
    const bgrMat = imgToMat(imgEl);

    const refined = shapes.map((shape, idx) => {
      if (!shape.enabled) {
        if (progressCb) progressCb(idx + 1, shapes.length);
        return shape;
      }
      const result = grabCutRefineShape(bgrMat, shape, margin, iters);
      if (progressCb) progressCb(idx + 1, shapes.length);
      return result;
    });

    bgrMat.delete();
    return refined;
  }

  // ── Dilation-Based Padding ─────────────────────────────────────────────

  /**
   * Expand a single contour outward by paddingPx using morphological dilation.
   * This is correct for concave shapes unlike the centroid-push approach.
   *
   * @param {Array}  points    – [{x,y}] contour points in full-image coords
   * @param {number} imgW      – full image width
   * @param {number} imgH      – full image height
   * @param {number} paddingPx – dilation radius in pixels
   * @returns {Array} new points array, or original if paddingPx <= 0
   */
  function dilateMask(points, imgW, imgH, paddingPx) {
    if (paddingPx <= 0 || points.length < 3) return points;

    // Rasterise the shape onto a blank mask
    const mask = cv.Mat.zeros(imgH, imgW, cv.CV_8UC1);
    const contourData = [];
    points.forEach(p => contourData.push(p.x, p.y));
    const contourMat = cv.matFromArray(points.length, 1, cv.CV_32SC2, contourData);
    const vec = new cv.MatVector();
    vec.push_back(contourMat);
    cv.drawContours(mask, vec, 0, new cv.Scalar(255), -1);  // FILLED

    // Dilate
    const kSize  = (paddingPx * 2 + 1) | 1;   // ensure odd
    const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kSize, kSize));
    const dilated = new cv.Mat();
    cv.dilate(mask, dilated, kernel);

    // Extract largest contour from dilated mask
    const contourVec = new cv.MatVector();
    const hierarchy  = new cv.Mat();
    cv.findContours(dilated, contourVec, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let best = null;
    let bestArea = 0;
    for (let i = 0; i < contourVec.size(); i++) {
      const c    = contourVec.get(i);
      const area = cv.contourArea(c);
      if (area > bestArea) { bestArea = area; best = c; }
      else c.delete();
    }

    let result = points;
    if (best) {
      const approx = new cv.Mat();
      cv.approxPolyDP(best, approx, 2.0, true);
      const newPts = [];
      for (let j = 0; j < approx.rows; j++) {
        newPts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
      }
      if (newPts.length >= 3) result = newPts;
      approx.delete();
      best.delete();
    }

    // Cleanup
    [mask, contourMat, kernel, dilated, contourVec, hierarchy].forEach(m => {
      try { m.delete(); } catch (_) {}
    });
    vec.delete();

    return result;
  }

  /**
   * Apply dilation-based padding to all enabled shapes in-place.
   *
   * @param {Array}            shapes     – shape objects (modified in-place)
   * @param {HTMLImageElement} imgEl      – used only for dimensions
   * @param {number}           paddingPx  – dilation amount in pixels
   * @returns {Array} same array reference with updated points
   */
  function applyDilationPadding(shapes, imgEl, paddingPx) {
    if (paddingPx <= 0) return shapes;
    const imgW = imgEl.naturalWidth  || imgEl.width;
    const imgH = imgEl.naturalHeight || imgEl.height;
    return shapes.map(shape => {
      if (!shape.enabled) return shape;
      const newPoints = dilateMask(shape.points, imgW, imgH, paddingPx);
      if (newPoints === shape.points) return shape;
      const boundsRect = {
        x: Math.min(...newPoints.map(p => p.x)),
        y: Math.min(...newPoints.map(p => p.y)),
        w: Math.max(...newPoints.map(p => p.x)) - Math.min(...newPoints.map(p => p.x)),
        h: Math.max(...newPoints.map(p => p.y)) - Math.min(...newPoints.map(p => p.y)),
      };
      return { ...shape, points: newPoints, bounds: boundsRect };
    });
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
    grabCutRefineAll,
    applyDilationPadding,
    sampleColorAt,
    rgbToHsv,
  };

})();

window.ClearCutCV = ClearCutCV;
