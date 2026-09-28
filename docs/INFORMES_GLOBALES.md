# Informes globales de WhatsApp: procesamiento por lotes

## Alcance

El informe procesa los mensajes de texto pendientes que ya están sincronizados en PostgreSQL para la cuenta activada. No hay un máximo total de mensajes ni un plazo total de diez minutos para el trabajo. Los audios y otros adjuntos siguen excluidos; no se descargan ni se marcan como analizados. El contador de WhatsApp puede incluir adjuntos o mensajes cuyo texto todavía no se ha sincronizado: no se inventan ni se descuentan esos mensajes.

## Ejecución

- `POST /api/chat/global-summary` devuelve `202` y un identificador de trabajo; la extensión consulta su estado sin mantener abierta la petición de generación.
- Los historiales se dividen por grupo en lotes de hasta 24.000 caracteres de datos serializados y 160 fragmentos. Cada petición completa queda acotada a 48.000 caracteres. Los textos individuales de más de 6.000 caracteres se fragmentan sin descartarlos. Estos son tamaños por petición, no máximos del historial.
- La primera llamada extrae hallazgos estructurados con citas literales, estado y referencias explícitas. El código comprueba que cada cita exista en ese grupo y lote, que sea literal y que todos los fragmentos estén cubiertos por hallazgos o intervalos informativos válidos. No basta con que el modelo diga que revisó todo.
- Una segunda llamada al mismo modelo, con instrucciones independientes de auditoría, contrasta los hallazgos y los mensajes clasificados como informativos con el texto original. Revisa también omisiones, negaciones, responsables, fechas, cifras y estados inventados. No es un segundo proveedor ni una garantía infalible.
- Se mantiene el modelo y el prompt del especialista capturados al iniciar el trabajo para la extracción. La auditoría usa instrucciones específicas de verificación. Ante cobertura incompleta, citas falsas, JSON truncado o rechazo del auditor se intenta corregir y después subdividir el lote. No se recortan los resultados para hacerlos caber.
- El informe final se compone de forma determinista: conserva los hallazgos verificados, su secuencia y las citas, sin una nueva compresión de resúmenes ni un límite global de 6.000 caracteres. Las últimas menciones por referencia son una ayuda de lectura, no el estado de todas las tareas del proyecto. Una tarea completada no elimina otras pendientes que compartan referencia.
- Cada llamada al proveedor tiene un timeout de diez minutos y hasta tres intentos ante fallos temporales. No se deja una conexión colgada indefinidamente. Si el proveedor no se recupera, el trabajo falla de forma visible y conserva sus lotes para reintentar.
- `summary_job_contexts` guarda la selección original y `summary_job_batches` los resultados intermedios. Un reinicio del backend recupera el trabajo. Reintentar el último trabajo fallido con el mismo especialista reutiliza su selección y sus lotes; los mensajes posteriores quedan para el siguiente informe.
- El progreso expone extracción, verificación y composición, con lotes verificados. La cantidad de lotes puede aumentar si es necesario subdividir. No expone contenido parcial ni el prompt privado. Cerrar y reabrir la extensión recupera el trabajo activo.
- La barra de la extensión muestra porcentaje analizado y restante a partir de `completedMessages / totalMessages` del servidor, sobre la selección original. Un mensaje extenso solo cuenta cuando todos sus fragmentos superan la auditoría. Dividir lotes no cambia el denominador; los mensajes nuevos quedan para el siguiente informe. La barra se actualiza con las consultas de estado cada tres segundos, no con un temporizador de avance simulado.
- Antes de conocer el total muestra preparación indeterminada. Al llegar al 100 % de análisis sigue indicando preparación/guardado hasta que el servidor confirme `completed`; no equivale a una estimación del tiempo restante. Ante un fallo mantiene el último avance confirmado y avisa de que no se guardó el informe. Servidores anteriores pueden mostrar porcentaje de lotes, etiquetado como tal.
- Solo la transacción que guarda el informe completo marca sus identificadores como revisados y actualiza los contadores internos. También elimina la copia temporal y los parciales. Ante un fallo se conserva el contexto para reanudación; no se publica un informe incompleto como terminado.
- No se envían mensajes ni confirmaciones de lectura a WhatsApp. La exclusión mutua por cuenta sigue impidiendo dos análisis simultáneos que consuman los mismos pendientes.
- `resumenes_globales_chat.evidence` conserva los hallazgos y las fuentes citadas, con sus identificadores originales. Los identificadores cortos del informe se corresponden con esas fuentes; no se generan rangos narrativos de mensajes.

## Límites de interpretación y operación

La verificación literal detecta citas inexistentes, pero por sí sola no demuestra que una interpretación sea correcta. La revisión semántica sigue siendo probabilística. Un responsable o fecha ausente debe quedar sin confirmar, no autocompletarse por intuición. Cada lote dispone del mensaje inmediatamente anterior y posterior como contexto; respuestas ambiguas que dependen de contexto lejano requieren revisar el original. La secuencia conserva las referencias explícitas sin fusionar automáticamente tareas por nombre de proyecto.

Si ni siquiera un fragmento aislado supera las comprobaciones, el trabajo falla con un mensaje explícito, conserva los pendientes y permite reintentar. No debe publicarse un resultado no verificado solo para terminar. Tampoco se garantiza una cantidad infinita: cuotas, capacidad de base de datos, memoria y disponibilidad de Gemini siguen siendo límites físicos. El snapshot completo se conserva en PostgreSQL y el proceso carga el contexto en memoria; volúmenes superiores a los ensayados requieren medir recursos. El tiempo y el coste aumentan con el texto y con las verificaciones y reintentos necesarios.

## Extensión y despliegue

La extensión deja de esperar a `SYNC_NOW` antes de encolar el informe; la sincronización periódica continúa por separado. Un fallo al refrescar la lista después de aceptar el trabajo no lo presenta como fallido.

El cambio principal requiere desplegar el backend y reiniciarlo: el arranque crea las tablas y añade la columna de evidencias mediante `ensureSummaryJobs`. Las versiones anteriores que consultan el estado del trabajo pueden mostrar el progreso textual del servidor. Para eliminar la espera previa de sincronización y mostrar el nuevo indicador de verificación hay que distribuir la extensión actualizada. Este documento no acredita un despliegue ni una publicación en Chrome Web Store.

## Verificación local

- Prueba unitaria con 20.000 textos repartidos entre diez grupos: todos aparecen exactamente una vez en los lotes de entrada, con peticiones acotadas.
- Prueba con 20.000 tareas distintas y proveedor simulado: ninguna se pierde por compresión global.
- Pruebas de textos gigantes y Unicode, recuperación de parciales, subdivisión de lotes densos y reintentos temporales.
- Rechazo de citas inventadas, fuentes de otro grupo, intervalos inválidos, mensajes omitidos, auditorías incompletas y negaciones invertidas. Una última mención completada no cierra otras tareas de la misma obra.
- Regresión PostgreSQL aislada `Q-20000`: 20.000 mensajes, fallo tras dos lotes, reinicio del ejecutor, doble solicitud de reanudación, guardado único y un mensaje nuevo que permanece pendiente. No se permiten llamadas externas durante esa prueba.
- Pruebas de extensión: inicio sin sincronización masiva bloqueante, progreso, recuperación del estado y actualización de contadores.

Las pruebas automáticas habituales usan IA simulada; verifican volumen, persistencia y contadores, no certifican cuotas, latencia ni calidad semántica del proveedor real. La duración y el coste aumentan con la cantidad y longitud de los mensajes.

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
