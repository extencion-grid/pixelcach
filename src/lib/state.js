const GALLERY_KEY = 'pcGallery';
const DEBUG_KEY = 'pcDebugLog';

let inMemory = {};
let hydrated = false;
let flushTimer = null;
const FLUSH_DELAY_MS = 400;

const byTab = (tabId) => String(tabId);

export async function hydrate() {
  if (hydrated) return inMemory;
  const stored = await chrome.storage.session.get([GALLERY_KEY, DEBUG_KEY]);
  inMemory = stored[GALLERY_KEY] || {};
  hydrated = true;
  return inMemory;
}

export async function getGallery(tabId) {
  await hydrate();
  return inMemory[byTab(tabId)] || [];
}

export async function addItems(tabId, items) {
  await hydrate();
  const key = byTab(tabId);
  const list = inMemory[key] || (inMemory[key] = []);
  const seen = new Set(list.map((i) => i.src));
  let changed = false;

  for (const item of items) {
    if (!item || !item.src || seen.has(item.src)) continue;
    seen.add(item.src);
    list.push({
      src: item.src,
      width: item.width || 0,
      height: item.height || 0,
      url: item.url || '',
      type: item.type || 'img',
      frameId: item.frameId ?? null
    });
    changed = true;
  }

  if (changed) scheduleFlush();
  return { changed, list };
}

export async function clearTab(tabId) {
  await hydrate();
  const key = byTab(tabId);
  if (!inMemory[key]) return;
  delete inMemory[key];
  scheduleFlush();
}

export async function dropTab(tabId) {
  await clearTab(tabId);
}

export async function appendDebug(entries) {
  if (!entries || !entries.length) return;
  const stored = await chrome.storage.session.get([DEBUG_KEY]);
  const all = stored[DEBUG_KEY] || [];
  all.push(...entries);
  while (all.length > 2000) all.shift();
  await chrome.storage.session.set({ [DEBUG_KEY]: all });
}

export async function readDebug() {
  const stored = await chrome.storage.session.get([DEBUG_KEY]);
  return stored[DEBUG_KEY] || [];
}

export function flushNow() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  return chrome.storage.session.set({ [GALLERY_KEY]: inMemory }).catch(() => {});
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    chrome.storage.session.set({ [GALLERY_KEY]: inMemory }).catch(() => {});
  }, FLUSH_DELAY_MS);
}