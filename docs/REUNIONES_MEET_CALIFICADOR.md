# Reuniones de Meet en el calificador interno (ticket 869fppbcj)

Las reuniones de Meet de los closers (F2 visita, F3 presentación, F4) entran en la base de datos, se vinculan a su
comercial y a su fase, y quedan listas para evaluarse con la rúbrica activa de su fase. Código en
`backend/reuniones-meet/`.

## Flujo

1. La sincronización de Google Drive ya importa las transcripciones (`google_drive_artifacts`, tipo `transcript`) y
   resuelve el organizador con Calendar (`meeting_artifact_organizers`). Esta parte no cambia.
2. Cada minuto, `ingestarTranscripciones` crea una fila `pendiente` en `reunion` por cada transcripción con texto que
   aún no la tenga. Un mismo archivo visto desde dos cuentas cuenta una vez (`UNIQUE google_file_id`).
3. `vincularPendientes` decide el estado de cada reunión, en este orden:

| Comprobación | Estado si falla |
|---|---|
| Nadie se niega a grabar | `sin_consentimiento` (definitivo) |
| Organizador conocido y activo | `sin_comercial` |
| Organizador en `comercial_rol` (por `empleado_id`) | `sin_comercial` |
| Fase en el título (F2/F3/F4, «visita», «presentación») | `sin_rubrica` (sin fase) |
| Versión activa en `rubrica_version` para esa fase | `sin_rubrica` |
| Todo lo anterior | `por_evaluar` con `version_rubrica` |

Las `sin_comercial` se revisan solas cuando alguien vincula al organizador a mano o se da de alta un comercial.
`reabrirSinRubrica(pool, fase)` devuelve a `pendiente` las `sin_rubrica` de una fase tras activar su rúbrica.

## Migración de las tablas del calificador (acordada con Juan, 11/11/2026)

La hace este módulo (`migracion-calificador.ts › adaptarCalificador`), aditiva, en un único bloque `DO` que se aplica
en cada arranque y comprueba cada paso. Juan la revisa antes de pasar a `main`.

| Tabla | Cambio | Por qué |
|---|---|---|
| `llamada_evaluacion` | + `reunion_id BIGINT` con FK `llamada_evaluacion_reunion_fk → reunion(id) ON DELETE RESTRICT` | Una sola tabla de notas para el gráfico 5 |
| | `llamada_id`, `extension_netelip` y `rol` admiten nulos | Una reunión no tiene llamada ni extensión |
| | `CHECK (num_nonnulls(llamada_id, reunion_id) = 1)` | Exactamente uno: una fila no mezcla llamada y reunión |
| | Índice único `(reunion_id, COALESCE(rubrica_version_id, 0))` | Una evaluación por reunión y versión, mismo patrón que las llamadas (PR #33) |
| `rubrica_version` | CHECK de `rol` con `closer_f4` | Rúbrica de cierre (F4) |
| `objecion_marketing` | `llamada_id` admite nulos; `CHECK` al menos `llamada_id` o `evaluacion_id` | La objeción de una reunión va por `evaluacion_id → llamada_evaluacion.reunion_id` |
| `comercial_rol` | Clave `id` propia; `extension_netelip` opcional y `UNIQUE`; `empleado_id UNIQUE`; rol `closer_f4` | Closers sin extensión, una fila por persona. La extensión sigue siendo única porque la cola, el envío y el alta hacen `ON CONFLICT (extension_netelip)` |

- `ROLES_COMERCIALES` (`netelip/calificador/schema.ts`) incluye `closer_f4`: es lo que valida el alta del Dashboard.
- La cola de llamadas (`netelip/calificador/proceso.ts`) solo coge filas con `llamada_id`: sin ese filtro, una reunión
  pendiente sería la más antigua y la cola se pararía. Las reuniones tendrán su propio procesador.
- Si `comercial_rol` ya tuviera un empleado repetido, `UNIQUE (empleado_id)` no se aplica (aviso en el log) para no
  tumbar el arranque; el resto de la migración sí.
- **Rúbrica de una reunión:** `rubrica_version` (PR #33) tiene una versión activa **por rol**, y la de la reunión sale de
  su fase: F2 → `closer_f2`, F3 → `closer_f3`, F4 → `closer_f4`. `reunion` guarda `rubrica_version_id` y, como
  `version_rubrica`, el código de la versión (`closer_f2-v1`), igual que las llamadas.
- **Envío por WhatsApp:** `enviarPendientes` solo envía evaluaciones de llamadas (`llamada_id IS NOT NULL`).
- **Consentimiento:** las reuniones usan el mismo detector que las llamadas (`detectarNegativaGrabacion`).
- `sin_rubrica` vive solo en `reunion`; `sin_consentimiento` se llama igual en las dos tablas.
- Feedback por WhatsApp a los closers: excluido hasta que negocio lo decida.

## Lead (Contacto de Reforma)

`vincularLeads` (`lead.ts`) decide `lead_estado` cuando la consulta de invitados ya terminó:

| `lead_estado` | Cuándo |
|---|---|
| `pendiente` | Faltan los invitados o la búsqueda (sin `buscarLead` configurado, todas se quedan aquí) |
| `vinculado` | Los emails externos coinciden con **una** tarea padre de «Contacto de Reforma» → `lead_id` = su `clickup_task_id` |
| `sin_lead` | Ninguna coincidencia, varias, o la reunión no tiene invitados externos (motivo en `lead_motivo`) |

- La búsqueda está en `clickup.ts` (solo lectura, API v2): pide los campos de la lista una vez, filtra las tareas por el
  campo de email de cada invitado externo, se queda con las tareas **padre** y comprueba el email sin mayúsculas. Devuelve
  también la `ETAPA_CRM` del lead, que se guarda en `reunion.lead_etapa`.
- Se activa con `CLICKUP_API_TOKEN`. Nombres por defecto, **tomados del ticket sin poder comprobarlos** (no hay acceso a la
  lista): lista `901211441576`, campo `email`, campo `ETAPA_CRM`. Se cambian con `REUNIONES_MEET_CLICKUP_LISTA`,
  `REUNIONES_MEET_CLICKUP_CAMPO_EMAIL` y `REUNIONES_MEET_CLICKUP_CAMPO_ETAPA`. Si el campo de email no existe, la búsqueda
  falla y las reuniones siguen `pendiente` (no se marca «sin lead» por error).
- El teléfono (`contact_phone_number`) no se usa: Calendar no da el teléfono de los invitados.

### Fase desde el CRM

Manda el título. Si no la dice, se usa la **etapa actual** del lead (no hay historial de etapas): por defecto solo
`e4 → F2` (lo que dice el ticket). Las de F3 y F4 se añaden con `REUNIONES_MEET_ETAPAS=e4:F2,e6:F3,e9:F4` (valores de
ejemplo; los reales, a confirmar). Si una reunión había quedado `sin_rubrica` por falta de fase y su lead trae una etapa
conocida, vuelve a `pendiente` y se vincula con `fase_origen = crm`.
- Si la búsqueda falla, la reunión sigue `pendiente` y se corta el lote hasta la vuelta siguiente.

## Invitados (Calendar)

`guardarInvitados` (`invitados.ts`) rellena `reunion.invitados` con los asistentes del evento de Calendar, para buscar
el lead cuando se conecte el CRM. Corre en la misma vuelta de cada minuto, 20 reuniones como máximo.

- Usa el evento que ya encontró el Agente de Reuniones (`meeting_artifact_organizers.assigned_by = 'calendar:<id>'`) y
  lo pide con `GET calendars/primary/events/{id}`, solo lectura. No toca `linkMeetingOrganizer`.
- Cada invitado: `{ email, nombre, respuesta, organizador, interno }`; `interno` = email de un empleado. Sin salas ni
  recursos.
- `invitados_en` NULL = sin consultar. Organizador vinculado a mano o evento borrado/cancelado: definitivo, con
  `invitados_motivo`. Red, 5xx, token o falta de permiso de Calendar: `invitados_reintentar`, cada hora.
- No mueve `actualizado_en` (la revisión de las `sin_comercial` lo compara con la asignación del organizador).
- `REUNIONES_MEET_INVITADOS=false` apaga solo esta consulta.

## Transcripción para el modelo

`prepararTranscripcion(texto, equipoLyn)` (`transcripcion.ts`) convierte la transcripción de Meet al formato del
calificador de llamadas: `[hh:mm:ss] GRUPO LYN: …` / `[hh:mm:ss] CLIENTE: …`. Así el prompt, la verificación de citas
(`citaVerificable`) y `marca_tiempo` funcionan sin cambios.

- Lee el documento de Meet (marcas de tiempo en su línea y párrafos `Nombre: texto`), WEBVTT (`<v Nombre>`) y SRT.
- Un «Nombre:» cuenta como hablante si aparece dos veces o es del equipo; la cabecera (título, asistentes) y el pie
  de Meet se descartan.
- Quien coincide con un empleado activo habla por GRUPO LYN (Ernesto y el closer nuevo, los dos); el resto es CLIENTE
  y su nombre se enmascara junto con teléfonos, emails y direcciones (`enmascarar` de Juan).
- `conHablantes = false` si no se reconoce ninguna voz: conviene marcar la evaluación con duda.
- Formato supuesto a partir de Meet; falta confirmarlo con una transcripción real de un closer.

## Formato real de las transcripciones (confirmado el 12/11/2026)

- Título generado por Meet: `Reunión del 9 nov 2026 a las 10:25 GMT-05:00 - Transcripción` (sin fase si el evento no
  la lleva). Sin línea de asistentes.
- Marcas `hh:mm:ss` solas en su línea; turnos `Nombre de la cuenta: texto`.
- Los hablantes son **cuentas de Google**, a menudo compartidas y con números («Tech Grupo LYN», «Interiorista Lyn 15»):
  un nombre con «LYN» habla por GRUPO LYN; también los invitados internos de Calendar.
- Pie: `La transcripción finalizó después de hh:mm:ss` (duración exacta) y un aviso; no se envían al modelo.
- Se enmascaran los clientes que hablan y los invitados externos de Calendar aunque solo se mencionen.
- Las direcciones con número se tapan aunque vayan en mitad de una frase (`enmascararDirecciones`): el enmascarado del
  calificador solo las tapa si llegan al final de la línea. Una dirección escrita toda en minúsculas no se tapa.

## Evaluación (`evaluacion.ts`)

1. `encolarReuniones`: cada reunión `por_evaluar` crea su fila `pendiente` en `llamada_evaluacion` con `reunion_id`,
   `empleado_id`, `rol`, `rubrica_version_id` y `version_rubrica` (código de la versión). Idempotente.
2. `procesarSiguienteReunion`: coge la siguiente con `reunion_id` (`FOR UPDATE SKIP LOCKED`) y:
   - si hay negativa a grabar (ahora o en una evaluación anterior) → `no_evaluada` + `sin_consentimiento`, sin modelo;
   - prepara la transcripción (turnos GRUPO LYN / CLIENTE, datos personales enmascarados);
   - llama a Gemini con el prompt y el esquema de la rúbrica versionada de Juan, valida la salida y aplica `decidir`
     (citas verificadas, apto, escalado). Sin hablantes identificados → duda y escalado;
   - guarda nota, pasos, errores, tokens y objeciones (`evaluacion_id`, `llamada_id` NULL) en una transacción y deja la
     reunión `evaluada`. Sin feedback por WhatsApp.
   - Fallos del modelo: reintento a 1, 5 y 15 min; al tercero, `error` y aviso a Tech. Transcripción de más de
     `REUNIONES_MEET_MAX_CARACTERES` (150.000 por defecto) → `no_evaluada`.
3. El proceso de cada minuto evalúa como mucho 5 reuniones por vuelta. Sin rúbricas de closer activas no hay ninguna
   `por_evaluar`: coste cero.

## Reevaluación al activar una rúbrica (`reevaluar.ts`)

`reevaluarReuniones({ codigo, desde?, hasta?, simular? })`, para una rúbrica de closer (`closer_f2|f3|f4-vN`):
- las reuniones `sin_rubrica` de su fase vuelven a la cola y se vinculan con la versión activa (requiere activarla);
- las ya evaluadas de esa fase con otra versión reciben una evaluación nueva (`reevaluacion = TRUE`), sin tocar la anterior;
- nunca entra una reunión con negativa a grabar.

Se lanza con el script de rúbricas de Juan (`scripts/calificador-rubrica.ts reevaluar --version … --desde … --hasta …`,
que ahora también recorre las reuniones) o con el nuestro:

```bash
npx tsx --env-file=.env scripts/reuniones-meet.ts reevaluar --version closer_f2-v1 [--desde …] [--hasta …] [--simular] [--ahora]
npx tsx --env-file=.env scripts/reuniones-meet.ts estado
npx tsx --env-file=.env scripts/reuniones-meet.ts coste [--desde …] [--hasta …] > coste.md
```

## Coste (`informe.ts`)

`coste` da, por evaluación, los tokens de entrada y salida, la duración y la versión, y en el resumen la media por
reunión y por minuto. Con `CALIFICADOR_PRECIO_ENTRADA_1M` y `CALIFICADOR_PRECIO_SALIDA_1M` (precio por millón de
tokens) añade el coste; sin ellos, solo tokens.

## Hora de la reunión

Al pedir los invitados a Calendar se guardan también `inicio` y `fin` del evento (con hora) y, si la transcripción no
la daba, la duración. Un evento de día entero no da hora.

## Pendiente (depende de otros)

- **Rúbricas de F2, F3 y F4** (Alex): hasta que existan y se activen, todas las reuniones quedan `sin_rubrica`.
- **Una transcripción de un closer con un cliente** (el formato ya se confirmó con una reunión interna) y, para el coste
  real, una rúbrica activa.
- **`rubrica_version`** la crea el ticket 869fpj8dm (columnas `id`, `fase`, `version`, `activo`, `vigente_desde`). Mientras
  no exista, todas las reuniones quedan `sin_rubrica`.
- **Comprobar contra la lista real** los nombres de los campos y el filtro por email (hecho con la API simulada), y
  saber qué etapas son F3 y F4: requiere acceso a «Contacto de Reforma» y un `CLICKUP_API_TOKEN`.
- **Alta de los closers en `comercial_rol`:** de momento por SQL (acordado con Juan; la ruta del Dashboard llegará cuando
  haya más closers sin extensión). Una fila por persona; el rol es informativo, porque la rúbrica sale de la fase:

  ```sql
  INSERT INTO comercial_rol (empleado_id, nombre, rol)
  SELECT id, CONCAT_WS(' ', nombre, apellido), 'closer_f2' FROM empleados WHERE LOWER(email) = '<email de Ernesto>' AND activo
  ON CONFLICT (empleado_id) DO UPDATE SET rol = EXCLUDED.rol, activo = TRUE, actualizado_en = NOW();
  ```

## Pruebas con servicios reales (tests «live»)

No se ejecutan en la suite normal: hace falta activarlos a propósito. Usan datos inventados y la base local de QA.

**Gemini** (`tests/reuniones-meet-gemini.live.test.ts`). Evalúa una reunión de oficina inventada, con el formato real de
Meet, con una rúbrica de prueba de F2 sacada del Manual Fase 0. Comprueba:
- que la salida es válida y las citas están verificadas;
- que a Gemini no le llega el nombre, el teléfono ni la dirección de la clienta;
- que detecta el «precio final» que se promete a propósito (`PRECIO_CERRADO`, no apto).

Imprime la nota, los pasos, los tokens y el coste. Solo permite conexiones a Gemini.

```bash
docker run -d --rm --name lyn-qa-reuniones -e POSTGRES_PASSWORD=qa -e POSTGRES_USER=qa -e POSTGRES_DB=lyn_qa_retest -p 127.0.0.1:15439:5432 postgres:16-alpine
QA_LIVE_REUNIONES_GEMINI=true GOOGLE_GEMINI_API_KEY=… QA_TEST_DATABASE_URL=postgres://qa:qa@127.0.0.1:15439/lyn_qa_retest npx vitest run tests/reuniones-meet-gemini.live.test.ts
```

Opcional: `CALIFICADOR_PRECIO_ENTRADA_1M` y `CALIFICADOR_PRECIO_SALIDA_1M` para ver el coste en dinero.

**ClickUp** (`tests/reuniones-meet-clickup.live.test.ts`). Solo lectura: bloquea cualquier escritura y cualquier otro
destino. Comprueba:
- que la lista tiene los campos supuestos, e imprime sus nombres y las opciones de `ETAPA_CRM` con la fase que les toca;
- que encuentra una sola tarea padre para el email de un lead real;
- que un email inexistente no encuentra nada.

No imprime datos de clientes, solo ids y nombres de campos.

```bash
QA_LIVE_REUNIONES_CLICKUP=true CLICKUP_API_TOKEN=pk_… QA_CLICKUP_EMAIL_LEAD=<email de un lead> npx vitest run tests/reuniones-meet-clickup.live.test.ts
```

## Operación

- `REUNIONES_MEET_ENABLED=false` apaga todo el proceso; `REUNIONES_MEET_EVALUAR=false` (o `CALIFICADOR_ENABLED=false`)
  apaga solo la evaluación; `REUNIONES_MEET_INVITADOS=false`, solo la consulta a Calendar.
- Acceso: las notas de reuniones son datos de desempeño (solo Dirección y Ernesto). Hoy ninguna ruta ni pantalla las
  muestra; quien las lea (gráfico 5, 869fpj8j3) debe aplicar esa regla.
- Solo llama al modelo con reuniones `por_evaluar`, es decir, con una rúbrica de closer activa.
- Reversión: `backend/reuniones-meet/schema-down.sql` (deshace la migración de las tablas del calificador y borra
  `reunion`; lee sus avisos) y revertir los commits.
- Pruebas: `npx vitest run tests/reuniones-meet.test.ts`. Para la de integración hace falta
  `QA_TEST_DATABASE_URL=postgres://…@127.0.0.1:15439/lyn_qa_retest`.
