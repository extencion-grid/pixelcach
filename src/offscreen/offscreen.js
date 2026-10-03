// Copia manual de src/lib/messages.js (el offscreen carga como módulo pero
// compartir el módulo de mensajes complica el import relativo al empaquetar;
// los literales aquí deben mantenerse sincronizados).
const MSG = {
  CONVERT_IMAGE: 'PC_CONVERT_IMAGE',
  BUFFER_TO_BLOB: 'PC_BUFFER_TO_BLOB',
  GENERATE_ZIP: 'PC_GENERATE_ZIP',
  ZIP_PROGRESS: 'PC_ZIP_PROGRESS'
};

const DECODE_TIMEOUT_MS = 15000;
const REVOKE_MS = 60000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('image-decode-timeout')), ms))
  ]);
}

// Las blob URLs mueren al cerrar el documento y nunca se revocaban: memoria
// retenida durante todo el idle del offscreen. Se revocan pasado un margen
// que da tiempo a que chrome.downloads haya leído el objeto.
function trackedObjectUrl(blob) {
  const url = URL.createObjectURL(blob);
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_MS);
  return url;
}

async function drawAndExport(source, width, height, mime) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (mime === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(source, 0, 0);
  return canvas.convertToBlob({ type: mime });
}

async function convertImage(src, mime) {
  // Formato "original" (mime null): paso en crudo, sin tocar píxeles.
  if (!mime) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`http-${res.status}`);
    return res.blob();
  }
  // Camino 1: cargar la imagen en este contexto sin forzar CORS.
  // Funciona para mismo-origen, data: y blob: de esta origen.
  try {
    const img = new Image();
    img.src = src;
    await withTimeout(img.decode(), DECODE_TIMEOUT_MS);
    const blob = await drawAndExport(img, img.naturalWidth, img.naturalHeight, mime);
    return blob;
  } catch (primaryError) {
    // Camino 2: traer los bytes con fetch() y decodificar como bitmap.
    // No depende de cómo se cargó el <img>, así que evita tainted canvas.
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`http-${res.status}`);
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      const out = await drawAndExport(bitmap, bitmap.width, bitmap.height, mime);
      bitmap.close?.();
      return out;
    } catch (secondaryError) {
      throw new Error(`convert-failed: ${primaryError} / ${secondaryError}`);
    }
  }
}

function guessExtension(mime) {
  return { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/avif': 'avif', 'image/png': 'png' }[mime] || 'png';
}

async function buildZipBlob(items, folderName, tabId) {
  const zip = new JSZip();
  const used = new Set();
  const failed = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const requested = item.filename || 'image.png';
    let name = requested;
    if (used.has(name)) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot + 1) : 'png';
      let n = 2;
      while (used.has(`${stem}-${n}.${ext}`)) n++;
      name = `${stem}-${n}.${ext}`;
    }
    used.add(name);

    const path = folderName ? `${folderName}/${name}` : name;
    try {
      // mime undefined → png por compat; mime null explícito → raw "original".
      const blob = await convertImage(item.src, item.mime === undefined ? 'image/png' : item.mime);
      zip.file(path, blob);
    } catch (e) {
      const err = `${path}.error.txt`;
      zip.file(err, `Failed to convert: ${item.src}\n${String(e)}`);
      failed.push({ filename: name, error: String(e) });
    }

    if (tabId != null) {
      chrome.runtime
        .sendMessage({
          type: 'PC_STATE_PUSH',
          tabId,
          progress: { done: i + 1, total: items.length, failed: failed.length, phase: 'pack' }
        })
        .catch(() => {});
    }
  }

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { blob, failed };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === MSG.CONVERT_IMAGE) {
    convertImage(msg.src, msg.mime)
      .then((blob) => {
        sendResponse({
          ok: true,
          blobUrl: trackedObjectUrl(blob),
          ext: guessExtension(msg.mime),
          size: blob.size
        });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (msg?.type === MSG.BUFFER_TO_BLOB) {
    // Recibe bytes del renderer (p. ej. un blob: de la página, que solo el
    // renderer puede leer) y los re-aloja aquí. Con mime además recodifica.
    (async () => {
      const source = new Blob([msg.buffer]);
      if (!msg.mime) return { blob: source, size: source.size };
      const bitmap = await createImageBitmap(source);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      if (msg.mime === 'image/jpeg') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, bitmap.width, bitmap.height);
      }
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close?.();
      const blob = await canvas.convertToBlob({ type: msg.mime });
      return { blob, size: blob.size };
    })()
      .then(({ blob, size }) => sendResponse({ ok: true, blobUrl: trackedObjectUrl(blob), size }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (msg?.type === MSG.GENERATE_ZIP) {
    buildZipBlob(msg.items || [], msg.folderName || '', msg.tabId ?? null)
      .then(({ blob, failed }) => {
        sendResponse({
          ok: true,
          blobUrl: trackedObjectUrl(blob),
          filename: msg.zipName || 'pixelcatch.zip',
          size: blob.size,
          failed
        });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  return false;
});
