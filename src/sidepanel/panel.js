import { MSG } from '../lib/messages.js';
import { loadConfig } from '../lib/config.js';
import { resolveLang, t, installI18n } from '../lib/i18n.js';

const els = {
  badge: document.getElementById('badge'),
  status: document.getElementById('status'),
  grid: document.getElementById('grid'),
  folderName: document.getElementById('folderName'),
  search: document.getElementById('search'),
  minWidth: document.getElementById('minWidth'),
  typeFilter: document.getElementById('typeFilter'),
  selectAll: document.getElementById('selectAll'),
  rangeFrom: document.getElementById('rangeFrom'),
  rangeTo: document.getElementById('rangeTo'),
  selectRange: document.getElementById('selectRange'),
  downloadFolder: document.getElementById('downloadFolder'),
  downloadZip: document.getElementById('downloadZip'),
  reScan: document.getElementById('reScan'),
  scanBackgrounds: document.getElementById('scanBackgrounds'),
  clearList: document.getElementById('clearList'),
  exportDebug: document.getElementById('exportDebug'),
  progressBar: document.getElementById('progressBar'),
  options: document.getElementById('options')
};

let items = [];
let selected = new Set();
let renderedNodes = new Map();
let activeTabId = null;
let config = await loadConfig();
let filter = { q: '', minWidth: 0, type: 'all' };

function visibleItems() {
  const q = filter.q.trim().toLowerCase();
  return items.filter((it) => {
    if (filter.minWidth && (it.width || 0) < filter.minWidth) return false;
    if (filter.type !== 'all') {
      const ext = (it.src.split('?')[0].split('.').pop() || '').toLowerCase();
      const fromType = it.type === 'bg' || it.type === 'resource' ? 'unknown' : ext;
      if (fromType !== filter.type) return false;
    }
    if (q && !it.src.toLowerCase().includes(q) && !(it.name || '').toLowerCase().includes(q)) return false;
    return true;
  });
}

function makeCard(item) {
  const card = document.createElement('div');
  card.className = 'card img-card';

  const thumb = document.createElement('img');
  thumb.className = 'thumb';
  thumb.loading = 'lazy';
  thumb.decoding = 'async';
  thumb.alt = '';
  thumb.src = item.src;

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'img-check';
  check.checked = selected.has(item.src);

  const meta = document.createElement('div');
  meta.className = 'muted small';
  meta.textContent = `${item.width || '?'}×${item.height || '?'}`;

  const idx = document.createElement('div');
  idx.className = 'muted img-index';
  idx.textContent = `#${items.indexOf(item) + 1}`;

  card.append(thumb, check, meta, idx);
  card.addEventListener('click', () => {
    if (selected.has(item.src)) selected.delete(item.src);
    else selected.add(item.src);
    check.checked = selected.has(item.src);
    paintSelection(card, check);
    updateCounters();
  });

  return { card, check };
}

function paintSelection(card, check) {
  card.classList.toggle('is-selected', check.checked);
}

function renderIncremental(list) {
  const seen = new Set();
  for (const item of list) {
    seen.add(item.src);
    if (renderedNodes.has(item.src)) continue;
    const { card, check } = makeCard(item);
    els.grid.append(card);
    renderedNodes.set(item.src, { card, check });
  }
  for (const [src, entry] of renderedNodes) {
    if (!seen.has(src)) {
      entry.card.remove();
      renderedNodes.delete(src);
    }
  }
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
  for (const btn of [els.downloadFolder, els.downloadZip, els.reScan, els.scanBackgrounds]) {
    btn.disabled = busy;
  }
}

async function init() {
  await resolveLang();
  installI18n(document);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  if (activeTabId == null) return;

  els.folderName.placeholder = t('folderName');
  els.search.placeholder = t('search');

  const res = await chrome.runtime.sendMessage({ type: MSG.GET_STATE, tabId: activeTabId }).catch(() => null);
  items = res?.items || [];
  applyFilters();
  updateCounters();
}

function applyFilters() {
  const list = visibleItems();
  renderIncremental(list);
  updateCounters();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === MSG.STATE_PUSH) {
    if (msg.tabId !== activeTabId) return;
    if (msg.progress) {
      setProgress(msg.progress.done / (msg.progress.total || 1));
      els.status.textContent = t('saving', { done: msg.progress.done, total: msg.progress.total });
      return;
    }
    items = msg.items || [];
    applyFilters();
  }

  if (msg?.type === MSG.OPEN_PANEL && msg.tabId === activeTabId) {
    items = msg.items || [];
    applyFilters();
  }
});

els.selectAll.onclick = () => {
  const list = visibleItems();
  if (selected.size === list.length) selected.clear();
  else for (const it of list) selected.add(it.src);
  for (const [src, entry] of renderedNodes) {
    entry.check.checked = selected.has(src);
    paintSelection(entry.card, entry.check);
  }
  updateCounters();
};

els.selectRange.onclick = () => {
  const from = parseInt(els.rangeFrom.value, 10);
  const to = parseInt(els.rangeTo.value, 10);
  if (!from || !to || from > to) return;
  selected.clear();
  for (let i = Math.max(0, from - 1); i < Math.min(to, items.length); i++) {
    selected.add(items[i].src);
  }
  for (const [src, entry] of renderedNodes) {
    entry.check.checked = selected.has(src);
    paintSelection(entry.card, entry.check);
  }
  updateCounters();
};

els.search.oninput = () => {
  filter.q = els.search.value;
  applyFilters();
};

els.minWidth.oninput = () => {
  filter.minWidth = parseInt(els.minWidth.value, 10) || 0;
  applyFilters();
};

els.typeFilter.onchange = () => {
  filter.type = els.typeFilter.value;
  applyFilters();
};

async function runDownload(zip) {
  const chosen = items.filter((it) => selected.has(it.src));
  if (!chosen.length) {
    els.status.textContent = t('noneSelected');
    return;
  }

  setBusy(true);
  setProgress(0);
  try {
    if (zip) els.status.textContent = t('packing');
    const res = await chrome.runtime.sendMessage({
      type: MSG.DOWNLOAD_SELECTED,
      tabId: activeTabId,
      items: chosen,
      folder: els.folderName.value.trim(),
      format: config.defaultFormat,
      zip
    });
    if (res?.failed) els.status.textContent = t('failed', { n: res.failed });
    else els.status.textContent = t('done');
    setProgress(1);
  } catch {
    els.status.textContent = t('failed', { n: chosen.length });
  } finally {
    setBusy(false);
  }
}

els.downloadFolder.onclick = () => runDownload(false);
els.downloadZip.onclick = () => runDownload(true);

els.reScan.onclick = async () => {
  setBusy(true);
  const res = await chrome.runtime.sendMessage({ type: MSG.GET_STATE, tabId: activeTabId }).catch(() => null);
  if (res?.items) {
    items = res.items;
    applyFilters();
  }
  setBusy(false);
};

els.scanBackgrounds.onclick = async () => {
  setBusy(true);
  await chrome.runtime.sendMessage({ type: MSG.SCAN_BACKGROUNDS, tabId: activeTabId }).catch(() => {});
  const res = await chrome.runtime.sendMessage({ type: MSG.GET_STATE, tabId: activeTabId }).catch(() => null);
  if (res?.items) {
    items = res.items;
    applyFilters();
  }
  setBusy(false);
};

els.clearList.onclick = async () => {
  selected.clear();
  await chrome.runtime.sendMessage({ type: MSG.CLEAR_LIST, tabId: activeTabId }).catch(() => {});
  items = [];
  applyFilters();
};

els.exportDebug.onclick = () => {
  chrome.runtime.sendMessage({ type: MSG.EXPORT_DEBUG, tabId: activeTabId }).catch(() => {});
};

els.options.onclick = () => {
  chrome.runtime.openOptionsPage();
};

await init();