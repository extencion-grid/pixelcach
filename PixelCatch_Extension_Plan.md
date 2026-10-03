# PixelCatch — Plan de Extensión de Chrome

> **Versión:** 1.0
> **Qué es:** combina lo que hacen bien dos proyectos distintos que investigué, más dos mejoras tuyas (galería previa y elegir entre ZIP o carpeta).

---

## 0. Primero, una aclaración importante: son DOS extensiones distintas

Investigué los tres enlaces y descubrí que **no describen el mismo proyecto**:

| Enlace | Qué es realmente |
|---|---|
| `github.com/peterbenoit/SaveAsExtension` y `peterbenoit.com/extensions/save-image-as` | Una extensión simple: clic derecho sobre **una** imagen → menú con PNG/JPG/WebP/AVIF/GIF/PDF → la convierte con `<canvas>` y la descarga. **No tiene** ZIP, ni atajos de teclado, ni botón de barra que cuente imágenes, ni galería. Es un fork del "Save Image as PNG" original de Rob Wu, con más formatos. |
| `chromewebstore.google.com/.../save-image-as-png/piigjafeabajlmjkcmcemimcoaekbjmh` ("Save Image As PNG", de "Music Find") | **Esta es la que de verdad tiene** las funciones que me describiste: guardar todo en ZIP, atajos `Alt+Shift+S` / `Alt+Shift+B`, popup con contador, modo silencioso, plantillas de nombre de archivo. |

**Dato que debes conocer antes de copiar su enfoque:** esa segunda extensión (Music Find) declara en su propia ficha de la Chrome Web Store que recopila **ubicación, actividad del usuario y contenido del sitio web**. No sabemos para qué lo usa exactamente, pero no es "todo local" como asegura la primera. Mi recomendación, y lo que refleja este plan, es construir **tu versión con las mismas funciones pero cero recolección de datos** — igual que la filosofía de peterbenoit ("no data collection, no external conversion service"), que si es verificable porque es código abierto.

---

## 1. Cómo logran "escanear sin recargar" (la pieza que te interesa copiar)

Ninguna de las dos publica el código del escáneo en vivo con detalle público (la de Music Find es de código cerrado), pero el mecanismo solo puede ser uno, porque es la única forma correcta de hacerlo en una extensión de Chrome moderna:

1. Un **content script** se inyecta en la página en cuanto carga (`document_idle`), sin esperar ninguna acción del usuario.
2. Hace un primer barrido de `document.images` (todas las `<img>` ya presentes).
3. Después del barrido inicial, monta un **`MutationObserver`** sobre `document.documentElement` observando `childList`, `subtree` y cambios de atributo `src`/`style`. Cualquier imagen que el sitio inserte después — por JavaScript, por un carrusel, por un generador de IA que pinta resultados nuevos — dispara el observer y se detecta al instante, **sin que la pestaña se recargue nunca**.
4. El content script mantiene un registro en memoria (actualizado en vivo) y lo comunica al fondo de la extensión (`service worker`) por mensajes, para que el icono de la barra muestre el contador y el panel/popup pueda pintar la galería cuando se abra.

Esto es exactamente el mismo principio que ya diseñamos en el plan anterior (GrabAll) para resolver Perchance — aquí se reutiliza como motor base y se le añaden las piezas que te interesan de "Save Image As PNG": clic derecho, atajos, conversión de formato, y ahora también ZIP o carpeta a elección.

---

## 2. Qué se copia de cada referencia y qué se mejora

| Función | De cuál referencia | Mejora que pides tú |
|---|---|---|
| Menú contextual "Guardar imagen como PNG" sobre imágenes normales, canvas, fondos CSS y elementos tapados por una capa transparente | Music Find (comportamiento descrito) + técnica de conversión de peterbenoit | — |
| Atajo para guardar la imagen bajo el cursor (`Alt+Shift+S`) | Music Find | — |
| Atajo para guardar todas las imágenes de la página (`Alt+Shift+B`) | Music Find | **En vez de ir directo al ZIP, primero abre la galería de revisión** |
| Botón de la barra que cuenta cuántas imágenes hay | Music Find | — |
| Conversión local con `<canvas>`, con respaldo por `fetch` para imágenes de otro origen | peterbenoit | — |
| Plantillas de nombre de archivo con tokens | Music Find | — |
| **Galería previa con casillas de selección antes de descargar** | — (no la tiene ninguna referencia) | **Tu idea**: ver todo lo detectado y elegir qué te interesa, no todo o nada |
| **Elegir ZIP *o* carpeta nombrada** | — (Music Find solo hace ZIP) | **Tu idea**: por un lado ZIP de un clic, por otro una carpeta con nombre propio dentro de Descargas, con los archivos sueltos |
| Cero recolección de datos | peterbenoit | Se mantiene como principio de diseño, a diferencia de Music Find |

---

## 3. Requisitos funcionales

### 3.1 Detección en vivo
| ID | Requisito |
|---|---|
| RF-01 | Detectar `<img>` (incluidas `data:`/`blob:`), `<canvas>`, y elementos con `background-image` en CSS |
| RF-02 | Detectar imágenes nuevas insertadas después de la carga, sin recargar la página (MutationObserver persistente) |
| RF-03 | Detectar la imagen real bajo el cursor **aunque esté tapada** por una capa transparente encima (usar `document.elementsFromPoint(x, y)`, que devuelve toda la pila de elementos en ese punto, no solo el de arriba, y quedarse con el primero que sea `<img>`/`<canvas>`/tenga `background-image`) |
| RF-04 | Deduplicar por `src` (o por huella de tamaño+origen para `blob:`) |
| RF-05 | Funcionar también dentro de iframes (`all_frames: true`), heredado del diseño de GrabAll, por si el sitio objetivo también genera contenido en iframes |

### 3.2 Guardado individual (menú contextual + atajo de cursor)
| ID | Requisito |
|---|---|
| RF-10 | Entrada de menú contextual "Guardar imagen como…" con submenú de formato (PNG, JPG, WebP, AVIF si el navegador lo soporta, PDF de una página) |
| RF-11 | Atajo de teclado configurable (por defecto `Alt+Shift+S`): guarda la imagen que esté bajo el cursor en ese instante, en el formato por defecto que el usuario haya fijado en Ajustes |
| RF-12 | Conversión local: dibujar la imagen en un `<canvas>` oculto y exportar con `toBlob(mime)`; si la imagen es de otro origen y el canvas queda "contaminado", recurrir a `fetch()` de los bytes + `createImageBitmap()` (esto sí evita el problema de contaminación, porque la restricción de "tainted canvas" depende de cómo se cargó la imagen como `<img>`, no de los píxeles en sí) |
| RF-13 | Si ambos caminos fallan (imagen protegida por CORS estricto sin ninguna vía de descarga), avisar con un mensaje claro en vez de fallar en silencio |

### 3.3 Guardado masivo (atajo + barra + galería)
| ID | Requisito |
|---|---|
| RF-20 | Icono de la extensión con **badge numérico**: cuántas imágenes hay detectadas en la pestaña activa ahora mismo |
| RF-21 | Atajo de teclado (por defecto `Alt+Shift+B`): abre la **galería de revisión** con todo lo detectado hasta ese momento, en vez de descargar directo (tu mejora) |
| RF-22 | Clic en el icono de la barra: abre el mismo panel de galería (consistente con el atajo) |
| RF-23 | Galería: cuadrícula de miniaturas, cada una con casilla de selección, tamaño en px, formato original; "Seleccionar todo" / "Ninguno" / selección manual |
| RF-24 | Dos botones de descarga, mutuamente independientes: **"Descargar como ZIP"** y **"Descargar en carpeta…"** |
| RF-25 | Al elegir "Descargar en carpeta", campo de texto para el nombre de la subcarpeta (dentro de Descargas); si se deja vacío, los archivos sueltos van directo a la raíz de Descargas |
| RF-26 | Al elegir ZIP, un único archivo `.zip` con todas las imágenes seleccionadas, nombrado por plantilla (p. ej. `{domain}-{date}.zip`) |
| RF-27 | Plantilla de nombre de archivo configurable con tokens `{name}`, `{domain}`, `{date}`, `{time}`, `{index}`, `{width}x{height}` |
| RF-28 | Formato de salida para el modo masivo: PNG por defecto, configurable igual que el modo individual |

### 3.4 Ajustes
| ID | Requisito |
|---|---|
| RF-30 | Formato por defecto para el atajo rápido y para el guardado masivo |
| RF-31 | Tamaño mínimo de imagen a considerar (para ignorar iconos/sprites) |
| RF-32 | Reasignar los atajos de teclado (enlaza con `chrome://extensions/shortcuts`, Chrome no permite capturarlos desde la propia página de ajustes) |
| RF-33 | Carpeta/plantilla recordada por sitio (opcional, para no reescribir el nombre cada vez que vuelves al mismo generador) |

### 3.5 No funcionales
| ID | Requisito |
|---|---|
| RNF-01 | Cero telemetría, cero servidor externo — toda la conversión y el empaquetado ocurren dentro del navegador |
| RNF-02 | Nunca recargar ni navegar la pestaña del usuario para hacer su trabajo |
| RNF-03 | Manifest V3; sin scripts remotos (todo el código, incluida la librería de ZIP, va empaquetado dentro de la extensión — Manifest V3 prohíbe cargar y ejecutar JavaScript remoto) |

---

## 4. Arquitectura técnica

### 4.1 Piezas

```
pixelcatch/
├─ manifest.json
├─ src/
│  ├─ background/service-worker.js    # menú contextual, atajos, orquesta descargas y ZIP
│  ├─ content/detector.js             # escaneo en vivo + seguimiento del cursor (todos los frames)
│  ├─ offscreen/offscreen.html + .js  # conversión de formato y empaquetado ZIP (necesitan DOM/Canvas)
│  ├─ sidepanel/panel.html + .js      # galería de revisión, selección, los dos botones de descarga
│  ├─ options/options.html + .js      # formato por defecto, plantilla, tamaño mínimo
│  └─ lib/jszip.min.js                # librería de ZIP empaquetada localmente (o 'fflate', más ligera)
└─ icons/
```

### 4.2 `manifest.json` (extracto razonado)

```json
{
  "manifest_version": 3,
  "name": "PixelCatch",
  "permissions": ["contextMenus", "downloads", "storage", "scripting", "offscreen", "sidePanel"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "src/background/service-worker.js", "type": "module" },
  "content_scripts": [
    { "matches": ["<all_urls>"], "all_frames": true, "js": ["src/content/detector.js"], "run_at": "document_idle" }
  ],
  "commands": {
    "save-under-cursor": { "suggested_key": { "default": "Alt+Shift+S" }, "description": "Guardar la imagen bajo el cursor" },
    "save-all-review":   { "suggested_key": { "default": "Alt+Shift+B" }, "description": "Abrir galería de todas las imágenes" }
  },
  "action": { "default_title": "PixelCatch" },
  "side_panel": { "default_path": "src/sidepanel/panel.html" },
  "options_page": "src/options/options.html"
}
```

**Nota sobre `commands`:** Chrome permite como máximo 4 atajos declarados con tecla sugerida por extensión (más `_execute_action`), y el usuario siempre puede reasignarlos en `chrome://extensions/shortcuts` — la extensión no puede capturarlos desde su propia interfaz, es una pantalla exclusiva del navegador.

### 4.3 Seguimiento del cursor (para que el atajo sepa qué hay debajo)

Un atajo de teclado se dispara en el **fondo** de la extensión (`chrome.commands.onCommand`), que no sabe dónde está el ratón. Por eso el content script debe llevar la cuenta en todo momento:

```js
// detector.js
let lastPointer = { x: 0, y: 0 };
document.addEventListener('mousemove', (e) => {
  lastPointer = { x: e.clientX, y: e.clientY };
}, { passive: true, capture: true });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'WHAT_IS_UNDER_CURSOR') return;
  const stack = document.elementsFromPoint(lastPointer.x, lastPointer.y); // TODA la pila, no solo el de arriba
  const target = stack.find(isImageLike); // <img>, <canvas>, o con background-image calculado
  sendResponse(target ? describeImageLikeElement(target) : null);
});
```

`document.elementsFromPoint` es la pieza exacta que resuelve "pines ocultos bajo una capa transparente": devuelve **todos** los elementos apilados en ese punto, de arriba hacia abajo, así que aunque el elemento superior sea una capa invisible de clics, el `<img>` real que está debajo sigue apareciendo en la lista.

Cuando el usuario presiona `Alt+Shift+S`, el fondo pregunta "¿qué hay bajo el cursor?" al content script de la pestaña activa (y, si el foco estaba dentro de un iframe, Chrome enruta el mensaje a ese frame igual que a cualquier otro) y descarga lo que responda.

### 4.4 Conversión de formato (reutilizando el enfoque de peterbenoit, con más detalle)

```js
async function convertImage(srcUrl, mime) {
  try {
    // Camino 1: dibujar la <img> tal cual, directo en la página (funciona si es
    // del mismo origen o ya tiene CORS habilitado)
    const img = await loadImage(srcUrl);
    return await drawAndExport(img, mime);
  } catch {
    // Camino 2: traer los bytes con fetch() y decodificar con createImageBitmap().
    // Esto NO contamina el canvas, porque la marca de "tainted" depende de cómo
    // se cargó el elemento <img>, no del contenido de los píxeles.
    const blob = await fetch(srcUrl).then(r => r.blob());
    const bitmap = await createImageBitmap(blob);
    return await drawAndExport(bitmap, mime);
  }
}
```

Este doble camino es textualmente lo que peterbenoit describe en su README ("attempts to load images in the context of the current page first... falls back to a background fetch"), y es la técnica correcta: no hay una tercera vía mejor, solo estas dos, y entre ambas cubren la gran mayoría de los casos. Sitios con CORS verdaderamente estricto en *ambas* vías (poco común) seguirán sin poder convertirse — ahí corresponde avisar al usuario en vez de fallar en silencio (RF-13).

### 4.5 Descarga masiva: ZIP vs. carpeta

Ambos caminos parten de la misma lista de imágenes seleccionadas en la galería; lo que cambia es el paso final:

**Camino ZIP:**
1. El panel envía al fondo la lista de imágenes seleccionadas (URL + nombre sugerido por plantilla).
2. El fondo abre un **offscreen document** (motivo `BLOBS`, porque empaquetar un ZIP y manejar `Blob`s de forma fiable necesita DOM/`window`, que el service worker no tiene).
3. El offscreen descarga/convierte cada imagen (mismo `convertImage` de §4.4) y las va añadiendo a un `JSZip` (o `fflate`, más liviana) **bundleado localmente** — nunca cargado desde un CDN, porque Manifest V3 no permite ejecutar JavaScript remoto en el contexto de la extensión.
4. Al terminar, genera el ZIP como `Blob`, lo convierte a `data:` URL (o `URL.createObjectURL` dentro del propio offscreen) y se lo pasa de vuelta al fondo.
5. El fondo llama a `chrome.downloads.download({ url: zipDataUrl, filename: nombrePlantilla + '.zip' })`.

**Camino carpeta:**
1. Igual lista de seleccionadas.
2. El fondo descarga cada una **directamente** con `chrome.downloads.download({ url, filename: "MiCarpeta/nombre.png", conflictAction: "uniquify" })`, en una cola con concurrencia limitada (3–5 a la vez) para no saturar el disco ni el limitador de Chrome.
3. Si el campo de carpeta quedó vacío, se omite el prefijo y cada archivo cae directo en la raíz de Descargas — exactamente el comportamiento que pediste.

> La diferencia de fondo entre ambos caminos es que el ZIP necesita procesar y empaquetar **todo** antes de poder descargar nada (una sola operación atómica), mientras que la carpeta puede ir soltando archivos a medida que se van procesando — por eso en la interfaz conviene mostrar una barra de progreso distinta para cada modo: "empaquetando…" para el ZIP, y "3 de 12 descargadas" para la carpeta.

### 4.6 "Modo silencioso" — una aclaración honesta

Music Find anuncia un "modo silencioso que salta el diálogo de Guardar como". Hay que ser preciso aquí: `chrome.downloads.download()` **ya** descarga sin diálogo por defecto — el diálogo del sistema solo aparece si el propio usuario activó, en los ajustes generales de Chrome (no de la extensión), la opción "Preguntar dónde guardar cada archivo antes de descargar". Ninguna extensión puede forzar que ese diálogo deje de aparecer si el usuario lo activó así a nivel de navegador; lo máximo que PixelCatch puede hacer es **no pedirlo activamente** (no usar `saveAs: true`), que es lo que ya hace por diseño. Vale la pena explicar esto en los ajustes de la extensión para no prometer algo que la API de Chrome no permite controlar.

---

## 5. Interfaz

| Pantalla | Contenido |
|---|---|
| Menú contextual | "Guardar imagen como…" con submenú PNG/JPG/WebP/AVIF*/PDF (*AVIF solo si el navegador lo soporta, detectado al arrancar) |
| Panel lateral (galería) | Cuadrícula de miniaturas con casillas · contador de seleccionadas · campo de nombre de carpeta · botón "Descargar como ZIP" · botón "Descargar en carpeta" · barra de progreso según el modo elegido |
| Ajustes | Formato por defecto · tamaño mínimo a detectar · plantilla de nombre de archivo con vista previa en vivo · enlace directo a `chrome://extensions/shortcuts` para los atajos |

---

## 6. Pruebas

| Área | Prueba |
|---|---|
| Detección en vivo | Insertar imágenes por `setInterval` en una página de prueba; confirmar que el badge y la galería se actualizan sin recargar |
| Elemento tapado | Página de prueba con un `<img>` cubierto por un `<div>` transparente encima; confirmar que `Alt+Shift+S` guarda la imagen de abajo, no falla |
| Conversión cross-origin | Imagen servida desde otro origen sin cabecera CORS; confirmar que el camino `fetch` + `createImageBitmap` la resuelve igual |
| ZIP vs. carpeta | Mismo conjunto de 10 imágenes por ambos caminos; confirmar que el ZIP contiene las 10 y que la carpeta las deja sueltas con el mismo contenido |
| Carpeta vacía | Confirmar que cae en la raíz de Descargas sin crear ninguna subcarpeta |
| Atajos en conflicto | Verificar comportamiento si el usuario ya tiene `Alt+Shift+S` asignado a otra extensión (Chrome simplemente no deja asignarlo dos veces; debe quedar un atajo alternativo o aviso) |
| Rendimiento | Página con 60+ imágenes grandes; confirmar que empaquetar el ZIP no cuelga la interfaz (debe correr en el offscreen document, nunca en el hilo del panel) |

---

## 7. Fases de desarrollo

**Fase 0 — Motor de detección:** content script con `all_frames`, `MutationObserver`, seguimiento de cursor con `elementsFromPoint`, mensajería al fondo, badge con contador.

**Fase 1 — Guardado individual:** menú contextual con submenú de formatos, conversión con el doble camino de §4.4, atajo `Alt+Shift+S`.

**Fase 2 — Galería y guardado masivo:** panel lateral con selección, atajo `Alt+Shift+B` que abre la galería (no descarga directo), camino "carpeta" con `chrome.downloads` en cola.

**Fase 3 — ZIP:** offscreen document, empaquetado con la librería de ZIP local, camino "ZIP" completo.

**Fase 4 — Ajustes y pulido:** plantillas de nombre, tamaño mínimo configurable, recordar carpeta por sitio, página de ajustes con vista previa en vivo del nombre de archivo, empaquetado para la Chrome Web Store con una política de privacidad honesta (cero recolección, a diferencia de la referencia de Music Find).

---

### Cierre

El mecanismo de "ver imágenes nuevas sin recargar" es el mismo `MutationObserver` que ya usamos para el proyecto anterior — aquí se le suma `document.elementsFromPoint` para resolver el caso de "imagen tapada por una capa", que es la pieza que hace que el atajo de un solo clic funcione incluso en sitios que ponen overlays encima de las imágenes. La diferencia respecto a las dos extensiones que investigué es que ninguna te deja **revisar antes de descargar ni elegir entre ZIP o carpeta** — eso es exactamente lo que el panel lateral de la Fase 2 añade, y es la mejora que tú pediste sobre lo que ya existe.
