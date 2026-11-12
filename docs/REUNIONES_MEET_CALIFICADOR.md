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

## Acuerdos con el calificador de llamadas (Juan, 11/11/2026)

- La rúbrica se elige **por fase** (F0 SDR, F2, F3, F4) en `rubrica_version`; el rol es informativo. `reunion` guarda
  `version_rubrica` y **`rubrica_version_id`**, porque la evaluación se encola con `rubrica_version_id NOT NULL` y
  `UNIQUE (reunion_id, rubrica_version_id)`.
- `sin_rubrica` vive solo en `reunion`: la fila en `llamada_evaluacion` (con `origen = reunion_meet`) se crea cuando
  hay rúbrica. `sin_consentimiento` se llama igual en las dos tablas.
- Juan crea `llamada_evaluacion.reunion_id` y su CHECK; **este módulo crea el FK** `llamada_evaluacion_reunion_fk →
  reunion(id) ON DELETE RESTRICT` (`enlazarEvaluaciones`, en cada arranque y solo si la columna existe).
- Su cola de llamadas ignora `reunion_meet`: las reuniones tendrán su propio procesador.
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

- **Evaluación con el modelo** (`por_evaluar` → `evaluada`) y escritura en `llamada_evaluacion` con
  `origen = reunion_meet`: requiere la migración de `llamada_evaluacion`, que hoy exige una llamada de Netelip.
  Se acuerda con el dueño del calificador de llamadas.
- **`rubrica_version`** la crea el ticket 869fpj8dm (columnas `id`, `fase`, `version`, `activo`, `vigente_desde`). Mientras
  no exista, todas las reuniones quedan `sin_rubrica`.
- **Búsqueda del lead y fase desde el CRM** (lista de ClickUp «Contacto de Reforma», `ETAPA_CRM`; F2 = e4 VISITA): falta
  acceso a la lista y saber qué valores son F3 y F4. No hay historial de `ETAPA_CRM`: manda el título.
- **Alta de closers en `comercial_rol`:** hoy su clave es la extensión de Netelip.

## Operación

- `REUNIONES_MEET_ENABLED=false` apaga la ingesta y la vinculación.
- No llama a ningún modelo: coste cero mientras no haya reuniones `por_evaluar` con evaluación activa.
- Reversión: `backend/reuniones-meet/schema-down.sql` (quita el FK de `llamada_evaluacion` y borra `reunion`) y revertir
  los commits.
- Pruebas: `npx vitest run tests/reuniones-meet.test.ts`. Para la de integración hace falta
  `QA_TEST_DATABASE_URL=postgres://…@127.0.0.1:15439/lyn_qa_retest`.
