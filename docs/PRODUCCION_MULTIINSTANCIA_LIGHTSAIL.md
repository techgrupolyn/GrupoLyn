# Operación centralizada multi-cuenta en AWS Lightsail

> Esta guía reemplaza el modelo anterior de una base de datos por cuenta. Superagente ahora opera **un backend, un Dashboard CEO y una base PostgreSQL central** para todas las cuentas de WhatsApp.

## Arquitectura

- Un único dominio público para Dashboard CEO y API, por ejemplo `https://superagente.example.com`.
- Una base PostgreSQL central de Superagente. Cada registro operativo incluye `account_id`.
- Una única Evolution API privada que administra varias instancias nombradas, una por cuenta de WhatsApp.
- Una extensión distribuible única. Cada instalación se activa con un código ligado a una cuenta y solo puede leer, sincronizar o enviar mensajes de esa cuenta.
- Un Dashboard CEO global: consulta métricas y grupos de todas las cuentas sin ejecutar operaciones de WhatsApp sobre la cuenta equivocada.

Los identificadores internos de chats y mensajes se guardan con ámbito de cuenta. La API nunca expone ese prefijo a la extensión; el aislamiento se aplica por `account_id` en consultas, sincronización, SSE, resúmenes, respuestas y envío de mensajes.

## Alta de una nueva cuenta

1. Entra al CEO como administrador y abre **Configuración**.
2. Crea una cuenta con un nombre corporativo y un nombre de instancia Evolution único, por ejemplo `ventas-caracas`.
3. Genera un código de activación y selecciona esa cuenta. El código solo sirve una vez y tiene vencimiento.
4. El empleado instala la misma extensión y canjea el código en sus opciones.
5. La extensión abre el QR de la instancia asociada. El empleado vincula únicamente el WhatsApp asignado.
6. La cuenta queda lista para sincronizar sus grupos. Los datos aparecen también en el CEO global bajo el nombre de esa cuenta.

No reutilices nombres de instancia Evolution: son la identidad técnica de cada WhatsApp.

## Despliegue en Lightsail

1. Provisiona una instancia Ubuntu, dominio y TLS siguiendo `PRODUCCION_LIGHTSAIL.md`.
2. Configura un único archivo de entorno de backend con la conexión central (`DATABASE_URL`), secretos CEO, URL pública de webhook y Evolution privada.
3. Ejecuta las migraciones una vez contra la base central:

```bash
cd /opt/lyn/backend
npm ci
npm run migrate
```

4. Inicia una sola unidad de backend y una sola unidad de Evolution API. Evolution debe persistir su propia base/volumen para conservar las sesiones WhatsApp de todas las instancias.
5. Expón solo Nginx/HTTPS. Mantén PostgreSQL, backend y Evolution en red privada o en `127.0.0.1`.
6. Genera el paquete de navegador desde el repositorio:

```bash
npm --prefix extension run package
```

El archivo para distribuir es `extension/dist/lyn-superagente-extension.zip`. Para Chrome/Edge, cada empleado extrae el ZIP y carga la carpeta descomprimida como extensión sin empaquetar, o se publica el mismo paquete mediante la tienda corporativa.

## Variables imprescindibles

- `DATABASE_URL`: una única base central de Superagente.
- `EVOLUTION_API_URL` y `EVOLUTION_API_KEY`: acceso privado a Evolution.
- `WEBHOOK_URL`: URL pública del backend; Evolution envía aquí los eventos de todas las instancias.
- `WEBHOOK_SECRET`: mismo secreto configurado en el backend y en Evolution.
- `CEO_INITIAL_PASSWORD` y `CEO_SESSION_SECRET`: acceso seguro del Dashboard CEO.
- `BIND_HOST=127.0.0.1`: Nginx es la única entrada pública al backend.

Nunca publiques los secretos ni empaquetes archivos `.env` dentro de la extensión.

## Operación segura

- Desactiva una cuenta desde Configuración para detener sus sincronizaciones sin eliminar su historial.
- Revoca una activación o genera un nuevo código si un dispositivo cambia de empleado.
- El CEO global sirve para auditoría y seguimiento; las acciones que cambian un grupo se realizan desde la extensión vinculada a la cuenta correspondiente.
- Haz copias diarias de la base central y del volumen/base de Evolution. Ambos son necesarios para recuperar historial y sesiones.
- Antes de actualizar, ejecuta la batería completa: `./scripts/test-all.ps1` en Windows o su equivalente en CI.

## Reset de desarrollo

Solo en entornos de prueba, elimina todos los datos de la plataforma con:

```powershell
$env:CONFIRM_CLEAN_RESET = 'YES'
npm --prefix backend run reset:clean
```

Después inicia el backend. Se crea la cuenta técnica `default` desactivada, sin chats, mensajes ni activaciones; las cuentas reales se añaden desde el CEO.