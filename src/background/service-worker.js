import { MSG, LIMITS } from '../lib/messages.js';
import { loadConfig } from '../lib/config.js';
import { BADGE_COLOR, BADGE_ERROR_COLOR } from '../lib/theme.js';
import * as state from '../lib/state.js';
import { buildFilename, sanitizeFolderPath, sanitizeFilename } from '../lib/filename.js';

const FORMATS = {
  original: { id: 'original', title: 'Original', mime: null, ext: null },
  png: { id: 'png', title: 'PNG', mime: 'image/png', ext: 'png' },
  jpg: { id: 'jpg', title: 'JPG', mime: 'image/jpeg', ext: 'jpg' },
  webp: { id: 'webp', title: 'WebP', mime: 'image/webp', ext: 'webp' },
  avif: { id: 'avif', title: 'AVIF', mime: 'image/avif', ext: 'avif' }
};
const MENU_FORMATS = ['png', 'jpg', 'webp', 'avif'];

const POPUP_ID = 'pixelcatch-root';
const IMG_EXT_RE = /^(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

let offscreenPromise = null;
let offscreenIdleTimer = null;

// Nada de top-level await: Chrome lo prohíbe en service workers (módulos
// incluidos). config se resuelve en una promesa y todo uso la espera.
let config = null;
const configReady = loadConfig().then((c) => (config = c));

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: POPUP_ID, title: 'Guardar imagen como…', contexts: ['image'] });
    for (const id of MENU_FORMATS) {
      const f = FORMATS[id];
      chrome.contextMenus.create({
        id: `pixelcatch-${f.id}`,
        parentId: POPUP_ID,
        title: f.title,
        contexts: ['image']
      });
    }
  });
}

// AVIF no se puede codificar en todos los navegadores: se prueba una vez y,
// si falla, se oculta la entrada del menú (idea tomada de SaveAsExtension).
async function probeAvifSupport() {
  try {
    const canvas = new OffscreenCanvas(2, 2);
    canvas.getContext('2d').fillRect(0, 0, 2, 2);
    const blob = await canvas.convertToBlob({ type: 'image/avif' });
    if (blob.type !== 'image/avif') {
      await chrome.contextMenus.remove('pixelcatch-avif').catch(() => {});
    }
  } catch {
    await chrome.contextMenus.remove('pixelcatch-avif').catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(() => {
  createMenus();
  probeAvifSupport();
});
chrome.runtime.onStartup.addListener(createMenus);

async function ensureOffscreen() {
  if (!(await chrome.offscreen.hasDocument?.())) {
    if (!offscreenPromise) {
      offscreenPromise = chrome.offscreen
        .createDocument({
          url: 'src/offscreen/offscreen.html',
          reasons: ['BLOBS', 'DOM_SCRAPING'],
          justification: 'Conversión de formato y empaquetado ZIP'
        })
        .catch((e) => {
          offscreenPromise = null;
          throw e;
        });
    }
    await offscreenPromise;
    offscreenPromise = null;
  }
  scheduleOffscreenClose();
}

function scheduleOffscreenClose() {
  clearTimeout(offscreenIdleTimer);
  offscreenIdleTimer = setTimeout(() => {
    chrome.offscreen.closeDocument().catch(() => {});
  }, LIMITS.OFFSCREEN_IDLE_MS);
}

async function callOffscreen(msg) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage(msg);
  scheduleOffscreenClose();
  if (!res?.ok) throw new Error(res?.error || 'offscreen-failed');
  return res;
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function forEachFrame(tabId, fn) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
  if (!frames?.length) {
    await fn(undefined);
    return;
  }
  await Promise.all(
    frames
      .filter((f) => !f.errorOccurred)
      .map((f) => fn(f.frameId))
  );
}

// Intenta decirle a TODOS los frames (incluidos iframes anidados) que hagan un
// barrido. El detector también envía deltas por sí mismo, así que con que uno
// responda basta para considerar que el escaneo se ejecutó.
async function askAllFramesToScan(tabId) {
  let any = false;
  await forEachFrame(tabId, async (frameId) => {
    const opts = Number.isFinite(frameId) ? { frameId } : undefined;
    const res = await chrome.tabs
      .sendMessage(tabId, { type: MSG.SCAN_FULL }, opts)
      .catch(() => null);
    any = any || !!res?.ok;
  });
  return any;
}

async function askAllFramesToScanBackgrounds(tabId) {
  let any = false;
  await forEachFrame(tabId, async (frameId) => {
    const opts = Number.isFinite(frameId) ? { frameId } : undefined;
    const res = await chrome.tabs
      .sendMessage(tabId, { type: MSG.SCAN_BACKGROUNDS, config: { ...config, detectBackgrounds: true } }, opts)
      .catch(() => null);
    any = any || !!res?.ok;
  });
  return any;
}

async function pushConfigToTab(tabId) {
  if (tabId == null) return;
  await configReady;
  chrome.tabs.sendMessage(tabId, { type: MSG.CONFIG, config }).catch(() => {});
}

async function pushConfigEverywhere() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((t) => pushConfigToTab(t.id)));
}

// ── Emisión de deltas a la UI ────────────────────────────────────────────────
// Antes se enviaba la galería entera en cada batch (O(n²)). Ahora se juntan
// los deltas durante EMIT_THROTTLE_MS y se manda solo lo nuevo/borrado.
const pendingDeltas = new Map();

function queueEmit(tabId, delta) {
  const pending = pendingDeltas.get(tabId) || { added: [], removed: [], clear: false, timer: null };
  if (delta.added) pending.added.push(...delta.added);
  if (delta.removed) pending.removed.push(...delta.removed);
  if (delta.clear) pending.clear = true;
  if (!pending.timer) {
    pending.timer = setTimeout(() => flushEmit(tabId), LIMITS.EMIT_THROTTLE_MS);
  }
  pendingDeltas.set(tabId, pending);
}

async function flushEmit(tabId) {
  const pending = pendingDeltas.get(tabId);
  if (!pending) return;
  pendingDeltas.delete(tabId);
  const total = pending.clear ? 0 : (await state.getGallery(tabId)).length;
  chrome.runtime
    .sendMessage({
      type: MSG.STATE_PUSH,
      tabId,
      added: pending.added,
      removed: pending.removed,
      clear: pending.clear,
      total
    })
    .catch(() => {});
}

async function updateBadge(tabId, count) {
  await chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {});
}

async function errorBadge(tabId) {
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text: '!' }).catch(() => {}),
    chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_ERROR_COLOR }).catch(() => {})
  ]);
}

async function handleBatch(sender, items) {
  const tabId = sender.tab?.id;
  if (tabId == null || !items?.length) return { ok: true };

  const { added, total } = await state.addItems(tabId, items, sender.frameId ?? null);
  if (added.length) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR }).catch(() => {});
    await updateBadge(tabId, total);
    queueEmit(tabId, { added });
  }
  return { ok: true, count: total };
}

// ── Resolución de orígenes ───────────────────────────────────────────────────
// Un item puede llegar como: URL http(s) directa, data: truncada (hay que
// reconstruirla pidiéndola al frame vivo) o blob: del renderer (hay que
// traerse los bytes porque ni el SW ni el offscreen pueden leerla).
async function resolveItemSrc(tabId, item) {
  if (!item.truncated) return item.src || null;
  const frameId = item.frameId ?? 0;
  const res = await chrome.tabs
    .sendMessage(tabId, { type: MSG.FETCH_BLOB, resurrect: { hash: item.hash, dataLength: item.dataLength, width: item.width, height: item.height } }, { frameId })
    .catch(() => null);
  return res?.ok && res.src ? res.src : null;
}

function urlExt(src) {
  try {
    const u = new URL(src);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return (u.pathname.split('.').pop() || '').toLowerCase();
  } catch {
    return '';
  }
}

function isHttp(src) {
  return /^https?:/i.test(src);
}

// Descarga directa solo si es http(s) y (o no hay conversión pedida o el
// formato pedido coincide con el original): así no se re-codifica nada.
function canDirectDownload(src, ext) {
  if (!isHttp(src)) return false;
  if (ext == null) return true; // formato "original"
  const cur = urlExt(src);
  if (!IMG_EXT_RE.test(cur)) return false;
  return (cur === 'jpeg' ? 'jpg' : cur) === ext;
}

// Convierte vía offscreen y devuelve blobUrl del origen de la extensión,
// apto para chrome.downloads.
async function convertToBlobUrl(src, mime) {
  const { blobUrl } = await callOffscreen({ type: MSG.CONVERT_IMAGE, src, mime });
  return blobUrl;
}

// Trae un blob: del renderer: el content script hace fetch (el renderer sí
// puede leer sus propios blobs) y el offscreen lo re-aloja como blob URL.
async function fetchRendererBlob(tabId, frameId, src, mime) {
  const res = await chrome.tabs
    .sendMessage(tabId, { type: MSG.FETCH_BLOB, src }, frameId != null ? { frameId } : undefined)
    .catch(() => null);
  if (!res?.ok || !res.buffer) return null;
  try {
    const { blobUrl } = await callOffscreen({ type: MSG.BUFFER_TO_BLOB, buffer: res.buffer, mime });
    return blobUrl;
  } catch {
    return null;
  }
}

// ── Descargas ────────────────────────────────────────────────────────────────
async function runPool(items, concurrency, task, onProgress) {
  let cursor = 0;
  const failures = [];

  async function worker(i) {
    await new Promise((r) => setTimeout(r, i * 12));
    while (cursor < items.length) {
      const index = cursor++;
      try {
        await task(items[index], index);
      } catch (e) {
        failures.push({ index, error: String(e?.message || e) });
      }
      onProgress?.({ done: cursor, total: items.length, failed: failures.length });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, (_, i) => worker(i)));
  return { done: items.length - failures.length, failures };
}

// Extensión para el nombre según el origen: la de la URL si existe; para
// data: el subtipo del MIME; si nada cuadra, png.
function extFor(item, src, fmt) {
  if (fmt.ext) return fmt.ext;
  const fromUrl = urlExt(src);
  if (IMG_EXT_RE.test(fromUrl)) return fromUrl === 'jpeg' ? 'jpg' : fromUrl;
  if (src.startsWith('data:')) {
    const m = /^data:image\/([a-z0-9+.-]+)/i.exec(src);
    if (m) return m[1] === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  }
  return 'png';
}

async function downloadItem(tabId, item, index, { prefix, configNow, fmt, now }) {
  const src = await resolveItemSrc(tabId, item);
  if (!src) throw new Error('src-unavailable');
  const name = buildFilename(item, index, configNow, extFor(item, src, fmt), now);

  if (canDirectDownload(src, fmt.ext)) {
    await chrome.downloads.download({ url: src, filename: `${prefix}${name}`, conflictAction: 'uniquify' });
    return;
  }

  // Con formato "original" los data: se descargan tal cual (chrome.downloads
  // los soporta de forma nativa): cero re-codificación, máxima velocidad.
  if (!fmt.mime && src.startsWith('data:')) {
    await chrome.downloads.download({ url: src, filename: `${prefix}${name}`, conflictAction: 'uniquify' });
    return;
  }

  if (isHttp(src)) {
    try {
      const blobUrl = await convertToBlobUrl(src, fmt.mime);
      await chrome.downloads.download({ url: blobUrl, filename: `${prefix}${name}`, conflictAction: 'uniquify' });
      return;
    } catch {
      // Respaldo honesto: bytes originales con su extensión original.
      const cur = urlExt(src);
      const fname = cur && IMG_EXT_RE.test(cur) ? name.replace(/\.[^.]+$/, `.${cur}`) : name;
      await chrome.downloads.download({ url: src, filename: `${prefix}${fname}`, conflictAction: 'uniquify' });
      return;
    }
  }

  // blob: del renderer → bytes por content script; data:/resto → offscreen.
  let blobUrl;
  if (src.startsWith('blob:')) {
    blobUrl = await fetchRendererBlob(tabId, item.frameId, src, fmt.mime);
    if (!blobUrl) throw new Error('blob-fetch-failed');
  } else {
    blobUrl = await convertToBlobUrl(src, fmt.mime);
  }
  await chrome.downloads.download({ url: blobUrl, filename: `${prefix}${name}`, conflictAction: 'uniquify' });
}

async function downloadSelection(tabId, items, { folder, format, zip }) {
  const configNow = await loadConfig();
  const cleanFolder = sanitizeFolderPath(folder || '');
  const prefix = cleanFolder ? `${cleanFolder}/` : '';
  const now = new Date();
  const fmt = FORMATS[format] || FORMATS.original;
  const progress = (p) =>
    chrome.runtime.sendMessage({ type: MSG.STATE_PUSH, tabId, progress: p }).catch(() => {});

  if (!zip) {
    const { done, failures } = await runPool(
      items,
      configNow.downloadConcurrency,
      (item, i) => downloadItem(tabId, item, i, { prefix, configNow, fmt, now }),
      progress
    );
    return { done, failed: failures.length, errors: failures.slice(0, 20) };
  }

  // ZIP: mismo resolve por item, pero empaquetado en el offscreen.
  const resolved = [];
  const failures = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      const src = await resolveItemSrc(tabId, item);
      if (!src) throw new Error('src-unavailable');
      resolved.push({
        src,
        filename: buildFilename(item, i, configNow, extFor(item, src, fmt), now),
        mime: fmt.mime,
        frameId: item.frameId ?? null
      });
    } catch (e) {
      failures.push({ index: i, error: String(e?.message || e) });
    }
    progress({ done: i + 1, total: items.length, failed: failures.length, phase: 'resolve' });
  }

  const { blobUrl, filename, failed: zipFailed } = await callOffscreen({
    type: MSG.GENERATE_ZIP,
    tabId,
    items: resolved,
    folderName: cleanFolder,
    zipName: sanitizeFilename(cleanFolder.replace(/\//g, '-') || 'pixelcatch')
  });

  await chrome.downloads.download({
    url: blobUrl,
    filename: filename.endsWith('.zip') ? filename : `${filename}.zip`,
    conflictAction: 'uniquify'
  });

  const allFailed = failures.length + (zipFailed?.length || 0);
  return { done: items.length - allFailed, failed: allFailed, errors: [...failures, ...(zipFailed || [])].slice(0, 20) };
}


chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!info.menuItemId.startsWith('pixelcatch-') || info.menuItemId === POPUP_ID) return;
  const fmt = FORMATS[info.menuItemId.replace('pixelcatch-', '')];
  if (!fmt) return;

  let src = info.srcUrl;
  // blob: dentro de una página: el menú contextual da la URL pero solo el
  // renderer puede leerla; pedimos los bytes ya recodificados al formato.
  if (src?.startsWith('blob:') && tab?.id != null) {
    src = await fetchRendererBlob(tab.id, info.frameId ?? null, src, fmt.mime);
  }
  if (src) {
    try {
      let blobUrl = src;
      if (isHttp(src) || src.startsWith('data:')) {
        ({ blobUrl } = await callOffscreen({ type: MSG.CONVERT_IMAGE, src, mime: fmt.mime }));
      }
      await chrome.downloads.download({
        url: blobUrl,
        filename: `pixelcatch-${Date.now()}.${fmt.ext}`,
        conflictAction: 'uniquify'
      });
      return;
    } catch {
      /* sigue el respaldo */
    }
  }
  if (tab?.id != null) errorBadge(tab.id);
  if (info.srcUrl && isHttp(info.srcUrl)) {
    await chrome.downloads
      .download({ url: info.srcUrl, conflictAction: 'uniquify' })
      .catch(() => {});
  }
});

// Imagen bajo el cursor: recorre los frames hasta encontrar el que la tiene.
chrome.commands.onCommand.addListener(async (command) => {
  const tabId = await activeTabId();

  if (command === 'save-under-cursor') {
    if (tabId == null) return;
    await configReady;
    const target = await findUnderCursor(tabId);
    if (!target?.src) {
      errorBadge(tabId);
      return;
    }
    const fmt = FORMATS[config.defaultFormat] || FORMATS.original;
    try {
      let src = target.src;
      if (src.startsWith('blob:')) {
        src = (await fetchRendererBlob(tabId, target.frameId ?? null, src, fmt.mime)) || null;
        if (!src) throw new Error('blob-fetch-failed');
      }
      if (!fmt.mime && (isHttp(src) || src.startsWith('data:') || src.startsWith('blob:'))) {
        // original: tal cual, sin re-codificar
        const ext = urlExt(src) || 'png';
        await chrome.downloads.download({
          url: src,
          filename: `pixelcatch-${Date.now()}.${ext}`,
          conflictAction: 'uniquify'
        });
        return;
      }
      const { blobUrl } = await callOffscreen({ type: MSG.CONVERT_IMAGE, src, mime: fmt.mime });
      await chrome.downloads.download({
        url: blobUrl,
        filename: `pixelcatch-${Date.now()}.${fmt.ext}`,
        conflictAction: 'uniquify'
      });
    } catch {
      errorBadge(tabId);
    }
    return;
  }

  if (command === 'save-all-review') {
    if (tabId == null) return;
    // Toda la UI vive en el popup flotante: Alt+Shift+B lo abre directamente.
    await chrome.action.openPopup().catch(() => {});
    const items = await state.getGallery(tabId);
    chrome.runtime
      .sendMessage({ type: MSG.STATE_PUSH, tabId, added: [], removed: [], clear: true, total: items.length, snapshot: items })
      .catch(() => {});
  }
});

async function findUnderCursor(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
  if (frames?.length) {
    for (const frame of frames) {
      if (frame.errorOccurred) continue;
      const res = await chrome.tabs
        .sendMessage(tabId, { type: MSG.WHAT_IS_UNDER_CURSOR }, { frameId: frame.frameId })
        .catch(() => null);
      if (res?.src) return { ...res, frameId: frame.frameId };
    }
    return null;
  }
  return chrome.tabs.sendMessage(tabId, { type: MSG.WHAT_IS_UNDER_CURSOR }).catch(() => null);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  loadConfig().then((next) => {
    config = next;
    pushConfigEverywhere();
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  state.dropTab(tabId);
});

// Solo la navegación del frame principal vacía la galería. Con iframes de
// terceros (Perchance) los subframes navegan constantemente y borraban todo.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0 || details.tabId < 0) return;
  const tabId = details.tabId;
  state.clearTab(tabId).then(() => {
    queueEmit(tabId, { clear: true, added: [], removed: [] });
    updateBadge(tabId, 0);
  });
});

state.onStorageError((e) => {
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (tab?.id != null) {
      errorBadge(tab.id);
      chrome.runtime
        .sendMessage({ type: MSG.STATE_PUSH, tabId: tab.id, error: 'storage-full' })
        .catch(() => {});
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const respond = (fn) => {
    fn().then(
      (data) => sendResponse({ ok: true, ...data }),
      (e) => sendResponse({ ok: false, error: String(e?.message || e) })
    );
    return true;
  };

  if (msg?.type === MSG.CONFIG) {
    config = { ...config, ...msg.config };
    return false;
  }
  if (msg?.type === MSG.DETECT_READY) {
    return respond(async () => {
      const tabId = sender.tab?.id;
      if (tabId == null) return {};
      if (sender.frameId === 0) await pushConfigToTab(tabId);
      return { tabId };
    });
  }
  if (msg?.type === MSG.DETECT_BATCH) {
    return respond(() => handleBatch(sender, msg.items));
  }
  if (msg?.type === MSG.GET_STATE) {
    return respond(async () => {
      const tabId = msg.tabId ?? sender.tab?.id ?? (await activeTabId());
      if (tabId == null) return { tabId: null, items: [] };
      await askAllFramesToScan(tabId);
      const items = await state.getGallery(tabId);
      await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR }).catch(() => {});
      await updateBadge(tabId, items.length);
      return { tabId, items };
    });
  }
  if (msg?.type === MSG.SCAN_BACKGROUNDS) {
    return respond(async () => {
      const tabId = msg.tabId ?? sender.tab?.id ?? (await activeTabId());
      if (tabId == null) return {};
      await pushConfigToTab(tabId);
      await configReady;
      const scanned = await askAllFramesToScanBackgrounds(tabId);
      return { scanned };
    });
  }
  if (msg?.type === MSG.CLEAR_LIST) {
    return respond(async () => {
      const tabId = msg.tabId ?? sender.tab?.id ?? (await activeTabId());
      if (tabId == null) return {};
      await state.clearTab(tabId);
      await updateBadge(tabId, 0);
      queueEmit(tabId, { clear: true, added: [], removed: [] });
      return { tabId };
    });
  }
  if (msg?.type === MSG.OPEN_PANEL) {
    return respond(async () => {
      await chrome.action.openPopup().catch(() => {});
      return { tabId: msg.tabId ?? (await activeTabId()) };
    });
  }
  if (msg?.type === MSG.DOWNLOAD_SELECTED) {
    return respond(async () => {
      const tabId = msg.tabId ?? sender.tab?.id ?? (await activeTabId());
      const res = await downloadSelection(tabId, msg.items || [], {
        folder: msg.folder,
        format: msg.format,
        zip: !!msg.zip
      });
      if (tabId != null && res.failed === res.done + res.failed && res.failed > 0) errorBadge(tabId);
      return res;
    });
  }
  if (msg?.type === 'PC_DEBUG_LOG') {
    return respond(async () => {
      await state.appendDebug(msg.entries || []);
      return {};
    });
  }
  if (msg?.type === MSG.EXPORT_DEBUG) {
    return respond(async () => {
      const entries = await state.readDebug();
      const text = entries
        .map((e) => `[${new Date(e.t).toISOString()}] ${e.msg} ${JSON.stringify(e.meta || {})} ${e.frame || ''}`)
        .join('\n');
      const { blobUrl } = await callOffscreen({ type: MSG.BUFFER_TO_BLOB, buffer: new TextEncoder().encode(text).buffer });
      await chrome.downloads.download({
        url: blobUrl,
        filename: `pixelcatch-debug-${msg.tabId ?? 'tab'}-${Date.now()}.txt`,
        conflictAction: 'uniquify'
      });
      return { entries: entries.length };
    });
  }

  return false;
});

// El worker puede morir en cualquier momento: volcamos el estado pendiente
// a storage.session en vez de depender solo del debounce de state.js.
chrome.runtime.onSuspend.addListener(() => {
  state.flushNow();
});

state.hydrate().then(() => configReady).then(() => pushConfigEverywhere());
