import { loadConfig, saveConfig } from '../lib/config.js';
import { resolveLang, t, installI18n } from '../lib/i18n.js';
const FIELDS = {
    defaultFormat: (el, v) => (el.value = String(v)),
    minSize: (el, v) => (el.value = String(v)),
    nameTemplate: (el, v) => (el.value = String(v)),
    detectBackgrounds: (el, v) => (el.checked = Boolean(v)),
    detectResources: (el, v) => (el.checked = Boolean(v)),
    downloadConcurrency: (el, v) => (el.value = String(v)),
    debugEnabled: (el, v) => (el.checked = Boolean(v))
};
const el = {};
for (const id of Object.keys(FIELDS)) {
    const node = document.getElementById(id);
    if (node)
        el[id] = node;
}
const status = document.getElementById('status');
const save = document.getElementById('save');
const shortcuts = document.getElementById('shortcuts');
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
    if (node)
        apply(node, config[id]);
}
save.onclick = async () => {
    const patch = {};
    for (const id of Object.keys(FIELDS)) {
        const node = el[id];
        if (!node)
            continue;
        if (node.type === 'checkbox')
            patch[id] = node.checked;
        else if (node.type === 'number')
            patch[id] = Number(node.value);
        else
            patch[id] = node.value;
    }
    const next = await saveConfig(patch);
    for (const [id, apply] of Object.entries(FIELDS)) {
        const node = el[id];
        if (node)
            apply(node, next[id]);
    }
    status.textContent = t('saved');
    setTimeout(() => (status.textContent = ''), 2000);
};
