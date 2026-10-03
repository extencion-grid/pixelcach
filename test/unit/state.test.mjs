import { test } from 'node:test';
import assert from 'node:assert/strict';

const SESSION = { pcGallery: {}, pcDebugLog: [] };

globalThis.chrome = {
  storage: {
    session: {
      async get(keys) {
        const out = {};
        for (const k of keys) if (k in SESSION) out[k] = structuredClone(SESSION[k]);
        return out;
      },
      async set(patch) {
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
  return import(`../../src/lib/state.js?fresh=${n++}`);
}

test('addItems deduplica por src dentro del mismo tab', async () => {
  const state = await freshState();
  const a = await state.addItems(1, [{ src: 'https://a.test/1.png', width: 200, height: 200 }]);
  const b = await state.addItems(1, [{ src: 'https://a.test/1.png', width: 200, height: 200 }]);
  assert.equal(a.changed, true);
  assert.equal(b.changed, false);
  assert.equal(b.list.length, 1);
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
  const { list } = await state.addItems(7, [{ src: 'https://a.test/x.png' }]);
  assert.equal(list[0].type, 'img');
  assert.equal(list[0].width, 0);
  assert.equal(list[0].height, 0);
});

test('descarta entradas sin src', async () => {
  const state = await freshState();
  const { changed, list } = await state.addItems(1, [{ width: 10 }, null, { src: '' }]);
  assert.equal(changed, false);
  assert.equal(list.length, 0);
});

test('conserva metadatos de tipo original y fondo', async () => {
  const state = await freshState();
  const { list } = await state.addItems(1, [
    { src: 'https://a.test/o.png', type: 'original' },
    { src: 'https://a.test/b.png', type: 'bg' }
  ]);
  assert.deepEqual(list.map((i) => i.type), ['original', 'bg']);
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
