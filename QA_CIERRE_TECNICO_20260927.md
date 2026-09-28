# Cierre técnico local y preparación de release — 27/09/2026

Actualización posterior: las pruebas reales están en curso en `QA_PRUEBAS_REALES_20260927.md`. Detectaron una incidencia adicional de tamaño de webhooks corregida localmente; este informe conserva los resultados de la ronda automatizada anterior, no acredita el cierre de las pruebas reales.

## Dictamen y alcance

Correcciones locales verificadas; candidato preparado para un despliegue controlado, **no desplegado ni certificado en producción**. El usuario ha elegido expresamente «por ahora solo validación local», sin cuenta/chat de prueba para WhatsApp. No se hace pasar esa prueba pendiente por aprobada.

No se modificaron producción, el origen Supabase, las credenciales productivas ni las sesiones de WhatsApp. No se hizo commit, push ni publicación en Chrome Web Store. Se preservaron los cambios locales de reuniones, organigrama, CRM, permisos e historial y se repitieron sus regresiones.

Este informe sustituye el estado de `QA_PROYECTO_COMPLETO_20260927.md`; los informes anteriores y el PDF se conservan únicamente como evidencia histórica. No se garantiza la inexistencia universal de bugs.

## Comparación y correcciones

| Hallazgo anterior | Estado local actual | Evidencia |
| --- | --- | --- |
| G01: 83 nodos productivos afectados en Evolution, incluidos 3 críticos | Auditoría npm completa: 0 vulnerabilidades conocidas reportadas | Baileys 7.0.0-rc14; dependencias actualizadas y overrides explícitos; tipos, build, carga CJS y seis pruebas de compatibilidad con Node 22 y 24. No equivale a probar una sesión WhatsApp real. |
| G04: 3 nodos moderados en backend | Auditoría npm completa: 0 | Resolución corregida de Express/body-parser/qs y actualización de Vitest. Frontend también devuelve 0, incluyendo desarrollo. |
| G02: worker global sin persistencia ni error visible | Corregido | `summary_jobs` conserva queued/running/completed/failed, resultado y error. La extensión consulta el estado y recupera el trabajo al abrir el panel. |
| G03: trabajos duplicados y doble descuento | Corregido en escenarios probados | Un trabajo activo por cuenta, advisory lock compartido con resúmenes individuales y registro por ID de mensaje. Informe, registro de mensajes y contadores se guardan en una transacción. |
| Reinicio durante el análisis | Recuperación verificada | Se termina un proceso QA que mantiene el lock; una nueva instancia de cola recupera el trabajo running. No se crea un segundo informe persistido. |
| Mensajes recibidos durante IA | Corregido | Lote de 1105 mensajes y una llegada posterior: el resumen procesa 1105 y queda 1 pendiente. |
| Lectura posterior en WhatsApp | Corregido | El upsert restablece `reviewed_unread_baseline`; un nuevo mensaje vuelve a incrementar pendientes. El análisis no envía confirmaciones de lectura a WhatsApp. |
| Respuesta IA vacía tratada como válida | Corregido | Se rechaza el resultado vacío en vez de guardar «sin respuesta de IA» y consumir mensajes. Fallos/fallback no completan el trabajo. |
| Publicación frontend con backend no preparado | Protección añadida | `/ready` exige esquema inicializado y DB accesible; deploy espera antes de publicar HTML, conserva assets anteriores y usa rename atómico. |
| Variables no definidas en llamadas | Corregido | `selectedChatId` fuera de alcance y `callIcon` inaccesible; dos regresiones de selección/detalle. |
| Referencias rotas en lotes antiguos de extensión | Retiradas | Código sin controles HTML ni listeners eliminado; se mantiene el envío seleccionado activo por `SEND_TEXT`. |
| Chunk grande del dashboard | Mejorado | Gráficos separados: App ~182 kB y charts ~360 kB. Sin aviso de chunk >500 kB en el build final. |

La cola limita trabajos simultáneos para no agotar conexiones PostgreSQL, **no recorta la cantidad de mensajes del informe global**. Conserva el timeout Gemini de 10 minutos. Los límites del proveedor siguen existiendo: si falla, los mensajes permanecen pendientes y se muestra el error. Una caída antes de persistir puede requerir repetir la llamada a IA; no se promete facturación exactamente una vez. Tras tres intentos interrumpidos el trabajo falla de forma visible y permite solicitar uno nuevo.

## Validación ejecutada

Entorno: Windows, PostgreSQL 16 aislado (`lyn_qa_retest`, loopback:55439), Node 22.23.3; comprobaciones adicionales con Node 24.

| Área | Resultado |
| --- | --- |
| Backend | 136 pruebas aprobadas; incluye 40 integraciones HTTP/PostgreSQL. Tipos aprobados. |
| Dashboard | 59 pruebas aprobadas y build de producción correcto. |
| Extensión | 26 pruebas aprobadas y sintaxis JS correcta. Incluye polling de éxito/fallo/reconexión. |
| Release | 4 pruebas aprobadas, incluyendo readiness con éxito, fallo, reintento y puerto inválido. |
| Dependencias Evolution | 6 pruebas aprobadas: Baileys/protobuf sin enviar, notificaciones MinIO CJS/ESM, Chatwoot/Axios con HTTP sintético, sharp/cron y rechazo de URLs privadas. |
| Gemini real, separado y opt-in | 1 prueba aprobada con transcripción sintética: tareas ambiguas, decisiones, información relevante, bloqueo y minuto; sin responsables inventados. |
| Total | **232 pruebas aprobadas** contando la prueba live separada. En la suite habitual esa prueba aparece omitida por diseño. |
| Análisis estático | 31 archivos JS/JSX, 0 errores en las reglas ejecutadas. Se incorpora al control local y CI. |
| Auditorías npm completas | Backend 0, frontend 0, Evolution 0. No significa ausencia de vulnerabilidades desconocidas. |
| Lockfiles | `npm ci --dry-run --ignore-scripts` correcto en los tres paquetes; no es una instalación Linux real. |
| Arranque aislado | Backend con NODE_ENV=production, sincronizaciones externas apagadas: `/ready` 200, `/health` 200, informe sin credenciales 401. Proceso QA detenido al terminar. |

Los errores SQL y de proveedor impresos por los tests de fallo son provocados deliberadamente para verificar rollback y estados fallidos. No se cuentan como fallos de la ejecución final. No se recalculó cobertura: las cifras del informe anterior no representan estos cambios nuevos.

## Dependencias y adaptador MinIO

No se usó `npm audit fix --force` ni se cambió la versión mayor de Prisma. Algunas correcciones requirieron cambiar API de paquetes y se probaron explícitamente.

MinIO permanece fijado a 8.0.7. `evolution-api/scripts/patch-minio.cjs` adapta únicamente sus dos imports de parser JSONL y las llamadas de construcción del stream a stream-json 3.7. Es idempotente, se ejecuta en postinstall y falla si cambia MinIO. La prueba procesa una notificación real del parser en CJS y ESM, sin servidor S3 externo. No quitar este adaptador mientras se conserve el override.

Referencia del aviso de Baileys: https://github.com/WhiskeySockets/Baileys/security/advisories/GHSA-qvv5-jq5g-4cgg. La ausencia de avisos se verifica contra el registro npm en esta ejecución, no por asumir que «latest» sea seguro.

## Paquete y despliegue

- Extensión de producción preparada: `extension/dist/lyn-superagente-extension.zip`, manifiesto **1.1.4**, hosts exclusivamente CEO/WhatsApp, sin secretos. No se ha subido ni se verificó la versión actualmente reservada en la tienda.
- El polling nuevo requiere publicar esa extensión; el backend mantiene el endpoint de último informe para versiones anteriores, pero no incorpora automáticamente la nueva UI a una versión ya instalada.
- CI ahora incluye Evolution, seguridad de dependencias, compatibilidad y análisis estático. La ejecución de GitHub Actions sobre este cambio está pendiente de subirlo; no se informa como aprobada.
- El script requiere Node 22.16+ de rama 22 o Node 24 y conserva cuentas/activaciones/configuración. No requiere reinstalar ni reactivar la extensión por diseño.
- El deploy conserva el HTML anterior y revierte ese HTML si falla la recarga de nginx. **No es rollback automático del backend ni de migraciones**. El despliegue sigue siendo in-place y necesita ventana de mantenimiento y respaldo verificable.
- Antes de aplicar: respaldar DB y última release; verificar espacio, Node y entorno; ejecutar preflight; aplicar migraciones/build; verificar `/ready`; publicar assets/HTML; comprobar login, permisos, Drive y WhatsApp en el entorno destino.
- No ejecutar un rollback de DB automático: las migraciones y datos nuevos deben evaluarse antes de restaurar. Para volver al frontend anterior puede restaurarse `.index.html.previous`; los assets permanecen disponibles.

## Reservas explícitas

1. Recepción/envío/reconexión de WhatsApp con Baileys nuevo: no ejecutadas por elección del usuario; se necesita cuenta y chat de pruebas.
2. Ensayo Linux/systemd/nginx y restauración desde respaldo: no ejecutado. El equipo no dispone de Docker ni WSL instalado. Bash se valida localmente, pero no representa el servidor destino.
3. No se repitió un login corporativo interactivo ni una autorización OAuth/Drive real en esta ronda. Los escenarios de permisos/Drive se regresionan con fixtures; la aceptación previa de Supabase no se presenta como login nuevo probado.

No hay fallos pendientes en las comprobaciones locales ejecutadas. Estas reservas deben acompañar cualquier decisión de despliegue del proyecto completo.

## Evidencia

Logs locales ignorados en `.runtime-logs/`: `remediation-quality-gate-node22-final.log`, `remediation-gemini-live.log`, `remediation-node22.log`, `remediation-*-audit-final.json`, `remediation-*-lockcheck.log`. Las pruebas están en el repositorio para repetirlas sin depender de los logs.
