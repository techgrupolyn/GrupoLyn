# Google Drive y Google Meet

## Alcance

La integración permite que administradores del Dashboard conecten una o varias cuentas Google por OAuth, registren varias carpetas de Drive y sincronicen las reuniones disponibles. El permiso solicitado es exclusivamente `drive.readonly`; no se crean, editan, mueven ni comparten archivos de Drive.

- Las grabaciones y audios permanecen en Google Drive y el Dashboard muestra un enlace al original.
- Las transcripciones de Google Docs y archivos de texto compatibles se guardan hasta `GOOGLE_DRIVE_TEXT_MAX_CHARS` para consulta posterior.
- Los vídeos y audios permanecen como referencias. Las transcripciones y documentos de texto nuevos o modificados se encolan para un único análisis automático, con auditoría y límite de contexto.

## Google Cloud

1. Crea o selecciona el proyecto Google Cloud de la integración.
2. Habilita Google Drive API y Google Calendar API.
3. Configura Google Auth Platform como **Interno** si todas las cuentas pertenecen al Workspace corporativo.
4. Solicita los scopes `https://www.googleapis.com/auth/drive.readonly` y `https://www.googleapis.com/auth/calendar.events.readonly`.
5. Crea un cliente OAuth de tipo **Aplicación web**.
6. Registra el origen `https://ceo.grupolyn.com` y el callback `https://ceo.grupolyn.com/api/integrations/google-drive/oauth/callback`.

## Producción

En `/etc/lyn/backend.env` define:

```env
GOOGLE_DRIVE_CLIENT_ID=...
GOOGLE_DRIVE_CLIENT_SECRET=...
GOOGLE_DRIVE_OAUTH_REDIRECT_URI=https://ceo.grupolyn.com/api/integrations/google-drive/oauth/callback
GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY=...
GOOGLE_DRIVE_SYNC_PAGE_SIZE=1000
GOOGLE_DRIVE_SYNC_INTERVAL_MS=60000
GOOGLE_DRIVE_TEXT_MAX_CHARS=200000
MEETING_AI_TEXT_MAX_CHARS=60000
MEETING_AI_ANALYSIS_INTERVAL_MS=20000
MEETING_AI_ANALYSIS_BATCH_SIZE=1
```

Genera `GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY` con:

```bash
openssl rand -hex 32
```

Tras desplegar, entra con `superadmin`, abre **Reuniones**, pulsa **Conectar Google Drive**, inicia sesión con la cuenta que tiene permiso de lector y registra cada carpeta por URL o ID. La primera sincronización comienza automáticamente y se repite cada `GOOGLE_DRIVE_SYNC_INTERVAL_MS`; el botón manual sirve para forzar una revisión inmediata.

## Operación segura

- Usa una cuenta corporativa dedicada o con acceso únicamente a las carpetas de reuniones.
- Comparte las carpetas con permiso **Lector**; nunca actives enlaces públicos.
- Si una carpeta deja de ser necesaria, usa **Desactivar**: detiene sincronizaciones futuras sin borrar el historial ya importado.
- La integración recorre subcarpetas, deduplica por ID de archivo de Google Drive y consulta cada carpeta activa cada 60 segundos por defecto. Solo guarda y extrae de nuevo archivos nuevos o modificados.
- La lectura procesa todas las páginas, incluidas páginas vacías con continuación, y resuelve accesos directos a archivos y carpetas accesibles por la cuenta conectada. En unidades compartidas consulta la unidad concreta. Los destinos de accesos directos deben tener sus propios permisos de lectura.
- `GOOGLE_DRIVE_SYNC_PAGE_SIZE` controla el tamaño de página (10–1000), no un límite total de archivos. Por compatibilidad se admite `GOOGLE_DRIVE_SYNC_MAX_FILES` como tamaño de página cuando la nueva variable no existe; ya no trunca el recorrido.
- Los archivos se importan según se leen las páginas, priorizando modificaciones recientes dentro de cada carpeta. Un archivo inaccesible no bloquea los restantes. Los errores parciales y `incompleteSearch` se guardan en `last_sync_error`; `last_synced_at` solo avanza al completar un ciclo sin incidencias. El siguiente ciclo vuelve a intentar los archivos fallidos.
- El ciclo y la cola de análisis se ejecutan en el servidor, independientemente de que haya usuarios conectados. El gestor consulta novedades cada 15 segundos y conserva los filtros y permisos de cada usuario. No hace falta pulsar «Sincronizar» para importar reuniones nuevas.
- El registro `[google-drive] Resultado de sincronización` indica carpeta, archivos leídos, importados, actualizados, errores y si se completó el ciclo. No contiene tokens ni texto de documentos.

## Identificación y nomenclatura

Al importar una transcripción, nota o documento, el Dashboard identifica el tipo de reunión y busca los campos **PMC**, **Obra/Proyecto** y **Contacto/Cliente** en los metadatos de Drive, el nombre del archivo y las primeras 20.000 letras del texto. La nomenclatura operativa es:

- `Comité de obra · {PMC}` para los comités de obra.
- `Reunión cliente · {Obra}` para reuniones con cliente.
- `Reunión · {Obra|PMC|Contacto}` si no se detecta uno de los dos tipos anteriores.

Los valores detectados se muestran en la bandeja y permanecen editables en el panel lateral. Las correcciones manuales se conservan y siempre prevalecen sobre una detección posterior. Para obtener la mayor precisión, usa encabezados independientes en la transcripción, por ejemplo: `PMC: Laura M.`, `Obra: Villajoyosa 12` y `Contacto: Marta S.`.


## PMC vinculado en Club LYN

Si falta el PMC, el gestor utiliza las asignaciones del proyecto importadas desde Club LYN (miembros del proyecto y cargos del organigrama vinculados a ese proyecto). Solo completa nombre e identificador cuando existe un único empleado activo con rol PMC/Jefe de Proyectos. Los cargos globales, proyectos ambiguos y proyectos con varios PMC distintos no generan una asignación automática.

Todos los PMC y delineantes/planimetristas activos vinculados al proyecto se guardan en `pmc_assignments`, deduplicados por empleado. Los delineantes aparecen como **PMC en prácticas** en el desplegable del equipo, tanto en la lista como en el detalle. Los filtros por persona y rol incluyen a todo el equipo. Si no existe PMC y solo hay un delineante, también completa el campo principal y `pmc_in_training`; si hay varios, quedan todos vinculados sin inventar un principal. No cambia cargos ni permisos globales y no asigna automáticamente las tareas del proyecto a todos ellos.

Se aplica durante el análisis de nuevas reuniones, al guardar su identificación y tras cada sincronización del directorio a las existentes. Se actualiza el equipo si cambian sus miembros, pero se conserva el PMC principal manual. Las reuniones editadas manualmente solo reciben un PMC principal si nombre e identificador están vacíos; un proyecto ya vinculado no se sustituye. No modifica datos de Club LYN ni necesita volver a enviar transcripciones a la IA para completar reuniones existentes.

Para vincular proyectos se priorizan el ID existente, el nombre o alias inequívoco y el título del documento, antes de las menciones en la transcripción. Se normalizan prefijos de fase/obra/proyecto y fechas finales, y se permiten nombres compuestos con todos sus términos presentes en el título. No se vinculan proyectos por coincidencias parciales dentro de otra palabra, por un nombre de pila aislado, ni se confunden números de obra distintos. Una reunión que menciona varias obras o cuya obra no existe en el catálogo requiere identificación adicional; no se crea un proyecto ficticio para eliminar el pendiente.

## Análisis IA de reuniones

Al importar una transcripción nueva o modificada, el servidor la encola automáticamente y la analiza una única vez por versión del documento y del analizador. La bandeja actualiza su estado periódicamente y la reunión se abre con el resultado ya guardado. El servidor envía como máximo `MEETING_AI_TEXT_MAX_CHARS` caracteres al modelo y exige una respuesta JSON estructurada. Guarda el resumen, decisiones, fecha real de la reunión, identidad, acciones y bloqueos en la base de datos central. Cuando la transcripción contiene marcas temporales, las referencias se conservan como minutos verificables. El botón del panel lateral se reserva para una regeneración explícita.

- La cola procesa por defecto un documento cada 20 segundos (`MEETING_AI_ANALYSIS_BATCH_SIZE=1`) para controlar coste. Una versión ya completada o fallida no se vuelve a enviar automáticamente; solo se reencola si Drive detecta una versión nueva o se publica una versión explícita del analizador que requiere una migración puntual.
- Las acciones generadas se identifican como **IA** y una nueva generación sustituye solo esas acciones; las añadidas o editadas manualmente se conservan.
- Los bloqueos detectados se regeneran a partir de la fuente y quedan visibles junto a los bloqueos de aprobación por responsable o fecha.
- Cada ejecución conserva proveedor, modelo, tamaño de contexto, respuesta estructurada, usuario y fecha en el historial auditable.
- Si Gemini no está disponible, el análisis no se guarda y el panel muestra un error; nunca se persiste un resultado de fallback como si fuera IA.
