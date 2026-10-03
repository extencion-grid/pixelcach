import { LIMITS } from './messages.js';

const GALLERY_KEY = 'pcGallery';
const DEBUG_KEY = 'pcDebugLog';
const FLUSH_DELAY_MS = 400;
const DEBUG_MAX = 2000;

export interface GalleryItem {
  src: string;
  width: number;
  height: number;
  url: string;
  type: string;
  frameId: number | null;
  hash: string;
  dataLength: number;
  truncated: boolean;
}

interface RawItem {
  src?: string;
  width?: number;
  height?: number;
  url?: string;
  type?: string;
  frameId?: number | null;
  hash?: string;
  dataLength?: number;
}

interface DebugEntry {
  t: number;
  msg: string;
  meta?: Record<string, unknown>;
  frame?: string;
}

let inMemory: Record<string, GalleryItem[]> = {};
const dedupSets: Record<string, Set<string>> = {};
let hydrated = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let errorHandler: ((e: unknown) => void) | null = null;

const byTab = (tabId: number | string) => String(tabId);

export function onStorageError(handler: (e: unknown) => void): void {
  errorHandler = handler;
}

function reportError(e: unknown): void {
  if (!errorHandler) return;
  try {
    errorHandler(e);
  } catch {
    /* no bloquear por el handler */
  }
}

// Clave única por imagen. blob: cambia de URL entre sesiones del renderer,
// así que se refuerza con dimensiones. data: se firma por hash+longitud
// porque el src completo puede estar truncado.
export function keyOf(item: RawItem | GalleryItem): string {
  const src = item?.src || '';
  if (src.startsWith('blob:')) return `${src}|${item.width || 0}x${item.height || 0}`;
  if ((item as GalleryItem)?.truncated) return `data#${(item as GalleryItem).hash}:${(item as GalleryItem).dataLength}`;
  return src;
}

// Guarda metadatos; el contenido se recupera al descargar. data: enormes se
// truncan para no reventar la cuota de storage.session (≈10 MB).
function normalize(item: RawItem, frameId: number | null): GalleryItem {
  const out: GalleryItem = {
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

export async function hydrate(): Promise<Record<string, GalleryItem[]>> {
  if (hydrated) return inMemory;
  const stored = await chrome.storage.session.get([GALLERY_KEY, DEBUG_KEY]);
  inMemory = (stored[GALLERY_KEY] as Record<string, GalleryItem[]>) || {};
  for (const [key, list] of Object.entries(inMemory)) {
    dedupSets[key] = new Set(list.map(keyOf));
  }
  hydrated = true;
  return inMemory;
}

export async function getGallery(tabId: number): Promise<GalleryItem[]> {
  await hydrate();
  return inMemory[byTab(tabId)] || [];
}

// Devuelve solo lo nuevo (delta) para que el SW no reenvíe toda la galería.
export async function addItems(
  tabId: number,
  items: RawItem[],
  frameId: number | null = null
): Promise<{ added: GalleryItem[]; total: number }> {
  await hydrate();
  const key = byTab(tabId);
  const list = inMemory[key] || (inMemory[key] = []);
  const seen = dedupSets[key] || (dedupSets[key] = new Set(list.map(keyOf)));
  const added: GalleryItem[] = [];

  for (const item of items) {
    if (!item || !item.src) continue;
    const norm = normalize(item, frameId);
    const k = keyOf(norm);
    if (seen.has(k)) continue;
    seen.add(k);
    list.push(norm);
    added.push(norm);
  }

  if (added.length) scheduleFlush();
  return { added, total: list.length };
}

export async function removeItem(tabId: number, srcKey: string): Promise<{ removed: boolean }> {
  await hydrate();
  const key = byTab(tabId);
  const list = inMemory[key];
  if (!list) return { removed: false };
  const idx = list.findIndex((i) => keyOf(i) === srcKey);
  if (idx === -1) return { removed: false };
  list.splice(idx, 1);
  dedupSets[key]?.delete(srcKey);
  scheduleFlush();
  return { removed: true };
}

export async function clearTab(tabId: number): Promise<void> {
  await hydrate();
  const key = byTab(tabId);
  if (!inMemory[key]) return;
  delete inMemory[key];
  delete dedupSets[key];
  scheduleFlush();
}

export const dropTab = clearTab;

export async function appendDebug(entries: DebugEntry[]): Promise<void> {
  if (!entries || !entries.length) return;
  try {
    const stored = await chrome.storage.session.get([DEBUG_KEY]);
    const all = (stored[DEBUG_KEY] as DebugEntry[]) || [];
    all.push(...entries);
    while (all.length > DEBUG_MAX) all.shift();
    await chrome.storage.session.set({ [DEBUG_KEY]: all });
  } catch (e) {
    reportError(e);
  }
}

export async function readDebug(): Promise<DebugEntry[]> {
  const stored = await chrome.storage.session.get([DEBUG_KEY]);
  return (stored[DEBUG_KEY] as DebugEntry[]) || [];
}

function writeGallery(): Promise<void> {
  return chrome.storage.session.set({ [GALLERY_KEY]: inMemory }).catch((e: unknown) => {
    reportError(e);
  });
}

export function flushNow(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  return writeGallery();
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void writeGallery();
  }, FLUSH_DELAY_MS);
}
