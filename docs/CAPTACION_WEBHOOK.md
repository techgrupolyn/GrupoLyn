# Webhook de ClickUp de la captación ABCD

Registra los cambios que un comercial hace **a mano** en una tarjeta de «Contacto de Reforma» (Categoría, Presupuesto y
motivo de No continuidad), recalcula la calificación y deja en ClickUp lo que escribe el sistema. Código:
`backend/netelip/captacion/webhook.ts` (lógica) y `webhook-ruta.ts` (ruta HTTP). Épico 869fny187, punto 5 de N-1.1.

## Qué hace con cada cambio

El aviso de ClickUp (`taskUpdated`) solo dice **qué campo** tocó **quién**; el valor se lee de la tarea. Los avisos del
usuario de integración (el dueño del token) y los de subtareas se descartan.

| Cambio manual | Qué se registra |
|---|---|
| Categoría (`valoracion_interna`) distinta de la que calculó el sistema | `cambio_categoria_manual`. Una A+ sin presupuesto de 100.000 € o más queda en A y ClickUp se corrige. Poner No apto marca el No apto a mano; sacarlo de No apto lo quita |
| Presupuesto (`presupuesto_estimado`) distinto del vigente | Evento de presupuesto con fuente «Manual» (cuenta siempre como presupuesto del proyecto), `cambio_presupuesto` y ponderado recalculado |
| No continuidad = «Presupuesto insuficiente» | Equivale a marcar No apto (`cambio_categoria_manual` a No apto) y **manda sobre la categoría mientras siga puesto**: si alguien elige otra categoría con ese motivo, el lead sigue en No apto y ClickUp se corrige (primero hay que cambiar el motivo) |
| El motivo deja de ser «Presupuesto insuficiente» y el No apto venía de una marca manual | Vuelve la última categoría que el lead tenía antes de No apto (Sin calificar si no tenía otra). Si el No apto lo puso la matriz de la llamada, no se levanta |
| Alguien edita un campo que solo escribe el sistema (ponderado, fuente, índice de orden, desglose) | No se registra nada; el sistema lo restituye |
| Importe vacío o 0, categoría vacía | No se registra (no es un presupuesto ni una categoría); el sistema restituye el campo |

Un lead que el sistema nunca calificó **solo** se da de alta si el cambio manual es de categoría, de presupuesto o del
motivo de No continuidad. Cualquier otro cambio en esa tarjeta no crea nada.

Repetir o reenviar un aviso es inofensivo: el presupuesto manual no se duplica (mismo cambio = misma interacción) y los
campos que ya están bien no se vuelven a escribir. Los avisos de una misma tarea se atienden de uno en uno; los de
tareas distintas, a la vez.

Cada lead se califica dentro de una transacción que lo bloquea (`pg_advisory_xact_lock` por id de tarea): un aviso, otro aviso
de una segunda instancia y la carga inicial no pueden darlo de alta dos veces ni pisarse. La cola en memoria solo ordena los
avisos de una misma instancia.

Si una escritura del sistema a ClickUp falló y la tarjeta se quedó con el valor viejo, eso **no** se toma por un cambio
manual: solo cuenta un campo que el aviso dice haber tocado un humano. En el siguiente aviso de esa tarjeta el sistema lo
restituye.

## Variables (`/etc/lyn/backend.env`)

| Variable | Valor |
|---|---|
| `CAPTACION_WEBHOOK_ENABLED` | `true` para activar. Sin esto la ruta no existe (404) |
| `CAPTACION_WEBHOOK_SECRET` | El `secret` que devuelve ClickUp al crear el webhook. No va al repo ni a chats |
| `CLICKUP_API_TOKEN` | Token del **usuario de integración**. Ojo: los cambios que haga ese usuario se descartan como «escritura del sistema», así que no debe ser el de una persona que edite tarjetas a mano |
| `CAPTACION_CLICKUP_LIST_ID` | `901211441576` |
| `CAPTACION_INTEGRATION_USER_ID` | Opcional. Si no está, se toma el dueño del token (`GET /user`) |

Si falta algo estando activado, el backend arranca igual, no abre la ruta y deja una línea `[captacion] webhook apagado: …`.

## Registrar el webhook en ClickUp

Un solo webhook sobre la lista, solo el evento `taskUpdated` (`POST /team/{team_id}/webhook`). ClickUp no tiene IP fija
(no se puede filtrar por IP): la defensa es la firma `X-Signature` (HMAC-SHA256 del cuerpo exacto con el secreto), que la
ruta comprueba antes de leer nada. La ruta es `POST /webhook/clickup/captacion`, fuera de `/api` y antes del parser JSON
global (la firma necesita los bytes originales).

```json
{ "endpoint": "https://<dominio>/webhook/clickup/captacion", "events": ["taskUpdated"], "list_id": 901211441576 }
```

La respuesta trae `webhook.secret`: va a `CAPTACION_WEBHOOK_SECRET`. Un segundo webhook sobre la misma lista duplicaría
los avisos (es inofensivo por lo anterior, pero gasta llamadas).

Nginx, bloque nuevo junto al de Netelip (sin `allow`/`deny`):

```nginx
location /webhook/clickup/ {
    client_max_body_size 1m;
    proxy_pass http://127.0.0.1:3003/webhook/clickup/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 30s;
}
```

## Respuesta y registro

La ruta responde `200` en cuanto la firma y el formato son válidos y sigue en segundo plano (ClickUp desactiva el webhook
si tarda o falla muchas veces). Firma mala: `401`. Cuerpo que no es un aviso de ClickUp: `400`. En el registro del servicio
(`journalctl -u lyn-backend | grep captacion_webhook`) queda una línea JSON por aviso con la tarea y el resultado
(`ignorado` con su motivo, o `procesado` con lo registrado y los campos escritos). No lleva datos de clientes.

## Qué no cubre (decirlo siempre)

- **No se pudo confirmar el formato exacto del campo `custom_field` dentro de `history_items`** con avisos reales de
  ClickUp (la documentación no lo detalla). El código reconoce el campo por su id o su nombre en cualquier parte del
  elemento y, si el aviso no dice qué campo fue, da por tocados todos los vigilados y deja que la comparación con el
  estado guardado decida. Primera comprobación al activarlo: cambiar a mano la categoría de una tarjeta de prueba y mirar
  la línea `captacion_webhook` en el registro.
- Probado con un ClickUp de mentira (la tarea y los campos son los de la lista real, pero no se llamó a ClickUp) y con
  Postgres real en local. No se probó la ruta detrás de Nginx ni con un aviso real.
- **El aviso se confirma (200) antes de guardarse y la cola vive en memoria.** Si el servicio se cae justo después de
  responder y antes de procesar, ese cambio manual no se registra ni ClickUp lo reenvía (lo detectó la revisión de Codex del
  17/11). Peor: si después alguien edita un campo del sistema en esa tarjeta, el sistema restituye su valor viejo y pisa el
  cambio manual perdido. La solución de fondo es una bandeja en Postgres (como la de Netelip) que guarde el aviso antes de
  responder y lo procese con reintentos; no está hecha. Mientras tanto, reiniciar `lyn-backend` en horas de poco uso.
- No usa `taskCreated`: un lead nuevo se califica por la carga inicial o por su primera llamada.

## Reversión

`CAPTACION_WEBHOOK_ENABLED=false` (o quitar la variable) y reiniciar `lyn-backend`: la ruta deja de existir. Después,
borrar el webhook en ClickUp (`DELETE /webhook/{id}`) para que no siga mandando avisos que reciben 404.
