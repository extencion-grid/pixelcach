(() => {
  'use strict';

  const MSG = {
    DETECT_BATCH: 'PC_DETECT_BATCH',
    DETECT_READY: 'PC_DETECT_READY',
    SCAN_FULL: 'PC_SCAN_FULL',
    SCAN_BACKGROUNDS: 'PC_SCAN_BACKGROUNDS',
    CONFIG: 'PC_CONFIG',
    FETCH_BLOB: 'PC_FETCH_BLOB',
    WHAT_IS_UNDER_CURSOR: 'PC_WHAT_IS_UNDER_CURSOR'
  };

  const DETECT_ATTRS = [
    'src', 'srcset', 'sizes', 'poster',
    'data-src', 'data-srcset', 'data-original', 'data-lazy-src', 'data-lazy'
  ];
  const MAX_BATCH = 50;
  const FLUSH_DELAY = 120;
  const RETRY_DELAY = 400;

  const seen = new Set();
  const pendingQueue = [];

  let flushScheduled = false;
  let config = { minSize: 150, detectBackgrounds: false, detectResources: true, debugEnabled: false };
  let lastPointer = { x: 0, y: 0 };

  const isContextValid = () => !!chrome?.runtime?.id;

  function debug(msg, meta = {}) {
    if (!config.debugEnabled || !isContextValid()) return;
    chrome.runtime
      .sendMessage({ type: 'PC_DEBUG_LOG', entries: [{ t: Date.now(), msg, meta, frame: location.href }] })
      .catch(() => {});
  }

  function send(msg) {
    if (!isContextValid()) return Promise.resolve({ ok: false, reason: 'invalid-context' });
    return chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, reason: String(e) }));
  }

  function scheduleFlush(delay = FLUSH_DELAY) {
    if (flushScheduled) return;
    flushScheduled = true;
    setTimeout(() => {
      flushScheduled = false;
      flushNow();
    }, delay);
  }

  function flushNow() {
    if (!pendingQueue.length || !isContextValid()) return;
    const batch = pendingQueue.splice(0, MAX_BATCH);

    send({ type: MSG.DETECT_BATCH, items: batch }).then((res) => {
      if (res && res.ok === false) {
        pendingQueue.unshift(...batch);
        scheduleFlush(RETRY_DELAY);
      }
    });

    if (pendingQueue.length) scheduleFlush(0);
  }

  function fingerprint(src, width, height) {
    return src.startsWith('blob:') ? `${src}|${width}x${height}` : src;
  }

  function passesSize(width, height) {
    if (!config.minSize) return true;
    if (!width || !height) return true;
    return width >= config.minSize && height >= config.minSize;
  }

  function enqueue(src, width, height, type = 'img') {
    if (!src) return false;
    if (seen.has(fingerprint(src, width, height))) return false;
    if (!passesSize(width, height)) return false;
    seen.add(fingerprint(src, width, height));
    pendingQueue.push({ src, width: width || 0, height: height || 0, url: location.href, type });
    scheduleFlush();
    return true;
  }

  function bestFromSrcset(srcset) {
    if (!srcset) return '';
    return (
      srcset
        .split(',')
        .map((c) => c.trim().split(/\s+/))
        .filter((p) => p[0])
        .sort((a, b) => parseFloat(b[1] || '1x') - parseFloat(a[1] || '1x'))[0]?.[0] || ''
    );
  }

  function lazyAttr(el) {
    for (const attr of DETECT_ATTRS) {
      if (attr === 'src' || attr === 'sizes') continue;
      const v = el.getAttribute?.(attr);
      if (v && !v.startsWith('data:')) return v;
    }
    return '';
  }

  function pictureBest(el) {
    const img = el.tagName === 'IMG' ? el : el.querySelector?.('img');
    if (!img) return '';
    let best = img.currentSrc || img.src || bestFromSrcset(img.getAttribute('srcset')) || lazyAttr(img);
    for (const src of img.parentElement?.querySelectorAll?.('source[srcset]') || []) {
      if (src.media && !window.matchMedia(src.media).matches) continue;
      const candidate = bestFromSrcset(src.getAttribute('srcset'));
      if (candidate && (!best || candidate.length > best.length)) best = candidate;
    }
    return best;
  }

  function reportImage(el) {
    if (el.tagName !== 'IMG') return;

    const width = el.naturalWidth;
    const height = el.naturalHeight;
    const src = el.currentSrc || el.src || pictureBest(el);

    if (el.complete && width > 0) {
      enqueue(src, width, height, 'img');
      reportLinkOriginal(el);
      return;
    }

    if (src) enqueue(src, width, height, 'img');
  }

  function reportLinkOriginal(el) {
    const anchor = el.closest?.('a[href]');
    if (!anchor) return;
    const href = anchor.href;
    if (!href || !/\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|#|$)/i.test(href)) return;
    if (href === el.currentSrc || href === el.src) return;
    enqueue(href, el.naturalWidth || 0, el.naturalHeight || 0, 'original');
  }

  const io =
    'IntersectionObserver' in window
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              reportImage(entry.target);
              io.unobserve(entry.target);
            }
          },
          { rootMargin: '2000px' }
        )
      : null;

  function watchImage(el) {
    if (el.tagName !== 'IMG') return;
    if (io) io.observe(el);
    else reportImage(el);
  }

  function watchTree(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.tagName === 'IMG') watchImage(root);
    else root.querySelectorAll?.('img').forEach(watchImage);

    for (const img of root.shadowRoot?.querySelectorAll?.('img') || []) watchImage(img);
  }

  function reportBackground(el) {
    if (!el || el.nodeType !== 1) return;
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none') return;
    for (const part of bg.split(',')) {
      const m = /url\(["']?(.+?)["']?\)/.exec(part.trim());
      if (!m || !m[1]) continue;
      const rect = el.getBoundingClientRect();
      enqueue(m[1], Math.round(rect.width), Math.round(rect.height), 'bg');
    }
  }

  function scanBackgrounds() {
    if (!config.detectBackgrounds) return;
    const walker = document.evaluate(
      '//*[contains(translate(@style,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"background")]',
      document,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    );
    for (let i = 0; i < walker.snapshotLength; i++) reportBackground(walker.snapshotItem(i));
  }

  function deepScan() {
    seen.clear();
    watchTree(document);
    scanBackgrounds();
    debug('deep_scan');
  }

  function observe() {
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'childList') {
          for (const node of m.addedNodes) watchTree(node);
        } else if (m.type === 'attributes' && DETECT_ATTRS.includes(m.attributeName)) {
          if (m.target.tagName === 'IMG') reportImage(m.target);
        }
      }
    });

    obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: DETECT_ATTRS
    });
  }

  function observeResources() {
    if (!config.detectResources || typeof PerformanceObserver === 'undefined') return;
    const wanted = new Set(['img', 'image', 'css']);
    try {
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!wanted.has(entry.initiatorType)) continue;
          enqueue(entry.name, 0, 0, 'resource');
        }
      });
      po.observe({ type: 'resource', buffered: true });
    } catch {
      debug('resource_observer_unavailable');
    }
  }

  function isImageLike(el) {
    if (!el) return false;
    if (el.tagName === 'IMG' || el.tagName === 'CANVAS') return true;
    const bg = getComputedStyle(el).backgroundImage;
    return !!bg && bg !== 'none';
  }

  function describe(el) {
    if (!el) return null;
    if (el.tagName === 'IMG') {
      return {
        type: 'img',
        src: el.currentSrc || el.src || pictureBest(el),
        width: el.naturalWidth,
        height: el.naturalHeight
      };
    }
    if (el.tagName === 'CANVAS') {
      return { type: 'canvas', src: '', width: el.width, height: el.height };
    }
    const m = /url\(["']?(.+?)["']?\)/.exec(getComputedStyle(el).backgroundImage || '');
    return m ? { type: 'bg', src: m[1], width: el.clientWidth, height: el.clientHeight } : null;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === MSG.CONFIG) {
      config = { ...config, ...msg.config };
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === MSG.SCAN_FULL) {
      deepScan();
      sendResponse({ ok: true, count: seen.size });
      return false;
    }
    if (msg?.type === MSG.SCAN_BACKGROUNDS) {
      if (msg.config) config = { ...config, ...msg.config };
      scanBackgrounds();
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === MSG.FETCH_BLOB) {
      fetch(msg.src)
        .then((r) => r.arrayBuffer())
        .then((buffer) => sendResponse({ ok: true, buffer, size: buffer.byteLength }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg?.type === MSG.WHAT_IS_UNDER_CURSOR) {
      const stack = document.elementsFromPoint(lastPointer.x, lastPointer.y);
      sendResponse(describe(stack.find(isImageLike)));
      return false;
    }
    return false;
  });

  document.addEventListener(
    'mousemove',
    (e) => {
      lastPointer = { x: e.clientX, y: e.clientY };
    },
    { passive: true, capture: true }
  );

  function initialize() {
    observe();
    watchTree(document);
    observeResources();
    scanBackgrounds();
    debug('content_script_init', { url: location.href });
    send({ type: MSG.DETECT_READY, url: location.href, isTop: window.top === window });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();