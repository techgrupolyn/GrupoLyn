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
- **`rubrica_version`** la crea el ticket 869fpj8dm. Se suponen las columnas `version`, `fase`, `activo` y
  `vigente_desde`. Si la tabla no existe o no tiene `fase`, todas las reuniones quedan `sin_rubrica`.
- **Lead y fase desde el CRM** («Contacto de Reforma», `ETAPA_CRM`): `lead_id` e `invitados` quedan vacíos hasta
  localizar el CRM y pedir los invitados a Calendar.
- **Alta de closers en `comercial_rol`:** hoy su clave es la extensión de Netelip.

## Operación

- `REUNIONES_MEET_ENABLED=false` apaga la ingesta y la vinculación.
- No llama a ningún modelo: coste cero mientras no haya reuniones `por_evaluar` con evaluación activa.
- Reversión: `backend/reuniones-meet/schema-down.sql` (borra solo la tabla `reunion`) y revertir el commit.
- Pruebas: `npx vitest run tests/reuniones-meet.test.ts`. Para la de integración hace falta
  `QA_TEST_DATABASE_URL=postgres://…@127.0.0.1:15439/lyn_qa_retest`.
