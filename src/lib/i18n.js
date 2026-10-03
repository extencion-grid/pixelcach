const messages = {
  es: {
    openGallery: 'Abrir galería',
    selectAll: 'Seleccionar todo',
    deselectAll: 'Deseleccionar todo',
    downloadFolder: 'Carpeta',
    downloadZip: 'ZIP',
    range: 'Rango',
    selectRange: 'Seleccionar rango',
    rescan: 'Re-escanear',
    exportLog: 'Exportar log',
    folderName: 'Nombre carpeta',
    loading: 'Cargando...',
    detected: '{n} imágenes detectadas',
    noneSelected: 'Selecciona al menos una imagen',
    packing: 'Empaquetando...',
    saving: 'Descargando {done} de {total}',
    done: 'Listo',
    failed: '{n} fallidas',
    filters: 'Filtros',
    search: 'Buscar por URL o nombre',
    minWidth: 'Ancho mín.',
    type: 'Tipo',
    all: 'Todos',
    clearList: 'Vaciar',
    unknown: 'Otros',
    saved: 'Guardado',
    save: 'Guardar',
    defaultFormat: 'Formato por defecto',
    minSize: 'Tamaño mínimo (px)',
    nameTemplate: 'Plantilla de nombre',
    concurrency: 'Descargas en paralelo',
    resourceScan: 'Detectar imágenes por resource timing',
    debugMode: 'Modo debug',
    settings: 'Ajustes',
    hint: 'Alt+Shift+B galería · Alt+Shift+S bajo cursor',
    backgroundScan: 'Buscar fondos (CSS)',
    partial: '{ok} descargadas, {failed} fallidas',
    storageFull: 'Almacenamiento lleno: reduce la galería'
  },
  en: {
    openGallery: 'Open gallery',
    selectAll: 'Select all',
    deselectAll: 'Deselect all',
    downloadFolder: 'Folder',
    downloadZip: 'ZIP',
    range: 'Range',
    selectRange: 'Select range',
    rescan: 'Rescan',
    exportLog: 'Export log',
    folderName: 'Folder name',
    loading: 'Loading...',
    detected: '{n} images detected',
    noneSelected: 'Select at least one image',
    packing: 'Packing...',
    saving: 'Downloading {done} of {total}',
    done: 'Done',
    failed: '{n} failed',
    filters: 'Filters',
    search: 'Search by URL or name',
    minWidth: 'Min width',
    type: 'Type',
    all: 'All',
    clearList: 'Clear',
    unknown: 'Other',
    saved: 'Saved',
    save: 'Save',
    defaultFormat: 'Default format',
    minSize: 'Minimum size (px)',
    nameTemplate: 'Name template',
    concurrency: 'Parallel downloads',
    resourceScan: 'Detect images via resource timing',
    debugMode: 'Debug mode',
    settings: 'Settings',
    hint: 'Alt+Shift+B gallery · Alt+Shift+S under cursor',
    backgroundScan: 'Scan CSS backgrounds',
    partial: '{ok} downloaded, {failed} failed',
    storageFull: 'Storage full: shorten the gallery'
  }
};

let current = 'es';

export function setLang(lang) {
  if (messages[lang]) current = lang;
  return current;
}

export async function resolveLang() {
  const stored = await chrome.storage.sync.get('lang');
  if (stored?.lang) return setLang(stored.lang);
  const ui = chrome.i18n?.getUILanguage?.() || navigator.language || 'es';
  return setLang(ui.startsWith('en') ? 'en' : 'es');
}

export function t(key, vars) {
  let out = messages[current]?.[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) out = out.replace(`{${k}}`, String(v));
  }
  return out;
}

export function installI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
}