# QA · WhatsApp automático cuando un lead entra en espera de llamada

Guía para probar de punta a punta [CAPTACION_WHATSAPP_ESPERA.md](CAPTACION_WHATSAPP_ESPERA.md) con **ClickUp y
WhatsApp reales**: tareas de prueba en la lista **Contacto de Reforma** y el aviso llegando a un móvil del equipo.

**Seguridad.** El backend de QA lee la lista real, donde entran leads reales. Por eso se arranca en **modo QA**
(`CAPTACION_WHATSAPP_SOLO_TELEFONOS`): solo escribe a los móviles de esa lista y cualquier otro lead queda
`no_enviado` con motivo `qa`. Nunca arrancar QA sin esa variable.

## Qué se necesita

| Qué | Para qué | Quién |
| --- | --- | --- |
| Backend del repo en local (rama del PR #38) y un PostgreSQL **vacío** | Ejecutar el módulo | Desarrollo |
| `CLICKUP_API_TOKEN` | Leer la lista | Desarrollo |
| `WHATSAPP_CLOUD_TOKEN` (usuario del sistema `lyn-backend-captacion`) | Enviar la plantilla | Desarrollo (no se comparte por chat) |
| Un móvil con WhatsApp (el de QA) | Recibir el aviso | QA |
| Acceso a ClickUp › Contacto de Reforma | Crear y mover las tareas de prueba | QA |

## Preparación (desarrollo)

1. Base de datos nueva, solo para esta prueba (las tablas se crean al arrancar).
2. En `backend/.env`, además de `DATABASE_URL` y `CLICKUP_API_TOKEN`:

   ```bash
   CAPTACION_WHATSAPP_ENABLED=true
   CAPTACION_WHATSAPP_SOLO_TELEFONOS=+34XXXXXXXXX          # el móvil de QA (varios, separados por comas)
   WHATSAPP_CLOUD_TOKEN=…
   WHATSAPP_CLOUD_PHONE_NUMBER_ID=782222018312993         # número general +34 865 45 61 02
   CAPTACION_WHATSAPP_PLANTILLA=aviso_solicitud_llamada
   CAPTACION_WHATSAPP_IDIOMA=es_ES
   CAPTACION_WHATSAPP_HORARIO=07:00-20:00
   CAPTACION_BARRIDO_MINUTOS=1                            # QA: detecta cambios cada minuto
   ```

   Sin `CAPTACION_CLICKUP_WEBHOOK_SECRET` ni `WHATSAPP_CLOUD_APP_SECRET`: en QA no hace falta túnel; el barrido
   detecta las entradas en e1 y los estados quedan en `enviado` (ver [Entregado y leído](#entregado-y-leído)).
3. Arrancar: `cd backend && npm start`. En el log deben salir:
   - `[captacion] MODO QA: solo se escribe a 1 teléfono(s)…`
   - `captacion_barrido` con `linea_base`: los leads que **ya** están en e1 quedan marcados y no reciben nada.
4. Para ver los avisos, en la base de QA:

   ```sql
   SELECT id, lead_nombre, telefono_e164, presupuesto, remitente, estado, motivo, intentos,
          enviado_en, entregado_en, leido_en, fallido_en
   FROM captacion_whatsapp_avisos ORDER BY id DESC LIMIT 20;
   ```

   (También `GET /api/captacion/whatsapp/avisos?clickup_task_id=…` con sesión de administración.)

## Tareas de prueba (QA)

Crear las tareas **después** de arrancar el backend (si no, entran en la línea base y no se avisan). Nombre con la
convención del equipo, para que los SDR no las llamen: `PRUEBA QA WhatsApp 1 (NO USAR)`, `… 2`, etc. Campos:
`contact_phone_number`, `Presupuesto formulario` (opcional) y `ETAPA_CRM`. Tras cada cambio, esperar **1-2 minutos**.

## Casos

| # | Caso | Cómo | Resultado esperado |
| --- | --- | --- | --- |
| 1 | **Lead nuevo en espera** | Tarea con el móvil de QA; poner `ETAPA_CRM` = «e1. EN ESPERA» | Llega el WhatsApp de **Grupo LyN**: «Hola, hemos recibido tu solicitud de llamada. Un asesor te llamará en breve.» Aviso `enviado`, con `wamid` y `enviado_en`. |
| 2 | **Sin duplicados** | Con la tarea 1 aún en e1, editar otros campos (descripción, comentario) y esperar 2 barridos | No llega otro mensaje; sigue habiendo **un** aviso para esa tarea. |
| 3 | **Nueva solicitud** | Pasar la tarea 1 a otra etapa (p. ej. «e2») y volver a «e1. EN ESPERA» | Llega **un** mensaje nuevo; la tarea tiene **dos** avisos (uno por solicitud). |
| 4 | **Sin teléfono** | Tarea sin `contact_phone_number`, a e1 | No llega nada. `no_enviado`, motivo `sin_telefono`. |
| 5 | **Teléfono no válido** | Teléfono `12345`, a e1 | `no_enviado`, motivo `telefono_no_valido`. |
| 6 | **Fijo** | Teléfono `+34 965 000 000`, a e1 | `no_enviado`, motivo `telefono_fijo` (los fijos no suelen tener WhatsApp). |
| 7 | **Fuera de la lista de QA** | Un móvil válido que **no** esté en `SOLO_TELEFONOS` (p. ej. `+34 612 000 000`), a e1 | No se envía. `no_enviado`, motivo `qa`. (Comprueba la protección de QA.) |
| 8 | **Remitente según presupuesto** | Dos tareas con el móvil de QA: `Presupuesto formulario` «Más de 200.000 €» y «40.000 € - 100.000 €» | Llegan ambos mensajes. `remitente` = **Ernesto** en la primera y **Victor** en la segunda. Hoy los dos salen del número general (aún no tienen número propio). |
| 9 | **Nunca modifica ClickUp** | Revisar la actividad de las tareas de prueba | Ningún cambio hecho por el backend: ni etapa, ni campos, ni comentarios. |
| 10 | **Lead real no se toca** | Revisar la consulta al terminar | Ningún aviso `enviado` a un teléfono distinto del de QA. |

### Casos que necesitan reiniciar con otra configuración (desarrollo)

| # | Caso | Cambio en `.env` y reinicio | Resultado esperado |
| --- | --- | --- | --- |
| 11 | **Fuera de horario** | `CAPTACION_WHATSAPP_HORARIO` con una franja que excluya la hora actual (p. ej. `03:00-04:00`) | Aviso `pendiente`, motivo `fuera_de_horario`; no llega nada. Al volver a `07:00-20:00` y reiniciar, llega en el siguiente intento (como mucho 10 min). |
| 12 | **Caducado** | Como el 11 y además `CAPTACION_WHATSAPP_CADUCIDAD_MINUTOS=2`; esperar ~10 min | Primero `pendiente` (`fuera_de_horario`); en el siguiente intento, `no_enviado` con motivo `caducado`. No llega nada. |
| 13 | **Error definitivo de Meta** | `CAPTACION_WHATSAPP_PLANTILLA=plantilla_inexistente` | `fallido` al primer intento, motivo con código `132001`. El lead sigue su curso en ClickUp. |
| 14 | **Reintentos** | `WHATSAPP_CLOUD_TOKEN=token_invalido` | `pendiente` con motivo `reintento: …` y `intentos` subiendo (1, 5 y 15 min); a los ~21 min, `fallido`. |

Restaurar la configuración de la [Preparación](#preparación-desarrollo) después de cada uno.

### Entregado y leído

Los estados `entregado` y `leido` llegan por el webhook de Meta, que exige que la app **Grupo LyN** esté
**publicada** y su URL de webhook apunte a este backend (con `WHATSAPP_CLOUD_APP_SECRET` y
`WHATSAPP_CLOUD_VERIFY_TOKEN`). Hoy la app está sin publicar y el webhook se reapunta al activar producción, así que
en QA los avisos quedan en `enviado`. **Este caso se valida en la prueba final de producción**: el aviso debe pasar a
`entregado` al llegar y a `leido` al abrirlo.

## Al terminar

1. Parar el backend.
2. Archivar o borrar las tareas de prueba en ClickUp.
3. Borrar la base de QA o ejecutar `backend/captacion-whatsapp/schema-down.sql`.
4. Quitar `WHATSAPP_CLOUD_TOKEN` del `.env` del portátil si no es de desarrollo.

## Resultado

| # | OK / KO | Notas |
| --- | --- | --- |
| 1-14 | | |
