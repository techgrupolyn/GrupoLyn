# Captación · WhatsApp automático cuando un lead entra en espera de llamada

Spec de Product (Jean Parra, 13/11/2026), a partir de la reunión con Alex del 12/11/2026. Código en
`backend/captacion-whatsapp/`.

Cuando un lead de la lista de ClickUp «Contacto de Reforma» (`901211441576`) entra en la fase **e1 EN ESPERA**
(campo `ETAPA_CRM`), recibe por WhatsApp la plantilla aprobada por Meta:

> Hola, hemos recibido tu solicitud de llamada. Un asesor te llamará en breve.

Así reconoce la llamada que le hace después el SDR desde el fijo de Netelip.

## Cómo funciona

```text
ClickUp ──webhook firmado──► /webhook/captacion/clickup ──► captacion_clickup_inbox ─┐
ClickUp ◄──barrido (5 min, solo lectura)───────────────────────────────────────────────┤
                                                                                       ▼
                                                   captacion_lead_espera (¿en e1? ¿desde cuándo?)
                                                                                       │ entrada nueva
                                                                                       ▼
Meta Cloud API ◄──plantilla── procesarAvisos ◄── captacion_whatsapp_avisos (pendiente)
Meta ──webhook firmado──► /webhook/whatsapp-cloud ──► entregado / leído / fallido
```

- **Disparador:** el webhook de ClickUp (`taskCreated`, `taskUpdated`) avisa en segundos. El barrido lista cada
  5 minutos los leads en e1 y recoge lo que el webhook no haya traído (caída del backend, webhook perdido).
- **Una solicitud = una entrada en e1.** Mismo `history_item` de ClickUp, o un lead que ya consta en espera desde
  antes de esa fecha, es la misma solicitud: no se reenvía. Si sale de e1 y vuelve, es una solicitud nueva y sí se
  envía. Webhook y barrido se coordinan con un bloqueo por lead (`FOR UPDATE`), así que no se pisan.
- **Línea base:** el primer barrido marca los leads que **ya** estaban en e1 al activar el módulo y **no** les
  escribe. Solo reciben aviso las entradas posteriores.
- **Teléfono:** campo `contact_phone_number`, normalizado a E.164 (España por defecto). Sin teléfono, con uno no
  válido o con un fijo (sin WhatsApp), el aviso queda `no_enviado` con su motivo.
- **Reintentos:** caída de la API, 5xx, límites de Meta y errores de token se reintentan (4 intentos en ~20 min).
  Un error definitivo (plantilla inexistente, destinatario no válido) o el último intento lo dejan `fallido`, con
  el código de Meta, y avisan a tecnología (`NETELIP_ALERT_WEBHOOK_URL`). El lead no se bloquea.
- **Comercial que llamará** (Alex, 13/11/2026): según el campo `Presupuesto formulario` del lead. Desde
  **100.000 €** («100.000 € - 200.000 €» y «Más de 200.000 €») es **Ernesto**; por debajo, sin presupuesto o con
  «Pendiente», **Victor**.
- **Número que envía y fijo anunciado** (Jean, 17/11/2026): el WhatsApp sale **siempre del número general**
  (+34 865 45 61 02). La plantilla `aviso_solicitud_llamada_comercial` anuncia el nombre del comercial y el **fijo de
  Netelip** desde el que llamará, para que el lead reconozca la llamada:

  > Hola, hemos recibido tu solicitud de contacto para tu reforma. {{1}}, asesor de Grupo LyN, te llamará en breve
  > desde el número {{2}}. Guárdalo para reconocer la llamada.

  `CAPTACION_WHATSAPP_PLANTILLA_PARAMETROS=nombre,telefono` dice qué va en cada variable; los fijos van en
  `…_REMITENTE_ALTO_TELEFONO` (Ernesto, +34 865 60 83 43) y `…_REMITENTE_BASE_TELEFONO` (Victor, +34 865 45 61 34).
  Si la plantilla pide un dato que el comercial no tiene configurado, el aviso espera con motivo `sin_configuracion`
  (nunca sale incompleto) y caduca a las 12 h. Queda registrado quién llamará (`remitente`), el fijo anunciado
  (`telefono_anunciado`), el número que lo envió (`remitente_numero_id`) y el presupuesto que lo decidió. Con
  `CAPTACION_WHATSAPP_PLANTILLA_PARAMETROS` vacío se usa una plantilla sin variables (la primera,
  `aviso_solicitud_llamada`). `…_REMITENTE_*_NUMERO_ID` solo hace falta si algún día un comercial envía desde su propio
  número de la Cloud API.
- **Tareas de prueba:** si el nombre de la tarea lleva «NO USAR» o la palabra «prueba» (convención del equipo,
  p. ej. «prueba Mateo-Roger(NO USAR)»), no se envía: queda `no_enviado` con motivo `prueba`. Sus teléfonos suelen
  ser inventados y podrían ser de alguien real. Para probar el envío de verdad, usar un lead con otro nombre y un
  móvil del equipo.
- **Modo QA:** con `CAPTACION_WHATSAPP_SOLO_TELEFONOS` (lista de móviles separados por comas) solo se escribe a esos
  números; cualquier otro lead queda `no_enviado` con motivo `qa`. En este modo las tareas de prueba **sí** se procesan
  (la lista ya protege), para que QA pueda usar la convención «PRUEBA … (NO USAR)». En producción va vacía.
  Guía de pruebas: [CAPTACION_WHATSAPP_PRUEBAS_QA.md](CAPTACION_WHATSAPP_PRUEBAS_QA.md).
- **Nunca escribe en ClickUp:** no cambia `ETAPA_CRM`, el estado ni ningún campo del lead.
- Las respuestas del lead por WhatsApp llegan al mismo webhook de Meta y **se ignoran** (fuera de alcance).

### Estados del aviso (`captacion_whatsapp_avisos.estado`)

| Estado | Significado |
| --- | --- |
| `pendiente` | Por enviar. `motivo` dice por qué espera: reintento, fuera de horario o sin configuración de la Cloud API. |
| `enviado` | Meta aceptó el mensaje (`wamid`, `enviado_en`). |
| `entregado` / `leido` | Confirmado por el webhook de Meta (`entregado_en`, `leido_en`). No retrocede aunque los avisos lleguen desordenados. |
| `fallido` | Falló el envío tras los reintentos o Meta lo rechazó después (`motivo` con el código). |
| `no_enviado` | No se intentó: `prueba`, `qa`, `sin_telefono`, `telefono_no_valido`, `telefono_fijo` o `caducado`. |

`caducado`: un aviso que no pudo salir en `CAPTACION_WHATSAPP_CADUCIDAD_MINUTOS` (12 h por defecto) ya no se envía.
«Un asesor te llamará en breve» no tiene sentido horas después, y así activar la Cloud API no dispara un atasco de
avisos viejos.

### Historial del lead

La tabla se relaciona con el lead por `clickup_task_id`, el mismo identificador que usan las reuniones de Meet y el
esquema centralizado. Lectura para el Dashboard (sesión de administración):

```text
GET /api/captacion/whatsapp/avisos?clickup_task_id=<id>     avisos de un lead, con fecha y estado de entrega
GET /api/captacion/whatsapp/avisos?limit=50                  los últimos avisos
```

## Paso a paso hasta producción

1. **Plantilla en Meta** (tarda de horas a 1–2 días; lanzarla primero). Con el token y el id de la cuenta de
   WhatsApp Business (`WHATSAPP_CLOUD_WABA_ID`) en `backend/.env`:

   ```bash
   cd backend && npx tsx captacion-whatsapp/alta.ts plantilla
   ```

   Crea `CAPTACION_WHATSAPP_PLANTILLA` (por defecto `aviso_solicitud_llamada`), categoría UTILITY, idioma `es_ES`,
   con el texto de Alex. Comprobar la aprobación con `npx tsx captacion-whatsapp/alta.ts estado-plantilla`. Si Meta
   cambia la redacción o la categoría, el código no cambia: solo envía la plantilla por su nombre.
2. **Números que envían:** los de Ernesto y Victor, dados de alta en la Cloud API. Si usan la app WhatsApp Business,
   por **coexistencia** (siguen usando la app; se conecta con un proveedor oficial de Meta). Al conectar se
   desvinculan sus dispositivos: hay que volver a escanear el QR de Evolution para que el Superagente siga leyendo sus
   chats; probarlo antes con un número no crítico. Sus ids van en `CAPTACION_WHATSAPP_REMITENTE_ALTO_NUMERO_ID`
   (Ernesto) y `CAPTACION_WHATSAPP_REMITENTE_BASE_NUMERO_ID` (Victor). Mientras no estén, el aviso sale del número
   general de la empresa (+34 865 45 61 02, `WHATSAPP_CLOUD_PHONE_NUMBER_ID=782222018312993`).
   Token: usuario del sistema `lyn-backend-captacion` (Empleado, token sin caducidad, permisos
   `whatsapp_business_messaging` y `whatsapp_business_management`). Hay que asignarle **tres** activos con control
   total: la app, la **cuenta de WhatsApp** y la **cuenta de mensajes** (Configuración → Cuentas → Cuentas de
   mensajes; en Grupo LyN es la `1476198046757580`, que paga los envíos). Sin la cuenta de mensajes, Meta rechaza
   el envío con el código 10 «Viewer cannot access the provided Paid Message Account». Cuidado: el usuario del
   sistema CHATWOOT también tiene acceso a esta cuenta.
3. **Webhook de Meta:** en la app de Meta, URL `https://<dominio>/webhook/whatsapp-cloud`, verify token =
   `WHATSAPP_CLOUD_VERIFY_TOKEN`, suscribir el campo `messages`. `WHATSAPP_CLOUD_APP_SECRET` = App Secret de la app.
   Nginx ya publica `/webhook/`.
4. **Variables** en `/etc/lyn/backend.env` (ver `deploy/env/backend.production.env.example`) con
   `CAPTACION_WHATSAPP_ENABLED=true` y, para el QA, `CAPTACION_WHATSAPP_SOLO_TELEFONOS` con el móvil de QA.
   Reiniciar el backend: crea las tablas y el primer barrido fija la línea base. El QA se hace así, en producción:
   [CAPTACION_WHATSAPP_PRUEBAS_QA.md](CAPTACION_WHATSAPP_PRUEBAS_QA.md); al terminar se vacía la variable y se
   reinicia.
5. **Webhook de ClickUp** (con `CLICKUP_TEAM_ID`):

   ```bash
   cd backend && npx tsx captacion-whatsapp/alta.ts webhook-clickup https://<dominio>/webhook/captacion/clickup
   ```

   Guardar el `webhook.secret` de la respuesta en `CAPTACION_CLICKUP_WEBHOOK_SECRET` y reiniciar. Sin él, el receptor
   responde 503 y solo funciona el barrido (con hasta 5 min de retraso).
6. **Prueba:** antes de activar, comprobar el envío con
   `npx tsx captacion-whatsapp/alta.ts prueba-envio "+34…" [plantilla] [idioma]` (por defecto `hello_world`, la de
   prueba de Meta; con el número de prueba, el móvil tiene que estar autorizado en «Para»). Ya activado, pasar a e1
   un lead con un móvil del equipo y un nombre sin «prueba» ni «NO USAR» y comprobar el mensaje y su fila en
   `captacion_whatsapp_avisos` (`enviado` → `entregado` → `leido`).

### Por verificar en vivo

- El formato exacto del `history_item` de ClickUp para un cambio de desplegable (se aceptan id, orderindex u
  objeto). Si no se reconociera, el barrido sigue detectando la entrada, con retraso de hasta 5 minutos.
- El nombre real del campo de teléfono (`CAPTACION_CLICKUP_CAMPO_TELEFONO`, por defecto `contact_phone_number`).

## Preguntas abiertas de la spec

- **Horario sin envíos:** resuelto (Jean): nunca entre las 20:00 y las 07:00, hora de Madrid →
  `CAPTACION_WHATSAPP_HORARIO=07:00-20:00`. Un lead que entra de noche recibe el aviso a las 07:00 (la caducidad de
  12 h cubre la noche entera). Vacío = siempre.
- **Número de WhatsApp que envía:** siempre el general de la empresa (+34 865 45 61 02), decidido por Jean el
  17/11/2026. Los fijos de Netelip de Ernesto y Victor no se conectan a la Cloud API: solo se anuncian en el mensaje
  (plantilla `aviso_solicitud_llamada_comercial`, pendiente de aprobación de Meta).
- **Webhook de estados de Meta:** la app Grupo LyN enviaba los eventos del número a un Chatwoot que no se usa
  (confirmado por Dani, 14/11/2026). Se reapunta a `/webhook/whatsapp-cloud` **después** de activar el módulo en
  producción (Meta verifica la URL al guardarla). Las respuestas de los leads llegan pero se ignoran (fuera de
  alcance): ya no quedan en ningún sitio. La app tiene que estar **publicada** (menú Publicar): sin publicar los
  mensajes salen, pero Meta no manda los webhooks de datos reales. Los permisos `whatsapp_business_*` bastan con
  acceso estándar («Listo para la prueba»): solo se usan con los activos del propio negocio, sin revisión de la app.
  El campo `messages` ya está suscrito.

## Variables

| Variable | Por defecto | Para qué |
| --- | --- | --- |
| `CAPTACION_WHATSAPP_ENABLED` | `false` | Interruptor general. |
| `CLICKUP_API_TOKEN` | — | Lectura de la lista (compartida con reuniones de Meet). |
| `CAPTACION_CLICKUP_LISTA` | `901211441576` | Lista «Contacto de Reforma». |
| `CAPTACION_CLICKUP_CAMPO_ETAPA` | `ETAPA_CRM` | Campo de etapa. |
| `CAPTACION_CLICKUP_ETAPA_ESPERA` | `e1. EN ESPERA` | Opción que dispara el aviso (se compara sin puntos, espacios ni mayúsculas). |
| `CAPTACION_CLICKUP_CAMPO_TELEFONO` | `contact_phone_number` | Campo del teléfono. |
| `CAPTACION_CLICKUP_CAMPO_PRESUPUESTO` | `Presupuesto formulario` | Rango del formulario web: decide el remitente. |
| `CAPTACION_WHATSAPP_UMBRAL_PRESUPUESTO` | `100000` | Desde este límite inferior del rango, remitente «alto». |
| `CAPTACION_WHATSAPP_REMITENTE_ALTO_NOMBRE` / `…_NUMERO_ID` | `Ernesto` / — | Remitente con presupuesto alto. |
| `CAPTACION_WHATSAPP_REMITENTE_ALTO_TELEFONO` / `…_BASE_TELEFONO` | — | Fijo de Netelip que anuncia la plantilla (`+34 865 60 83 43` / `+34 865 45 61 34`). |
| `CAPTACION_WHATSAPP_REMITENTE_BASE_NOMBRE` / `…_NUMERO_ID` | `Victor` / — | Remitente por defecto. |
| `CAPTACION_CLICKUP_WEBHOOK_SECRET` | — | Firma del webhook de ClickUp (`X-Signature`). |
| `WHATSAPP_CLOUD_TOKEN` | — | Envío por la Cloud API. |
| `WHATSAPP_CLOUD_PHONE_NUMBER_ID` | — | Opcional: número común para el remitente que no tenga uno propio. |
| `WHATSAPP_CLOUD_API_VERSION` | `v23.0` | Versión de la Graph API. |
| `WHATSAPP_CLOUD_APP_SECRET`, `WHATSAPP_CLOUD_VERIFY_TOKEN` | — | Webhook de estados de Meta. |
| `CAPTACION_WHATSAPP_PLANTILLA`, `CAPTACION_WHATSAPP_IDIOMA` | —, `es_ES` | Plantilla aprobada (`aviso_solicitud_llamada_comercial`). |
| `CAPTACION_WHATSAPP_PLANTILLA_PARAMETROS` | vacío | Variables de la plantilla, en orden: `nombre`, `telefono`. Con la de Jean: `nombre,telefono`. |
| `CAPTACION_WHATSAPP_HORARIO` | vacío | Franja de envío (Madrid). Producción: `07:00-20:00`. |
| `CAPTACION_WHATSAPP_SOLO_TELEFONOS` | vacío | Modo QA: solo se escribe a estos móviles. **Vacío en producción.** |
| `CAPTACION_WHATSAPP_CADUCIDAD_MINUTOS` | `720` | Antigüedad máxima para enviar. |
| `CAPTACION_BARRIDO_MINUTOS` | `5` | Frecuencia del barrido. |
| `WHATSAPP_CLOUD_WABA_ID`, `CLICKUP_TEAM_ID` | — | Solo para `alta.ts`. |

## Reversión

`CAPTACION_WHATSAPP_ENABLED=false` y reiniciar detiene todo al momento. Para quitar las tablas:
`backend/captacion-whatsapp/schema-down.sql` (solo borra `captacion_*`). Borrar el webhook de ClickUp aparte.

## Pruebas

```bash
cd backend && npx vitest run tests/captacion-whatsapp.test.ts
```

```bash
cd backend && QA_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:15439/lyn_qa_retest npx vitest run tests/captacion-whatsapp.integration.test.ts
```

QA de punta a punta en producción, en modo QA: [CAPTACION_WHATSAPP_PRUEBAS_QA.md](CAPTACION_WHATSAPP_PRUEBAS_QA.md).

La de integración cubre los cinco escenarios de la spec contra PostgreSQL real, con ClickUp y Meta simulados.
