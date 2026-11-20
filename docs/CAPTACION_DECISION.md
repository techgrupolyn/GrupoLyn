# Decisión de pase del SDR (N-1.4)

Primera fase de la metodología «Escalado de SDR»: **SDR → IA → Ernesto**, solo para la decisión de **pase** (si el lead pasa o no a la
sesión de conceptos, F2). Ticket 869fpj8e0, épico 869fny187. Ninguna decisión mueve la tarjeta de fase ni escribe al cliente: es una
recomendación que ejecutan el SDR o Ernesto.

## Cómo funciona

1. **La IA decide por su cuenta.** En el mismo llamado al modelo de N-1.2/N-1.3 se añade `decision_ia`: decisión, de 1 a 3 motivos con su
   cita, excepciones, dudas, «Pendiente de Ernesto» y de 1 a 3 próximos pasos (cada uno con su cita). El modelo **nunca recibe la
   propuesta del SDR**. Un lead en F2 (e4) o más allá no genera decisión (el prompt le dice que devuelva `null` y el código la ignora).
2. **El SDR propone** en el detalle de la llamada del Dashboard General: decisión, motivo de la lista (o «otro» con su texto) y el dato
   de la llamada que la justifica. Una sola vez por llamada. **No ve la decisión de la IA hasta registrar la suya**: el servidor no la
   manda antes.
3. **Se crea el caso para Ernesto** cuando existen las dos propuestas, sea cual sea el orden. Motivo de escalado por prioridad:
   `discrepancia` (decisión **o motivo** distintos: coincidir es coincidir en las dos cosas) > `excepcion` (descuento, condiciones de pago, topógrafo, fuera de zona, videollamada, sesión sin
   un decisor, o un paso que «requiere Ernesto») > `duda` (presupuesto al límite, encaje incierto, viabilidad técnica, o «Pendiente de
   Ernesto») > `piloto` (todo lo demás: durante el piloto Ernesto valida el 100 %).
4. **Ernesto revisa** en la bandeja: **Confirmar** (si SDR e IA no coinciden en decisión y motivo, tiene que decir con quién está de
   acuerdo) o **Corregir** (decisión, motivo y el dato que cambia su criterio son obligatorios; puede editar los próximos pasos). Quedan
   guardadas por separado las tres valoraciones (`decision_lead`: sdr, ia y ernesto).
5. **La decisión final se refleja en la tarjeta** (campo de texto «Decisión de pase»: «Seguimiento · Ernesto») si el servidor tiene
   `CLICKUP_API_TOKEN` y `CAPTACION_CLICKUP_LIST_ID`. Es informativo y no falla la revisión si ClickUp no contesta.

## Datos (se crean al arrancar con `ensureCaptacion`, aditivos e idempotentes)

| Tabla | Para qué |
|---|---|
| `decision_lead` | Una fila por actor y llamada (`sdr`, `ia`, `ernesto`). Nunca se edita. La IA lleva `version_guion`, `version_manual` y `version_prompt`; `origen` es `nuevo` o `historico` (solo la IA puede ser histórica) |
| `validacion_decision` | El caso de la bandeja: coincidencia, motivo de escalado, estado (`pendiente_ernesto`, `validada`, `corregida`) y quién y cuándo lo revisó |
| `decision_motivo_config` | Lista de motivos de cada decisión, **versionada**: publicar una versión nueva cambia la lista sin desplegar. «otro» existe siempre y no se configura |
| `decision_contexto_config` | Guion del SDR y manual de reglas que recibe la IA, **versionados por tipo**: un guion nuevo es una fila nueva |

Para publicar una lista de motivos nueva se insertan TODAS sus filas con una versión mayor (la lista vigente es la de mayor versión):

```sql
INSERT INTO decision_motivo_config (version, decision, codigo, etiqueta, orden) VALUES (2, 'seguimiento', 'falta_dato_cliente', 'Falta el plano', 1), …;
```

Para un guion o manual nuevo: `INSERT INTO decision_contexto_config (tipo, version, texto) VALUES ('guion', 2, '…');`.

## API (rutas en `decision-rutas.ts`, mismas sesión y roles que Historial de llamadas)

| Ruta | Quién | Qué hace |
|---|---|---|
| `GET /api/netelip/calls/:id/decision` | Quien ve Historial de llamadas | Estado para el SDR: su propuesta, la lista de motivos y, solo si ya decidió, la de la IA |
| `POST /api/netelip/calls/:id/decision` | ídem | Registra la propuesta del SDR (400 si no cumple; 409 si la llamada no tiene lead o ya está registrada) |
| `GET /api/captacion/decisiones/bandeja?estado=pendientes\|revisados\|todos` | Validadores | Una fila por caso |
| `GET /api/captacion/decisiones/llamada/:id` | Validadores | El caso completo con el resumen del lead (N-1.3) y su calificación |
| `POST …/llamada/:id/confirmar` (`a_favor`: sdr o ia) y `…/corregir` | Validadores | Revisan el caso (409 si ya está revisado) |
| `GET /api/captacion/decisiones/acierto` | Validadores | Tabla de acierto |

**Validadores:** por defecto los mismos roles que supervisan el calificador (superadmin, admin, director y director general); se cambian con
`CAPTACION_DECISION_VALIDADORES` (roles separados por comas). Sin permiso de leer transcripciones no sale ningún texto que suele ser de la
llamada: las citas de la IA y de sus pasos, el «dato o cita» de ninguno de los tres actores y el texto libre de un motivo «otro» de la IA.

**Concurrencia:** la decisión de la IA y la propuesta del SDR se guardan bajo el mismo bloqueo por lead (`pg_advisory_xact_lock`), para que
dos transacciones simultáneas no dejen sin crear el caso de Ernesto.

## Acierto

Solo casos `nuevo` ya revisados. «SDR e IA coinciden»: de los casos en que coincidieron en decisión y motivo, cuántos Ernesto **confirmó**.
Por actor (SDR, IA): de todos los revisados, cuántos tienen su decisión **y** su motivo como los finales de Ernesto. Los próximos pasos
no cuentan y los históricos de la calibración no suman.

## Calibración con el histórico

```bash
npx tsx netelip/captacion/calibracion-cli.ts --informe C:/ruta/fuera-del-repo/calibracion.csv --confirmo-copia
```

La IA decide sobre **todas** las llamadas ya transcritas con lead identificado (también leads ya en F2 o cerrados: su fase actual es el
desenlace con el que se compara) y el informe las compara con lo que pasó con el lead en «Contacto de Reforma». Solo lectura de ClickUp.
Las llamadas sin lead identificado quedan fuera del informe (solo se cuentan). Las decisiones quedan como `historico`: sin caso en la
bandeja y sin sumar al acierto. Usa una **copia** de la base (como el lote). Comparación orientativa: pasar a reunión coincide si el lead
avanzó (de F2 en adelante); descartar, si se perdió o rechazó; seguimiento, si sigue antes de F2; derivar a Partners no tiene referencia en
el tablero.

## Qué no cubre (decirlo siempre)

- **El guion v1 es una marca de «pendiente de cargar».** El guion real (versión 2, que incluye las reglas de escalado) se carga con un
  SQL aparte antes de activar el flujo; el manual v1 está armado con las reglas explícitas de N-1.4. La lista de motivos es la que fijó
  Jean el 19/11 (cuatro decisiones, motivos fijos y «Otro»); cambiarla es publicar una versión mayor, sin desplegar.
- **Probado con Gemini y ClickUp reales el 19/11, en una copia de la base** (no en producción). El prompt con el guion v2 pasa de
  26.800 a unos 62.800 caracteres (≈ 17.000 tokens por llamada); el bloque fijo es igual en todas las llamadas.
- **El flujo automático** (cola) está descrito en `CAPTACION_COLA.md`; hay que activarlo con las variables `CAPTACION_*` tras el despliegue.
- **La bandeja muestra el id de la tarjeta de ClickUp**, no el nombre del lead (la base de captación no guarda nombres): lleva un enlace
  a la tarjeta.
- Independencia frente a «la IA revisa los descartes del SDR» (texto literal del guion): manda la independencia (la IA nunca ve al SDR).
  La revisión se hace por comparación: si el SDR descarta y la IA no lo confirma con claridad, el caso va a Ernesto por discrepancia o duda.
- Un SDR solo puede registrar una vez por llamada, y solo si la llamada ya está vinculada a un lead (procesada por la captación).
- La regla «solo SDR» se aplica por la **fase del lead**, no por quién llama (P-08, sugerencia a Alex pendiente de su respuesta). Mientras
  Alex responde P-02, P-03 y P-08 se siguen las sugerencias del ticket.
- La calibración no distingue las llamadas del SDR de las de los closers (toma todas las transcritas con lead identificado).

## Reversión

`schema-down.sql` borra las tablas de la captación, incluidas las de este ticket (con sus decisiones). Solo para entornos de prueba o si no
llegó a usarse. El campo «Decisión de pase» de ClickUp lo crea y lo borra un administrador.
