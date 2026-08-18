# Superagente WhatsApp

Plataforma interna para centralizar conversaciones de WhatsApp, proponer respuestas con IA y consultar la operación desde un único dashboard, incluida la vista CEO.

## Arquitectura

```text
Extensión Chromium / Dashboard web --HTTPS--> Nginx --localhost--> Backend
                                                    |             |
                                                    |             +--> PostgreSQL: superagente
                                                    +--> Evolution API --localhost--> PostgreSQL: evolution_db
```

El dashboard operativo y el dashboard CEO son la misma aplicación: `/?view=ceo` abre la vista ejecutiva. No existe un segundo dashboard que mantener.

## Componentes

| Componente | Función | Puerto local |
| --- | --- | --- |
| `frontend` | Dashboard operativo y CEO | 5173 (desarrollo) |
| `backend` | API, IA, persistencia, SSE y webhooks | 3003 |
| `evolution-api` | Conexión con WhatsApp Web | 8080 |
| `extension` | Panel lateral para Chrome, Edge, Brave y otros Chromium | — |
| PostgreSQL | Datos operativos (`superagente`) y sesión Evolution (`evolution_db`) | 5432 |

## Desarrollo local

Requisitos: Node.js 20+, PostgreSQL y los dos esquemas de base de datos. Nunca subas archivos `.env` ni respaldos al repositorio.

1. Copia `backend/.env.example` a `backend/.env` y completa las credenciales.
2. Aplica el esquema operativo:

```powershell
cd backend
npm.cmd install
npm.cmd run migrate
```

3. Inicia los servicios en terminales separadas:

```powershell
cd evolution-api; npm.cmd run dev:server
cd backend; npm.cmd run dev
cd frontend; npm.cmd run dev -- --host 127.0.0.1
```

Abre [http://127.0.0.1:5173](http://127.0.0.1:5173). La vista CEO está en [http://127.0.0.1:5173/?view=ceo](http://127.0.0.1:5173/?view=ceo).

## Datos y acceso CEO

- `superagente` contiene usuarios, chats normalizados, mensajes, resúmenes, respuestas sugeridas, especialistas y auditoría del CEO.
- `evolution_db` pertenece a Evolution API: conserva la instancia, QR/sesión y datos que Evolution sincroniza.
- `CEO_INITIAL_PASSWORD` define la clave inicial de `superadmin` al arrancar sobre una base nueva. `CEO_SESSION_SECRET` debe ser aleatorio y privado.
- La IA usa la Interactions API de Gemini con `gemini-3.6-flash` por defecto. Requiere una clave válida en `GOOGLE_GEMINI_API_KEY`; sin saldo o sin clave, las rutas de IA responden con error controlado y no guardan resultados incompletos.

Consulta `docs/RESET_Y_DATOS.md` antes de borrar datos.

## Extensión

Carga `extension` como extensión sin empaquetar en Chrome, Edge o Brave. Para usarla contra producción, abre sus opciones y configura la URL HTTPS pública, por ejemplo `https://app.example.com`.

El backend publicado por HTTPS permite que la extensión funcione desde cualquier equipo y sistema compatible con navegadores Chromium. Cada instalación requiere un código de activación generado por el CEO; la activación se valida en cada petición y puede revocarse desde Configuración. Firefox requiere una interfaz equivalente a `sidePanel` antes de ofrecer soporte completo.

## Operación y arquitectura`n`nLa referencia funcional y de seguridad está en `docs/ARQUITECTURA_OPERATIVA.md`. Incluye el flujo de sincronización, modelo de datos, límites multiinstancia, activación de extensiones y procedimientos de validación.`n`n## Producción en AWS Lightsail

La guía completa está en `docs/PRODUCCION_LIGHTSAIL.md`. El despliegue usa:

- Nginx como único punto público (`80/443`).
- Backend y Evolution API vinculados a `127.0.0.1`.
- Variables secretas en `/etc/lyn/*.env` con propietario `root:lyn` y permisos `640`.
- Servicios `systemd`, script de despliegue y respaldo PostgreSQL incluidos en `deploy/`.

No expongas PostgreSQL (`5432`), Evolution (`8080`) ni el backend (`3003`) a Internet.

## Verificación rápida

```powershell
Invoke-RestMethod http://127.0.0.1:3003/health
Invoke-RestMethod http://127.0.0.1:3003/api/auth/status
```

En producción, ejecuta las mismas comprobaciones bajo `https://app.example.com`.


## Múltiples cuentas de WhatsApp

Para desplegar varias cuentas de WhatsApp en una plataforma centralizada, sigue [la guía multi-cuenta](docs/PRODUCCION_MULTIINSTANCIA_LIGHTSAIL.md). Todas comparten backend, Dashboard CEO y base de datos; cada cuenta usa una instancia Evolution y un `account_id` aislados.


## Seguridad

Consulta [docs/SECURITY.md](docs/SECURITY.md) antes de publicar la extensión o desplegar una instancia.
