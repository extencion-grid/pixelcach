# PixelCatch

Extensión Chrome MV3 que escanea las imágenes de la página cargada (sin límite por extensión) y las muestra en una galería flotante para guardarlas.

## Instalación
1. Abre `chrome://extensions`
2. Activa Modo desarrollador
3. Carga la carpeta `pixelcatch` con **Cargar descomprimida**

## Uso
- Clic en el icono de la barra → galería flotante con todas las imágenes detectadas
- `Alt+Shift+B` → abre la misma galería (atajo)
- `Alt+Shift+S` → guarda la imagen que esté bajo el cursor
- Menú contextual sobre una imagen → "Guardar imagen como…" (PNG/JPG/WebP/AVIF)

## Qué detecta
- `<img>` en el DOM (también lazy, `srcset`/`<picture>`, enlaces a original)
- `<canvas>` dibujados
- `background-image` en CSS (botón "Fondos")
- Imágenes nuevas insertadas después de la carga (MutationObserver, multi-frame)
- Cualquier URL: `http(s)`, `data:`, `blob:` — sin filtro por extensión
- Las `data:` muy grandes se guardan como metadato + huella y se reconstruyen del DOM al descargar

## Descarga
- Carpeta propia dentro de Descargas o raíz de Descargas
- ZIP con progreso y reporte de fallos real
- El formato elegido en Ajustes se respeta también en la descarga por carpeta

Sin telemetría. Assets desde `/home/victor/dev/logos`.

## Desarrollo
- `npm run check` — rutas, sintaxis, scripts clásicos con sintaxis de módulo
- `npm test` — tests unitarios (`node --test`) de `state`, `filename`
- `test/harness/index.html` — página manual de humo (lazy, blob, inyección tardía)

## Límites conocidos
- Canvas "tainted" por CORS no se puede leer (limitación del navegador)
- La galería vive en la sesión del navegador: al cerrar Chrome se pierde
- El popup se cierra al perder el foco; las descargas ya lanzadas continúan en segundo plano
