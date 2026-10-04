import { extractDomain } from './config.js';
// Saneo total para Windows/macOS/Linux:
//  - prohibidos: \ / : * ? " < > |  y controles \0-\x1f \x7f
//  - sin espacios ni puntos al final (Windows los rechaza)
//  - nombres de dispositivo DOS reservados (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
//  - sin punto inicial (oculto en POSIX), sin '..' (traversal)
//  - longitud: base ≤ 100 glifos (el límite real es 255 *bytes* de nombre)
// Prohibidos en nombres de fichero: \\ / : * ? " < > | y controles.
// (Construido con charCodes para no tener nunca un carácter literal en la fuente.)
const BANNED = new Set([0x5c, 0x2f, 0x3a, 0x2a, 0x3f, 0x22, 0x3c, 0x3e, 0x7c, 0x7f, ...Array.from({ length: 32 }, (_, i) => i)]);
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_BASE = 100;
function stripBanned(s) {
    let out = '';
    for (const ch of s) {
        out += BANNED.has(ch.codePointAt(0) || 0) ? '-' : ch;
    }
    return out;
}
export function sanitizeFilename(name, fallback = 'image') {
    let out = stripBanned(name);
    out = out.replace(/^\.+$/, '');
    out = out.replace(/\.+$/, '').replace(/\s+$/, '');
    out = out.replace(/\s+/g, ' ').replace(/-+/g, '-').trim();
    out = out.replace(/^[-. ]+|[-. ]+$/g, '');
    if (!out)
        out = fallback;
    if (RESERVED.test(out))
        out = `_${out}`;
    if (out.length > MAX_BASE)
        out = out.slice(0, MAX_BASE).replace(/[.\s-]+$/, '');
    return out || fallback;
}
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
        // blob: y data: no tienen un nombre de archivo real: el segmento final
        // sería un UUID o prefijo base64, así que se cae al nombre genérico.
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
            return 'image';
        const last = url.pathname.split('/').filter(Boolean).pop();
        if (!last)
            return 'image';
        return decodeURIComponent(last).replace(/\.[a-z0-9]+$/i, '') || 'image';
    }
    catch {
        return 'image';
    }
}
export function buildName(item, index, config, now = new Date()) {
    const template = config?.nameTemplate || '{domain}-{date}-{index}';
    const values = {
        name: sanitizeFilename(item.name || baseName(item.src)),
        domain: extractDomain(item.url || ''),
        date: stamp(now, 'YYYY-MM-DD'),
        time: stamp(now, 'HH-mm-ss'),
        index: pad(index + 1, 3),
        width: item.width || 0,
        height: item.height || 0
    };
    let out = template.replace(/\{(\w+)(?::(\w+))?\}/g, (_, key, sub) => {
        if (key === 'datetime')
            return stamp(now, sub || 'YYYY-MM-DD_HH-mm-ss');
        if (key === 'time')
            return stamp(now, sub || 'HH-mm-ss');
        return String(values[key] ?? '');
    });
    out = stripBanned(out.replace(/\s+/g, ' ').trim()).replace(/[.\s-]+$/, '');
    if (RESERVED.test(out))
        out = `_${out}`;
    if (out.length > MAX_BASE)
        out = out.slice(0, MAX_BASE).replace(/[.\s-]+$/, '');
    return out || `image-${pad(index + 1, 3)}`;
}
export function buildFilename(item, index, config, ext = 'png', now = new Date()) {
    const name = buildName(item, index, config, now);
    const dot = name.lastIndexOf('.');
    const clean = dot > 0 ? name.slice(0, dot) : name;
    const safeExt = sanitizeFilename(ext.replace(/^\.+/, ''), 'png').toLowerCase();
    return `${clean}.${safeExt}`;
}
// Sanea una ruta de carpeta (segmento a segmento) para chrome.downloads/ZIP:
// se descartan '.' y '..' (traversal) y los segmentos vacíos.
export function sanitizeFolderPath(input) {
    return input
        .split(/[\\/]+/)
        .map((seg) => seg.trim())
        .filter((seg) => seg && seg !== '.' && seg !== '..')
        .map((seg) => sanitizeFilename(seg, 'folder'))
        .join('/');
}
