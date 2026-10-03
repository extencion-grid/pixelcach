# PixelCatch

Extensión Chrome MV3 para detectar y guardar imágenes dinámicas con galería previa.

## Instalación
1. Abre `chrome://extensions`
2. Activa Modo desarrollador
3. Carga la carpeta `pixelcatch` con **Cargar descomprimida**

## Atajos
- `Alt+Shift+S` guardar imagen bajo el cursor
- `Alt+Shift+B` abrir galería

## Funciones
- Detección en vivo multi-frame: `MutationObserver` + `IntersectionObserver` (lazy) + `PerformanceObserver`
- Soporta `http(s)`, `data:` y `blob:` (los bytes de `blob:` se re-alojan en el offscreen)
- Imágenes `data:` muy grandes: se guardan solo metadatos + huella (FNV-1a) y se reconstruyen del DOM al descargar
- Menú contextual PNG/JPG/WebP/AVIF sobre cualquier imagen
- Galería en panel lateral: selección, filtros, render por lotes, descarga en carpeta o en ZIP con progreso
- Conversión de formato real en las dos rutas de descarga (carpeta y ZIP)
- Opciones: formato por defecto, tamaño mínimo, plantilla de nombre, concurrencia

Sin telemetría. Assets desde `/home/victor/dev/logos`.

## Desarrollo
- `npm run check` — rutas, sintaxis, scripts clásicos con sintaxis de módulo
- `npm test` — tests unitarios (`node --test`) de `state`, `filename`
- `test/harness/index.html` — página manual de humo (generadores, lazy, blob, iframe)

## Límites conocidos
- Canvas "tainted" por CORS no se puede leer (limitación del navegador)
- La galería vive en la sesión del navegador: al cerrar Chrome se pierde
- `Alt+Shift+S` itera frames; si el sitio bloquea el script el atajo no encuentra nada
