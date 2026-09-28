# Pruebas reales — 27/09/2026

Estado: **en curso; no cerrar QA ni desplegar basándose en esta sesión parcial**.

## Entorno y autorización

- Backend local 3003, dashboard 5173 y Evolution 8080, código modificado localmente.
- PostgreSQL aislado 127.0.0.1:55439: `lyn_qa_live` y `lyn_evolution_qa_live`, creadas exclusivamente para estas pruebas. No se utilizan las bases productivas ni la base de regresiones.
- El usuario inició sesión personalmente con superadmin y vinculó su WhatsApp mediante QR. Autorizó el chat individual Zuri, facilitó su número y autorizó el grupo «apolinar karaoke». Se verificó el número mediante `whatsappNumbers` antes de enviar un único mensaje identificado como prueba a Zuri. No se enviaron mensajes a otros destinatarios.
- Sin sincronización Supabase, análisis IA automático ni sincronización periódica masiva. Webhooks habilitados para recibir eventos reales; WhatsApp no se configura para marcar mensajes/estados leídos ni presencia permanente. `syncFullHistory=false` no impide todos los eventos iniciales que envía WhatsApp.
- No se hizo commit, push ni despliegue. Producción solo recibió tres GET de comprobación.
- Cambio de alcance del usuario: continuar únicamente con recepción pasiva, sin enviar más mensajes ni pedir mensajes artificiales al grupo. El envío anterior a Zuri permanece como evidencia histórica; no se repite. No se generan resúmenes IA en esta comprobación de recepción.

## Resultados observados

| Prueba | Resultado | Alcance |
| --- | --- | --- |
| Login real superadmin | Aprobado | Sesión introducida por el usuario, nombre/rol visibles y acceso a reuniones y configuración. |
| Backend local listo | Aprobado | `/ready` devuelve JSON 200 `ok:true`. |
| Migraciones Evolution | Aprobado local | 57 migraciones aplicadas a una base nueva de QA; no acredita migración sobre datos productivos. |
| Arranque Evolution | Aprobado | HTTP 200; arranque inicial lento, aproximadamente 75 segundos. |
| Vinculación QR | Aprobado | Estado de instancia `open` tras escanear el usuario. |
| Reconexión real | Aprobado | Reinicio exclusivo del proceso Evolution QA conservando su DB; vuelve a `open` sin otro QR. |
| Cuenta en dashboard | Preparada | La cuenta predeterminada de la DB nueva estaba inactiva. Se habilitó exclusivamente en QA mediante PATCH autenticado como superadmin. No se modificó el estado de cuentas productivas. |
| Salud productiva | Observado | `/health` devuelve JSON 200 `lyn-production`; informe global sin credenciales devuelve 401. |
| Readiness productivo por HTTPS | No acredita readiness | `/ready` devuelve HTML del frontend, no JSON del backend. El script de despliegue usa el puerto backend local, no esa URL pública. |
| Envío real a Zuri | Aprobado en Evolution | Número autorizado verificado, destinatario de respuesta coincidente y un único envío. Confirmaciones `SERVER_ACK` y `DELIVERY_ACK` persistidas en MessageUpdate. No acredita el flujo de envío de la extensión: `/api/enviar` está diseñado exclusivamente para grupos. |
| Recepción de respuesta de Zuri | Aprobado en Evolution | Mensaje entrante con marca QA registrado el 27/09 a las 23:41:13 (UTC−4) y posteriores, incluido uno a las 23:44:08 con DELIVERY_ACK. Consulta solo de metadatos del contacto autorizado, sin llamadas de lectura ni envíos. El backend mantiene 0 mensajes individuales de Zuri porque el webhook filtra chats no grupales; no acredita recepción de grupos ni informe global. |
| Identificación de Apolinar karaoke | Aprobado | Localizado en Contact de la instancia QA mediante filtro por nombre y dirección de grupo. No se leyó el directorio completo. |
| Recepción pasiva del grupo | Aprobada tras revinculación | Apolinar karaoke tiene 1195 mensajes entrantes en Evolution y en el backend local. Contador 39 en ambos; véase cierre del 28/09. |
| Configuración de recepción | Aprobado | Instancia open; webhook habilitado hacia 127.0.0.1:3003 con eventos de mensajes/chats/conexión; readMessages y readStatus desactivados. Sin historial completo. No se provocó sincronización ni lectura. |
| Contadores y disponibilidad real | Aprobado para Apolinar | 39 pendientes en ambas bases y 39 mensajes disponibles en la ventana de pendientes sin revisar. No se modificaron contadores manualmente. |
| Resumen individual y descuento real | Aprobado para el lote probado | Tres resúmenes persistidos, contador 39 → 3 → 1 → 0; 39 identificadores revisados. Otros chats sin cambios; Evolution conserva 39. La recuperación y análisis real de los tres adjuntos inicialmente pendientes se detalla al final. |
| Informe global real | Pendiente | Esta prueba analiza solo Apolinar; no se autoriza ni ejecuta el análisis de todos los chats personales. |
| Roles empleado/PMC/director | Pendiente | Superadmin no sirve para validar restricciones de otros roles. |
| OAuth/Drive y Linux | Pendiente | No ejecutados en esta sesión. |

## Incidencia real y corrección local

Se observaron `PayloadTooLargeError` en el backend al recibir lotes de sincronización inicial. Su parser admite 10 MB y Evolution reenviaba el lote completo repetidamente.

Corrección local en el emisor de webhooks:

- Fragmenta eventos de listas de mensajes/chats/contactos en lotes de hasta 512 KiB, conservando orden, instancia y elementos; no limita el total de mensajes.
- Si el receptor responde 413, reduce nuevamente el lote cuando es divisible.
- Un elemento individual demasiado grande falla explícitamente, sin reintentar indefinidamente el mismo 413 ni descartarlo silenciosamente.
- No cambia el límite global del backend ni desactiva autenticación.
- Cinco regresiones aprobadas con lote sintético de más de 10 MB, UTF-8, conservación de orden, 413 y elementos indivisibles. Tipos y compilación Evolution aprobados. Integradas en control local y CI.

La instancia QA fue reiniciada con esta corrección y reconectó. En ese momento faltaba acreditar otro lote real; la revinculación posterior permitió validar la entrega de historial para Apolinar, como se detalla en el cierre. Los 232 tests del informe anterior corresponden a su ejecución anterior; estas cinco pruebas son adicionales, no una nueva ejecución completa de 237 tests.

No almacenar en este informe QR, tokens, contraseñas, números completos ni contenido de conversaciones reales.

## Discrepancia de pendientes comunicada por el usuario

El usuario ve 39 mensajes sin leer en Apolinar karaoke en WhatsApp. La base QA seguía sin Chat ni Message del grupo, aunque Contact sí lo identifica. Ese cero representa datos locales ausentes, no cero pendientes en el teléfono.

Se identificó otra causa local: faltaba `DATABASE_SAVE_DATA_HISTORIC=true` en el entorno Evolution. La configuración convierte su ausencia en false. El manejador de `messaging-history.set` emite webhooks, pero solo guarda Chat y Message cuando ese flag es true. Los logs confirman recepción de lotes de historial; su entrega inicial también sufrió los 413 documentados. Reiniciar no acredita que WhatsApp reenvíe un historial ya procesado.

Se añadió el flag al `.env` local (ignorado por Git). No se modificó el contador manualmente a 39 ni se fabricaron mensajes. La recuperación del historial y la comparación con los pendientes reales siguen abiertas: cambiar configuración no recupera por sí solo lo que no se guardó. Producción no se modificó.

Evolution QA se reinició con el flag explícito y volvió a `open` sin otro QR. La comprobación posterior seguía devolviendo 0 mensajes almacenados del grupo: ese reinicio no recuperó el historial perdido. Falta repetir la vinculación QA para solicitarlo de nuevo y comprobar su persistencia y contador; no se cerró la sesión sin participación del usuario.

### Corrección adicional del contrato de contador e historial

Al revisar la discrepancia se encontraron y corrigieron más pérdidas de información:

- `persistChat` no aceptaba `unreadMessages`, aunque Evolution lo devuelve. Ahora reconoce ese campo además de los formatos anteriores.
- El manejador de historial de Evolution eliminaba `unreadCount` al preparar Chat y omitía chats ya existentes. Ahora conserva el contador cuando está presente, actualiza por instancia y chat, y no inventa un cero cuando falta el dato.
- El backend ignoraba el contenido de MESSAGES_SET/CHATS_SET y volvía a consultar Evolution. Ahora persiste los eventos recibidos directamente, sin depender de una consulta concurrente a una base que podía no haber guardado el lote todavía.
- Importar o repetir mensajes históricos no incrementa pendientes ni dispara clasificación IA. La carga del último mensaje de un snapshot y la sincronización de historial usan el mismo modo histórico.

Regresión aislada Q-04: 45 mensajes históricos con un snapshot de 39 pendientes conservan 39 después de importar y repetir; tras una base revisada de 10, repetir el snapshot conserva 29; un evento sin contador no lo borra y un cero explícito lo restablece. Estos datos son sintéticos y no se introdujeron en la base del WhatsApp real.

Validación de esta corrección: 137 pruebas backend aprobadas (la live opt-in omitida), 6 regresiones de lotes/contador Evolution aprobadas, tipos y build correctos. Backend y Evolution QA reiniciados con la corrección, sesión WhatsApp open. La consulta posterior del grupo real sigue sin Chat/Message: **arreglo probado y aplicado localmente, recuperación de los 39 mensajes reales aún pendiente**. No se afirma recepción real completa ni aptitud productiva por estos resultados.

## Cierre de recepción del 28/09/2026

El usuario volvió a vincular la instancia QA y confirmó «Vinculado». El historial terminó de recibirse (progreso 100%). Las comprobaciones finales de solo lectura muestran:

- Evolution: Apolinar karaoke, 1195 mensajes entrantes almacenados y 39 pendientes.
- Backend: el mismo grupo y 1195 mensajes entrantes, `unread_count=39`, `whatsapp_unread_count=39`, `reviewed_unread_baseline=0`.
- La consulta equivalente a la ventana usada por `getUnreadMessageContext` encuentra 39 mensajes pendientes disponibles y no revisados, no solamente un contador sin contenido.
- Instancia `open`, backend `/ready` con `ok:true`, registro de errores del proceso backend reiniciado vacío. Webhooks de historial con respuestas 200.

Corrección de la comprobación diagnóstica: el backend almacena identificadores con prefijo de cuenta (`default::`). Consultar únicamente el identificador WhatsApp sin prefijo devolvía cero filas aunque ya hubiera datos. Esas consultas anteriores no acreditan ausencia de datos en el backend. La comparación final usa el identificador interno correcto y el filtro de cuenta. El cero inicial observado directamente en Evolution y los errores 413 históricos son incidencias distintas.

Los apartados anteriores describen la secuencia de investigación; su pendiente de recuperación queda sustituido por esta comprobación final. No se enviaron nuevos mensajes, no se marcaron como leídos y no se generó ningún informe IA. El descuento real tras un resumen sigue sin probarse en esta cuenta por el alcance autorizado. No se modificó producción ni se acredita con esta prueba que todo el proyecto esté libre de errores.

## Resumen individual real autorizado — 28/09/2026

Posteriormente el usuario autorizó expresamente el envío de los pendientes de Apolinar karaoke y los adjuntos procesables a Google Gemini. Se ejecutó una única petición a `/api/chat/summary` en el backend local, no el informe global.

- HTTP 200 en 9,6 segundos; resumen ID 1, 702 caracteres, persistido en `resumenes_chat`.
- Proveedor `gemini`, modelo `gemini-3.6-flash`, `ai_fallback=false`.
- 36 mensajes incluidos y 36 identificadores guardados; contador interno de 39 a 3, base revisada 36.
- Los tres restantes son un audio sin transcripción y dos registros de tipo texto sin contenido. El endpoint los excluye y no los marca como analizados. Esto deja pendiente resolver su tratamiento; no acredita análisis completo de los 39 ni comprensión de todos los adjuntos.
- Huella agregada de los contadores del resto de chats idéntica antes/después: no se descontaron pendientes ajenos.
- Evolution conserva 39 pendientes para Apolinar; no se invocó envío de mensajes ni confirmación de lectura WhatsApp.

Esta comprobación valida respuesta IA real, persistencia y descuento exclusivo de los mensajes incluidos. No valida todavía el informe global con todos los grupos, el flujo visual completo de la extensión ni un contador cero cuando existen contenidos no procesados. Producción no se modificó.

## Resolución de los tres pendientes — 28/09/2026

El usuario autorizó continuar. Los dos registros aparentemente vacíos contenían vídeos dentro de `associatedChildMessage.message`; el extractor solo inspeccionaba el primer nivel. El tercer pendiente era un audio excluido expresamente por no tener texto.

Correcciones locales:

- Normalización de envoltorios conocidos sin confundir mensajes citados con contenido nuevo; aplicada a la extracción de texto, tipo, metadatos y descarga.
- Recuperación de datos ya almacenados al construir el contexto pendiente, conservando el original `raw` y el aislamiento por cuenta.
- Inclusión de audio en el resumen. Un adjunto sin texto solo se descuenta si se recuperó y se incluyó realmente en la petición; los omitidos por límite o fallo de descarga permanecen pendientes.
- Los archivos enviados corresponden exclusivamente a los mensajes seleccionados para ese resumen.
- Soporte Files para peticiones multimedia grandes, espera del estado ACTIVE y limpieza de las copias temporales en `finally`, incluso si falla el análisis. Restricción del destino de subida al dominio oficial; timeout y errores visibles sin descontar pendientes.
- Límite local `MAX_MEDIA_ANALYSIS_BYTES=52428800` (50 MiB) para admitir el vídeo de 27.477.728 bytes. El `.env` es local e ignorado por Git; no cambia la configuración productiva ni elimina el límite de recursos. Un despliegue futuro requerirá decidir expresamente esa configuración.

Referencia técnica utilizada: [Files API de Google Gemini](https://ai.google.dev/gemini-api/docs/files), con referencias URI en [Interactions](https://ai.google.dev/api/interactions-api).

Resultados reales:

| Operación | Resultado |
| --- | --- |
| Audio y primer vídeo recuperado | Resumen ID 2, Gemini sin fallback, HTTP 200 en 20,2 s, 487 caracteres; 2 incluidos, contador 3 → 1. |
| Vídeo de 27 MB mediante Files | Resumen ID 3, Gemini sin fallback, HTTP 200 en 18,7 s, 276 caracteres; 1 incluido, contador 1 → 0. La ruta ejecutó la limpieza sin advertencias. |
| Persistencia final | 3 resúmenes con 36 + 2 + 1 identificadores; 39 registros en el ledger de revisados. |
| WhatsApp | Contador Evolution 39; contador interno 0 y base revisada 39. No se enviaron mensajes ni confirmaciones de lectura. |
| Otros chats | Huella de contadores idéntica antes/después de cada prueba. |
| Repetir sin pendientes | HTTP 422 indicando ausencia de mensajes pendientes; no genera otro resumen. |

Validación automatizada final: **145 pruebas backend aprobadas, 1 live opt-in omitida**, TypeScript y `git diff --check` correctos. Incluye envoltorios anidados, audio, conservación de adjuntos no disponibles, no repetición, Files, rechazo de destinos ajenos y limpieza tras fallo de IA. Una ejecución intermedia tuvo un error de tabla por faltar `DATABASE_URL` aislada; se repitió correctamente fijando ambas variables a `lyn_qa_retest`.

Alcance: recepción y resumen individual vía API local. No se ha probado aquí el informe global real de todos los grupos ni la interacción visual completa de la extensión. El primer resumen de 36 elementos se ejecutó antes de la corrección de selección multimedia; sus identificadores no acreditan análisis binario de todos sus adjuntos. No se reprocesaron esos mensajes automáticamente ni se presenta esta prueba como garantía de cero bugs. Sin commit, push ni despliegue.
