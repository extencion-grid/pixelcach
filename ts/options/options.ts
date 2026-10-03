import { loadConfig, saveConfig, type Config } from '../lib/config.js';
import { resolveLang, t, installI18n } from '../lib/i18n.js';

type FieldApplier = (el: HTMLElement, v: unknown) => void;

const FIELDS: Record<keyof Omit<Config, never>, FieldApplier> = {
  defaultFormat: (el, v) => ((el as HTMLSelectElement).value = String(v)),
  minSize: (el, v) => ((el as HTMLInputElement).value = String(v)),
  nameTemplate: (el, v) => ((el as HTMLInputElement).value = String(v)),
  detectBackgrounds: (el, v) => ((el as HTMLInputElement).checked = Boolean(v)),
  detectResources: (el, v) => ((el as HTMLInputElement).checked = Boolean(v)),
  downloadConcurrency: (el, v) => ((el as HTMLInputElement).value = String(v)),
  debugEnabled: (el, v) => ((el as HTMLInputElement).checked = Boolean(v))
};

const el: Record<string, HTMLElement> = {};
for (const id of Object.keys(FIELDS)) {
  const node = document.getElementById(id);
  if (node) el[id] = node;
}

const status = document.getElementById('status') as HTMLElement;
const save = document.getElementById('save') as HTMLButtonElement;
const shortcuts = document.getElementById('shortcuts') as HTMLAnchorElement | null;

await resolveLang();
installI18n(document);

if (shortcuts) {
  shortcuts.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
}

const config = await loadConfig();
for (const [id, apply] of Object.entries(FIELDS)) {
  const node = el[id];
  if (node) apply(node, config[id as keyof Config]);
}

save.onclick = async () => {
  const patch: Record<string, unknown> = {};
  for (const id of Object.keys(FIELDS)) {
    const node = el[id] as HTMLInputElement | undefined;
    if (!node) continue;
    if (node.type === 'checkbox') patch[id] = node.checked;
    else if (node.type === 'number') patch[id] = Number(node.value);
    else patch[id] = node.value;
  }

  const next = await saveConfig(patch as Partial<Config>);
  for (const [id, apply] of Object.entries(FIELDS)) {
    const node = el[id];
    if (node) apply(node, next[id as keyof Config]);
  }

  status.textContent = t('saved');
  setTimeout(() => (status.textContent = ''), 2000);
};
