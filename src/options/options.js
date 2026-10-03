import { loadConfig, saveConfig } from '../lib/config.js';
import { resolveLang, t, installI18n } from '../lib/i18n.js';

const FIELDS = {
  defaultFormat: (el, v) => (el.value = v),
  minSize: (el, v) => (el.value = v),
  nameTemplate: (el, v) => (el.value = v),
  detectBackgrounds: (el, v) => (el.checked = v),
  detectResources: (el, v) => (el.checked = v),
  downloadConcurrency: (el, v) => (el.value = v),
  debugEnabled: (el, v) => (el.checked = v)
};

const el = {};
for (const id of Object.keys(FIELDS)) el[id] = document.getElementById(id);

const status = document.getElementById('status');
const save = document.getElementById('save');

await resolveLang();
installI18n(document);

const config = await loadConfig();
for (const [id, apply] of Object.entries(FIELDS)) apply(el[id], config[id]);

save.onclick = async () => {
  const patch = {};
  for (const [id, apply] of Object.entries(FIELDS)) {
    const node = el[id];
    if (node.type === 'checkbox') patch[id] = node.checked;
    else if (node.type === 'number') patch[id] = Number(node.value);
    else patch[id] = node.value;
  }

  const next = await saveConfig(patch);
  for (const [id, apply] of Object.entries(FIELDS)) apply(el[id], next[id]);

  status.textContent = t('saved');
  setTimeout(() => (status.textContent = ''), 2000);
};