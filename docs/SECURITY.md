# Seguridad de producción

## Perímetro de la API

La API pública solo deja sin sesión dos operaciones: `POST /api/auth/ceo-login` y `POST /api/extension/invitations/redeem`. Todas las demás rutas requieren una de estas credenciales:

- Una sesión firmada de CEO con rol `superadmin`, `admin` o `CEO`.
- Una activación de extensión válida, únicamente para el conjunto reducido de rutas de sincronización, mensajes, resúmenes y respuestas.

Las rutas legacy de Evolution no son accesibles a una extensión y quedan bloqueadas sin sesión CEO. El canje de invitaciones y el inicio de sesión tienen límites de intentos específicos.

## Extensión oficial

En producción se debe definir `CHROME_EXTENSION_IDS` con el identificador de 32 caracteres asignado por Chrome Web Store. Se admite más de un ID separado por comas para una migración controlada.

```env
CHROME_EXTENSION_IDS=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

El backend rechaza cualquier origen de extensión presente que no esté en esa lista. Las solicitudes sin encabezado `Origin` siguen requiriendo una activación válida; CORS no concede acceso a sitios externos. No uses un comodín ni agregues IDs de extensiones de desarrollo en producción.

## Activaciones

- Los códigos `LYN1` tienen secreto aleatorio, se almacenan con hash y se canjean una sola vez.
- El vencimiento aplica al código pendiente, no a una activación ya canjeada.
- Invalidar un código desde el Dashboard CEO también revoca la activación asociada de inmediato.
- Cada activación queda asociada a una única cuenta de WhatsApp y el backend aplica ese alcance a las rutas de extensión.

## Secretos y red

- `GOOGLE_GEMINI_API_KEY`, `GOOGLE_DRIVE_CLIENT_SECRET`, `GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY`, `EVOLUTION_API_KEY`, `DATABASE_URL`, `WEBHOOK_SECRET` y `CEO_SESSION_SECRET` viven exclusivamente en `/etc/lyn/*.env`; nunca en la extensión, el frontend ni Git.
- Google Drive usa OAuth con `drive.readonly`. Los tokens de acceso y renovación se cifran con AES-256-GCM antes de persistirse. Rotar `GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY` invalida las conexiones existentes, que deberán autorizarse de nuevo.
- El backend y PostgreSQL deben permanecer en `127.0.0.1`; Nginx es el único servicio expuesto a Internet.
- `CORS_ALLOWED_ORIGINS` debe contener únicamente el dominio HTTPS del Dashboard CEO.
- Rota inmediatamente cualquier secreto que se haya pegado en un chat, consola compartida o repositorio.

## RLS de PostgreSQL

El aislamiento operativo actual se aplica en el backend con activación por cuenta y consultas con `account_id`. RLS de PostgreSQL no debe habilitarse de forma parcial: requiere separar el rol migrador del rol de ejecución y establecer el contexto de cuenta en cada transacción. Ese cambio debe hacerse como migración dedicada, con respaldo y pruebas de restauración, antes de activarlo en la base de producción.
