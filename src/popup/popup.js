import { MSG, LIMITS } from '../lib/messages.js';
import { loadConfig } from '../lib/config.js';
import { resolveLang, t, installI18n } from '../lib/i18n.js';
const $ = (id) => document.getElementById(id);
const els = {
    badge: $('badge'),
    status: $('status'),
    grid: $('grid'),
    folderName: $('folderName'),
    search: $('search'),
    selectAll: $('selectAll'),
    downloadFolder: $('downloadFolder'),
    downloadZip: $('downloadZip'),
    reScan: $('reScan'),
    clearList: $('clearList'),
    progressBar: $('progressBar'),
    options: $('options')
};
let items = [];
let selected = new Set();
let renderedNodes = new Map();
let activeTabId = null;
const config = await loadConfig();
const filter = { q: '' };
let renderOffset = 0;
let sentinelObserver = null;
const keyOfPanel = (it) => it.truncated ? `data#${it.hash}:${it.dataLength}` : it.src?.startsWith('blob:') ? `${it.src}|${it.width}x${it.height}` : it.src;
function visibleItems() {
    const q = filter.q.trim().toLowerCase();
    if (!q)
        return items;
    return items.filter((it) => it.src.toLowerCase().includes(q) || (it.url || '').toLowerCase().includes(q));
}
function makeCard(item, index) {
    const card = document.createElement('div');
    card.className = 'card img-card';
    card.tabIndex = 0;
    const thumb = document.createElement('img');
    thumb.className = 'thumb';
    thumb.loading = 'lazy';
    thumb.decoding = 'async';
    thumb.alt = '';
    if (!item.truncated)
        thumb.src = item.src;
    else
        thumb.classList.add('thumb-empty');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'img-check';
    check.checked = selected.has(keyOfPanel(item));
    const meta = document.createElement('div');
    meta.className = 'muted small img-meta';
    meta.textContent = item.width && item.height ? `${item.width}×${item.height}` : '—';
    const idx = document.createElement('div');
    idx.className = 'muted img-index';
    idx.textContent = `#${index + 1}`;
    card.append(thumb, check, meta, idx);
    const toggle = () => {
        const k = keyOfPanel(item);
        if (selected.has(k))
            selected.delete(k);
        else
            selected.add(k);
        check.checked = selected.has(k);
        paintSelection(card, check.checked);
        updateCounters();
    };
    card.addEventListener('click', toggle);
    card.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            toggle();
        }
    });
    return { card, check };
}
function paintSelection(card, on) {
    card.classList.toggle('is-selected', on);
}
// Render por lotes: con muchas imágenes se añade un trozo y se espera al
// scroll antes de seguir, en lugar de montar miles de nodos de golpe.
function renderChunk() {
    const list = visibleItems();
    const slice = list.slice(renderOffset, renderOffset + LIMITS.VIRTUALIZE_CHUNK);
    if (!slice.length)
        return;
    for (let i = 0; i < slice.length; i++) {
        const item = slice[i];
        const key = keyOfPanel(item);
        if (renderedNodes.has(key))
            continue;
        const { card, check } = makeCard(item, renderOffset + i);
        els.grid.append(card);
        renderedNodes.set(key, { card, check });
    }
    renderOffset += slice.length;
    bindSentinel();
}
function bindSentinel() {
    if (sentinelObserver)
        sentinelObserver.disconnect();
    const list = visibleItems();
    if (renderOffset >= list.length)
        return;
    const sentinel = document.createElement('div');
    sentinel.className = 'sentinel';
    els.grid.append(sentinel);
    sentinelObserver = new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (!e.isIntersecting)
                continue;
            sentinelObserver?.unobserve(e.target);
            e.target.remove();
            renderChunk();
        }
    });
    sentinelObserver.observe(sentinel);
}
function applyFilters(reset = true) {
    if (reset) {
        renderOffset = 0;
        els.grid.replaceChildren();
        renderedNodes.clear();
    }
    renderChunk();
    updateCounters();
}
function updateCounters() {
    const total = items.length;
    const chosen = selected.size;
    els.badge.textContent = String(total);
    els.status.textContent = total ? t('detected', { n: total }) : t('loading');
    els.selectAll.textContent = chosen === total && total > 0 ? t('deselectAll') : t('selectAll');
}
function setProgress(ratio) {
    els.progressBar.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
}
function setBusy(busy) {
    for (const btn of [els.downloadFolder, els.downloadZip, els.reScan]) {
        btn.disabled = busy;
    }
}
function statusLine(res) {
    if (!res)
        return t('failed', { n: 0 });
    if (res.error === 'storage-full')
        return t('storageFull');
    const done = res.done ?? 0;
    const failed = res.failed ?? 0;
    if (failed > 0 && done > 0)
        return t('partial', { ok: done, failed });
    if (failed > 0)
        return t('failed', { n: failed });
    return t('done');
}
async function init() {
    await resolveLang();
    installI18n(document);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab?.id ?? null;
    if (activeTabId == null) {
        els.status.textContent = t('loading');
        return;
    }
    els.folderName.placeholder = t('folderName');
    els.search.placeholder = t('search');
    const res = (await chrome.runtime.sendMessage({ type: MSG.GET_STATE, tabId: activeTabId }).catch(() => null));
    items = res?.items || [];
    applyFilters(true);
    setProgress(0);
}
chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== MSG.STATE_PUSH || (msg.tabId != null && msg.tabId !== activeTabId))
        return;
    if (msg.progress) {
        const label = msg.progress.phase === 'pack'
            ? t('packing')
            : t('saving', { done: msg.progress.done, total: msg.progress.total });
        els.status.textContent = label;
        setProgress(msg.progress.done / (msg.progress.total || 1));
        return;
    }
    if (msg.snapshot) {
        items = msg.snapshot;
        applyFilters(true);
        return;
    }
    if (msg.clear) {
        items = [];
        selected.clear();
        applyFilters(true);
        return;
    }
    if (msg.added?.length) {
        items.push(...msg.added);
        applyFilters(false);
    }
    if (msg.removed?.length) {
        const gone = new Set(msg.removed);
        items = items.filter((it) => !gone.has(keyOfPanel(it)));
        for (const k of gone) {
            const entry = renderedNodes.get(k);
            if (entry) {
                entry.card.remove();
                renderedNodes.delete(k);
            }
            selected.delete(k);
        }
        applyFilters(false);
    }
});
function syncChecksFromSelection(visible, clear) {
    if (clear)
        selected.clear();
    else
        for (const it of visible)
            selected.add(keyOfPanel(it));
    for (const [key, entry] of renderedNodes) {
        entry.check.checked = selected.has(key);
        paintSelection(entry.card, entry.check.checked);
    }
    updateCounters();
}
els.selectAll.onclick = () => {
    const list = visibleItems();
    syncChecksFromSelection(list, selected.size === list.length);
};
els.search.oninput = () => {
    filter.q = els.search.value;
    applyFilters(true);
};
async function runDownload(zip) {
    const chosen = items.filter((it) => selected.has(keyOfPanel(it)));
    if (!chosen.length) {
        els.status.textContent = t('noneSelected');
        return;
    }
    setBusy(true);
    setProgress(0);
    try {
        if (zip)
            els.status.textContent = t('packing');
        // Si el popup se cierra a mitad, la descarga continúa en el service worker.
        const res = (await chrome.runtime.sendMessage({
            type: MSG.DOWNLOAD_SELECTED,
            tabId: activeTabId,
            items: chosen,
            folder: els.folderName.value.trim(),
            format: config.defaultFormat,
            zip
        }));
        els.status.textContent = statusLine(res);
        setProgress(1);
    }
    catch {
        els.status.textContent = t('failed', { n: chosen.length });
    }
    finally {
        setBusy(false);
    }
}
els.downloadFolder.onclick = () => runDownload(false);
els.downloadZip.onclick = () => runDownload(true);
els.reScan.onclick = async () => {
    setBusy(true);
    const res = (await chrome.runtime.sendMessage({ type: MSG.GET_STATE, tabId: activeTabId }).catch(() => null));
    if (res?.items) {
        items = res.items;
        applyFilters(true);
    }
    setBusy(false);
};
els.clearList.onclick = async () => {
    selected.clear();
    await chrome.runtime.sendMessage({ type: MSG.CLEAR_LIST, tabId: activeTabId }).catch(() => { });
    items = [];
    applyFilters(true);
};
els.options.onclick = () => {
    chrome.runtime.openOptionsPage();
};
await init();
