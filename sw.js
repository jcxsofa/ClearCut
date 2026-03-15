/**
 * sw.js — Service Worker for ClearCut PWA
 *
 * Strategy:
 *   - Cache-first for all app shell assets
 *   - Network-first for OpenCV.js (so updates propagate), fall back to cache
 *   - On first load, pre-cache all app shell assets + attempt to cache OpenCV.js
 */

const CACHE_VERSION    = 'v2';
const APP_CACHE        = `clearcut-app-${CACHE_VERSION}`;
const OPENCV_CACHE     = `clearcut-opencv-${CACHE_VERSION}`;
const OPENCV_URL       = 'https://docs.opencv.org/4.x/opencv.js';

const PDFJS_VERSION    = '3.11.174';
const PDFJS_CACHE      = `clearcut-pdfjs-${CACHE_VERSION}`;
const PDFJS_URLS       = [
  `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.js`,
  `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`,
];

// App shell — all local assets
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './cv.js',
  './svg.js',
  './backgrounds.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// ── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      // Cache app shell
      const appCache = await caches.open(APP_CACHE);
      await appCache.addAll(APP_SHELL);

      // Try to cache OpenCV.js — non-fatal if it fails (e.g. offline install)
      try {
        const opencvCache = await caches.open(OPENCV_CACHE);
        const response    = await fetch(OPENCV_URL, { cache: 'no-store' });
        if (response.ok) {
          await opencvCache.put(OPENCV_URL, response);
          console.log('[SW] OpenCV.js cached for offline use.');
        }
      } catch (err) {
        console.warn('[SW] Could not pre-cache OpenCV.js (no network?):', err.message);
      }

      // Try to cache PDF.js — non-fatal if it fails
      try {
        const pdfjsCache = await caches.open(PDFJS_CACHE);
        await Promise.all(PDFJS_URLS.map(async url => {
          const response = await fetch(url, { cache: 'no-store' });
          if (response.ok) await pdfjsCache.put(url, response);
        }));
        console.log('[SW] PDF.js cached for offline use.');
      } catch (err) {
        console.warn('[SW] Could not pre-cache PDF.js (no network?):', err.message);
      }

      // Activate immediately without waiting for old SW to be discarded
      await self.skipWaiting();
    })()
  );
});

// ── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      // Delete old cache versions
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter(name => name.startsWith('clearcut-') && name !== APP_CACHE && name !== OPENCV_CACHE)
          .map(name => caches.delete(name))
      );
      // Take control of existing clients immediately
      await self.clients.claim();
    })()
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = request.url;

  // OpenCV.js: network-first, fall back to cache
  if (url === OPENCV_URL || url.startsWith('https://docs.opencv.org/')) {
    event.respondWith(networkFirstWithCache(request, OPENCV_CACHE));
    return;
  }

  // PDF.js: network-first, fall back to cache
  if (PDFJS_URLS.includes(url)) {
    event.respondWith(networkFirstWithCache(request, PDFJS_CACHE));
    return;
  }

  // Everything else: cache-first for same-origin requests
  if (request.method === 'GET') {
    event.respondWith(cacheFirstWithNetwork(request, APP_CACHE));
  }
});

// ── Strategies ────────────────────────────────────────────────────────────────

async function cacheFirstWithNetwork(request, cacheName) {
  const cache    = await caches.open(cacheName);
  const cached   = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok && response.status < 400) {
      // Only cache same-origin or CORS-safe responses
      if (response.type === 'basic' || response.type === 'cors') {
        await cache.put(request, response.clone());
      }
    }
    return response;
  } catch (_) {
    // Return a simple offline fallback for navigation requests
    if (request.mode === 'navigate') {
      const fallback = await cache.match('./index.html');
      if (fallback) return fallback;
    }
    return new Response('Offline — resource not cached.', {
      status: 503,
      statusText: 'Service Unavailable',
    });
  }
}

async function networkFirstWithCache(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (_) {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response('OpenCV.js not available offline yet. Please connect to the internet for first use.', {
      status: 503,
      statusText: 'Service Unavailable',
    });
  }
}
