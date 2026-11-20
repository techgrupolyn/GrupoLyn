# Captación · N-1.0 · Llamada de Netelip ↔ lead de «Contacto de Reforma»

Ticket: N-1.0 (`1an2gnq0c77`), subtarea del épico de captación (`869fny187`). Bloquea la calificación (N-1.2), la decisión de pase (N-1.4) y la
calibración con el histórico: sin saber a qué lead pertenece cada llamada no se puede calificar nada.

## Qué pasaba

El Historial de llamadas del Dashboard General resuelve el contacto de cada llamada con las tablas `clientes` y `crm_leads` (el CRM del
Superagente). Los leads que entran por el formulario web y por Meta viven en ClickUp («Contacto de Reforma», lista `901211441576`), no ahí.
Por eso casi todas las llamadas del SDR salían como «Sin contacto identificado», aunque el teléfono sí estuviera en una tarjeta.

## Qué hace ahora

Cada llamada tiene una fila en `captacion_llamada_lead` con su estado:

| Estado | Qué significa |
| --- | --- |
| `vinculada` | El teléfono (o, si no, el email) coincide con UNA tarjeta padre. Guarda la tarjeta, su nombre y la vía (`telefono`, `email` o `manual`). |
| `varias_coincidencias` | Coincide con varias tarjetas: no se asigna sola. Guarda las candidatas y aparece en la lista para elegir a mano. |
| `sin_coincidencia` | Ninguna tarjeta coincide (todavía). |
| `sin_datos` | Número oculto y sin email. |

- **Teléfono:** se normaliza igual en los dos lados (`claveTelefono`): `638 82 92 13`, `34638829213`, `0034638829213` y `+34638829213` son el mismo.
- **Email:** si el teléfono no coincide con ninguna tarjeta, se prueba el email de la ficha del Dashboard a la que ya esté enlazada la llamada (lead
  o cliente); las llamadas de Netelip no traen email propio.
- **Qué tarjetas cuentan:** las tarjetas padre de cualquier fase y abiertas o cerradas (las cerradas son las que tienen historial). Las subtareas no.
- **Solo lee ClickUp.** Lo único que escribe es `captacion_llamada_lead`.

## Cuándo corre

- **En el servicio** (`CAPTACION_VINCULO_ENABLED=true`, necesita `CLICKUP_API_TOKEN` y `CAPTACION_CLICKUP_LIST_ID`, no necesita Gemini): una pasada
  cada minuto. Lee los leads de ClickUp con una vigencia de 5 minutos. Toma las llamadas sin fila y vuelve a mirar las que no coincidieron en los
  últimos 30 días (el lead puede crearse después de la llamada). Una llamada ya vinculada no se toca. Apagado por defecto.
- **El repaso del histórico** (una vez, o cuando haga falta), desde `backend/`:

  ```
  npx tsx netelip/captacion/vinculo-cli.ts
  ```

  Mira todas las llamadas sin lead, de cualquier fecha, con los leads recién leídos. Es seguro repetirlo. Imprime solo totales, sin nombres ni
  teléfonos: cuántas se asociaron, cuántas quedaron con varias coincidencias y cuántas sin coincidencia.

## Qué se ve en el Dashboard

- **Historial de llamadas:** la fila y el detalle muestran el lead de ClickUp (nombre, enlace a la tarjeta y «Lead ClickUp») en vez de «Sin contacto
  identificado». El indicador y el filtro «Sin contacto identificado» ya no cuentan las vinculadas, y la búsqueda encuentra por el nombre del lead.
- **Llamadas con varias coincidencias:** un aviso encima de la tabla (solo si hay alguna) para elegir a mano la tarjeta correcta.
  - `GET /api/captacion/llamadas/sin-asignar`: la lista, con las candidatas y el resumen por estado. Pide sesión con acceso al Historial.
  - `POST /api/captacion/llamadas/:id/asignar` con `{ "clickup_task_id": "..." }`: la tarjeta tiene que ser una de las candidatas. Pide el mismo
    permiso que validar decisiones de pase (`CAPTACION_DECISION_VALIDADORES`, o los roles que supervisan el calificador).
  - Lo asignado a mano (`origen = manual`) no lo pisa el cruce automático y lo respeta la cola de la calificación (`leadAsignado`). Si la llamada
    se había rendido como «sin lead» en esa cola, se reabre.

## Qué no cubre

- **No escribe nada en ClickUp** y no mueve tarjetas.
- **No crea leads:** una llamada de alguien que nunca pasó por «Contacto de Reforma» queda como `sin_coincidencia`.
- **La cola de la calificación solo califica leads vivos (e1 a e13)**; el cruce de N-1.0 usa todas las tarjetas padre. Una llamada puede quedar
  vinculada a un lead cerrado y, aun así, no generar calificación.
- **Sin probar en producción** ni con ClickUp real. Probado con Postgres en memoria y ClickUp falso (ver las pruebas `captacion-vinculo.test.ts`).
- **Teléfonos de otros países sin prefijo:** sin el país no se pueden normalizar (`020 7946 0958` puede ser de cualquier sitio); coinciden los escritos con prefijo (`+44 20 7946 0958`) y los españoles en cualquier formato.
- **Asignación a mano durante una evaluación en curso:** si ocurre mientras se evalúa una llamada y es a otra tarjeta, no se escribe en ClickUp y la llamada pasa a la cola de errores con aviso (la evaluación ya quedó guardada sobre la primera tarjeta). Con la llamada a punto de rendirse como «sin lead», se reabre.
- **La lista de varias coincidencias trae como mucho 500 llamadas;** el aviso muestra el total real y, al asignar, entran las siguientes.
- **No hay botón para deshacer una asignación manual:** si se asigna mal, hay que corregirla en la base.

## Reversión

`backend/netelip/captacion/schema-down.sql` borra la tabla (`captacion_llamada_lead`). El listado del Historial sigue funcionando sin ella solo si
se vuelve a crear con el arranque (`ensureCaptacion`); mientras la tabla no exista, el listado falla: revierte el código a la vez.
