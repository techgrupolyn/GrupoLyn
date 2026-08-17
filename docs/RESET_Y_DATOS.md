# Reinicio y persistencia de datos

## Bases de datos

El sistema usa dos bases con responsabilidades distintas:

| Base | Propietario | Contenido |
| --- | --- | --- |
| `superagente` | Aplicación | Dashboard, CEO, especialistas, chats normalizados, mensajes, resúmenes y auditoría |
| `evolution_db` | Evolution API | Instancia WhatsApp, credenciales de conexión y almacenamiento propio de Evolution |

El backend convierte los eventos recibidos de Evolution en el historial consultable por el dashboard. Por eso `superagente` es la fuente para las consultas CEO y no debe truncarse selectivamente.

## Reiniciar `superagente`

Detén el backend antes de borrar la base. Después crea la base vacía y aplica el esquema:

```powershell
psql -U postgres -c "DROP DATABASE superagente"
psql -U postgres -c "CREATE DATABASE superagente"
cd backend
npm.cmd run migrate
```

Al primer arranque, el backend crea el usuario CEO inicial con `CEO_INITIAL_PASSWORD`.

## Reiniciar también WhatsApp

Reiniciar `evolution_db` borra la sesión de WhatsApp, QR, instancias y datos internos de Evolution. Solo hazlo si quieres desvincular WhatsApp y volver a escanear un QR:

```powershell
psql -U postgres -c "DROP DATABASE evolution_db"
psql -U postgres -c "CREATE DATABASE evolution_db"
```

Después aplica las migraciones de Evolution y reinicia el servicio. Al abrir Evolution se generará un QR nuevo. Esta acción no se ejecuta automáticamente durante despliegues ni reinicios normales.

## Respaldo y recuperación

En producción utiliza `deploy/scripts/backup-postgres.sh` cada día. Para restaurar, detén los servicios y aplica el respaldo sobre la base correspondiente con `pg_restore` o `psql`, según su formato. Prueba la recuperación en una instancia separada antes de reemplazar datos de producción.
