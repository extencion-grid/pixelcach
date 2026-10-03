import { MSG } from '../lib/messages.js';
import { resolveLang, t, installI18n } from '../lib/i18n.js';

const els = {
  open: document.getElementById('open'),
  hint: document.getElementById('hint')
};

await resolveLang();
installI18n(document);

const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];

if (!tab?.id) {
  els.open.disabled = true;
} else {
  els.open.onclick = async () => {
    await chrome.runtime.sendMessage({ type: MSG.OPEN_PANEL, tabId: tab.id }).catch(() => {});
    window.close();
  };
}

els.hint.textContent = t('hint');