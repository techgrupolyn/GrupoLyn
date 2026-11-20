# Captación ABCD · flujo automático (cola de llamadas)

Cada llamada de Netelip que termina de transcribirse y dura 60 segundos o más entra en una cola. Un procesador la evalúa con el mismo
núcleo que el lote (vincula la llamada con su lead, califica, genera el resumen ejecutivo y la decisión de pase) y, si se le deja,
escribe el resultado en la tarjeta de ClickUp. Está apagado por defecto.

## Cómo se enciende

| Variable | Qué hace |
| --- | --- |
| `CAPTACION_WORKER_ENABLED=true` | Enciende el flujo: las transcripciones nuevas se encolan y el procesador las evalúa. Sin ella no se encola ni se procesa nada. |
| `CAPTACION_ESCRIBIR_CLICKUP=true` | Permite escribir en las tarjetas. Sin ella el flujo es un simulacro: guarda todo en la base y no toca ClickUp. |
| `CAPTACION_RECUPERACION_DIAS` | Días hacia atrás que mira la recuperación (por defecto 2). Si el flujo estuvo parado más tiempo, súbela una vez para recoger lo que quedó fuera y vuelve a dejarla. |
| `CLICKUP_API_TOKEN`, `CAPTACION_CLICKUP_LIST_ID` | Lectura de los leads y escritura de campos. Sin ellos el flujo no arranca y avisa en el log. |
| `CAPTACION_GEMINI_API_KEY` (o `GOOGLE_GEMINI_API_KEY`), `CAPTACION_MODEL` | Modelo de la evaluación. Sin clave el flujo no arranca y avisa en el log. |

Orden recomendado para la primera vez: encender solo `CAPTACION_WORKER_ENABLED`, mirar la cola durante unos días y, cuando las
evaluaciones se vean bien, añadir `CAPTACION_ESCRIBIR_CLICKUP`. Para apagarlo basta quitar la variable y reiniciar.

## Qué hace con cada llamada

1. **Cola.** `captacion_cola` tiene una fila por llamada. Al terminar la transcripción se encola sola; cada 10 minutos una recuperación
   encola las transcritas en los últimos 2 días (`CAPTACION_RECUPERACION_DIAS`) que se hubieran quedado fuera (un aviso perdido, un
   reinicio). No recoge todo el histórico a propósito: al encender el flujo no se procesan las llamadas antiguas.
2. **Orden.** Una sola llamada a la vez en todo el sistema (cerrojo de sesión de Postgres, espacio 7102) y por fecha de la llamada. Una
   llamada espera a que terminen las anteriores del mismo teléfono: el resumen de una parte del de la anterior y la decisión se toma con
   el lead al día.
3. **Leads.** Lee la lista de ClickUp con una vigencia de 5 minutos (no relee 2.000 tarjetas por llamada), deja el alcance provisional y el
   rango del formulario como datos del lead, y busca el lead por teléfono. Solo cuentan las tarjetas padre y vivas (e1 a e13).
4. **Evaluación.** Igual que el lote. Un lead en F2 o más allá no genera decisión de pase.
5. **Escritura.** Con permiso, escribe en la tarjeta calificación, desglose, presupuesto, resumen ejecutivo y demás campos permitidos.
   Si la tarjeta ya no está viva, no se toca.

## Estados de `captacion_cola`

| Estado | Significado |
| --- | --- |
| `pendiente` | Espera su turno (o su siguiente intento: `proximo_intento`). |
| `procesando` | Reclamada por el procesador. Si el servicio se cae, vuelve a estar disponible a los 10 minutos. |
| `procesada` | Evaluada. La columna `escritura` dice qué pasó con ClickUp: `escrita`, `simulada`, `no_vivo` o `error`. |
| `sin_lead` | Cola «sin lead»: ninguna tarjeta coincide con el teléfono. Se vuelve a mirar cada 6 horas, hasta 3 veces, por si el lead se crea después. |
| `sin_conversacion` | La grabación no tiene conversación o la transcripción ya no existe. |
| `error` | Cola de errores: el modelo falló 3 veces (entre un intento y otro espera 1 y 5 minutos). Avisa a tecnología. |

Si ClickUp no contesta al leer los leads, la llamada vuelve a `pendiente` sin gastar intento y se prueba de nuevo a los 5 minutos. Si
falla la escritura, la llamada queda `procesada` con `escritura = 'error'` y una reparación la repite sin volver a llamar al modelo
(cada 15 minutos como mucho, durante 2 días).

## Consultas útiles

```sql
SELECT estado, escritura, count(*) FROM captacion_cola GROUP BY 1, 2 ORDER BY 1, 2;
SELECT llamada_id, estado, intentos, motivo FROM captacion_cola WHERE estado IN ('error', 'sin_lead') ORDER BY actualizado_en DESC;
```

Para reintentar una llamada en `error`: `UPDATE captacion_cola SET estado = 'pendiente', intentos = 0, proximo_intento = now() WHERE llamada_id = '...';`

## Qué está probado y qué no

Probado de punta a punta en local (Postgres en memoria, ClickUp falso y modelo falso): encolar, orden por fecha, exclusión por teléfono,
reintentos y cola de errores, cola «sin lead», ClickUp caído, escritura fallida y su reparación, simulacro, cerrojo, y el enganche con
la transcripción. Con mutaciones sobre `cola.ts` (`mutaciones-cola.mjs`).

No probado: Gemini real, ClickUp real, dos servicios a la vez contra la misma base (el cerrojo y `SKIP LOCKED` se comprueban con
simulación, no con dos conexiones reales), el arranque en el servidor real (solo se comprueba que los procesos se construyen).

## Reversión

`schema-down.sql` borra `captacion_cola` junto con el resto de tablas de la captación. Para quitar solo el flujo automático basta apagar
`CAPTACION_WORKER_ENABLED`: las tablas de calificación, resumen y decisión no cambian.
