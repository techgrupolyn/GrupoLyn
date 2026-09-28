# QA transversal del proyecto — preproducción

> INFORME HISTÓRICO. Los hallazgos de esta ejecución se corrigieron posteriormente; consultar `QA_CIERRE_TECNICO_20260927.md` para el estado actualizado, las pruebas y las reservas de despliegue. Se conservan los resultados originales como comparación.

Fecha: 27/09/2026. Base: `1c4fc71` y cambios locales acumulados. Entorno Windows, Node 24.19.0, PostgreSQL 16 aislado en 127.0.0.1:55439.

## Dictamen: NO APTO todavía para desplegar el proyecto completo

El control de calidad automatizado pasa **215 pruebas**, pero la revisión ampliada encontró riesgos no cubiertos por las regresiones anteriores. Pasar los tests no equivale a cero incidencias. Los bloqueantes abiertos se detallan a continuación; no se ha hecho commit, push ni despliegue, ni se ha modificado producción o la fuente Supabase.

Este informe prevalece sobre el dictamen local del gestor de reuniones en `QA_AMPLIACION_20260927.md`. La revisión abarca backend, dashboard, extensión, dependencias Evolution, configuración de CI y scripts de despliegue. No se presenta como certificación exhaustiva de cada ruta o integración externa.

## Hallazgos abiertos

### QA-G01 — Bloqueante: dependencias de Evolution con avisos críticos/altos

`npm audit --omit=dev` contra el registro público detecta **83 paquetes afectados: 3 críticos, 26 altos y 54 moderados**. Los tres nodos críticos son `baileys`, `fast-xml-parser` y `protobufjs`. Los conteos son los del grafo de dependencias, no 83 explotaciones reproducidas ni necesariamente 83 avisos únicos.

- Baileys instalado en el lockfile: `7.0.0-rc.9`; el registro señala corrección disponible en otra release candidate. Referencia: https://github.com/advisories/GHSA-qvv5-jq5g-4cgg.
- Parser XML: https://github.com/advisories/GHSA-m7jm-9gc2-mpf2.
- Protobuf: varios avisos de generación de código, inyección y denegación de servicio figuran en la evidencia npm.

No se ejecutaron cargas maliciosas ni se demostró explotación en producción. La compilación de Evolution pasa, pero eso no elimina estos avisos. No se hizo una actualización forzada de Baileys/Evolution: necesita ensayo de compatibilidad, sesiones, recepción, historial y envío en un entorno aislado antes de reemplazar el motor WhatsApp.

### QA-G02 — Alta: informe global sin trabajo durable ni error observable

`POST /api/chat/global-summary` devuelve 202 y lanza una llamada HTTP al mismo backend. No conserva un trabajo pendiente/fallido que pueda consultarse o recuperarse después de reiniciar. El `catch` del lanzamiento captura errores de transporte, pero no una respuesta HTTP 500/503 del worker. El usuario puede seguir viendo el informe anterior sin conocer el fallo de la generación nueva.

Reproducción local controlada, sin proveedor externo: se hicieron dos solicitudes con el worker simulado devolviendo 503; ambas respondieron 202 con `en_progreso=true`. No debe confundirse un 202 con un informe completado. Se corrigió ese texto en la extensión, pero **la persistencia/recuperación del trabajo sigue pendiente**.

### QA-G03 — Alta: solicitudes simultáneas pueden duplicar el análisis

La misma reproducción lanzó **2 trabajos para 2 solicitudes iguales concurrentes**. No hay exclusión por cuenta ni clave de idempotencia en ese lanzamiento. El guardado incrementa el contador interno por cantidad, sin comprobar si otra generación ya consumió esos mismos mensajes. También debe cubrirse el solapamiento de informe global y resumen individual.

La duplicación del lanzamiento está reproducida; el efecto sobre contadores con mensajes entrantes concurrentes se identifica por revisión de código, no por una prueba de carga real. Se requiere cola/estado durable e idempotencia por mensajes antes de autorizar esta funcionalidad bajo carga.

### QA-G04 — Moderada: dependencia qs del backend

El registro reporta **3 paquetes afectados moderados** (`qs`, `express`, `body-parser`) por dos avisos de `qs` 6.15.3:
- https://github.com/advisories/GHSA-x5fp-wj9c-mxmx
- https://github.com/advisories/GHSA-4mjr-xmp4-gh2g

Una actualización acotada de prueba no eliminó los avisos y provocó cambios extensos de resolución; se revirtió el lockfile y se restauraron las dependencias desde él. No se conserva una actualización que parezca solucionar el riesgo sin hacerlo. Requiere actualización compatible de la cadena Express/body-parser/qs y repetir regresión.

### QA-G05 — Cobertura y validación externa incompletas

Cobertura final de líneas instrumentadas: backend **44,18 %**, frontend **26,53 %**. El proveedor mide los archivos incluidos/instrumentados en esa ejecución; no se debe extrapolar a toda integración externa. Parte de los tests de extensión y despliegue son comprobaciones estructurales de código/configuración, no sesiones end-to-end.

No se ha realizado en esta ronda: sesión Chrome/WhatsApp real, envío real, reconexión de una cuenta de WhatsApp, carga real de más de 1000 mensajes, recuperación tras matar el worker, deploy Linux/systemd/nginx, ejecución en Node 22 de CI ni nueva autenticación corporativa. La confianza declarada por el usuario en Supabase no sustituye estas pruebas del dashboard y la extensión.

## Correcciones realizadas durante esta revisión

| ID | Defecto | Corrección y validación |
| --- | --- | --- |
| QA-F01 | El bypass de activación local no rechazaba explícitamente NODE_ENV=production. | Solo desarrollo/entorno sin NODE_ENV permiten evaluar el bypass. Regresión de petición con Host loopback y flag activado en producción: 401. |
| QA-F02 | CI omitía silenciosamente las integraciones PostgreSQL de reuniones. | CI crea `lyn_qa_retest` y define `QA_TEST_DATABASE_URL`. El script completo exige esta variable; omitir integraciones requiere opción explícita. YAML y prueba estructural aprobados. |
| QA-F03 | Deploy publicaba index.html antes de los assets, con ventana de importación dinámica fallida. | Publicación de assets primero; index preparado en archivo temporal y reemplazado con rename. Publicación frontend movida después de las migraciones/reinicios. Bash y prueba de orden aprobados; pendiente ensayo real Linux/rollback/readiness. |
| QA-F04 | Etiquetas, Business, Plantillas y Especialistas ocultaban errores de carga/consulta. | Mensajes visibles y seis regresiones de paneles, incluido Grupos. No se presentan fallos como listas vacías válidas. |
| QA-F05 | Extensión mostraba «Informe generado» al recibir un trabajo aún en proceso. | Mensaje diferenciado para `en_progreso`; test añadido. No soluciona G02/G03. |
| QA-F06 | Documentación TESTING describía un modelo de cuenta única ya desactualizado. | Actualizada con aislamiento por activación, base de QA obligatoria y límites reales de validación. |

## Matriz ejecutada

| Área | Resultado | Alcance |
| --- | --- | --- |
| Backend | **133 tests aprobados**, 1 live Gemini optativo omitido | Incluye **37 integraciones HTTP/PostgreSQL** aisladas, autorización, Drive controlado, historial, responsables, organigrama, CRM y contadores. |
| Dashboard | **57 tests aprobados**, 15 archivos | Componentes, rutas, errores visibles, permisos/render, acciones, reuniones y operaciones. |
| Extensión | **23 tests aprobados** | Sincronización, contadores, endpoints, manifiestos, persistencia y reglas de envío. Parte son asserts estructurales. |
| Seguridad de release | **2 tests aprobados** | Orden assets/index y activación de DB tests en CI; no ejecutan el deploy. |
| Control completo `scripts/test-all.ps1` | **Aprobado** | Tipos backend, tests backend/dashboard/extensión, build frontend, sintaxis JS y checks de release. |
| Evolution | **Tipos y build aprobados** | No inicia conexiones ni valida sesiones reales. Build avisa que no usa plugin SWC con emitDecoratorMetadata. |
| Frontend build | **Aprobado** | Aviso no bloqueante: chunk App de **537,60 kB**. |
| Paquete Chrome producción | **Verificado** | ZIP 1.1.3, 15 entradas, archivos obligatorios, hosts producción/WhatsApp, sin hosts locales ni archivos .env/client_secret/pem. No se subió a la tienda; no se consultó su versión vigente. |
| Scripts/configuración | **Sintaxis aprobada** | Bash deploy/preflight, PowerShell test-all y YAML CI. `git diff --check` sin errores de whitespace. |
| Auditoría npm frontend productivo | **0 avisos** | `--omit=dev`; no cubre herramientas de desarrollo ni garantiza seguridad absoluta. |
| Auditoría npm backend/Evolution | **No aprobada** | G01 y G04. No se instalaron correcciones forzadas. |

### Evidencia adicional multicuentas

La nueva integración crea dos cuentas y tres chats sintéticos. Comprueba que la activación de A no obtiene el mensaje privado de B aunque solicite el identificador con prefijo de B; resumir un chat de A deja intactos los pendientes de su otro chat y los de B; el contador WhatsApp original no cambia; no se hace ninguna llamada externa; revocar la activación devuelve 403. Fixtures retirados al finalizar.

## Evidencias locales

Archivos ignorados por Git en `.runtime-logs/`:
- `qa-project-quality-gate.log`: ejecución final completa.
- `qa-project-backend-final.log`, `qa-project-backend-coverage.log`, `qa-project-frontend-coverage.log`.
- `qa-project-evolution.log`, `qa-project-evolution-build.log`.
- `qa-audit-backend.json`, `qa-audit-frontend.json`, `qa-audit-evolution-api.json`: respuestas del registro; algunos incluyen avisos npm después del JSON.
- `qa-global-queue-repro.log`: `requests=2`, `backgroundLaunches=2`, respuestas `[202,202]`, worker simulado 503, cero solicitudes externas.
- `qa-release-check/extension.zip`: paquete únicamente para inspección local.

El primer intento de integración encontró PostgreSQL de QA apagado: se levantó el cluster aislado y se repitió con éxito. Un fixture nuevo necesitó cast UUID explícito, corregido antes de la ejecución final. Estos intentos no se contabilizan como pruebas finales aprobadas ni se ocultan como resultados del producto.

## Condiciones para levantar el bloqueo

1. Actualizar de forma compatible y ensayar Evolution/Baileys y sus dependencias afectadas; reauditar sin alertas críticas/altas no justificadas.
2. Persistir trabajos de informe global, errores y recuperación; impedir procesar dos veces el mismo conjunto de mensajes y descontar por IDs de mensajes, no solo por cantidad.
3. Probar concurrencia global/individual, entrada de mensajes durante IA, fallos y reinicios con un lote de más de 1000 mensajes sintéticos.
4. Repetir smoke en Linux/Node de producción y sesiones reales en staging sin usar cuentas productivas para pruebas destructivas; verificar migraciones, readiness, assets, rollback y contadores.

**No se declara «cero errores» del proyecto completo ni se autoriza el despliegue mientras sigan abiertos los bloqueantes.**
