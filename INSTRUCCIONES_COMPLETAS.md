# LYN Superagente — Instrucciones completas

Guía operativa y técnica para desarrollar, probar y desplegar LYN Superagente. Esta plataforma centraliza conversaciones de WhatsApp, análisis con IA, reuniones de Google Drive y el directorio corporativo en un único dashboard.

> **No guardes contraseñas, claves API, tokens OAuth ni archivos `.env` en Git.** Usa siempre las plantillas `.env.example` y el gestor de secretos del entorno correspondiente.

## 1. Alcance y arquitectura

La solución está compuesta por cuatro piezas:

```text
Extensión Chromium / Dashboard web
                │ HTTPS
                ▼
             Nginx público
                │ localhost
                ▼
      Backend Node.js + PostgreSQL
          │           │
          │           ├─ Google Drive / Gemini / Supabase (salida autenticada)
          ▼
   Evolution API (local)
```

| Componente | Directorio | Responsabilidad | Puerto local |
| --- | --- | --- | --- |
| Backend | `backend/` | API, seguridad, IA, sincronización y datos | `3003` |
| Dashboard | `frontend/` | Interfaz CEO, reuniones y backoffice | `5173` |
| Extensión | `extension/` | Asistente de WhatsApp y reportes globales | — |
| Evolution API | `evolution-api/` | Conexión técnica con WhatsApp | `8080` |
| PostgreSQL | — | Datos operativos y auditoría | `5432` |
| Nginx | `deploy/nginx/` | TLS y proxy inverso de producción | `443` |

El navegador nunca se conecta directamente a PostgreSQL, Evolution, Google Drive, Gemini ni Supabase. El backend es el único componente que usa esas credenciales.

## 2. Funcionalidades actuales

### WhatsApp y extensión

- Cuentas WhatsApp independientes sobre Evolution API, con datos centralizados por cuenta.
- Activación de la extensión mediante código emitido desde el dashboard.
- Validación de origen contra `CHROME_EXTENSION_IDS`; la extensión publicada usa el ID `aegllelflhplgbcemoadjdlohfkbbkpj`.
- Copilotos configurables desde el dashboard y respuestas sugeridas por IA.
- Análisis individual de chats pendientes y un informe global de mensajes pendientes.
- El análisis no marca mensajes como vistos en WhatsApp: solo registra internamente qué mensajes ya fueron procesados.
- La activación y la URL configurada se conservan al actualizar la extensión, salvo que el usuario borre sus datos de Chrome o revoque la activación.

### Dashboard y permisos

- Inicio de sesión propio para el dashboard CEO, independiente de la cuenta de WhatsApp.
- `superadmin` y Dirección tienen acceso total.
- El resto de usuarios puede consultar IA y sus reuniones vinculadas; no ve reuniones ajenas.
- Backoffice con empleados, clientes, subcontratas, proyectos y asignaciones por proyecto.
- El directorio se sincroniza desde Supabase en modo lectura: este proyecto no modifica datos en Supabase.

### Gestión de reuniones

- Importación automática desde carpetas autorizadas de Google Drive.
- Análisis una sola vez y persistencia de resumen, decisiones, acciones, bloqueos, tipo de reunión, PMC, proyecto, contacto y fecha de reunión.
- Reprocesamiento controlado para reuniones que no pudieron identificarse correctamente.
- Acciones con responsable principal, responsables adicionales, fechas opcionales, asignación manual y trazabilidad de cambios.
- Jerarquía operativa: Delineante → PMC/Jefe de proyectos → Dirección de operaciones → Director general. Cuando la IA no identifica un responsable, se prioriza la asignación por proyecto y, como último recurso, el PMC.
- Acceso y paneles personalizados con contadores de revisión, tareas y reuniones vinculadas.

## 3. Estructura del repositorio

```text
backend/                 API, PostgreSQL, IA, Drive, Supabase y tests
frontend/                Dashboard React/Vite
extension/               Extensión Chromium Manifest V3
evolution-api/           Servicio Evolution API y sus instrucciones propias
deploy/                  systemd, Nginx, scripts y ejemplos de producción
docs/                    Guías específicas de operación y seguridad
INSTRUCCIONES_COMPLETAS.md  Esta guía
README.md                Resumen técnico rápido
TESTING.md               Estrategia y comandos de pruebas
```

Consulta además:

- `docs/GOOGLE_DRIVE_REUNIONES.md` para Drive y reuniones.
- `docs/SECURITY.md` para controles de seguridad.
- `docs/PRODUCCION_LIGHTSAIL.md` y `docs/PRODUCCION_MULTIINSTANCIA_LIGHTSAIL.md` para servidor.
- `docs/RELEASE_CHECKLIST.md` antes de publicar una extensión o desplegar.
- `evolution-api/AGENTS.md` antes de modificar ese subproyecto.

## 4. Requisitos locales

- Node.js 20 o superior y npm.
- PostgreSQL disponible localmente.
- Una instancia local de Evolution API si se va a probar WhatsApp/QR.
- Credenciales de prueba para Gemini, Google Drive y Supabase solo si se prueban esas integraciones.

No copies valores reales de producción en archivos que vayan a quedar en el repositorio.

## 5. Puesta en marcha local

### 5.1 Instalar dependencias

```powershell
cd backend
npm install

cd ..\frontend
npm install

cd ..\extension
npm install
```

Sigue las instrucciones de `evolution-api/` únicamente si necesitas levantar también ese servicio.

### 5.2 Configurar el backend

```powershell
Copy-Item backend\.env.example backend\.env
```

Edita `backend/.env`. Como mínimo configura:

- `DATABASE_URL` para la base local.
- `EVOLUTION_API_URL`, `EVOLUTION_API_KEY` e `INSTANCE_NAME` si habrá WhatsApp local.
- `CEO_INITIAL_PASSWORD` y `CEO_SESSION_SECRET` para el dashboard.
- `CORS_ALLOWED_ORIGINS=http://127.0.0.1:5173,http://localhost:5173`.
- `GOOGLE_GEMINI_API_KEY` para análisis con IA.

Configuraciones opcionales, según la funcionalidad que vayas a probar:

- Google Drive: `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, `GOOGLE_DRIVE_OAUTH_REDIRECT_URI` y `GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY`.
- Directorio Supabase de solo lectura: `SUPABASE_SOURCE_URL`, `SUPABASE_SOURCE_SECRET_KEY`, `SUPABASE_SYNC_ENABLED=true` y sus intervalos.
- Autenticación con usuarios corporativos: `SUPABASE_AUTH_ENABLED=true` solo cuando esas credenciales y el flujo estén configurados para el entorno.
- Extensión local sin activación: `ALLOW_UNAUTHENTICATED_LOCAL_EXTENSION=true` **solo en local**. Nunca se debe usar en producción.

La lista completa y actualizada de variables está en `backend/.env.example`.

### 5.3 Crear o actualizar el esquema

```powershell
cd backend
npm run migrate
```

Ejecuta las migraciones antes de arrancar una versión que incorpore cambios de base de datos.

### 5.4 Arrancar servicios

En terminales separadas:

```powershell
# Backend
cd backend
npm run dev

# Dashboard
cd frontend
npm run dev

# Evolution API, solo cuando sea necesaria
cd evolution-api
# Ejecutar según sus instrucciones propias
```

Abre `http://127.0.0.1:5173/?view=ceo` para el dashboard o `http://127.0.0.1:5173/?view=meetings` para Gestión de reuniones. El proxy Vite envía `/api` a `http://127.0.0.1:3003`.

Comprobación básica:

```powershell
Invoke-RestMethod http://127.0.0.1:3003/health
```

## 6. Extensión Chromium

### Desarrollo local

1. Configura la URL del backend local desde la pantalla de activación de la extensión.
2. En Chrome abre `chrome://extensions` y activa **Modo de desarrollador**.
3. Selecciona **Cargar descomprimida** y elige `extension/`.
4. Para generar un paquete verificable:

```powershell
cd extension
npm run check
npm test
npm run package:local
```

### Producción y Chrome Web Store

```powershell
cd extension
npm run check
npm test
npm run package
```

- Incrementa la versión en `extension/manifest.production.json` antes de empaquetar. Debe ser mayor que la última versión publicada.
- La extensión de producción debe usar `https://ceo.grupolyn.com` y el ID publicado debe estar incluido en `CHROME_EXTENSION_IDS` del backend.
- La instalación pública no da acceso a datos corporativos: cada navegador necesita una activación válida y el backend valida el origen de Chrome.
- Cualquier cambio de código de la extensión exige una nueva publicación y la revisión que aplique Chrome. Los cambios exclusivos de backend no requieren publicar la extensión.

## 7. Google Drive y análisis de reuniones

1. Crea el cliente OAuth en Google Cloud y habilita Google Drive API.
2. Configura la redirección del backend y guarda las credenciales solamente en `backend/.env` o `/etc/lyn/backend.env`.
3. Autoriza la cuenta que tiene acceso de lectura a las carpetas de reuniones.
4. Añade y habilita las carpetas desde Configuración del dashboard.
5. El proceso periódico detecta archivos nuevos, los almacena y programa su análisis automático.

La sincronización es centralizada: los usuarios autorizados ven sus reuniones vinculadas sin necesidad de conectar cada uno su propio Drive. Si una reunión no se identifica, el panel permite corregir PMC, proyecto, contacto, tipo o responsables de forma manual; la auditoría conserva esos cambios.

## 8. Sincronización corporativa desde Supabase

Supabase se usa como fuente de directorio, no como destino:

- El backend descarga empleados, roles, clientes, subcontratas, proyectos, asignaciones y la jerarquía disponibles para la integración.
- Los datos se copian a PostgreSQL de LYN para búsquedas rápidas, asignación automática y control de permisos.
- La sincronización periódica incorpora altas y cambios de la fuente sin alterar sus tablas, políticas RLS ni credenciales.
- Si faltan datos en el dashboard, verifica `SUPABASE_SYNC_ENABLED`, URL, clave secreta de servicio y los logs del backend antes de modificar la interfaz.

## 9. Pruebas obligatorias

Ejecuta estos controles antes de pedir un despliegue:

```powershell
cd backend
npm run typecheck
npm test

cd ..\frontend
npm test
npm run build

cd ..\extension
npm run check
npm test
npm run package
```

Además comprueba manualmente, con cuentas autorizadas:

- Inicio y cierre de sesión del dashboard.
- Restricciones por rol y visibilidad de reuniones propias.
- Carga de opciones de filtros (proyecto, PMC, rol, contacto y fecha).
- Apertura de una reunión, edición de responsables y registro de auditoría.
- Importación de una reunión de Drive y su análisis persistido.
- Activación de extensión, listado de chats, análisis individual e informe global.

No se debe desplegar si fallan pruebas, el build, migraciones o el chequeo de seguridad de la extensión.

## 10. Producción

La instalación actual usa:

- Aplicación: `/opt/lyn`.
- Variables privadas: `/etc/lyn/backend.env`.
- Servicios: `lyn-backend`, `lyn-evolution` y `nginx`.
- URL pública: `https://ceo.grupolyn.com`.

### Flujo de despliegue

1. En local, deja el árbol de trabajo limpio y ejecuta las pruebas de la sección anterior.
2. Sube a Git solo el código y migraciones necesarios; nunca `.env`, tokens o paquetes temporales.
3. En el servidor, actualiza el repositorio, instala dependencias si cambiaron, ejecuta migraciones y compila el frontend.
4. Reinicia únicamente los servicios que correspondan y valida salud, interfaz y logs.

Comandos de comprobación en el servidor:

```bash
sudo systemctl is-active lyn-backend lyn-evolution nginx
curl -fsS https://ceo.grupolyn.com/health
sudo journalctl -u lyn-backend -n 100 --no-pager
sudo git -C /opt/lyn rev-parse --short HEAD
```

Para el procedimiento completo, incluidos backups, Nginx, systemd y rollback, usa `docs/PRODUCCION_LIGHTSAIL.md` y `docs/RELEASE_CHECKLIST.md`.

### Reglas de producción

- El backend y Evolution API deben escuchar solo en `127.0.0.1`; Nginx es el único punto público.
- Usa HTTPS, secretos fuertes y rotables, y cookies de sesión seguras.
- `ALLOW_UNAUTHENTICATED_LOCAL_EXTENSION` debe permanecer desactivado.
- Define exclusivamente IDs reales en `CHROME_EXTENSION_IDS`.
- Mantén copias de seguridad de PostgreSQL antes de migraciones sensibles.
- Tras desplegar frontend, recarga forzada el navegador si conserva assets antiguos.

## 11. Diagnóstico rápido

| Síntoma | Comprobación inicial |
| --- | --- |
| `502 Bad Gateway` | `systemctl status lyn-backend`, logs y `curl http://127.0.0.1:3003/health` desde el servidor. |
| `401` en extensión | Verifica activación válida, URL del backend y que no se haya borrado el almacenamiento de Chrome. |
| `403 Origen de extensión no autorizado` | Comprueba el ID de Chrome y `CHROME_EXTENSION_IDS`; reinicia el backend tras cambiar variables. |
| Drive no incorpora reuniones | Revisa credenciales OAuth, token autorizado, carpetas habilitadas y `last_sync_error` en `google_drive_folders`. |
| No llega directorio corporativo | Verifica variables `SUPABASE_*`, sincronización habilitada y logs que contengan `supabase` o `directory`. |
| IA falla o queda pendiente | Revisa la clave/modelo Gemini, cuota, conectividad y logs de `lyn-backend`. |
| Pantalla antigua o módulo no carga | Comprueba el build desplegado, la versión Git y realiza recarga forzada del navegador. |

## 12. Principios de mantenimiento

- Mantén los cambios pequeños, con migración y prueba asociada cuando afectan datos.
- Primero se valida en local; después se publica en Git y finalmente se despliega con checklist.
- No se modifica Supabase desde LYN: cualquier cambio de estructura debe acordarse con el equipo dueño de esa fuente.
- Toda reasignación, edición o eliminación relevante en reuniones debe quedar registrada con actor y fecha.
- Ante una duda operativa, prioriza consistencia de datos, seguridad y trazabilidad antes que automatizar sin validación.
