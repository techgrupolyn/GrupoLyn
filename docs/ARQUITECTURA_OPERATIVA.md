# Arquitectura y operación

## Alcance

Superagente WhatsApp es una plataforma interna para operar **chats grupales** de una única cuenta de WhatsApp por instancia. La extensión y el dashboard operativo consumen el mismo backend; el Dashboard CEO es una vista autenticada de la misma aplicación y no muestra ni emite alertas de chat.

La carpeta `evolution-api/` es la dependencia de conexión a WhatsApp. Debe tratarse como un servicio independiente y actualizarse siguiendo su propia documentación; el código de producto se mantiene en `backend/`, `frontend/` y `extension/`.

## Componentes y flujo

```text
WhatsApp Web / Evolution API
          │ webhook + sincronización incremental
          ▼
Backend Express ── PostgreSQL (superagente)
    │       │
    │       └── Gemini Interactions API
    │
    ├── SSE de cambios para la extensión
    ├── Dashboard operativo
    └── Dashboard CEO (sesión de CEO)
```

- `backend/`: API, sincronización, persistencia PostgreSQL, IA, SSE, autenticación y proxy controlado a Evolution.
- `frontend/`: dashboard operativo y vista CEO bajo `/?view=ceo`.
- `extension/`: extensión Manifest V3 para navegadores Chromium; sincroniza mediante service worker, caché local y SSE.
- `schema.sql`: esquema idempotente para instalaciones nuevas. `backend/server.ts` aplica además actualizaciones compatibles al iniciar.
- `deploy/`: Nginx, systemd, scripts de despliegue y respaldo.

## Reglas funcionales

1. Solo los JID terminados en `@g.us` entran en la lista operativa, sincronización, mensajes pendientes, resúmenes y respuestas IA.
2. Los resúmenes y sugerencias usan únicamente mensajes entrantes con `estado = 'pendiente'` y conservan su rol, mensajes origen, modelo y proveedor en base de datos.
3. Al marcar un chat como revisado, el contador pendiente se actualiza en base de datos; el contador de WhatsApp se reconcilia desde la extensión cuando WhatsApp Web está abierto.
4. El Dashboard CEO consulta datos persistidos y no crea notificaciones del navegador ni paneles de alertas de chat.

## Datos persistidos

| Dominio | Tablas principales |
| --- | --- |
| Conversaciones | `chats`, `grupos`, `mensajes`, `grupo_participantes` |
| IA y trazabilidad | `especialistas`, `analisis_ia`, `resumenes_chat`, `respuestas_chat`, `auditoria_respuestas`, `ceo_consultas` |
| Organización | `usuarios`, `empleados`, `roles`, `usuario_rol`, `proyectos` |
| Extensión | `extension_invitations`, `extension_activations` |

No borres tablas o mensajes manualmente. Para un reinicio controlado usa `docs/RESET_Y_DATOS.md` y realiza un respaldo antes.

## Seguridad y accesos

- CEO: `POST /api/auth/ceo-login` entrega una sesión firmada. En producción define siempre `CEO_SESSION_SECRET` y `CEO_INITIAL_PASSWORD` en `backend/.env` o en el archivo de entorno de systemd.
- Extensión: el CEO genera un código de un solo uso en **Configuración**. Al canjearlo, la extensión recibe una activación. Toda petición originada por la extensión debe incluir `X-Extension-Activation`; SSE usa `activation_id`. Revocar el código invalida inmediatamente las peticiones de esa instalación.
- Red: Nginx es el único servicio público. PostgreSQL, Evolution y backend se enlazan a `127.0.0.1`.
- IA: `GOOGLE_GEMINI_API_KEY` nunca se expone al frontend o extensión. Los límites de mensajes y medios se configuran con `PENDING_CONTEXT_MESSAGE_LIMIT`, `SUMMARY_HISTORY_MAX_CHARS`, `MAX_MEDIA_ANALYSIS_ITEMS` y `MAX_MEDIA_ANALYSIS_BYTES`.

## Desarrollo local

```powershell
cd backend; npm.cmd install; npm.cmd run migrate; npm.cmd run dev
cd frontend; npm.cmd install; npm.cmd run dev -- --host 127.0.0.1
cd extension; npm.cmd test
```

Carga `extension/` como extensión sin empaquetar. En producción configura una URL HTTPS desde las opciones de la extensión y actívala con el código generado en el CEO.

## Validación antes de desplegar

```powershell
.\scripts\test-all.ps1
Invoke-RestMethod http://127.0.0.1:3003/health
```

Comprueba además manualmente: inicio CEO, generación y revocación de código de extensión, conexión QR, llegada de un mensaje grupal, contador pendiente, resumen, sugerencia y envío aprobado.

## Límite multiinstancia

La plataforma central conserva una cuenta Evolution por registro de `whatsapp_accounts`. Todas las cuentas comparten backend, Dashboard CEO y base de datos, mientras `account_id` aísla chats, mensajes, sincronización, resúmenes, respuestas y activaciones. Consulta `docs/PRODUCCION_MULTIINSTANCIA_LIGHTSAIL.md` para la operación multi-cuenta centralizada.