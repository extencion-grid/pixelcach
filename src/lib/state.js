import { LIMITS } from './messages.js';
const GALLERY_KEY = 'pcGallery';
const DEBUG_KEY = 'pcDebugLog';
const FLUSH_DELAY_MS = 400;
const DEBUG_MAX = 2000;
let inMemory = {};
const dedupSets = {};
let hydrated = false;
let flushTimer = null;
let errorHandler = null;
const byTab = (tabId) => String(tabId);
export function onStorageError(handler) {
    errorHandler = handler;
}
function reportError(e) {
    if (!errorHandler)
        return;
    try {
        errorHandler(e);
    }
    catch {
        /* no bloquear por el handler */
    }
}
// Clave única por imagen. blob: cambia de URL entre sesiones del renderer,
// así que se refuerza con dimensiones. data: se firma por hash+longitud
// porque el src completo puede estar truncado.
export function keyOf(item) {
    const src = item?.src || '';
    if (src.startsWith('blob:'))
        return `${src}|${item.width || 0}x${item.height || 0}`;
    if (item?.truncated)
        return `data#${item.hash}:${item.dataLength}`;
    return src;
}
// Guarda metadatos; el contenido se recupera al descargar. data: enormes se
// truncan para no reventar la cuota de storage.session (≈10 MB).
function normalize(item, frameId) {
    const out = {
        src: item.src || '',
        width: item.width || 0,
        height: item.height || 0,
        url: item.url || '',
        type: item.type || 'img',
        frameId: item.frameId ?? frameId ?? null,
        hash: item.hash || '',
        dataLength: item.dataLength || (item.src?.startsWith('data:') ? item.src.length : 0),
        truncated: false
    };
    if (out.src.length > LIMITS.DATA_URL_INLINE_MAX * 2 && out.src.startsWith('data:')) {
        out.src = out.src.slice(0, LIMITS.DATA_URL_INLINE_MAX);
        out.truncated = true;
    }
    return out;
}
export async function hydrate() {
    if (hydrated)
        return inMemory;
    const stored = await chrome.storage.session.get([GALLERY_KEY, DEBUG_KEY]);
    inMemory = stored[GALLERY_KEY] || {};
    for (const [key, list] of Object.entries(inMemory)) {
        dedupSets[key] = new Set(list.map(keyOf));
    }
    hydrated = true;
    return inMemory;
}
export async function getGallery(tabId) {
    await hydrate();
    return inMemory[byTab(tabId)] || [];
}
// Devuelve solo lo nuevo (delta) para que el SW no reenvíe toda la galería.
export async function addItems(tabId, items, frameId = null) {
    await hydrate();
    const key = byTab(tabId);
    const list = inMemory[key] || (inMemory[key] = []);
    const seen = dedupSets[key] || (dedupSets[key] = new Set(list.map(keyOf)));
    const added = [];
    for (const item of items) {
        if (!item || !item.src)
            continue;
        const norm = normalize(item, frameId);
        const k = keyOf(norm);
        if (seen.has(k)) {
            // Misma imagen reportada de nuevo, ya con tamaño real: se actualiza.
            if (norm.width > 0 && norm.height > 0) {
                const prev = list.find((i) => keyOf(i) === k);
                if (prev && (!prev.width || !prev.height)) {
                    prev.width = norm.width;
                    prev.height = norm.height;
                    scheduleFlush();
                }
            }
            continue;
        }
        seen.add(k);
        list.push(norm);
        added.push(norm);
    }
    if (added.length)
        scheduleFlush();
    return { added, total: list.length };
}
export async function removeItem(tabId, srcKey) {
    await hydrate();
    const key = byTab(tabId);
    const list = inMemory[key];
    if (!list)
        return { removed: false };
    const idx = list.findIndex((i) => keyOf(i) === srcKey);
    if (idx === -1)
        return { removed: false };
    list.splice(idx, 1);
    dedupSets[key]?.delete(srcKey);
    scheduleFlush();
    return { removed: true };
}
export async function clearTab(tabId) {
    await hydrate();
    const key = byTab(tabId);
    if (!inMemory[key])
        return;
    delete inMemory[key];
    delete dedupSets[key];
    scheduleFlush();
}
export const dropTab = clearTab;
export async function appendDebug(entries) {
    if (!entries || !entries.length)
        return;
    try {
        const stored = await chrome.storage.session.get([DEBUG_KEY]);
        const all = stored[DEBUG_KEY] || [];
        all.push(...entries);
        while (all.length > DEBUG_MAX)
            all.shift();
        await chrome.storage.session.set({ [DEBUG_KEY]: all });
    }
    catch (e) {
        reportError(e);
    }
}
export async function readDebug() {
    const stored = await chrome.storage.session.get([DEBUG_KEY]);
    return stored[DEBUG_KEY] || [];
}
function writeGallery() {
    return chrome.storage.session.set({ [GALLERY_KEY]: inMemory }).catch((e) => {
        reportError(e);
    });
}
export function flushNow() {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    return writeGallery();
}
function scheduleFlush() {
    if (flushTimer)
        return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        void writeGallery();
    }, FLUSH_DELAY_MS);
}
