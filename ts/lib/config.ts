export interface Config {
  defaultFormat: 'png' | 'jpg' | 'webp' | 'avif';
  minSize: number;
  nameTemplate: string;
  detectBackgrounds: boolean;
  detectResources: boolean;
  downloadConcurrency: number;
  debugEnabled: boolean;
}

const DEFAULTS: Config = {
  defaultFormat: 'png',
  minSize: 0,
  nameTemplate: '{domain}-{date}-{index}',
  detectBackgrounds: true,
  detectResources: true,
  downloadConcurrency: 4,
  debugEnabled: false
};

export async function loadConfig(): Promise<Config> {
  const stored: Record<string, unknown> = await chrome.storage.sync.get(DEFAULTS as unknown as Record<string, unknown>);
  return {
    ...DEFAULTS,
    ...stored,
    minSize: Number.isFinite(Number(stored.minSize)) ? Number(stored.minSize) : DEFAULTS.minSize,
    downloadConcurrency: Math.min(8, Math.max(1, Number(stored.downloadConcurrency) || DEFAULTS.downloadConcurrency))
  } as Config;
}

export async function saveConfig(patch: Partial<Config>): Promise<Config> {
  await chrome.storage.sync.set(patch);
  return loadConfig();
}

export function onConfigChanged(handler: () => void): () => void {
  const listener = (_changes: Record<string, unknown>, area: string) => {
    if (area !== 'sync') return;
    handler();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname || '';
  } catch {
    return '';
  }
}
