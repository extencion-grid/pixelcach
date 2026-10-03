import { extractDomain } from './config.js';

const UNSAFE = /[\\/:*?"<>|]+/g;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function stamp(date: Date, pattern: string): string {
  const d = date;
  const map: Record<string, string | number> = {
    YYYY: d.getFullYear(),
    MM: pad(d.getMonth() + 1),
    DD: pad(d.getDate()),
    HH: pad(d.getHours()),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds())
  };
  return pattern.replace(/YYYY|MM|DD|HH|mm|ss/g, (t) => String(map[t]));
}

function baseName(src: string): string {
  try {
    const url = new URL(src);
    // blob: y data: no tienen un nombre de archivo real: el segmento final
    // sería un UUID o prefijo base64, así que se cae al nombre genérico.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'image';
    const last = url.pathname.split('/').filter(Boolean).pop();
    if (!last) return 'image';
    return decodeURIComponent(last).replace(UNSAFE, '').replace(/\.[a-z0-9]+$/i, '') || 'image';
  } catch {
    return 'image';
  }
}

export interface NameItem {
  src: string;
  url?: string;
  name?: string;
  width?: number;
  height?: number;
}

export function buildName(item: NameItem, index: number, config?: { nameTemplate?: string }, now = new Date()): string {
  const template = config?.nameTemplate || '{domain}-{date}-{index}';
  const values: Record<string, string | number> = {
    name: item.name || baseName(item.src),
    domain: extractDomain(item.url || ''),
    date: stamp(now, 'YYYY-MM-DD'),
    time: stamp(now, 'HH-mm-ss'),
    index: pad(index + 1, 3),
    width: item.width || 0,
    height: item.height || 0
  };

  let out = template.replace(/\{(\w+)(?::(\w+))?\}/g, (_, key: string, sub?: string) => {
    if (key === 'datetime') return stamp(now, sub || 'YYYY-MM-DD_HH-mm-ss');
    if (key === 'time') return stamp(now, sub || 'HH-mm-ss');
    return String(values[key] ?? '');
  });

  out = out.replace(/\s+/g, ' ').trim().replace(UNSAFE, '-');
  return out || `image-${pad(index + 1, 3)}`;
}

export function buildFilename(item: NameItem, index: number, config?: { nameTemplate?: string }, ext = 'png', now = new Date()): string {
  const name = buildName(item, index, config, now);
  const dot = name.lastIndexOf('.');
  const clean = dot > 0 ? name.slice(0, dot) : name;
  return `${clean}.${ext}`;
}
