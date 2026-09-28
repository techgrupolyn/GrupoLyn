# Publicación de informes globales y extensión 1.1.5

## Alcance

- Backend: cola recuperable, análisis por lotes, citas verificables, auditoría semántica y progreso por mensajes completos.
- Extensión: barra de porcentaje analizado/restante y recuperación del trabajo al reabrir.
- Sin cambios en dependencias del backend, Evolution, frontend CEO, credenciales ni configuración de cuentas.
- Publicar el código en GitHub no reinicia el servidor ni publica la extensión en Chrome Web Store.

## Despliegue dirigido del backend

El script `deploy/scripts/deploy-global-summary.sh` requiere root y el SHA completo aprobado como primer argumento. Está preparado para el servidor existente con `/opt/lyn`, servicio `lyn-backend`, bases `superagente` y `evolution_db`, y configuración `/etc/lyn/backend.env`. No sirve para despliegues multiinstancia.

Para obtenerlo antes de actualizar el checkout, hacer `git fetch origin` como usuario `lyn` y extraer el script desde el commit aprobado mediante `git show SHA:deploy/scripts/deploy-global-summary.sh`. Ejecutarlo con `systemd-run` permite cerrar la terminal sin interrumpir el trabajo. El SHA se pasa también al script para comprobarlo contra `origin/main`.

El procedimiento comprueba rama, cambios locales, dependencias, espacio para respaldos y preflight; crea un bundle de Git, copia de configuración y unidad del backend, parche de cambios locales y dumps de ambas bases en un directorio root `0700`. Valida los índices de los dumps y los checksums; esto no equivale a una restauración ensayada. Respalda mediante stash únicamente los lockfiles permitidos. Después avanza con fast-forward y reinicia solo el backend, que ejecuta TypeScript con el runtime ya instalado.

No instala dependencias, no reconstruye Evolution o el frontend, no rota claves y no borra sesiones. Añade las tablas de checkpoints y la columna `evidence` durante el arranque. Comprueba `/ready`, servicios, columna de evidencias y `/health` público. El marcador de éxito es `BACKEND ACTUALIZADO: SHA`. Que la unidad figure `active (exited)` no basta: comprobar también el marcador y `ExecMainStatus=0`.

Ante un fallo se detiene e imprime la ruta del respaldo. No repetir a ciegas ni restaurar la base automáticamente: pueden haber entrado mensajes desde la copia. Revisar el registro y decidir la recuperación con el commit anterior guardado en `previous-commit.txt`. La migración es aditiva; conservar las tablas y datos al evaluar una reversión de código.

## Extensión

Paquete de producción: `extension/dist/release-1.1.5/lyn-superagente-extension-1.1.5.zip`.

Se genera con `extension/scripts/package-extension.ps1 -Profile production` y contiene `manifest.production.json` como `manifest.json`. No incluye hosts localhost, credenciales, pruebas ni archivos de entorno. Subirlo a la misma ficha de Chrome Web Store para mantener el ID; actualizar conserva el almacenamiento local y la activación. No desinstalar ni crear otra ficha para aplicar la actualización.

La versión 1.1.5 supera 1.1.4 local y 1.1.2 declarada anteriormente en Store. Si existe un borrador superior no comunicado, comprobarlo antes de cargar el ZIP. La subida y aprobación/publicación en Store son pasos independientes del backend.

## Comprobación posterior

1. Confirmar SHA del checkout, `ExecMainStatus=0`, `/ready` y `/health` y revisar errores del backend.
2. Instalar la actualización 1.1.5 desde la misma ficha sin borrar la activación.
3. Generar un informe de textos pendientes: comprobar progreso confirmado por el servidor, cerrar/reabrir el panel y esperar el informe guardado.
4. Los mensajes solo se descuentan al guardar el informe; no se envían confirmaciones de lectura a WhatsApp. Los nuevos mensajes permanecen pendientes.

La validación local más reciente tiene 198 pruebas backend y 38 de extensión aprobadas, compilación backend y sintaxis de extensión correctas. El ensayo real de 20.000 textos con Gemini está en `QA_INFORME_GLOBAL_EVIDENCIAS_20260928.md`; la barra se validó posteriormente con pruebas de progreso y una vista estrecha de navegador. No se repitieron llamadas facturadas a Gemini para el cambio de versión. La validación local no acredita que el despliegue remoto ya haya ocurrido.
