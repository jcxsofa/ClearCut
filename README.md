# ✂️ ClearCut

**Generate Cricut SVG cut files from scanned laminated sheets — right in your browser.**

No server. No account. No data leaves your device. Works offline after first load.

---

## Live App

> Deploy to GitHub Pages then update this URL:
> **https://jcxsofa.github.io/ClearCut/**

---

## How It Works

1. **Choose your scanning method** — Two Photos (phone), Printable Background (scanner), or Solid Color
2. **Upload your image(s)** — drag-and-drop, file picker, or direct camera capture on mobile
3. **Detect items** — OpenCV.js runs entirely in the browser to find each item's silhouette
4. **Adjust & preview** — tweak sensitivity, padding, and toggle individual shapes on/off
5. **Download SVG** — import directly into Cricut Design Space and cut

---

## Scanning Methods

### 📷 Method A — Two Photos (recommended for phone cameras)
Place items on **any surface**. Take one photo of the empty surface, then another with items on top. The app subtracts the two images to isolate each item. Works on carpet, desks, tables — anything.

### 🖨️ Method B — Printable Background (recommended for flatbed scanners)
Download and print one of three reference backgrounds (stripes, checkerboard, dot grid). Place laminated items on the printed sheet and scan. The app detects items by identifying interruptions in the repeating pattern.

### 🟩 Method C — Solid Color Background (simplest)
Place items on a solid-colored surface (e.g. bright green paper). Pick the background color with the color picker or click on it in the preview. The app uses HSV thresholding to separate items from background.

---

## Tech Stack

| Technology | Purpose |
|---|---|
| Vanilla HTML/CSS/JS | Single-page app — no framework |
| [OpenCV.js](https://docs.opencv.org/4.x/opencv.js) | Client-side computer vision |
| Canvas API | Image processing & preview |
| Service Worker | Offline PWA support |
| Web Manifest | Installable on iOS/Android/Desktop |
| GitHub Pages | Free static hosting |

---

## File Structure

```
ClearCut/
├── index.html        # App UI
├── app.js            # Core application logic
├── cv.js             # OpenCV.js detection module
├── svg.js            # SVG generation & export
├── backgrounds.js    # Printable background generation
├── sw.js             # Service worker
├── manifest.json     # PWA manifest
├── style.css         # Styles
├── generate-icons.js # Icon generation script (dev only)
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── README.md
```

---

## GitHub Pages Deployment

1. Fork / push this repo to GitHub
2. Go to **Settings → Pages**
3. Set Source: **main branch, / (root)**
4. App is live at `https://<username>.github.io/ClearCut/`

> **Note:** Update `start_url` and `scope` in `manifest.json` to match your GitHub Pages URL path.

---

## Development

No build step required. Open `index.html` directly in a browser, or serve locally:

```bash
# Python
python -m http.server 8080

# Node.js
npx serve .
```

Then open http://localhost:8080

### Regenerating Icons

```bash
node generate-icons.js
# or with canvas package for proper rendering:
npm install canvas
node generate-icons.js
```

---

## Privacy

All image processing runs locally in your browser using WebAssembly (OpenCV.js). No images, no data, and no results are ever sent to any server.

---

## License

MIT

Web app to simplify cutting small laminated items with cricut.
