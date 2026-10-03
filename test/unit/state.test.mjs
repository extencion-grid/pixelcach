import { test } from 'node:test';
import assert from 'node:assert/strict';

const SESSION = { pcGallery: {}, pcDebugLog: [] };
let throwOnSet = null;

globalThis.chrome = {
  storage: {
    session: {
      async get(keys) {
        const out = {};
        for (const k of keys) if (k in SESSION) out[k] = structuredClone(SESSION[k]);
        return out;
      },
      async set(patch) {
        if (throwOnSet) {
          const e = throwOnSet;
          throwOnSet = null;
          throw e;
        }
        for (const [k, v] of Object.entries(patch)) SESSION[k] = structuredClone(v);
      }
    }
  }
};

// Módulo nuevo por test: el estado interno de state.js es cacheado a nivel de
// instancia, igual que lo estaría dentro de un service worker real.
let n = 0;
async function freshState() {
  for (const k of Object.keys(SESSION)) delete SESSION[k];
  SESSION.pcGallery = {};
  SESSION.pcDebugLog = [];
  throwOnSet = null;
  return import(`../../src/lib/state.js?fresh=${n++}`);
}

const dataUrl = (body) => `data:image/png;base64,${body}`;

test('addItems deduplica por src dentro del mismo tab', async () => {
  const state = await freshState();
  const a = await state.addItems(1, [{ src: 'https://a.test/1.png', width: 200, height: 200 }]);
  const b = await state.addItems(1, [{ src: 'https://a.test/1.png', width: 200, height: 200 }]);
  assert.equal(a.added.length, 1);
  assert.equal(b.added.length, 0);
  assert.equal(b.total, 1);
});

test('aisla galerías de pestañas distintas', async () => {
  const state = await freshState();
  await state.addItems(1, [{ src: 'https://a.test/1.png' }]);
  await state.addItems(2, [{ src: 'https://b.test/1.png' }]);
  assert.equal((await state.getGallery(1))[0].src, 'https://a.test/1.png');
  assert.equal((await state.getGallery(2))[0].src, 'https://b.test/1.png');
});

test('clearTab vacía solo la pestaña indicada', async () => {
  const state = await freshState();
  await state.addItems(1, [{ src: 'https://a.test/1.png' }]);
  await state.addItems(2, [{ src: 'https://b.test/1.png' }]);
  await state.clearTab(1);
  assert.equal((await state.getGallery(1)).length, 0);
  assert.equal((await state.getGallery(2)).length, 1);
});

test('dropTab elimina la galería persistida', async () => {
  const state = await freshState();
  await state.addItems(3, [{ src: 'https://a.test/1.png' }]);
  await state.dropTab(3);
  assert.equal((await state.getGallery(3)).length, 0);
});

test('getGallery devuelve vacío para una pestaña desconocida', async () => {
  const state = await freshState();
  assert.deepEqual(await state.getGallery(999), []);
});

test('normaliza campos ausentes y añade type por defecto', async () => {
  const state = await freshState();
  const { added } = await state.addItems(7, [{ src: 'https://a.test/x.png' }]);
  assert.equal(added[0].type, 'img');
  assert.equal(added[0].width, 0);
  assert.equal(added[0].height, 0);
  assert.equal(added[0].truncated, false);
});

test('descarta entradas sin src', async () => {
  const state = await freshState();
  const { added, total } = await state.addItems(1, [{ width: 10 }, null, { src: '' }]);
  assert.equal(added.length, 0);
  assert.equal(total, 0);
});

test('conserva metadatos de tipo original y fondo', async () => {
  const state = await freshState();
  const { added } = await state.addItems(1, [
    { src: 'https://a.test/o.png', type: 'original' },
    { src: 'https://a.test/b.png', type: 'bg' }
  ]);
  assert.deepEqual(added.map((i) => i.type), ['original', 'bg']);
});

test('rehidrata la galería desde storage.session tras reiniciar el worker', async () => {
  const first = await freshState();
  await first.addItems(11, [{ src: 'https://a.test/keep.png', width: 300, height: 300 }]);
  await first.flushNow();

  // Nueva instancia del módulo, mismo backing store: simula el worker
  // reviving después de que Chrome lo descargara.
  const revived = await import(`../../src/lib/state.js?fresh=${n++}`);
  const items = await revived.getGallery(11);
  assert.equal(items.length, 1);
  assert.equal(items[0].src, 'https://a.test/keep.png');
});

test('el log de debug está acotado a 2000 entradas', async () => {
  const state = await freshState();
  await state.appendDebug(Array.from({ length: 2100 }, (_, i) => ({ t: i, msg: `m${i}` })));
  const log = await state.readDebug();
  assert.equal(log.length, 2000);
  assert.equal(log[0].msg, 'm100');
});

test('appendDebug ignora entradas vacías', async () => {
  const state = await freshState();
  await state.appendDebug([]);
  assert.equal((await state.readDebug()).length, 0);
});

test('las data: grandes se truncan y se puede volver a reconstruir por huella', async () => {
  const state = await freshState();
  const big = dataUrl('a'.repeat(10_000));
  const { added } = await state.addItems(1, [
    { src: big, width: 800, height: 600, hash: 'deadbeef', dataLength: big.length, type: 'img' }
  ]);
  assert.equal(added[0].truncated, true);
  assert.ok(added[0].src.length < big.length);
  assert.equal(added[0].hash, 'deadbeef');
  assert.equal(added[0].dataLength, big.length);
});

test('despues de truncar, la clave de dedupe es la huella, no el fenómeno src', async () => {
  const state = await freshState();
  const big = dataUrl('b'.repeat(10_000));
  await state.addItems(1, [{ src: big, hash: 'abc', dataLength: big.length }]);
  const second = await state.addItems(1, [{ src: big, hash: 'abc', dataLength: big.length }]);
  assert.equal(second.added.length, 0);
  assert.equal(second.total, 1);
});

test('dos data: distintas no colisionan por hash distinto', async () => {
  const state = await freshState();
  const a = dataUrl('x'.repeat(10_000));
  const b = dataUrl('y'.repeat(10_000));
  await state.addItems(1, [{ src: a, hash: 'h1', dataLength: a.length }]);
  const r = await state.addItems(1, [{ src: b, hash: 'h2', dataLength: b.length }]);
  assert.equal(r.added.length, 1);
});

test('blob: se deduplica por src y dimensiones', async () => {
  const state = await freshState();
  const src = 'blob:https://a.test/uuid-1';
  await state.addItems(1, [{ src, width: 200, height: 100 }]);
  const dup = await state.addItems(1, [{ src, width: 200, height: 100 }]);
  assert.equal(dup.added.length, 0);
  const other = await state.addItems(1, [{ src: src + '-2', width: 200, height: 100 }]);
  assert.equal(other.added.length, 1);
});

test('removeItem borra por keyOf de la propia galería', async () => {
  const state = await freshState();
  const { added } = await state.addItems(5, [{ src: 'https://a.test/z.png', width: 10, height: 10 }]);
  const key = state.keyOf(added[0]);
  const res = await state.removeItem(5, key);
  assert.equal(res.removed, true);
  assert.equal((await state.getGallery(5)).length, 0);
});

test('cuota llena llama al handler de error en vez de perder datos en silencio', async () => {
  const state = await freshState();
  let hits = 0;
  state.onStorageError(() => hits++);
  throwOnSet = new Error('QUOTA_BYTES');
  await state.addItems(6, [{ src: 'https://a.test/q.png' }]);
  await state.flushNow();
  assert.equal(hits, 1);
});

test('addItems asigna el frameId del sender al item', async () => {
  const state = await freshState();
  const { added } = await state.addItems(8, [{ src: 'https://a.test/f.png' }], 12);
  assert.equal(added[0].frameId, 12);
});
