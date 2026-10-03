import { extractDomain } from './config.js';

const UNSAFE = /[\\/:*?"<>|]+/g;

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

function stamp(date, pattern) {
  const d = date;
  const map = {
    YYYY: d.getFullYear(),
    MM: pad(d.getMonth() + 1),
    DD: pad(d.getDate()),
    HH: pad(d.getHours()),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds())
  };
  return pattern.replace(/YYYY|MM|DD|HH|mm|ss/g, (t) => String(map[t]));
}

function baseName(src) {
  try {
    const url = new URL(src);
    // blob: y data: no tienen un nombre de archivo real: el segment final
    // sería un UUID, así que se cae al nombre genérico.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'image';
    const last = url.pathname.split('/').filter(Boolean).pop();
    if (!last) return 'image';
    return decodeURIComponent(last).replace(UNSAFE, '').replace(/\.[a-z0-9]+$/i, '') || 'image';
  } catch {
    return 'image';
  }
}

export function buildName(item, index, config, now = new Date()) {
  const template = config?.nameTemplate || '{domain}-{date}-{index}';
  const values = {
    name: item.name || baseName(item.src),
    domain: extractDomain(item.url || ''),
    date: stamp(now, 'YYYY-MM-DD'),
    time: stamp(now, 'HH-mm-ss'),
    index: pad(index + 1, 3),
    width: item.width || 0,
    height: item.height || 0
  };

  let out = template.replace(/\{(\w+)(?::(\w+))?\}/g, (_, key, sub) => {
    if (key === 'datetime') return stamp(now, sub || 'YYYY-MM-DD_HH-mm-ss');
    if (key === 'time') return stamp(now, sub || 'HH-mm-ss');
    return values[key] ?? '';
  });

  out = out.replace(/\s+/g, ' ').trim().replace(UNSAFE, '-');
  return out || `image-${pad(index + 1, 3)}`;
}

export function buildFilename(item, index, config, ext = 'png', now = new Date()) {
  const name = buildName(item, index, config, now);
  const dot = name.lastIndexOf('.');
  const clean = dot > 0 ? name.slice(0, dot) : name;
  return `${clean}.${ext}`;
}