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

- La búsqueda en ClickUp entra como dependencia (`createReunionesWorkers(pool, env, { buscarLead })`) y **aún no está
  implementada**: falta acceso de lectura a la lista y el nombre de su campo de email.
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

## Pendiente (depende de otros)

- **Procesador de evaluación** (`por_evaluar` → `evaluada`): escribe en `llamada_evaluacion` con `reunion_id`. Las
  tablas ya lo admiten; falta el procesador y, sobre todo, las rúbricas de F2, F3 y F4 (Alex).
- **`rubrica_version`** la crea el ticket 869fpj8dm (columnas `id`, `fase`, `version`, `activo`, `vigente_desde`). Mientras
  no exista, todas las reuniones quedan `sin_rubrica`.
- **Búsqueda del lead y fase desde el CRM** (lista de ClickUp «Contacto de Reforma», `ETAPA_CRM`; F2 = e4 VISITA): falta
  acceso a la lista y saber qué valores son F3 y F4. No hay historial de `ETAPA_CRM`: manda el título.
- **Alta de los closers en `comercial_rol`:** de momento por SQL (acordado con Juan; la ruta del Dashboard llegará cuando
  haya más closers sin extensión). Una fila por persona; el rol es informativo, porque la rúbrica sale de la fase:

  ```sql
  INSERT INTO comercial_rol (empleado_id, nombre, rol)
  SELECT id, CONCAT_WS(' ', nombre, apellido), 'closer_f2' FROM empleados WHERE LOWER(email) = '<email de Ernesto>' AND activo
  ON CONFLICT (empleado_id) DO UPDATE SET rol = EXCLUDED.rol, activo = TRUE, actualizado_en = NOW();
  ```

## Operación

- `REUNIONES_MEET_ENABLED=false` apaga la ingesta y la vinculación.
- No llama a ningún modelo: coste cero mientras no haya reuniones `por_evaluar` con evaluación activa.
- Reversión: `backend/reuniones-meet/schema-down.sql` (deshace la migración de las tablas del calificador y borra
  `reunion`; lee sus avisos) y revertir los commits.
- Pruebas: `npx vitest run tests/reuniones-meet.test.ts`. Para la de integración hace falta
  `QA_TEST_DATABASE_URL=postgres://…@127.0.0.1:15439/lyn_qa_retest`.
