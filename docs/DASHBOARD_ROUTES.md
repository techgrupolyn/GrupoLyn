# Rutas del Dashboard

La navegación del Dashboard separa las vistas de operación de la configuración de cada dominio. Esta reorganización es únicamente de interfaz y rutas: no altera endpoints ni datos almacenados.

## Vistas operativas

| Área | Ruta | Uso |
| --- | --- | --- |
| General | `/?view=dashboard` | Resumen ejecutivo |
| General | `/?view=ai` | Consultas a la IA |
| Agente de reuniones | `/?view=meetings` | Bandeja de revisión, acciones, bloqueos y aprobación de reuniones |
| Superagente WhatsApp | `/?view=groups`, `labels`, `templates`, `business` | Operación de WhatsApp |

## Configuración

La configuración se abre en `/?view=settings`. Si no se indica `tab`, se muestra `general`.

| Sección | Ruta |
| --- | --- |
| General | `/?view=settings&tab=general` |
| WhatsApp | `/?view=settings&tab=whatsapp` |
| Agente de reuniones / Google Drive | `/?view=settings&tab=meetings` |
| Router de agentes | `/?view=settings&tab=router` |
| Integraciones | `/?view=settings&tab=integrations` |

`/?view=meetings` muestra un aviso descartable que indica la nueva ubicación de la configuración de Google Drive. El aviso se guarda solamente en el navegador del usuario.

## Desvincular WhatsApp

En **Configuración > WhatsApp > Cuentas WhatsApp**, un desplegable permite seleccionar una sola cuenta. Su conexión se consulta en Evolution mediante `GET /api/whatsapp-accounts/:id/status`, sin caché, al seleccionar o actualizar las cuentas. Solo una cuenta conectada muestra **Desvincular**; una sesión cerrada muestra **Desvinculada**, y un QR pendiente muestra **Pendiente de vincular**. Los fallos de consulta muestran **Estado no disponible**, nunca una falsa desconexión. El formulario **Añadir una cuenta** permanece plegado por defecto.

El botón **Desvincular** solicita confirmación con el nombre e instancia y cierra únicamente esa sesión mediante `POST /api/whatsapp-accounts/:id/disconnect`. Ambos endpoints están restringidos a administradores del dashboard. No se eliminan la instancia, la cuenta, los chats, los mensajes ni los informes almacenados; tampoco se revoca la activación de la extensión. Tras confirmar la desvinculación desaparece el botón. Para reconectar se debe escanear un nuevo QR desde la extensión asociada. La etiqueta «Cuenta habilitada» describe su habilitación en el dashboard, no su conexión a WhatsApp. Si Evolution falla, se muestra el error y se permite reintentar sin anunciar una desvinculación exitosa.

## Compatibilidad

### Grabaciones de reuniones en Drive

El detalle conserva su diseño y añade un botón secundario **Ver vídeo**, con icono de cámara y apertura en otra pestaña. Drive comprueba los permisos del usuario que abre el enlace; guardar el ID no comparte el vídeo ni modifica la ACL. No se descargan vídeos ni se llama a endpoints de permisos.

- La identidad actual es `google_drive_artifacts.id` (UUID local) y `google_file_id` (archivo de notas/transcripción). La ficha procesada vive en `meeting_reviews`; no existe una tabla `meetings` equivalente.
- La migración idempotente `backend/migrations/20261019_meeting_recordings.sql`, ejecutada por `ensureDatabaseSchema`, añade `recording_file_id`, el enum `recording_status` y `recording_checked_at` a `meeting_reviews`. Los existentes comienzan en `pending`. Una restricción impide `available` sin un ID válido o estados sin enlace con un ID residual.
- Primero se consulta la exportación HTML del documento de notas, sin persistirla, para extraer enlaces explícitos con etiqueta `Grabación` o `Recording`. Se admiten enlaces HTTPS de Drive y el envoltorio de enlaces de Google Docs, nunca otros destinos ni etiquetas genéricas. Si no hay enlace explícito, la asociación acepta un único vídeo adjunto al evento de Calendar que contiene el ID exacto del documento fuente, o un único vídeo importado de la misma conexión con el mismo nombre base, fecha y hora de Meet. Se comprueba el ID y MIME de vídeo en Drive antes de guardar. No se compara por similitud de obra ni solo por código Meet, que puede reutilizarse. Las coincidencias múltiples permanecen pendientes; no se elige arbitrariamente una grabación.
- En Calendar se consulta únicamente lectura y se usa la autorización existente `calendar.events.readonly`. Si no existe ese permiso, queda disponible el contraste de archivos ya sincronizados. La grabación debe estar accesible para la conexión del organizador o de la cuenta autorizada; no se amplían permisos ni se accede a otros Drives automáticamente.
- `available`: muestra el enlace generado en el navegador como `https://drive.google.com/file/d/{file_id}/view`, con `noopener noreferrer`. Solo se persiste el ID, no una nueva URL de grabación.
- `pending`: muestra **Grabación en proceso**, sin enlace. Incluye la primera comprobación, una asociación ambigua o una consulta fallida; no certifica que Google esté procesando vídeo en todos esos casos.
- `none`: muestra **Sin grabación** cuando la búsqueda accesible termina sin coincidencias, según la aclaración del solicitante del 19/10/2026. Significa «no encontrada», no prueba que nunca se grabara. No se convierte un 403, 404 o error de red en `none`.
- Los estados `none` y `pending` se vuelven a comprobar al sincronizar el documento o abrir su detalle. El panel consulta el estado cada 30 segundos mientras no esté disponible; el servidor limita las consultas a Google a una cada cinco minutos por reunión y tres concurrentes. Las llamadas externas no bloquean la respuesta del detalle. Los orígenes pausados o revocados no se consultan.
- Consultas autenticadas: `GET /api/meetings/:artifactId/recording` y `GET /api/project-meetings/:artifactId/recording`. Mantienen el ámbito de acceso de su flujo. En el flujo por proyectos se requiere acceso al contenido completo: un usuario con acciones o ramas parciales no recibe el ID del vídeo completo de otras obras, ni siquiera si es Director. Las vistas de resolución de vínculos tampoco lo exponen.

La transcripción y la grabación son artefactos distintos de Meet; no se deduce una grabación por existir texto. Referencias técnicas: [artefactos de Meet](https://developers.google.com/workspace/meet/api/guides/artifacts) y [adjuntos de eventos de Calendar](https://developers.google.com/workspace/calendar/api/v3/reference/events). No se añadió autorización de Meet REST ni se modificaron permisos de Calendar o Drive.

Validación local: pruebas de asociación exacta, enlaces explícitos con entidades HTML, ambigüedad, destinos engañosos, ID inválido, permisos intactos, vídeo tardío, migración repetible, persistencia en PostgreSQL y aislamiento del enlace entre proyectos.

Prueba real de lectura realizada el 19/10/2026: notas del 29/04/2026 a las 15:27 GMT-05:00 y su grabación Meet de 13 min 21 s. El nombre genérico de las notas no coincide con el código Meet del vídeo; su enlace explícito sí permite asociarlos sin inferencias. El servicio local se ejecutó como diagnóstico en memoria con respuestas reales de Google y escrituras interceptadas, sin instalarlo en producción. Se comprobó el destino del enlace en las notas, MIME `video/mp4`, archivo no eliminado y reproducción en Drive. El componente real `MeetingRecording` en una página de prueba local abrió ese mismo ID en una pestaña nueva. Evidencia local privada: `.runtime-logs/recording-real-verified-20261019.json`. Sin escrituras en PostgreSQL de producción ni cambios de ACL; no equivale a un despliegue ni a auditar todo el catálogo.

Despliegue del vídeo realizado el 19/10/2026 sobre una copia del código efectivo de producción, con solo ocho archivos de la función y el bundle del dashboard. No se publicaron los demás cambios locales ni se activó el flujo por proyectos. La versión aislada pasó 35 pruebas, TypeScript y la compilación del frontend. Respaldo verificado en `/var/backups/lyn/pre-video-gBn8oJFS`; reversión con `sudo bash /var/backups/lyn/pre-video-gBn8oJFS/rollback.sh`, conservando las columnas aditivas.

Verificación en producción: la reunión real del 29/04/2026 muestra **Ver vídeo**, persiste `available` y abre el mismo archivo de Drive en una pestaña nueva. La comparación de permisos antes y después coincidió; las consultas a Drive fueron exclusivamente GET y el resto de la ficha permaneció intacto. Una sincronización del directorio ya existente retuvo temporalmente el bloqueo de la fila; el enlace quedó disponible al terminar esa transacción, sin interrumpirla. Evidencia privada en `.runtime-logs/video-release-20261019/production-verification.json` y `production-video-button.png`. Esta prueba confirma la reunión comprobada, no la disponibilidad de grabaciones para todo el catálogo.

Revisión del histórico completada el 19/10/2026: se contrastaron las 868 reuniones de producción (abril a octubre y nueve sin fecha). Quedaron 370 reuniones con enlace explícito de sus notas a un vídeo válido de Drive y 498 sin asociación verificable. Los 868 estados persistidos coinciden con la auditoría; no quedó ninguna comprobación pendiente. Las 370 asociaciones corresponden a 368 vídeos: no se detectó reutilización entre fechas distintas. «Sin grabación» sigue significando «no encontrada con la evidencia y acceso disponibles», no una certificación de que nunca se grabó.

Segunda comprobación de solo lectura: se consultaron los padres reales en Drive de las 498 reuniones no enlazadas y sus archivos hijos, con paginación y sin errores de acceso en esas consultas. Se encontraron cinco candidatos adicionales con nombre/fecha/hora coincidentes. Hay tanto carpetas generales de organizadores como carpetas específicas; compartir carpeta no garantiza identidad: unas notas de Torre del cura del 27/08 están junto a un vídeo del 17/08. En otras carpetas la cuenta conectada solo ve notas, sin vídeo. No se cambiaron asociaciones ni permisos en esta segunda revisión.

Mejora preparada localmente, todavía no desplegada: si no hay asociación previa verificable, consultar los vídeos de las carpetas reales del documento con la misma conexión OAuth. Reconocer fechas `YYYY/MM/DD` y el prefijo «Transcripción del chat:», manteniendo la coincidencia del resto del nombre y la fecha/hora; no elegir por carpeta, fecha aislada o parecido. Las búsquedas incompletas, errores de acceso o múltiples coincidencias no generan enlace. Pruebas: 28 tests unitarios/integración PostgreSQL local y TypeScript correctos; simulación adicional con los metadatos de cinco casos reales, sin escrituras de producción. Evidencia privada de la revisión: `/var/backups/lyn/video-coverage-20261019/folder-audit.jsonl`.

El relleno histórico modificó únicamente los tres campos de grabación y no reanalizó reuniones ni cambió ACL. Se revalidó el enlace explícito antes de guardar vídeos nuevos. Ante bloqueos del sincronizador existente se conservaron las pruebas y se completaron las escrituras con bloqueos de fila `SKIP LOCKED` y transacciones breves, sin interrumpir dicho sincronizador. Auditoría y estados anteriores privados en `/var/backups/lyn/video-coverage-20261019/` (`audit.jsonl`, `applied.jsonl`, `finalize-backup.jsonl`). Comprobación local: diez pruebas de las utilidades, incluida escritura idempotente en PostgreSQL local mediante tablas temporales y rollback. Evidencia de cobertura en `.runtime-logs/video-release-20261019/coverage-production-verified.json`; apertura desde producción y reproducción comprobadas para la reunión del 04/05/2026 a las 14:52 GMT-05:00, con captura `legacy-video-production.png`.

- Las rutas existentes de WhatsApp, Evolution y Google Drive se mantienen.
- Las cuentas, chats y archivos importados conservan su estado.
- Las pestañas `router` e `integrations` reservan el espacio para sus entregas funcionales futuras.

## Gestión de reuniones

Al seleccionar una reunión se abre un panel lateral operativo. Todos los roles con acceso a esa reunión pueden crear y editar acciones y asignar responsables principales o adicionales. Solo PMC/Jefe de Proyectos y Director pueden borrar acciones: no Delineante, Dirección de Operaciones ni superadministrador. El servidor comprueba estos permisos y el alcance del proyecto; ocultar un botón no sustituye la autorización. Estos permisos no conceden edición del resumen, configuración ni acceso a reuniones ajenas.

La cadena de revisión es **Encargado de la reunión → Delineante → PMC**. El encargado se obtiene del organizador vinculado al documento (Google Calendar o asignación administrativa en el panel). Al terminar el análisis, una reunión con encargado activo entra automáticamente en su bandeja. Si falta una persona en una etapa, no se salta a Dirección ni se aprueba automáticamente: hay que completar el encargado o el equipo del proyecto. Una misma persona con varios cargos conserva cada revisión por separado.

El PMC puede aprobar definitivamente o seleccionar un empleado activo para una revisión adicional. Solo ese destinatario recibe el turno y puede aprobar o devolver al PMC. `POST /api/meetings/:artifactId/workflow` acepta `recipient_id` únicamente al aprobar desde PMC. No se reasignan las acciones por cambiar de revisor: **Mis pendientes** y los avisos de acciones siguen mostrando únicamente las asignadas personalmente. **Mi turno** aplica el mismo criterio de revisor que la API de aprobación. El director conserva su acceso administrativo al catálogo, no una bandeja automática de todas las acciones.

La fecha de una acción es opcional; la aprobación se bloquea si quedan acciones pendientes sin responsable. Se conservan auditoría, versiones, reuniones aprobadas y asignaciones existentes. Las revisiones antiguas detenidas en Dirección sin destinatario explícito quedan disponibles al PMC, sin notificar automáticamente a Dirección; las que estaban en Delineante/PMC continúan en su etapa, sin reiniciarse. Las configuraciones antiguas no reactivan la cadena automática a Dirección. El atajo de escalado de Organigrama abre el panel de revisión en lugar de saltar etapas.
