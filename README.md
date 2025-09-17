# EduMix — Mezcla, organiza y reproduce tus audios

EduMix es una app web (PWA) para organizar, reproducir y mezclar tus audios con listas de reproducción, fundidos suaves, portada de carátulas, valoración por estrellas y sincronización opcional con Dropbox.

Puedes usarla totalmente en local (sin nube) o activar la sincronización para mantener tus listas y archivos entre dispositivos.

---

## Funcionalidades principales

- Listas de reproducción múltiples
  - Crear, renombrar, eliminar y vaciar listas.
  - Selector para cambiar de lista activa.
  - Almacenamiento por lista en Dropbox: cada lista se guarda en `/Playlists/<nombre>.json` y los ajustes globales en `/Playlists/_settings.json` (reduce colisiones y diffs).

- Gestión de pistas
  - Añadir archivos locales (carpetas completas) y conservarlos en el navegador (IndexedDB) para usarlos sin conexión.
  - Reordenar por arrastrar y soltar.
  - Renombrar y eliminar pistas.
  - Valoración por estrellas (1–5) por pista.

- Reproducción y mezcla
  - Fundido configurable entre pistas.
  - Repetición automática de la pista actual (loop).
  - Reproducción aleatoria (shuffle) sin repetición hasta agotar la cola.
  - Control de velocidad de 0,5× a 1,5× con pasos de 0,01 y botón de reset (1×).

- Interfaz
  - Forma de onda con progreso (se aplaza la descarga en ahorro de datos).
  - Carátulas: portada en “Reproducción” (con lightbox al hacer clic) y miniaturas en la lista.
  - Paginación de listas (Todas / 10 / 25 / 50 / 100).
  - Orden por valoración (alta→baja, baja→alta) y filtro por mínimo de estrellas.
  - Indicadores de almacenamiento: uso local (IndexedDB) y total de archivos subidos por la app a Dropbox.

- Dropbox (opcional)
  - Conectar, sincronizar y desconectar.
  - Subir solo al reproducir: no sube los archivos locales hasta que los escuchas.
  - Descargar solo al reproducir: no descarga audios/ondas remotas hasta que los reproduces.
  - Preferir fuente local si existe (ahorra datos aunque haya copia en Dropbox).
  - Subidas robustas con sesiones (archivos grandes) y borrados en lote.
  - Prefetch del siguiente tema para reducir esperas (si no se activa el ahorro de datos).
  - Detección y resolución de conflictos de playlist con merge por `updatedAt`.

- PWA / Offline
  - Instalación como app (botón “Instalar app”).
  - Service Worker con caché del shell de la app.

---

## Controles rápidos

- Reproducción
  - Botones anterior/pausar-sigue/siguiente.
  - Fundido: slider 🌫️ (muestra valor en segundos).
  - Velocidad: slider ⏱️ de 0,5× a 1,5× (pasos 0,01) + botón ⟲ para volver a 1×.
  - Loop: interruptor 🔁.

- Carátula
  - Clic en la portada para ampliarla (lightbox). Esc para cerrar.

- Valoración
  - Lista: 5 estrellas bajo el nombre de cada pista (clic para valorar).
  - Reproducción: estrellas grandes bajo la portada para valorar al vuelo.

- Orden y filtro
  - Ordenar por valoración: ⭐ alta→baja o baja→alta.
  - Filtro “mínimo de estrellas”: muestra solo ≥ N.
  - Paginación: controla el tamaño de página y navega con los botones ◀︎ ▶︎.

---

## Atajos de teclado

- Valoración rápida de la pista actual: teclas 1, 2, 3, 4, 5.
- Velocidad:
  - `+` sube +0,01×
  - `-` baja −0,01×
  - `R` vuelve a 1×
- Lightbox: `Esc` para cerrar.

(Nota: no actúan mientras estás escribiendo en un campo de texto.)

---

## Dropbox — sincronización y ahorro de datos

- Conexión:
  - Pulsa “Conectar con Dropbox” y autoriza. La app guarda el token de forma local (LocalStorage) y lo renueva cuando caduca.
- Ajustes de ahorro de datos:
  - “Subir solo al reproducir”: sube al reproducir (útil en móvil).
  - “Descargar solo al reproducir”: aplaza descargas/remotas (ondas/portadas) hasta reproducir.
  - “Preferir fuente local si existe”: usa audio local aunque haya copia en Dropbox.
- Estructura en la nube:
  - Listas en `/Playlists/<nombre>.json` y ajustes en `/Playlists/_settings.json`.
  - Audios subidos en `/tracks/<id>-<archivo>`.
- Conflictos:
  - Si se detecta conflicto de `playlist.json` (modo legacy), se ofrece combinar con el remoto o elegir versión.

---

## Consejos de uso

- Recarga dura si no ves cambios tras una actualización (Ctrl/Cmd+Shift+R) por el Service Worker.
- En listas muy largas, usa el tamaño de página y el filtro por estrellas para mantener el rendimiento.
- Importar carpetas conserva el orden natural de los archivos.

---

## Desarrollo

- Estructura
  - `index.html`, `styles.css`, `app.js`, `service-worker.js` y `/icons`.
- Ejecutar en local
  - Sirve la carpeta con cualquier servidor estático (por ejemplo):

    ```bash
    npx serve .
    # o
    python3 -m http.server 8080
    ```

  - Abre `http://localhost:8080/`.
- Sin permisos externos: todo funciona sin Dropbox; si lo activas, requiere conexión.

---

## Privacidad y almacenamiento

- Local: las pistas importadas se guardan en IndexedDB solo en tu navegador.
- Dropbox: al sincronizar, tus pistas se suben a tu cuenta; EduMix no envía datos a terceros.
- Puedes desconectar Dropbox y borrar la caché local cuando quieras.

---

## Licencia

Distribuido bajo la Licencia MIT. Consulta `LICENSE` para más información.

---

¿Sugerencias o problemas? Abre un issue o comenta qué te gustaría mejorar.
