# Informes globales de WhatsApp: procesamiento por lotes

## Alcance

«Por analizar» significa textos entrantes de grupos disponibles en PostgreSQL y todavía no incluidos en un análisis guardado. No depende del contador de no leídos de WhatsApp: un texto disponible sin revisar sigue pendiente aunque WhatsApp indique cero. No existe un máximo total de textos ni se selecciona una muestra.

Los mensajes ausentes, vacíos, salientes, generados desde el dashboard y los adjuntos no cuentan. La selección normaliza contenido recuperable del campo original, reconoce adjuntos mal clasificados como texto y excluye los IDs de `summary_reviewed_messages` y las omisiones guardadas en `summary_skipped_messages`. No borra mensajes ni modifica sus estados de lectura en WhatsApp. El contador permanece visible y representa textos disponibles sin analizar ni omitir.

## Ejecución

- `POST /api/chat/global-summary` devuelve `202` y un identificador de trabajo; la extensión consulta su estado sin mantener abierta la petición de generación.
- El informe utiliza una selección fija de los textos disponibles de todos los grupos. No llama a Evolution ni espera recuperar un historial ausente. La sincronización y la recuperación periódica continúan independientemente: cualquier texto que llegue después aparecerá en el contador y en el siguiente informe.
- `/api/chats`, `/api/pendientes`, el resumen individual y el informe global comparten el criterio de selección. `unread_count` en esas respuestas representa textos disponibles sin analizar, no la columna homónima interna ni los no leídos del teléfono. La lista de pendientes no incluye grupos cuyo total es cero. Los totales restantes del informe aplican el mismo criterio.
- Los contadores originales de la base se conservan para el diagnóstico operativo de sincronización. No se reinician ni se utilizan como condición de acceso al análisis.
- Si no hay textos disponibles sin analizar, se indica explícitamente; no se llama a Gemini ni se guarda un informe vacío.
- `coverage.scope: available_texts` identifica el alcance nuevo. `coverage.pending` y `coverage.texts` coinciden con el número de textos seleccionados. No afirman que se haya recuperado todo el historial de WhatsApp.
- La recepción durable, los reintentos tras reinicio y la auditoría periódica por cuenta se describen en `RELEASE_PERSISTENCIA_WHATSAPP_20260929.md`. Su diagnóstico no bloquea el informe de contenido disponible.
- Los historiales se dividen por grupo en lotes de hasta 24.000 caracteres de datos serializados y 160 fragmentos. Cada petición completa queda acotada a 48.000 caracteres. Los textos individuales de más de 6.000 caracteres se fragmentan sin descartarlos. Estos son tamaños por petición, no máximos del historial.
- La primera llamada extrae hallazgos estructurados con citas literales, estado y referencias explícitas. El código comprueba que cada cita exista en ese grupo y lote, que sea literal y que todos los fragmentos estén cubiertos por hallazgos o intervalos informativos válidos. No basta con que el modelo diga que revisó todo.
- Una segunda llamada al mismo modelo, con instrucciones independientes de auditoría, contrasta los hallazgos y los mensajes clasificados como informativos con el texto original. Revisa también omisiones, negaciones, responsables, fechas, cifras y estados inventados. No es un segundo proveedor ni una garantía infalible.
- Se mantiene el modelo y el prompt del especialista capturados al iniciar el trabajo en extracción, auditoría y síntesis. El protocolo JSON interno reemplaza únicamente el formato de cada llamada, no el alcance del rol. Lo ajeno al alcance se revisa como informativo: no se transforma en tareas u obras ficticias. Ante cobertura incompleta, citas falsas, JSON truncado o rechazo del auditor se intenta corregir y después subdividir el lote.
- Una etapa final redacta el informe según ese prompt, en lugar de concatenar hallazgos y citas. Sintetiza hechos verificados en puntos por entidad/obra y apartado; consolida entidades presentes en varios chats y separa obras dentro de un mismo chat. Después elabora un resumen ejecutivo jerárquico. Omite apartados vacíos y conversaciones ajenas al alcance. La información original y sus citas quedan en `evidence.groups`, no saturan el texto del informe.
- Si no queda ningún punto del rol pero hay textos verificados, se genera un **reporte descriptivo del contenido analizado**, en vez de devolver únicamente «no se identificaron asuntos relevantes». Revisa todos esos textos por lotes y explica temas, novedades, conversaciones sociales y solicitudes explícitas por grupo. No inventa obras ni convierte esas conversaciones en tareas del usuario. El prompt guardado del especialista no cambia: esta etapa informativa se identifica separadamente y no sustituye un informe del rol que sí tenga contenido.
- El reporte descriptivo no permite excluir saludos, rutina u otras fuentes: debe caracterizarlos brevemente y conservar cobertura completa por referencias. Se verifica también con el auditor. Si falla no se guarda ni se descuentan mensajes. `evidence.version: 3` y `synthesis.kind: descriptive` identifican este caso; sus referencias apuntan a mensajes `Gx-My` (o fragmentos), conservados en `evidence.groups.sources`. Los informes `kind: role` siguen referenciando hallazgos `Gx-Fy`. Los textos omitidos por evidencia insuficiente no se reincorporan a la descripción.
- La síntesis se audita contra sus fuentes y el prompt del rol: responsables, fechas, decisiones frente a ejecución, contradicciones y vigencia histórica. Cada hallazgo se vincula a un punto o una exclusión justificada por alcance/rutina. Al consolidar puntos no se admite descartar fuentes. `evidence.synthesis` conserva puntos, referencias y exclusiones; cada referencia `Gx-Fy` identifica el hallazgo y grupo correspondientes en `evidence.groups`. Las referencias del resumen ejecutivo remiten también a esos hallazgos originales.
- Las peticiones de síntesis se dividen en bloques de unos 14.000 caracteres de datos y respetan el máximo total de 48.000 por petición. Si una obra es demasiado extensa para consolidarla en una llamada se conservan todos sus bloques de detalle; el resumen ejecutivo se reduce jerárquicamente sin recortar ese detalle. No existe un máximo global de 6.000 caracteres. Estas comprobaciones son estructurales y auditorías del mismo modelo, no una garantía infalible de interpretación o deduplicación semántica.
- Un fallo de síntesis o de su auditoría no convierte mensajes válidos en omisiones individuales: no se guarda el informe ni se descuentan mensajes. El reintento reutiliza las extracciones verificadas. Los prompts de rol de más de 12.000 caracteres se rechazan antes de procesar mensajes, en lugar de provocar falsas omisiones por tamaño.
- Cada llamada al proveedor tiene un timeout de diez minutos y hasta tres intentos ante fallos temporales. No se deja una conexión colgada indefinidamente. Si el proveedor no se recupera, el trabajo falla de forma visible y conserva sus lotes para reintentar.
- `summary_job_contexts` guarda la selección original y `summary_job_batches` los resultados intermedios. Un reinicio del backend recupera el trabajo. Reintentar el último trabajo fallido con el mismo especialista reutiliza su selección y sus lotes; los mensajes posteriores quedan para el siguiente informe.
- Solo se reutilizan selecciones de la política actual (`selectionVersion: 5`, `coverage.scope: available_texts`). Se capturan la fecha de referencia y las fechas completas ISO de mensajes para no confundir años o avisos históricos con actualidad. Al reanudar selecciones antiguas se reconstruyen desde los textos disponibles no revisados y se descartan los lotes de la política anterior.
- El progreso expone extracción, verificación y composición, con lotes verificados. La cantidad de lotes puede aumentar si es necesario subdividir. No expone contenido parcial ni el prompt privado. Cerrar y reabrir la extensión recupera el trabajo activo.
- La barra de la extensión muestra porcentaje analizado y restante a partir de `completedMessages / totalMessages` del servidor, sobre la selección original. Un mensaje extenso solo cuenta cuando todos sus fragmentos superan la auditoría. Dividir lotes no cambia el denominador; los mensajes nuevos quedan para el siguiente informe. La barra se actualiza con las consultas de estado cada tres segundos, no con un temporizador de avance simulado.
- Antes de conocer el total muestra preparación indeterminada. Al llegar al 100 % de análisis sigue indicando preparación/guardado hasta que el servidor confirme `completed`; no equivale a una estimación del tiempo restante. Ante un fallo mantiene el último avance confirmado y avisa de que no se guardó el informe. Servidores anteriores pueden mostrar porcentaje de lotes, etiquetado como tal.
- Solo la transacción que guarda el informe marca los identificadores verificados como revisados y registra los omitidos por separado, con motivo `insufficient_evidence`. Ambos salen del contador; los omitidos no se incluyen en `mensaje_ids` ni en `summary_reviewed_messages`. También elimina la copia temporal y los resultados intermedios. Un fallo de proveedor o guardado no descuenta ninguno y conserva el contexto para reanudación. Las llegadas posteriores pertenecen al siguiente informe.
- Cuando hay omisiones, el progreso usa `(completedMessages + skippedMessages) / totalMessages` y se etiqueta **procesado**, separando verificados de omitidos; nunca presenta un omitido como analizado. Puede retroceder al retirar y volver a verificar los hallazgos del grupo afectado. El 100 % no implica que todos se verificaron ni que el informe ya se guardó. Sin omisiones se mantiene el porcentaje de textos verificados. Los informes anteriores conservan sus indicadores históricos.
- No se envían mensajes ni confirmaciones de lectura a WhatsApp. La exclusión mutua por cuenta sigue impidiendo dos análisis simultáneos que consuman los mismos pendientes.
- `resumenes_globales_chat.evidence` conserva los hallazgos y las fuentes citadas, con sus identificadores originales. Los identificadores cortos del informe se corresponden con esas fuentes; no se generan rangos narrativos de mensajes.

## Límites de interpretación y operación

Para conservar lo recibido desde WhatsApp, Evolution debe tener `DATABASE_SAVE_DATA_NEW_MESSAGE=true` y `DATABASE_SAVE_DATA_HISTORIC=true` en su entorno, además de `syncFullHistory=true` en la configuración de la instancia. El lector de configuración de Evolution interpreta una variable `DATABASE_SAVE_DATA_HISTORIC` ausente como desactivada. Las plantillas de producción anteriores omitían esta opción; corregir la plantilla no modifica el archivo `/etc/lyn/evolution.env` del servidor. El preflight ahora advierte de esa omisión. Activarla requiere reiniciar Evolution para cargar el entorno; permite guardar futuras entregas de historial, pero no reconstruye retroactivamente mensajes ya descartados. La recuperación del teléfono debe verificarse sin borrar sesiones, contadores ni historiales, y no se garantiza que WhatsApp vuelva a entregar todo lo antiguo.

La verificación literal detecta citas inexistentes, pero por sí sola no demuestra que una interpretación sea correcta. La revisión semántica sigue siendo probabilística. Un responsable o fecha ausente debe quedar sin confirmar, no autocompletarse por intuición. Cada lote dispone del mensaje inmediatamente anterior y posterior como contexto; respuestas ambiguas que dependen de contexto lejano requieren revisar el original. La secuencia conserva las referencias explícitas sin fusionar automáticamente tareas por nombre de proyecto.

Si un fragmento aislado sigue fallando la validación de evidencia tras dos intentos, se omite su mensaje original completo y se continúa con el resto. Se reconstruye el grupo sin ese mensaje como fuente ni contexto para no conservar hallazgos sustentados por un omitido; se reutilizan los lotes válidos cuyo prompt no cambia. El informe y `evidence.skippedMessages` indican las omisiones; `coverage.verified` y `coverage.skipped` separan los totales. Si todos se omiten, se guarda un resultado explícito con cero textos verificados y sin hallazgos. Los originales permanecen en `mensajes`.

La exclusión no aplica a fallos de red, cuota, fallback o base de datos. Estos detienen el trabajo sin consumir mensajes. Tampoco se garantiza una cantidad infinita: cuotas, memoria y disponibilidad de Gemini siguen siendo límites físicos. El snapshot completo se conserva en PostgreSQL y el proceso carga el contexto en memoria; volúmenes superiores a los ensayados requieren medir recursos. El tiempo y el coste aumentan con el texto y los reintentos necesarios.

## Extensión y despliegue

### Recuperación de la síntesis final

El 100 % de textos procesados no significa informe guardado: después se redacta, audita y guarda el resultado. La extensión 1.1.10 distingue esta fase, también cuando falla, sin inventar un porcentaje de síntesis.

La síntesis permite tres intentos por partición; el tercero recibe la propuesta rechazada y las observaciones de la auditoría. Los borradores rechazados se invalidan, no se reutilizan indefinidamente como si hubieran sido aprobados. Los apartados que pasan la auditoría y las subdivisiones se guardan en `summary_job_batches`, por trabajo. Reintentar el último trabajo fallido con la misma cuenta y rol conserva la selección inicial y reutiliza los lotes y apartados aprobados. Las claves de extracción y verificación anteriores no cambian. Los informes anteriores a esta mejora conservan sus resultados de llamadas en caché; no tienen todavía los nuevos checkpoints de particiones.

Si falla la reformulación de un punto ya validado, se conserva ese mismo punto sin añadir conclusiones. Si no puede clasificarse o redactarse un hallazgo de la extracción ya verificado contra sus citas, se conserva literalmente bajo «Asuntos verificados pendientes de agrupar», sin inventar una obra ni descartar el hallazgo. Si falla la selección ejecutiva, se entrega el detalle completo validado con un aviso explícito, sin publicar la selección rechazada. Estas recuperaciones se registran en `evidence.synthesis.recoveries`. No se aplica esta salida a un detalle nunca validado ni a errores de cuota, conexión o almacenamiento.

Si no puede validarse ni el detalle individual, el trabajo sigue fallando sin guardar ni descontar mensajes, pero conserva el motivo y referencias en `summary_jobs.result.synthesisDiagnostic`. Este diagnóstico no se expone en la respuesta pública del trabajo. El mensaje al usuario diferencia el fallo de síntesis y explica cómo reanudar. Una mejora del código no garantiza que un proveedor externo apruebe cualquier texto: se mantiene la barrera contra conclusiones no sustentadas.

Consulta de diagnóstico de solo lectura (no requiere consultar conversaciones ni claves):

```sql
SELECT id, account_id, status, updated_at,
       result->'progress' AS progreso,
       result->'synthesisDiagnostic' AS diagnostico
FROM summary_jobs
WHERE account_id = 'director-01'
ORDER BY updated_at DESC LIMIT 3;
```

El backend es compatible con la extensión anterior; la aclaración visual requiere la 1.1.10. No hace falta borrar ni recrear el trabajo de Alex. Desplegar el backend solo tras publicar y aprobar el commit, usando el procedimiento con respaldo `deploy/scripts/deploy-global-summary.sh` en modo `backend`; después reintentar desde la misma cuenta y rol. La publicación y el resultado real de ese trabajo deben verificarse por separado de las pruebas locales.

La extensión no espera a `SYNC_NOW` antes de encolar el informe. La sincronización y recuperación periódicas continúan por separado, sin bloquear la selección disponible. Un fallo al refrescar la lista después de aceptar el trabajo no lo presenta como fallido.

El cambio principal requiere desplegar el backend y reiniciarlo. El arranque crea `summary_skipped_messages` sin borrar datos existentes. Las extensiones anteriores reciben el contador corregido y el aviso de omisiones dentro del informe, pero conservan las explicaciones visuales antiguas; las etiquetas de progreso procesado requieren actualizar la extensión. Este documento no acredita un despliegue ni una publicación en Chrome Web Store.

## Verificación local

- El contador, la lista y el informe coinciden para textos normales y texto recuperable del campo original. Excluyen vacíos, adjuntos con pie de foto, salientes, mensajes internos y textos ya analizados.
- Cero, cinco o diez mil no leídos de WhatsApp no cambian la selección del mismo texto disponible. Un grupo sin contenido no bloquea los textos de otro.
- Sin contenido disponible, el trabajo termina con un aviso, sin llamadas a Evolution o Gemini y sin reencolar indefinidamente.
- Los mensajes recibidos después pasan a pendientes aunque el contador de WhatsApp sea cero. Una llegada durante el análisis queda para el siguiente informe.
- Los casos de 246 y 55 vacíos verifican el contador de textos, refrescos idempotentes y exclusión del historial todavía ausente.
- Regresión de 3.000 textos, adjuntos y textos ya revisados: se consumen exactamente los textos seleccionados y queda una llegada posterior.
- Regresión PostgreSQL aislada de 20.000 textos: lotes, fallo parcial, reanudación y guardado único. No consume mensajes nuevos ni llama a proveedores externos.
- Se mantienen las pruebas de paginación y recuperación como capacidades de sincronización, no como requisitos para generar informes.
- Las pruebas de evidencia rechazan citas inventadas, aíslan mensajes no verificables y continúan con el resto; distinguen omitir de analizar. Cubren mensajes fragmentados, cero verificados, reutilización de caché y errores del proveedor. PostgreSQL comprueba rollback, exclusión idempotente, conservación de originales y contadores por cuenta.
- La extensión distingue el alcance de textos disponibles de la cobertura de informes antiguos.

Las pruebas automáticas ordinarias usan proveedores simulados y una base local aislada. No certifican cuotas, latencia ni calidad semántica del proveedor real ni un despliegue en producción. `tests/summary-synthesis.live.test.ts`, optativa mediante `QA_LIVE_SYNTHESIS=true`, comprueba el flujo completo con Gemini y 19 mensajes ficticios: varias obras repartidas entre chats, cambios de estado, contradicciones, responsables ausentes, ruido vecinal e instrucciones maliciosas dentro de los mensajes. Guarda el reporte y sus evidencias en `.runtime-logs/synthesis-live/`, sin usar conversaciones reales ni modificar bases.

## Prueba explícita con Gemini real

`backend/tests/global-summary-gemini.live.test.ts` está desactivada por defecto. Al habilitarla consume la API Gemini configurada en `backend/.env`, nunca envía conversaciones reales y solo admite la base PostgreSQL local dedicada `lyn_qa_global_gemini` en `127.0.0.1:55439`. La base debe existir antes de ejecutarla. Se bloquea cualquier llamada HTTP distinta de Gemini Interactions.

Desde `backend`, en PowerShell:

```powershell
$env:QA_TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55439/lyn_qa_global_gemini'
$env:DATABASE_URL=$env:QA_TEST_DATABASE_URL
$env:QA_LIVE_GLOBAL_GEMINI='true'
npm.cmd test -- --no-file-parallelism tests/global-summary-gemini.live.test.ts
```

La prueba crea 20.000 mensajes sintéticos en diez grupos, encola el informe por la API de extensión, consulta su progreso y comprueba automáticamente las tareas pendientes de control de mitad y final del historial. Incluye tareas iniciales que después se cierran, una negación de autorización de pago y una tarea sin responsable ni fecha. Valida citas contra fuentes guardadas e inserta un mensaje después de la selección inicial para verificar que queda pendiente. Guarda tiempos, llamadas, resultado y comprobaciones en `.runtime-logs/global-summary-grounded-gemini-live-evidence.json`, sin credenciales. Limpia sus cuentas, mensajes y activaciones sintéticas al terminar. Un resultado de fallback no acredita la prueba.

El primer ensayo real del 28/09/2026 está documentado en `docs/QA_INFORME_GLOBAL_GEMINI_20260928.md`: corresponde al algoritmo previo de compresión y detectó referencias narrativas imprecisas. Sus tiempos y resultados no validan este nuevo algoritmo con citas y doble comprobación; se conservan como comparación histórica.

El ensayo del nuevo algoritmo está documentado en `docs/QA_INFORME_GLOBAL_EVIDENCIAS_20260928.md`: 20.000 textos, 42 hallazgos con citas, 322 llamadas reales y 11 min 43 s, con contadores y controles semánticos aprobados. No acredita un despliegue en producción.
