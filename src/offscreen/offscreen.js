const MSG = {
  CONVERT_IMAGE: 'PC_CONVERT_IMAGE',
  GENERATE_ZIP: 'PC_GENERATE_ZIP'
};

const DECODE_TIMEOUT_MS = 15000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('image-decode-timeout')), ms))
  ]);
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

async function buildZipBlob(items, folderName) {
  const zip = new JSZip();
  const used = new Set();

  for (const item of items) {
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
      const blob = await convertImage(item.src, item.mime || 'image/png');
      zip.file(path, blob);
    } catch (e) {
      zip.file(`${path}.error.txt`, `Failed to convert: ${item.src}\n${String(e)}`);
    }
  }

  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === MSG.CONVERT_IMAGE) {
    convertImage(msg.src, msg.mime)
      .then((blob) => {
        sendResponse({
          ok: true,
          blobUrl: URL.createObjectURL(blob),
          ext: guessExtension(msg.mime),
          size: blob.size
        });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (msg?.type === MSG.GENERATE_ZIP) {
    buildZipBlob(msg.items || [], msg.folderName || '')
      .then((blob) => {
        sendResponse({
          ok: true,
          // El blob se resuelve dentro del offscreen: nunca se serializa
          // en base64, así que no choca con el límite de 64 MiB por mensaje.
          blobUrl: URL.createObjectURL(blob),
          filename: msg.zipName || 'pixelcatch.zip',
          size: blob.size
        });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  return false;
});