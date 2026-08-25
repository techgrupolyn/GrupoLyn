# Google Drive y Google Meet

## Alcance

La integración permite que administradores del Dashboard conecten una o varias cuentas Google por OAuth, registren varias carpetas de Drive y sincronicen las reuniones disponibles. El permiso solicitado es exclusivamente `drive.readonly`; no se crean, editan, mueven ni comparten archivos de Drive.

- Las grabaciones y audios permanecen en Google Drive y el Dashboard muestra un enlace al original.
- Las transcripciones de Google Docs y archivos de texto compatibles se guardan hasta `GOOGLE_DRIVE_TEXT_MAX_CHARS` para consulta posterior.
- Ningún vídeo, audio o documento se envía automáticamente al proveedor IA. El análisis IA requiere una función explícita posterior, con control de coste y auditoría.

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
GOOGLE_DRIVE_TEXT_MAX_CHARS=200000
```

Genera `GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY` con:

```bash
openssl rand -hex 32
```

Tras desplegar, entra con `superadmin`, abre **Reuniones**, pulsa **Conectar Google Drive**, inicia sesión con la cuenta que tiene permiso de lector y registra cada carpeta por URL o ID. Ejecuta la primera sincronización manualmente y comprueba la lista de archivos importados.

## Operación segura

- Usa una cuenta corporativa dedicada o con acceso únicamente a las carpetas de reuniones.
- Comparte las carpetas con permiso **Lector**; nunca actives enlaces públicos.
- Si una carpeta deja de ser necesaria, usa **Desactivar**: detiene sincronizaciones futuras sin borrar el historial ya importado.
- La integración recorre subcarpetas, deduplica por ID de archivo de Google Drive y vuelve a extraer texto únicamente cuando el archivo cambia.