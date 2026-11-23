# Resumen ejecutivo del lead (N-1.3)

Tras cada llamada procesada, el sistema deja en el campo «Resumen ejecutivo» de la tarjeta 4 líneas con etiqueta: qué quiere el
lead, dónde quedó la conversación, qué lo frena y para qué llamarlo. Ticket 869fny1ek, épico 869fny187. Código:
`backend/netelip/captacion/resumen.ts` (reglas), `repositorio.ts` (guardar y leer), `proceso.ts` (resumen anterior al modelo) y
`prompt.ts` (instrucciones y ejemplos, versión `captacion-v4`).

## Cómo funciona

1. Antes de llamar al modelo se lee el resumen que el lead tenía **antes de esa llamada** y se le da junto a la transcripción
   (generación incremental: no se le pasa todo el historial).
2. El modelo devuelve el resumen en el mismo JSON de N-1.2 (sin llamada extra), con cuatro bloques y, si hay fecha acordada,
   `fecha_prevista` y `fecha_prevista_cita` (la frase literal de la llamada que la demuestra).
3. El código lo valida (abajo). Si vale, lo guarda en `lead_resumen_historial` y lo incluye en lo que se escribe a ClickUp. Si no
   vale, **no se guarda, el anterior se mantiene** y el motivo consta en los descartes de la llamada.
4. El texto que llega a ClickUp es siempre el vigente: el de la llamada más reciente **por fecha de la llamada**. Una llamada vieja
   procesada tarde queda en el historial pero no sustituye a una posterior.

## Qué valida el código

| Regla | Qué pasa si no se cumple |
|---|---|
| Un bloque sin texto | Se escribe «Sin información». Con los cuatro vacíos no hay resumen (no se guarda ni cuenta como descarte) |
| Cada bloque en una línea | Los saltos de línea y espacios de más se recogen |
| Sin importes: `€`, «euros», «40k», «cien mil», «90.000», números de 5 cifras o más | Resumen descartado |
| Sin datos de contacto: email, teléfono (9 o más dígitos), marcadores `[NOMBRE]`, dirección (calle, avenida, plaza… seguida de un nombre o número) | Resumen descartado |
| `fecha_prevista` es una fecha real AAAA-MM-DD, no anterior al día de la llamada (hora de Madrid), no más de 400 días después, y trae una cita literal de la transcripción que menciona una fecha o un plazo | Resumen descartado: la fecha nunca se inventa |
| Sin fecha acordada | «Para qué llamarlo» termina en «sin fecha acordada» (lo añade el código) |
| Con fecha acordada | «Para qué llamarlo» lleva «fecha prevista DD/MM/AAAA» al final (lo añade el código, después de «Preguntar presupuesto» si toca). Si el bloque ya trae esa fecha, no se repite |
| Lead sin presupuesto vigente (de cualquier fuente) | «Para qué llamarlo» incluye «Preguntar presupuesto» (lo añade el código). Si el modelo escribe «No preguntar presupuesto», el resumen se descarta |
| Texto completo con etiquetas, 600 caracteres como máximo | Resumen descartado |

El prompt le pide al modelo hasta 140 caracteres en «Qué quiere» y 110 en cada uno de los otros tres, para que quepan los 600
aunque el código añada sus indicaciones. El número de líneas es siempre 4 (el ticket permite hasta 5).

## Datos

Tabla nueva `lead_resumen_historial` (aditiva e idempotente, se crea al arrancar con `ensureCaptacion`): un resumen por llamada
procesada, con los 4 bloques, la fecha prevista y la fecha de la interacción. Se añadió `fecha_interaccion` y `seq` a las columnas
del ticket para poder decidir cuál es el vigente. Nunca se borra ni se edita. La reversión (`schema-down.sql`) la borra con las
demás tablas de la captación.

## En ClickUp

- **Hay que crear el campo «Resumen ejecutivo»** (texto largo) en la lista «Contacto de Reforma». Lo crea un administrador
  (Dani o Jean). Mientras no exista, el sistema escribe el resto de la calificación y anota `resumen (el campo no existe en la
  lista)` en el informe, sin error.
- El campo es del sistema: si alguien lo edita a mano, el webhook lo restituye (igual que el desglose).
- **Que no se vea en la tarjeta cerrada del Board** (decisión de Jean, 18/11) es configuración de la vista de ClickUp, no del
  código: hay que dejar el campo oculto en las tarjetas del tablero y visible en el detalle de la tarjeta. Está sin comprobar.

## Qué no cubre (decirlo siempre)

- **Un resumen malo no se reintenta ni cuesta la calificación.** El ticket pide reintentos cuando la generación falla; aquí los
  reintentos existentes (lote y cola) cubren una salida de JSON inválida o un fallo del modelo, que dejan el resumen anterior. Pero
  si la salida es válida y solo el **texto** del resumen incumple una regla (un importe, un teléfono), la calificación de esa llamada
  se guarda igual y solo el resumen se descarta: no se reintenta toda la llamada por un defecto del texto.
- Las reglas de importes, teléfonos y direcciones son heurísticas de texto. Un importe escrito de forma muy rara o una dirección sin
  la palabra calle/avenida/plaza puede pasar. Una dirección se reconoce con la palabra de la vía y un nombre con mayúscula («calle
  Mayor») o con un número de portal («calle mayor 5», «avenida de la constitución 12, 3ºB»); «una calle ruidosa» o «plaza de garaje para
  2 coches» no cuentan.
- La cita de la fecha prevista debe mencionar una fecha o un plazo (un número, un día de la semana, un mes, «mañana», «semana»…): «te
  llamo cuando pueda» no respalda ninguna fecha. Es una comprobación de indicio, no de significado.
- **Dos llamadas del mismo lead a la vez pueden perder información** (revisión de Codex, 18/11). Cada una lee el resumen anterior antes de llamar al modelo y no hay bloqueo del lead durante esa llamada (no se retiene una conexión mientras el modelo contesta). Si la más nueva termina mientras la vieja sigue en curso, su resumen puede omitir lo de la vieja y quedar como vigente. El lote procesa las llamadas de una en una y por fecha, así que no ocurre ahí. **La cola o el disparador automático (aún sin construir) debe procesar las llamadas de un mismo lead de una en una.**
- La fecha prevista se comprueba contra una cita literal, pero el código no puede saber si esa frase significa la fecha elegida («mañana» frente a una fecha concreta): solo descarta fechas imposibles, pasadas o a más de 400 días.
- No se ha probado con el modelo real (Gemini): los ejemplos del prompt cumplen las reglas y pasan por el mismo validador, pero la
  calidad real de los resúmenes hay que mirarla con llamadas reales.
- El prompt creció de unos 12.900 a unos 17.200 caracteres (≈ 5.000 tokens) con el resumen y el ejemplo de seguimiento.
- Los resúmenes ya guardados no se regeneran al cambiar el prompt: el resumen de un lead se actualiza con su siguiente llamada.
