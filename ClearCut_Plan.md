# ClearCut — Cricut SVG Generator PWA
## Project Plan for Claude Code

---

## Overview

A Progressive Web App (PWA) that allows teachers to:
1. Photograph or scan a laminated sheet of cut-out items using one of three background methods (see below)
2. Automatically detect the silhouette of each item using computer vision
3. Generate a correctly scaled SVG cut file ready to import into Cricut Design Space
4. Download the SVG and optionally save/install the app offline

No server required. All image processing happens client-side in the browser.
Hosted for free via GitHub Pages.

---

## Tech Stack

- **Vanilla HTML/CSS/JS** — single-page app, no framework needed
- **OpenCV.js** — client-side computer vision (background subtraction, contour detection)
  - CDN: `https://docs.opencv.org/4.x/opencv.js`
- **Service Worker** — for PWA offline support and installability
- **Web Manifest** — for "Add to Home Screen" on iOS/Android
- **Canvas API** — for image processing and preview rendering
- **SVG generation** — pure JS, no library needed
- **GitHub Pages** — free static hosting

---

## File Structure

```
ClearCut/
├── index.html          # Main app UI
├── app.js              # Core application logic
├── cv.js               # OpenCV.js image processing module
├── svg.js              # SVG generation and export module
├── backgrounds.js      # Printable background generation + two-shot subtraction logic
├── sw.js               # Service worker for offline/PWA
├── manifest.json       # PWA web manifest
├── style.css           # App styles
├── icons/
│   ├── icon-192.png    # PWA icon (192x192)
│   └── icon-512.png    # PWA icon (512x512)
└── README.md           # Usage instructions
```

---

## Core Workflow

### Step 1 — Choose Background Method

Present the user with three options on first launch (choice is remembered via localStorage):

#### Method A — Two-Shot Subtraction (Best for phone cameras, any surface)
1. User places their laminated items on **any surface** (desk, carpet, table — anything)
2. App prompts: "First, take a photo of the surface WITHOUT the items on it"
3. User uploads or photographs the empty background
4. App prompts: "Now place your items on that same surface and take a second photo"
5. User uploads or photographs the sheet with items
6. App performs **pixel-difference subtraction** between the two images — anything that changed between shots is an item silhouette
7. Most robust method — works on any background, handles uneven lighting

#### Method B — Printable Reference Background (Best for flatbed scanners)
- App offers a "Print a Reference Background" section with downloadable/printable PDFs generated client-side as SVGs:
  - **Bold alternating stripes** (recommended — 1cm black/white stripes, high contrast)
  - **Checkerboard** (8x8 grid of 1" squares)
  - **Dot grid** (regular array of filled circles on white)
- User prints their chosen background, places laminated items on top, scans the whole sheet
- App detects items by recognizing interruptions in the known repeating pattern
- Background PDFs are generated entirely in JS/SVG — no external files needed
- Each PDF includes corner registration marks and a printed scale ruler for accurate sizing

#### Method C — Solid Color (Simplest, least robust)
- User places items on a solid-colored surface (e.g. a sheet of bright green or red paper)
- User selects the background color using a color picker, or clicks on the background in the preview to sample it
- App uses `cv.inRange()` HSV thresholding with user-adjustable tolerance

### Step 2 — Upload Image(s)
- For Method A: two upload zones (background, then items), or sequential camera capture prompts on mobile
- For Methods B and C: single upload zone
- Drag-and-drop and file picker both supported
- On mobile: direct camera capture via `<input capture="environment">`
- App displays preview of uploaded image(s) immediately

### Step 3 — Detection (cv.js)
Using OpenCV.js, detection strategy depends on the chosen method:

**Method A (Two-Shot Subtraction):**
1. Align the two images (apply homography correction in case camera moved slightly between shots)
2. Compute absolute pixel difference: `cv.absdiff(bgImage, itemsImage, diff)`
3. Convert diff to grayscale, apply threshold to create binary mask
4. Clean up with morphological operations (erosion + dilation)
5. Run `cv.findContours()` on the mask

**Method B (Printable Background):**
1. Convert image to grayscale
2. Apply adaptive thresholding to isolate the pattern
3. Use frequency/pattern analysis or template matching to reconstruct expected background
4. Subtract reconstructed background from actual image to isolate items
5. Clean up and run `cv.findContours()`

**Method C (Solid Color):**
1. Convert image to HSV color space
2. Use `cv.inRange()` to threshold the selected background color with user-adjustable tolerance
3. Invert mask to get item regions
4. Clean up and run `cv.findContours()`

**All methods then:**
- Filter contours by minimum area (default ~500px² — ignores dust/noise)
- Optionally apply a small outward offset (configurable padding in mm) so cut line is slightly outside item edge
- Apply `cv.approxPolyDP()` to smooth contours and reduce SVG path complexity

### Step 4 — Preview & Edit
- Overlay detected cut lines on the image in the browser
- User can:
  - Adjust detection sensitivity (threshold slider)
  - Adjust padding/offset around each shape (mm)
  - Toggle individual shapes on/off (click to deselect)
  - Manually add a rectangular cut region by drawing on the image

### Step 5 — SVG Generation (svg.js)
- User inputs physical dimensions of the sheet (default: US Letter 8.5" x 11")
- Scale contours from pixel space to real-world mm/inches based on sheet dimensions
- Generate SVG:
  - Document size: 12" x 12" (standard Cricut mat)
  - Each contour becomes an SVG `<path>` element
  - Paths use `fill="none" stroke="#000000" stroke-width="0.01in"` (standard for Cricut cut lines)
  - Include a bounding rectangle representing the mat edge
- User downloads the `.svg` file

### Step 6 — Cricut Import Instructions
- After download, show a simple step-by-step guide:
  1. Open Cricut Design Space
  2. Click "Upload" → "Upload Image"
  3. Select the downloaded SVG
  4. Choose "Cut Image"
  5. Place laminated sheet on mat aligned to top-left corner
  6. Cut!

---

## PWA Requirements

### manifest.json
```json
{
  "name": "ClearCut",
  "short_name": "ClearCut",
  "description": "Generate Cricut SVG cut files from scanned laminated sheets",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#4A90D9",
  "icons": [
    { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

### sw.js (Service Worker)
- Cache all app assets on install
- Serve from cache when offline
- Cache OpenCV.js from CDN on first load so it works offline after that

---

## UI Layout

```
┌─────────────────────────────────────┐
│  ✂️ ClearCut                     │
│  Generate Cricut cut files from     │
│  scanned laminated sheets           │
├─────────────────────────────────────┤
│  How are you scanning?              │
│  ○ Two photos (phone camera)        │
│  ○ Printable background (scanner)   │
│  ○ Solid color background           │
├─────────────────────────────────────┤
│  [METHOD A: Two photo upload zones] │
│  [ 📷 Upload background photo ]     │
│  [ 📷 Upload photo with items  ]    │
│  — or —                             │
│  [METHOD B: Single upload zone +    │
│   "Print a background" button that  │
│   opens background chooser panel]   │
│  — or —                             │
│  [METHOD C: Single upload + color   │
│   picker / click-to-sample]         │
├─────────────────────────────────────┤
│  Detection sensitivity: [====○--]   │
│  Cut line padding: [2mm      ]      │
│  Sheet size: [8.5" x 11" ▼  ]      │
├─────────────────────────────────────┤
│  ┌─────────────────────────────┐    │
│  │  [Preview canvas with       │    │
│  │   detected outlines shown   │    │
│  │   overlaid in green]        │    │
│  └─────────────────────────────┘    │
│  Shapes detected: 12               │
├─────────────────────────────────────┤
│  [ ⬇ Download SVG for Cricut ]     │
├─────────────────────────────────────┤
│  How to use in Cricut Design Space  │
│  [collapsible step-by-step guide]   │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│  🖨️ Print a Reference Background    │
│                                     │
│  ○ Bold Stripes (recommended)       │
│  ○ Checkerboard                     │
│  ○ Dot Grid                         │
│                                     │
│  [Preview of selected pattern]      │
│                                     │
│  [ ⬇ Download PDF to Print ]       │
│                                     │
│  Tip: Print at 100% scale, no       │
│  fit-to-page scaling                │
└─────────────────────────────────────┘
```

---

## Key Implementation Notes

### OpenCV.js Loading
OpenCV.js is large (~8MB). Handle loading carefully:
- Show a loading indicator while OpenCV initializes
- OpenCV.js calls `Module.onRuntimeInitialized` when ready — gate all CV operations on this
- Cache in service worker after first load

### Scaling Pixel Coords to Physical Dimensions
```js
// User inputs sheet width in inches
const sheetWidthInches = 8.5;
const sheetWidthPx = imageElement.naturalWidth;
const pxPerInch = sheetWidthPx / sheetWidthInches;

// Cricut mat is 12x12 inches = 864x864 at 72dpi SVG units
const svgUnitsPerInch = 72;
const scale = svgUnitsPerInch / pxPerInch;

// Apply scale to all contour points
const scaledX = point.x * scale;
const scaledY = point.y * scale;
```

### SVG Path Generation from Contours
```js
function contourToSVGPath(contour) {
  const points = [];
  for (let i = 0; i < contour.rows; i++) {
    points.push(`${contour.data32S[i*2] * scale},${contour.data32S[i*2+1] * scale}`);
  }
  return `M ${points[0]} L ${points.slice(1).join(' L ')} Z`;
}
```

### Two-Shot Image Subtraction (backgrounds.js)
The two-shot method needs to handle slight camera movement between shots. Use a lightweight homography correction:
```js
// Find matching keypoints between the two images and warp bg to align with items image
const orb = new cv.ORB();
const kp1 = new cv.KeyPointVector();
const kp2 = new cv.KeyPointVector();
const desc1 = new cv.Mat();
const desc2 = new cv.Mat();
orb.detectAndCompute(bgGray, new cv.Mat(), kp1, desc1);
orb.detectAndCompute(itemsGray, new cv.Mat(), kp2, desc2);
// Match, find homography, warpPerspective bgImage to align with itemsImage
// Then cv.absdiff(alignedBg, itemsImage, diff)
```
If ORB matching fails (too few keypoints — e.g. plain wall background), fall back to direct subtraction without alignment and warn the user.

### Printable Background Generation (backgrounds.js)
Generate backgrounds as SVG strings, convert to a downloadable PDF using a minimal PDF wrapper (no external library — write raw PDF structure for a single-page image):
```js
function generateStripesSVG(widthIn, heightIn, stripeWidthCm) {
  // Generate alternating black/white vertical stripes
  // Include corner registration marks (L-shaped brackets at each corner)
  // Include a 10cm scale ruler along the bottom edge
  // Return SVG string
}

function generateCheckerboardSVG(widthIn, heightIn, squareSizeIn) { ... }
function generateDotGridSVG(widthIn, heightIn, dotSpacingCm) { ... }
```
All three patterns should include:
- Corner registration marks (helps user align sheet consistently)
- A printed scale ruler (lets app auto-detect DPI/scale from the scan if desired in future)
- "ClearCut reference sheet — do not scale when printing" watermark text

### iOS Camera Considerations
- Use `<input type="file" accept="image/*" capture="environment">` for direct camera access on iOS
- Also allow file picker for uploading from Photos app or Files app (scanned PDFs)
- For flatbed scans from a desktop, standard file upload works perfectly
- For Method A (two-shot), show sequential prompts on mobile to guide user through both captures

---

## GitHub Pages Deployment

1. Create repo: `github.com/[username]/ClearCut`
2. Push all files to `main` branch
3. Go to Settings → Pages → Source: `main` branch, `/ (root)`
4. App live at: `https://[username].github.io/ClearCut`
5. PWA installable immediately from that URL on any device

---

## Future Enhancements (out of scope for v1)

- PDF input support (scanned multi-page sheets)
- Automatic sheet size detection using QR code or corner markers on a printable reference sheet
- "Registration mark" printable template that makes background subtraction trivially easy
- Batch processing of multiple scanned sheets
- Save/load sessions via localStorage
- Share cut files directly via Web Share API

---

## Acceptance Criteria for v1

- [ ] User can upload a photo or scan
- [ ] Method A: Two-shot subtraction works on any background surface
- [ ] Method B: Printable reference backgrounds (stripes, checkerboard, dot grid) can be downloaded as PDFs
- [ ] Method B: App correctly detects items placed on a printed reference background
- [ ] Method C: Solid color background detection works with color picker / click-to-sample
- [ ] Preview shows detected outlines overlaid on image
- [ ] User can adjust sensitivity and padding
- [ ] User can toggle individual detected shapes on/off
- [ ] App generates a valid SVG importable into Cricut Design Space
- [ ] SVG paths are correctly scaled to physical sheet dimensions
- [ ] App works offline after first load (service worker)
- [ ] App is installable as PWA on iOS, Android, Mac, and Windows
- [ ] Works on mobile (responsive layout, sequential camera capture for Method A)
- [ ] No data leaves the user's device
- [ ] Background method preference is saved in localStorage