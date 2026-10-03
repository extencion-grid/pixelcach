const DEFAULTS = {
  defaultFormat: 'png',
  minSize: 150,
  nameTemplate: '{domain}-{date}-{index}',
  detectBackgrounds: false,
  detectResources: true,
  downloadConcurrency: 4,
  debugEnabled: false,
  uiMode: 'auto'
};

export async function loadConfig() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return {
    ...DEFAULTS,
    ...stored,
    minSize: Number.isFinite(Number(stored.minSize)) ? Number(stored.minSize) : DEFAULTS.minSize,
    downloadConcurrency: Math.min(8, Math.max(1, Number(stored.downloadConcurrency) || DEFAULTS.downloadConcurrency))
  };
}

export async function saveConfig(patch) {
  await chrome.storage.sync.set(patch);
  return loadConfig();
}

export function onConfigChanged(handler) {
  const listener = (changes, area) => {
    if (area !== 'sync') return;
    handler();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export function extractDomain(url) {
  try {
    return new URL(url).hostname || '';
  } catch {
    return '';
  }
}