# QA · WhatsApp automático cuando un lead entra en espera de llamada

Guía para probar en **producción** [CAPTACION_WHATSAPP_ESPERA.md](CAPTACION_WHATSAPP_ESPERA.md), con ClickUp y
WhatsApp reales, antes de abrirlo a todos los leads.

**Cómo se hace sin riesgo.** El módulo se activa en producción en **modo QA**: con
`CAPTACION_WHATSAPP_SOLO_TELEFONOS` solo escribe al móvil de QA. Cualquier otro lead que entre en e1 mientras dure
la prueba queda `no_enviado` con motivo `qa` y **no recibe nada, tampoco después** (igual que hoy, sin el módulo):
conviene que el QA dure horas, no días. Al terminar, se vacía la variable y se reinicia: ya está en real.

## Qué se necesita

| Qué | Para qué | Quién |
| --- | --- | --- |
| PR #38 fusionado y desplegado | El código en el servidor | Desarrollo |
| Acceso a `/etc/lyn/backend.env` y a reiniciar `lyn-backend` | Configurar y activar | Desarrollo |
| Acceso a la app **Grupo LyN** en developers.facebook.com | Publicar la app y su webhook | Desarrollo |
| Un móvil con WhatsApp (el de QA) | Recibir el aviso | QA |
| Acceso a ClickUp › Contacto de Reforma | Crear y mover las tareas de prueba | QA |

## 1. Activación en modo QA (desarrollo)

1. **Variables** en `/etc/lyn/backend.env` (valores secretos: se copian en el servidor, nunca por chat):

   ```bash
   CAPTACION_WHATSAPP_ENABLED=true
   CAPTACION_WHATSAPP_SOLO_TELEFONOS="+34XXXXXXXXX"        # móvil de QA (varios, separados por comas)
   WHATSAPP_CLOUD_TOKEN="…"                                # usuario del sistema lyn-backend-captacion
   WHATSAPP_CLOUD_PHONE_NUMBER_ID="782222018312993"        # número general +34 865 45 61 02
   WHATSAPP_CLOUD_APP_SECRET="…"                           # app Grupo LyN → Configuración → Básica
   WHATSAPP_CLOUD_VERIFY_TOKEN="…"                         # cadena aleatoria
   CAPTACION_WHATSAPP_PLANTILLA="aviso_solicitud_llamada_comercial"   # si Meta aún no la aprobó: "aviso_solicitud_llamada" y sin las 3 siguientes
   CAPTACION_WHATSAPP_PLANTILLA_PARAMETROS="nombre,telefono"
   CAPTACION_WHATSAPP_REMITENTE_ALTO_TELEFONO="+34 865 60 83 43"     # fijo de Netelip de Ernesto
   CAPTACION_WHATSAPP_REMITENTE_BASE_TELEFONO="+34 865 45 61 34"     # fijo de Netelip de Victor
   CAPTACION_WHATSAPP_IDIOMA="es_ES"
   CAPTACION_WHATSAPP_HORARIO="07:00-20:00"
   ```

   Verify token aleatorio: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`.
2. **Reiniciar**: `sudo systemctl restart lyn-backend`. En `journalctl -u lyn-backend -n 100` deben salir:
   - `[captacion] MODO QA: solo se escribe a 1 teléfono(s)…`
   - `captacion_barrido` con `linea_base`: los leads que **ya** están en e1 quedan marcados y no reciben nada.
3. **Meta**: publicar la app (developers.facebook.com → app Grupo LyN → **Publicar**). Después, en **Casos de uso →
   Conectarte con los clientes a través de WhatsApp → Personalizar → Configuración → Webhook → Editar**:
   URL `https://<dominio>/webhook/whatsapp-cloud`, token de verificación = `WHATSAPP_CLOUD_VERIFY_TOKEN`,
   **Verificar y guardar**. Comprobar que el campo `messages` sigue suscrito.
4. **ClickUp**: en el servidor, con `CLICKUP_TEAM_ID` en el entorno,

   ```bash
   cd backend && npx tsx captacion-whatsapp/alta.ts webhook-clickup https://<dominio>/webhook/captacion/clickup
   ```

   Guardar el `secret` de la respuesta en `CAPTACION_CLICKUP_WEBHOOK_SECRET` y **reiniciar** enseguida.
5. Avisar a QA de que puede empezar.

**Ver los avisos** (para comprobar motivos y remitente): con sesión de administración,
`GET https://<dominio>/api/captacion/whatsapp/avisos?limit=20`, o en el servidor:

```sql
SELECT id, lead_nombre, telefono_e164, presupuesto, remitente, estado, motivo, intentos,
       enviado_en, entregado_en, leido_en, fallido_en
FROM captacion_whatsapp_avisos ORDER BY id DESC LIMIT 20;
```

## 2. Casos (QA)

Tareas en **Contacto de Reforma**, creadas **después** de la activación, con la convención del equipo para que los
SDR no las llamen: `PRUEBA QA WhatsApp 1 (NO USAR)`, `… 2`, etc. Campos: `contact_phone_number`,
`Presupuesto formulario` (opcional) y `ETAPA_CRM`. El mensaje llega en segundos (webhook de ClickUp); si no, como
mucho en 5 minutos (barrido).

| # | Caso | Cómo | Resultado esperado |
| --- | --- | --- | --- |
| 1 | **Lead nuevo en espera** | Tarea con el móvil de QA; `ETAPA_CRM` = «e1. EN ESPERA» | Llega el WhatsApp de **Grupo LyN** (número general): «Hola, hemos recibido tu solicitud de contacto para tu reforma. Victor, asesor de Grupo LyN, te llamará en breve desde el número +34 865 45 61 34. Guárdalo para reconocer la llamada.» Aviso `enviado`, con `telefono_anunciado`. |
| 2 | **Entregado y leído** | Mirar el aviso del caso 1 antes y después de abrir el mensaje | `entregado` (con `entregado_en`) al llegar; `leido` (con `leido_en`) al abrirlo. |
| 3 | **Sin duplicados** | Con la tarea 1 aún en e1, editar otros campos (descripción, comentario) | No llega otro mensaje; sigue habiendo **un** aviso para esa tarea. |
| 4 | **Nueva solicitud** | Pasar la tarea 1 a otra etapa (p. ej. «e2») y volver a «e1. EN ESPERA» | Llega **un** mensaje nuevo; la tarea tiene **dos** avisos. |
| 5 | **Sin teléfono** | Tarea sin `contact_phone_number`, a e1 | No llega nada. `no_enviado`, motivo `sin_telefono`. |
| 6 | **Teléfono no válido** | Teléfono `12345`, a e1 | `no_enviado`, motivo `telefono_no_valido`. |
| 7 | **Fijo** | Teléfono `+34 965 000 000`, a e1 | `no_enviado`, motivo `telefono_fijo`. |
| 8 | **Fuera de la lista de QA** | Un móvil válido que **no** sea el de QA (p. ej. `+34 612 000 000`), a e1 | No se envía. `no_enviado`, motivo `qa`. |
| 9 | **Remitente según presupuesto** | Dos tareas con el móvil de QA: «Más de 200.000 €» y «40.000 € - 100.000 €» | Llegan ambos, desde el número general. El primero anuncia a **Ernesto** y +34 865 60 83 43; el segundo, a **Victor** y +34 865 45 61 34. `remitente` y `telefono_anunciado` coinciden. |
| 10 | **Nunca modifica ClickUp** | Revisar la actividad de las tareas de prueba | Ningún cambio hecho por el backend: ni etapa, ni campos, ni comentarios. |
| 11 | **Ningún lead real recibe nada** | Consulta de avisos al terminar | Ningún aviso `enviado` a un teléfono distinto del de QA. |

**Horario, caducidad, reintentos y errores de Meta** no se prueban en producción (habría que cambiar variables y
reiniciar el backend, que sirve a todo el dashboard). Los cubre la prueba de integración contra PostgreSQL:

```bash
cd backend && QA_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:15439/lyn_qa_retest npx vitest run tests/captacion-whatsapp.integration.test.ts
```

(18 tests: fuera de horario espera, caducado no se envía, error temporal se reintenta y acaba `fallido`, plantilla
inexistente `fallido` sin reintentos, `failed` de Meta, línea base, duplicados por webhook y barrido.)

## 3. Paso a real (desarrollo)

Con todos los casos OK:

1. En `/etc/lyn/backend.env`, **vaciar o quitar** `CAPTACION_WHATSAPP_SOLO_TELEFONOS`.
2. `sudo systemctl restart lyn-backend`. En el log ya **no** debe salir «MODO QA».
3. Archivar las tareas de prueba en ClickUp. Los avisos de prueba pueden quedarse en la tabla (no se reenvían).

Si algo sale mal en QA: `CAPTACION_WHATSAPP_ENABLED=false` y reiniciar lo apaga al momento.

## Resultado

| # | OK / KO | Notas |
| --- | --- | --- |
| 1-11 | | |
