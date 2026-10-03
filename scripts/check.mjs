import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

const files = await walk(join(root, 'src'));

const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));

const referenced = new Set([
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_page,
  manifest.side_panel.default_path,
  ...manifest.content_scripts.flatMap((c) => c.js)
]);

for (const rel of referenced) {
  if (!existsSync(join(root, rel))) failures.push(`manifest referencia archivo inexistente: ${rel}`);
}

const parsed = await Promise.all(
  files
    .filter((f) => f.endsWith('.js') && !f.endsWith('jszip.min.js'))
    .map(async (f) => {
      const src = await readFile(f, 'utf8');
      try {
        execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
        return { f, src, imports: [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]) };
      } catch (e) {
        failures.push(`error de sintaxis: ${f.replace(root + '/', '')}\n${e.stderr?.toString() || e}`);
        return null;
      }
    })
);

for (const { f, imports } of parsed.filter(Boolean)) {
  for (const spec of imports) {
    if (!spec.startsWith('.')) continue;
    const target = resolve(dirname(f), spec);
    if (!existsSync(target)) failures.push(`import roto en ${f.replace(root + '/', '')}: ${spec}`);
  }
}

const htmlFiles = files.filter((f) => f.endsWith('.html'));
for (const html of htmlFiles) {
  const src = await readFile(html, 'utf8');
  for (const m of src.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const ref = m[1];
    if (/^(https?:|data:|#|\/\/)/.test(ref)) continue;
    const target = resolve(dirname(html), ref.split('?')[0]);
    if (!existsSync(target)) failures.push(`referencia rota en ${html.replace(root + '/', '')}: ${ref}`);
  }

  // Un <script> que usa import/export/await de nivel superior sin
  // type="module" muere con SyntaxError en pleno arranque (bug del popup 0.1).
  for (const m of src.matchAll(/<script(?![^>]*type="module")[^>]*src="([^"]+\.js)"[^>]*>/g)) {
    const target = resolve(dirname(html), m[1]);
    if (!existsSync(target)) continue;
    const js = await readFile(target, 'utf8');
    if (/^\s*(import|export)\s/m.test(js) || /^(?!.*=>).*await\s/m.test(js.replace(/\/\/[^\n]*/g, ''))) {
      failures.push(`script clásico con sintaxis de módulo (falta type="module") en ${html.replace(root + '/', '')}: ${m[1]}`);
    }
  }
}

for (const dir of ['icons', 'src/assets/styles']) {
  const full = join(root, dir);
  if (!existsSync(full)) failures.push(`directorio ausente: ${dir}`);
}

if (failures.length) {
  console.error('FALLOS:\n' + failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}

console.log(`OK: ${files.length} archivos, ${referenced.size} referencias de manifest, 0 errores`);
