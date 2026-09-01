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
GOOGLE_DRIVE_SYNC_MAX_FILES=1000
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

## Identificación y nomenclatura

Al importar una transcripción, nota o documento, el Dashboard identifica el tipo de reunión y busca los campos **PMC**, **Obra/Proyecto** y **Contacto/Cliente** en los metadatos de Drive, el nombre del archivo y las primeras 20.000 letras del texto. La nomenclatura operativa es:

- `Comité de obra · {PMC}` para los comités de obra.
- `Reunión cliente · {Obra}` para reuniones con cliente.
- `Reunión · {Obra|PMC|Contacto}` si no se detecta uno de los dos tipos anteriores.

Los valores detectados se muestran en la bandeja y permanecen editables en el panel lateral. Las correcciones manuales se conservan y siempre prevalecen sobre una detección posterior. Para obtener la mayor precisión, usa encabezados independientes en la transcripción, por ejemplo: `PMC: Laura M.`, `Obra: Villajoyosa 12` y `Contacto: Marta S.`.


## Análisis IA de reuniones

Al importar una transcripción nueva o modificada, el servidor la encola automáticamente y la analiza una única vez por versión del documento y del analizador. La bandeja actualiza su estado periódicamente y la reunión se abre con el resultado ya guardado. El servidor envía como máximo `MEETING_AI_TEXT_MAX_CHARS` caracteres al modelo y exige una respuesta JSON estructurada. Guarda el resumen, decisiones, fecha real de la reunión, identidad, acciones y bloqueos en la base de datos central. Cuando la transcripción contiene marcas temporales, las referencias se conservan como minutos verificables. El botón del panel lateral se reserva para una regeneración explícita.

- La cola procesa por defecto un documento cada 20 segundos (`MEETING_AI_ANALYSIS_BATCH_SIZE=1`) para controlar coste. Una versión ya completada o fallida no se vuelve a enviar automáticamente; solo se reencola si Drive detecta una versión nueva o se publica una versión explícita del analizador que requiere una migración puntual.
- Las acciones generadas se identifican como **IA** y una nueva generación sustituye solo esas acciones; las añadidas o editadas manualmente se conservan.
- Los bloqueos detectados se regeneran a partir de la fuente y quedan visibles junto a los bloqueos de aprobación por responsable o fecha.
- Cada ejecución conserva proveedor, modelo, tamaño de contexto, respuesta estructurada, usuario y fecha en el historial auditable.
- Si Gemini no está disponible, el análisis no se guarda y el panel muestra un error; nunca se persiste un resultado de fallback como si fuera IA.
