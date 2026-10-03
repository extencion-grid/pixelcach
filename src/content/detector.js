(() => {
  'use strict';

  // Copia manual de src/lib/messages.js (los content scripts no pueden
  // importar módulos ES). Mantener sincronizado al tocar el canal.
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
  const PAGE_RE = /\.(html?|php|aspx?|jsp|cfm)($|[?#])/i;

  // Recorta el #fragmento: la misma imagen con distinto ancla no es otra imagen
  // (técnica de PactInteractive/image-downloader).
  function stripHash(url) {
    const i = url.indexOf('#');
    return i >= 0 ? url.slice(0, i) : url;
  }

  function toAbsolute(url) {
    if (!url) return '';
    if (url.startsWith('/') && !url.startsWith('//')) return location.origin + url;
    return url;
  }
  const MAX_BATCH = 50;
  const FLUSH_DELAY = 80;
  const RETRY_DELAY = 300;

  const seen = new Set();
  const pendingQueue = [];

  let flushScheduled = false;
  let config = { minSize: 0, detectBackgrounds: false, detectResources: true, debugEnabled: false };
  let lastPointer = { x: 0, y: 0 };
  let canvasSweepTimer = null;

  const isContextValid = () => typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

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

  // FNV-1a 32 bits: huella barata de data: URLs para dedup y resurrect.
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16);
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

  function fingerprint(src, width, height, hash, dataLength) {
    if (src.startsWith('blob:')) return `${src}|${width}x${height}`;
    if (src.startsWith('data:')) return `data#${hash}:${dataLength}`;
    return src;
  }

  function passesSize(width, height) {
    if (!config.minSize) return true;
    if (width > 0 && height > 0) return width >= config.minSize && height >= config.minSize;
    // Sin dimensiones todavía (lazy sin cargar): entra igualmente; el filtro
    // real de tamaño se ofrece después en la galería, no aquí.
    return true;
  }

  function enqueue(src, width, height, type = 'img') {
    if (!src) return false;
    if (typeof src === 'string') {
      if (!/^(data:|blob:|https?:|\/\/)/i.test(src)) src = toAbsolute(src);
      src = stripHash(src);
    }
    const isData = src.startsWith('data:');
    const hash = isData ? fnv1a(src) : '';
    const dataLength = isData ? src.length : 0;
    const fp = fingerprint(src, width, height, hash, dataLength);
    if (seen.has(fp)) return false;
    if (!passesSize(width, height, src, type)) return false;
    seen.add(fp);
    pendingQueue.push({ src, width: width || 0, height: height || 0, url: location.href, type, hash, dataLength });
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
      reportAllSrcsetVariants(el, width, height);
      reportLinkOriginal(el);
      return;
    }

    if (src) enqueue(src, width, height, 'img');
  }

  // Todas las variantes del srcset (no solo la que eligió el navegador):
  // el usuario pide TODAS las versiones de cada imagen.
  function reportAllSrcsetVariants(el, width, height) {
    const seenLocal = new Set();
    const attrs = ['srcset', 'data-srcset'];
    for (const attr of attrs) {
      const v = el.getAttribute?.(attr);
      if (!v) continue;
      for (const part of v.split(',')) {
        const url = part.trim().split(/\s+/)[0];
        if (!url || seenLocal.has(url)) continue;
        seenLocal.add(url);
        enqueue(url, width, height, 'img');
      }
    }
    for (const src of el.parentElement?.querySelectorAll?.('source[srcset]') || []) {
      for (const part of (src.getAttribute('srcset') || '').split(',')) {
        const url = part.trim().split(/\s+/)[0];
        if (url && !seenLocal.has(url)) {
          seenLocal.add(url);
          enqueue(url, width, height, 'img');
        }
      }
    }
  }

  // SVG en línea: <image> y <use> referencian recursos externos con xlink:href.
  function reportSvgRefs(root) {
    for (const el of root.querySelectorAll?.('image, use') || []) {
      const href = el.getAttribute?.('xlink:href') || el.getAttribute?.('href');
      if (!href) continue;
      enqueue(href, el.getBoundingClientRect().width || 0, el.getBoundingClientRect().height || 0, 'img');
    }
  }

  const canvasVersions = new WeakMap();
  const CANVAS_MAX_VARIANTS = 3;

  function reportCanvas(el) {
    const width = el.width;
    const height = el.height;
    if (!width || !height || !passesSize(width, height)) return;
    let dataUrl;
    try {
      dataUrl = el.toDataURL('image/png');
    } catch {
      debug('canvas_tainted', { width, height });
      return;
    }
    const hash = fnv1a(dataUrl);
    // Un canvas animado cambia en cada frame: máximo 3 variantes por elemento.
    const prev = canvasVersions.get(el) || { count: 0, last: '' };
    if (prev.last === hash || prev.count >= CANVAS_MAX_VARIANTS) return;
    canvasVersions.set(el, { count: prev.count + 1, last: hash });
    enqueue(dataUrl, width, height, 'canvas');
  }

  // Los canvas redibujados no generan mutaciones de DOM: barrido periódico
  // barato, solo mientras haya canvases en el documento.
  function sweepCanvases() {
    if (canvasSweepTimer) return;
    canvasSweepTimer = setInterval(() => {
      const canvases = document.querySelectorAll('canvas');
      if (!canvases.length) {
        clearInterval(canvasSweepTimer);
        canvasSweepTimer = null;
        return;
      }
      canvases.forEach(reportCanvas);
    }, 4000);
  }

  function reportLinkOriginal(el) {
    const anchor = el.closest?.('a[href]');
    if (!anchor) return;
    const href = anchor.href;
    if (!href || href === el.currentSrc || href === el.src) return;
    // Solo descartamos lo que claramente es una página, no una imagen.
    if (PAGE_RE.test(href)) return;
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
    // Registro inmediato con lo que haya (src/srcset/picture): queremos
    // TODAS las imágenes, no solo las que cargan o entran en viewport.
    reportImage(el);
    // El IO sólo re-reporta con dimensiones reales cuando carga.
    if (io) io.observe(el);
  }

  function watchTree(root) {
    if (!root) return;
    let foundCanvas = false;
    const collect = (scope) => {
      scope.querySelectorAll?.('img').forEach(watchImage);
      scope.querySelectorAll?.('canvas').forEach((c) => {
        reportCanvas(c);
        foundCanvas = true;
      });
    };
    // document (9) y ShadowRoot (11) no tienen tagName: se usa su rama de query.
    if (root.nodeType === 9 || root.nodeType === 11) {
      collect(root);
      reportSvgRefs(root);
      root.querySelectorAll?.('*').forEach((el) => {
        if (el.shadowRoot) watchTree(el.shadowRoot);
      });
      if (foundCanvas) sweepCanvases();
      return;
    }
    if (root.nodeType !== 1) return;
    if (root.tagName === 'IMG') watchImage(root);
    else if (root.tagName === 'CANVAS') {
      reportCanvas(root);
      foundCanvas = true;
    } else {
      collect(root);
      if (root.tagName === 'IMAGE' || root.tagName === 'USE') {
        const href = root.getAttribute?.('xlink:href') || root.getAttribute?.('href');
        if (href) enqueue(href, 0, 0, 'img');
      }
      reportSvgRefs(root);
    }

    for (const img of root.shadowRoot?.querySelectorAll?.('img') || []) watchImage(img);
    if (foundCanvas) sweepCanvases();
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
    // Como image-downloader: estilo computado de TODOS los elementos que
    // pueden llevar fondo ([class] y/o [style]), no solo style inline.
    const els = document.querySelectorAll('[class], [style]');
    let n = 0;
    for (const el of els) {
      if (n++ > 4000) break; // tope de seguridad en páginas enormes
      const bg = getComputedStyle(el).backgroundImage;
      if (!bg || bg === 'none') continue;
      for (const part of bg.split(',')) {
        const m = /url\(["']?(.+?)["']?\)/.exec(part.trim());
        if (!m || !m[1]) continue;
        enqueue(m[1], Math.round(el.getBoundingClientRect().width), Math.round(el.getBoundingClientRect().height), 'bg');
      }
    }
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
    const wanted = new Set(['img', 'image']);
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
      try {
        return { type: 'canvas', src: el.toDataURL('image/png'), width: el.width, height: el.height };
      } catch {
        return { type: 'canvas', src: '', tainted: true, width: el.width, height: el.height };
      }
    }
    const m = /url\(["']?(.+?)["']?\)/.exec(getComputedStyle(el).backgroundImage || '');
    return m ? { type: 'bg', src: m[1], width: el.clientWidth, height: el.clientHeight } : null;
  }

  // Localiza la imagen viva cuyo src data: coincide con la huella guardada:
  // sirve para reconstruir el contenido que no persistimos en storage.
  function findDataImage({ hash, dataLength, width, height }) {
    for (const img of document.querySelectorAll('img')) {
      const src = img.currentSrc || img.src || '';
      if (!src.startsWith('data:')) continue;
      if (dataLength && src.length !== dataLength) continue;
      if (width && img.naturalWidth && img.naturalWidth !== width) continue;
      if (height && img.naturalHeight && img.naturalHeight !== height) continue;
      if (!hash || fnv1a(src) === hash) return src;
    }
    if (width && height) {
      for (const c of document.querySelectorAll('canvas')) {
        if (c.width !== width || c.height !== height) continue;
        let src;
        try {
          src = c.toDataURL('image/png');
        } catch {
          continue;
        }
        if (dataLength && src.length !== dataLength) continue;
        if (!hash || fnv1a(src) === hash) return src;
      }
    }
    return '';
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === MSG.CONFIG) {
      config = { ...config, ...msg.config };
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === MSG.SCAN_FULL) {
      deepScan();
      // El IntersectionObserver resuelve de forma asíncrona: se responde
      // tras un tick para que count refleje algo útil.
      setTimeout(() => sendResponse({ ok: true, count: seen.size }), FLUSH_DELAY + 100);
      return true;
    }
    if (msg?.type === MSG.SCAN_BACKGROUNDS) {
      if (msg.config) config = { ...config, ...msg.config };
      scanBackgrounds();
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === MSG.FETCH_BLOB) {
      if (msg.resurrect) {
        sendResponse({ ok: true, src: findDataImage(msg.resurrect) || null });
        return false;
      }
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

  // Cada <img> que termina de cargar dispara 'load' en fase de captura:
  // re-reporte inmediato con dimensiones reales, sin esperar al observer.
  document.addEventListener(
    'load',
    (e) => {
      if (e.target?.tagName === 'IMG') reportImage(e.target);
    },
    true
  );

  function initialize() {
    observe();
    watchTree(document);
    observeResources();
    scanBackgrounds();
    sweepCanvases();
    debug('content_script_init', { url: location.href });
    send({ type: MSG.DETECT_READY, url: location.href, isTop: window.top === window });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
