import { MSG, LIMITS } from '../lib/messages.js';
import { loadConfig } from '../lib/config.js';
import * as state from '../lib/state.js';
import { buildFilename } from '../lib/filename.js';

const FORMATS = {
  png: { id: 'png', title: 'PNG', mime: 'image/png', ext: 'png' },
  jpg: { id: 'jpg', title: 'JPG', mime: 'image/jpeg', ext: 'jpg' },
  webp: { id: 'webp', title: 'WebP', mime: 'image/webp', ext: 'webp' },
  avif: { id: 'avif', title: 'AVIF', mime: 'image/avif', ext: 'avif' }
};

const POPUP_ID = 'pixelcatch-root';
const UNSAFE_NAME = /[\\/:*?"<>|]+/g;

let offscreenPromise = null;
let offscreenIdleTimer = null;
let config = await loadConfig();

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: POPUP_ID, title: 'Guardar imagen como…', contexts: ['image'] });
    for (const f of Object.values(FORMATS)) {
      chrome.contextMenus.create({
        id: `pixelcatch-${f.id}`,
        parentId: POPUP_ID,
        title: f.title,
        contexts: ['image']
      });
    }
  });
}

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

async function pushConfigToTab(tabId) {
  if (tabId == null) return;
  // Sin frameId, Chrome entrega el mensaje a todos los frames de la pestaña.
  chrome.tabs.sendMessage(tabId, { type: MSG.CONFIG, config }).catch(() => {});
}

async function pushConfigEverywhere() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((t) => pushConfigToTab(t.id)));
}

async function emitState(tabId) {
  const items = await state.getGallery(tabId);
  chrome.runtime.sendMessage({ type: MSG.STATE_PUSH, tabId, items }).catch(() => {});
}

async function updateBadge(tabId, count) {
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {}),
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#4f8cff' }).catch(() => {})
  ]);
}

async function handleBatch(sender, items) {
  const tabId = sender.tab?.id;
  if (tabId == null || !items?.length) return { ok: true };

  const { changed, list } = await state.addItems(tabId, items);
  if (changed) {
    await updateBadge(tabId, list.length);
    await emitState(tabId);
  }
  return { ok: true, count: list.length };
}

async function downloadWithQueue(entries, concurrency, onProgress) {
  let cursor = 0;
  let done = 0;
  const failed = [];

  async function worker() {
    await new Promise((r) => setTimeout(r, cursor * 12));
    while (cursor < entries.length) {
      const entry = entries[cursor++];
      try {
        await chrome.downloads.download({ ...entry, conflictAction: 'uniquify' });
        done++;
      } catch {
        failed.push(entry.filename);
      }
      onProgress?.({ done, total: entries.length, failed: failed.length });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  return { done, failed };
}

async function resolveBlobFromTab(tabId, src) {
  const buffer = await chrome.tabs
    .sendMessage(tabId, { type: MSG.FETCH_BLOB, src })
    .catch(() => null);
  if (!buffer?.ok || !buffer.buffer) return null;
  return URL.createObjectURL(new Blob([buffer.buffer]));
}

async function downloadSelection(tabId, items, { folder, mime, ext, zip }) {
  const configNow = await loadConfig();
  const prefix = folder ? `${folder.replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '')}/` : '';
  const now = new Date();
  const entries = items.map((item, i) => ({
    url: item.src,
    filename: `${prefix}${buildFilename(item, i, configNow, ext, now)}`
  }));

  if (!zip) {
    return downloadWithQueue(entries, configNow.downloadConcurrency, (p) =>
      chrome.runtime.sendMessage({ type: MSG.STATE_PUSH, tabId, progress: p }).catch(() => {})
    );
  }

  const { blobUrl, filename } = await callOffscreen({
    type: MSG.GENERATE_ZIP,
    items: items.map((item, i) => ({
      src: item.src,
      filename: buildFilename(item, i, configNow, ext, now),
      mime
    })),
    folderName: folder,
    zipName: (folder || 'pixelcatch').replace(UNSAFE_NAME, '-')
  });

  await chrome.downloads.download({
    url: blobUrl,
    filename: filename.endsWith('.zip') ? filename : `${filename}.zip`,
    conflictAction: 'uniquify'
  });
  return { done: items.length, failed: 0 };
}

chrome.runtime.onInstalled.addListener(createMenus);
chrome.runtime.onStartup.addListener(createMenus);

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (!info.menuItemId.startsWith('pixelcatch-')) return;
  const fmt = FORMATS[info.menuItemId.replace('pixelcatch-', '')];
  if (!fmt) return;

  try {
    const { blobUrl } = await callOffscreen({ type: MSG.CONVERT_IMAGE, src: info.srcUrl, mime: fmt.mime });
    await chrome.downloads.download({
      url: blobUrl,
      filename: `pixelcatch-${Date.now()}.${fmt.ext}`,
      conflictAction: 'uniquify'
    });
  } catch {
    await chrome.downloads.download({
      url: info.srcUrl,
      filename: `pixelcatch-${Date.now()}.${fmt.ext}`,
      conflictAction: 'uniquify'
    });
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const tabId = await activeTabId();

  if (command === 'save-under-cursor') {
    if (tabId == null) return;
    const target = await chrome.tabs.sendMessage(tabId, { type: MSG.WHAT_IS_UNDER_CURSOR }).catch(() => null);
    if (!target?.src) return;
    const fmt = FORMATS[config.defaultFormat] || FORMATS.png;
    try {
      const { blobUrl } = await callOffscreen({ type: MSG.CONVERT_IMAGE, src: target.src, mime: fmt.mime });
      await chrome.downloads.download({
        url: blobUrl,
        filename: `pixelcatch-${Date.now()}.${fmt.ext}`,
        conflictAction: 'uniquify'
      });
    } catch {
      const blobUrl = await resolveBlobFromTab(tabId, target.src);
      await chrome.downloads.download({
        url: blobUrl || target.src,
        filename: `pixelcatch-${Date.now()}.${fmt.ext}`,
        conflictAction: 'uniquify'
      });
    }
    return;
  }

  if (command === 'save-all-review') {
    if (tabId == null) return;
    await chrome.sidePanel.open({ tabId }).catch(() => {});
    const items = await state.getGallery(tabId);
    chrome.runtime.sendMessage({ type: MSG.OPEN_PANEL, tabId, items }).catch(() => {});
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  loadConfig().then((next) => {
    config = next;
    pushConfigEverywhere();
  });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await state.dropTab(tabId);
  await updateBadge(tabId, 0).catch(() => {});
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status === 'loading') {
    await state.clearTab(tabId);
    await updateBadge(tabId, 0);
    emitState(tabId);
  }
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
      await pushConfigToTab(tabId);
      await emitState(tabId);
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
      chrome.tabs.sendMessage(tabId, { type: MSG.SCAN_FULL }).catch(() => {});
      const items = await state.getGallery(tabId);
      await updateBadge(tabId, items.length);
      return { tabId, items };
    });
  }
  if (msg?.type === MSG.SCAN_BACKGROUNDS) {
    return respond(async () => {
      const tabId = msg.tabId ?? sender.tab?.id ?? (await activeTabId());
      if (tabId == null) return {};
      await pushConfigToTab(tabId);
      const res = await chrome.tabs
        .sendMessage(tabId, { type: MSG.SCAN_BACKGROUNDS, config: { ...config, detectBackgrounds: true } })
        .catch(() => null);
      return { scanned: !!res?.ok };
    });
  }
  if (msg?.type === MSG.CLEAR_LIST) {
    return respond(async () => {
      const tabId = msg.tabId ?? sender.tab?.id ?? (await activeTabId());
      if (tabId == null) return {};
      await state.clearTab(tabId);
      await updateBadge(tabId, 0);
      await emitState(tabId);
      return { tabId };
    });
  }
  if (msg?.type === MSG.DOWNLOAD_SELECTED) {
    return respond(async () => {
      const tabId = msg.tabId ?? sender.tab?.id ?? (await activeTabId());
      const fmt = FORMATS[msg.format] || FORMATS.png;
      return downloadSelection(tabId, msg.items || [], {
        folder: msg.folder,
        mime: fmt.mime,
        ext: fmt.ext,
        zip: !!msg.zip
      });
    });
  }
  if (msg?.type === MSG.OPEN_PANEL) {
    return respond(async () => {
      const tabId = msg.tabId ?? (await activeTabId());
      if (tabId == null) return {};
      await chrome.sidePanel.open({ tabId }).catch(() => {});
      return { tabId };
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
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      await chrome.downloads.download({
        url,
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

await state.hydrate();
await pushConfigEverywhere();