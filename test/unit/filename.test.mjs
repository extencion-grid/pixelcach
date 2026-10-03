import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildName, buildFilename } from '../../src/lib/filename.js';

const config = { nameTemplate: '{domain}-{date}-{index}' };
const now = new Date(2026, 0, 5, 9, 8, 7);
const item = { src: 'https://example.com/a/b/photo-1.jpg?size=large', url: 'https://example.com/gallery' };

test('extrae el nombre del pathname y descarta la query', () => {
  assert.equal(buildName(item, 0, config, now), 'example.com-2026-01-05-001');
});

test('respeta el índice con padding de tres dígitos', () => {
  assert.match(buildName(item, 41, config, now), /-042$/);
});

test('usa el dominio de la URL de la página, no el del CDN', () => {
  assert.ok(buildName(item, 0, config, now).startsWith('example.com-'));
});

test('soporta plantillas con domain, name, width y height', () => {
  const sized = { ...item, width: 200, height: 150 };
  const out = buildName(sized, 2, { nameTemplate: '{domain}/{name}_{width}x{height}' }, now);
  assert.equal(out, 'example.com-photo-1_200x150');
});

test('sustituye {datetime} con el patrón solicitado', () => {
  assert.match(buildName(item, 0, { nameTemplate: '{datetime}' }, now), /^2026-01-05/);
});

test('sustituye {time} con el patrón solicitado', () => {
  assert.match(buildName(item, 0, { nameTemplate: '{time}' }, now), /^09-08-07$/);
});

test('elimina separadores de ruta y caracteres prohibidos', () => {
  const risky = { src: 'https://cdn.test/a/b/c*d?e.png', url: 'https://host.test' };
  const out = buildName(risky, 0, { nameTemplate: '{domain}/{name}' }, now);
  assert.doesNotMatch(out, /[\\/:*?"<>|]/);
});

test('colapsa espacios repetidos', () => {
  const out = buildName({ src: 'https://a.test/my  photo.png', url: 'https://a.test' }, 0, { nameTemplate: '{name}' }, now);
  assert.doesNotMatch(out, /\s{2,}/);
});

test('la extensión final es la del formato solicitado', () => {
  assert.ok(buildFilename(item, 0, config, 'webp', now).endsWith('.webp'));
  assert.ok(buildFilename(item, 0, config, 'avif', now).endsWith('.avif'));
});

test('no duplica la extensión si la plantilla ya trae una', () => {
  const out = buildFilename(item, 0, { nameTemplate: '{name}.jpg' }, 'png', now);
  assert.equal(out.match(/\./g).length, 1);
  assert.ok(out.endsWith('.png'));
});

test('cae a un nombre por defecto cuando falta el nombre', () => {
  assert.equal(buildName({ src: 'blob:chrome-extension://abc/1234', url: '' }, 6, { nameTemplate: '{name}' }, now), 'image');
});

test('los tokens desconocidos se sustituyen por cadena vacía', () => {
  assert.equal(buildName(item, 0, { nameTemplate: 'x{nope}y' }, now), 'xy');
});

test('una data: URL cae al nombre generico sin reventar', () => {
  const out = buildName({ src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==', url: 'https://a.test' }, 0, { nameTemplate: '{name}' }, now);
  assert.equal(out, 'image');
});

test('una blob: URL cae al nombre generico', () => {
  const out = buildName({ src: 'blob:https://a.test/9f1d-uuid', url: 'https://a.test' }, 0, { nameTemplate: '{name}' }, now);
  assert.equal(out, 'image');
});

test('la plantilla {width}x{height} separada funciona como token doble', () => {
  const sized = { src: 'https://a.test/q.png', url: 'https://a.test', width: 800, height: 600 };
  assert.equal(buildName(sized, 0, { nameTemplate: '{width}x{height}' }, now), '800x600');
});

test('item truncado con data: no deja ningun prefijo base64 en el nombre', () => {
  const truncated = { src: 'data:image/png;base64,'.padEnd(60, 'A'), url: 'https://a.test', truncated: true, hash: 'abc' };
  const out = buildFilename(truncated, 0, { nameTemplate: '{name}-{index}' }, 'jpg', now);
  assert.doesNotMatch(out, /AAAA/);
  assert.ok(out.endsWith('.jpg'));
});
