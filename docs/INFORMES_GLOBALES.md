# Informes globales de WhatsApp: procesamiento por lotes

## Alcance

«Por analizar» significa textos entrantes de grupos disponibles en PostgreSQL y todavía no incluidos en un análisis guardado. No depende del contador de no leídos de WhatsApp: un texto disponible sin revisar sigue pendiente aunque WhatsApp indique cero. No existe un máximo total de textos ni se selecciona una muestra.

Los mensajes ausentes, vacíos, salientes, generados desde el dashboard y los adjuntos no cuentan. La selección normaliza contenido recuperable del campo original, reconoce adjuntos mal clasificados como texto y excluye los IDs de `summary_reviewed_messages`. No borra mensajes ni modifica sus estados de lectura en WhatsApp.

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
- Se mantiene el modelo y el prompt del especialista capturados al iniciar el trabajo para la extracción. La auditoría usa instrucciones específicas de verificación. Ante cobertura incompleta, citas falsas, JSON truncado o rechazo del auditor se intenta corregir y después subdividir el lote. No se recortan los resultados para hacerlos caber.
- El informe final se compone de forma determinista: conserva los hallazgos verificados, su secuencia y las citas, sin una nueva compresión de resúmenes ni un límite global de 6.000 caracteres. Las últimas menciones por referencia son una ayuda de lectura, no el estado de todas las tareas del proyecto. Una tarea completada no elimina otras pendientes que compartan referencia.
- Cada llamada al proveedor tiene un timeout de diez minutos y hasta tres intentos ante fallos temporales. No se deja una conexión colgada indefinidamente. Si el proveedor no se recupera, el trabajo falla de forma visible y conserva sus lotes para reintentar.
- `summary_job_contexts` guarda la selección original y `summary_job_batches` los resultados intermedios. Un reinicio del backend recupera el trabajo. Reintentar el último trabajo fallido con el mismo especialista reutiliza su selección y sus lotes; los mensajes posteriores quedan para el siguiente informe.
- Solo se reutilizan selecciones de la política actual (`selectionVersion: 4`, `coverage.scope: available_texts`). Al reanudar selecciones antiguas se reconstruyen desde los textos disponibles no revisados y se descartan los lotes de la política anterior.
- El progreso expone extracción, verificación y composición, con lotes verificados. La cantidad de lotes puede aumentar si es necesario subdividir. No expone contenido parcial ni el prompt privado. Cerrar y reabrir la extensión recupera el trabajo activo.
- La barra de la extensión muestra porcentaje analizado y restante a partir de `completedMessages / totalMessages` del servidor, sobre la selección original. Un mensaje extenso solo cuenta cuando todos sus fragmentos superan la auditoría. Dividir lotes no cambia el denominador; los mensajes nuevos quedan para el siguiente informe. La barra se actualiza con las consultas de estado cada tres segundos, no con un temporizador de avance simulado.
- Antes de conocer el total muestra preparación indeterminada. Al llegar al 100 % de análisis sigue indicando preparación/guardado hasta que el servidor confirme `completed`; no equivale a una estimación del tiempo restante. Ante un fallo mantiene el último avance confirmado y avisa de que no se guardó el informe. Servidores anteriores pueden mostrar porcentaje de lotes, etiquetado como tal.
- Solo la transacción que guarda el informe de toda la selección verificada marca sus identificadores como revisados y actualiza los contadores internos. También elimina la copia temporal y los resultados intermedios. Ante un fallo de IA se conserva el contexto completo para reanudación. La ausencia de historial de WhatsApp no bloquea esta selección de textos disponibles. Las llegadas posteriores a la selección pertenecen al siguiente informe, no se absorben indefinidamente en un trabajo en curso.
- Un 100 % significa que se verificaron los **textos seleccionados**, no que se analizaron todos los pendientes de WhatsApp. La interfaz actual solo cuenta textos disponibles; los informes anteriores conservan sus indicadores históricos. Los informes antiguos sin `coverage` y con más pendientes que textos analizados indican cobertura no verificada; no se atribuye retroactivamente una causa a esa diferencia.
- No se envían mensajes ni confirmaciones de lectura a WhatsApp. La exclusión mutua por cuenta sigue impidiendo dos análisis simultáneos que consuman los mismos pendientes.
- `resumenes_globales_chat.evidence` conserva los hallazgos y las fuentes citadas, con sus identificadores originales. Los identificadores cortos del informe se corresponden con esas fuentes; no se generan rangos narrativos de mensajes.

## Límites de interpretación y operación

Para conservar lo recibido desde WhatsApp, Evolution debe tener `DATABASE_SAVE_DATA_NEW_MESSAGE=true` y `DATABASE_SAVE_DATA_HISTORIC=true` en su entorno, además de `syncFullHistory=true` en la configuración de la instancia. El lector de configuración de Evolution interpreta una variable `DATABASE_SAVE_DATA_HISTORIC` ausente como desactivada. Las plantillas de producción anteriores omitían esta opción; corregir la plantilla no modifica el archivo `/etc/lyn/evolution.env` del servidor. El preflight ahora advierte de esa omisión. Activarla requiere reiniciar Evolution para cargar el entorno; permite guardar futuras entregas de historial, pero no reconstruye retroactivamente mensajes ya descartados. La recuperación del teléfono debe verificarse sin borrar sesiones, contadores ni historiales, y no se garantiza que WhatsApp vuelva a entregar todo lo antiguo.

La verificación literal detecta citas inexistentes, pero por sí sola no demuestra que una interpretación sea correcta. La revisión semántica sigue siendo probabilística. Un responsable o fecha ausente debe quedar sin confirmar, no autocompletarse por intuición. Cada lote dispone del mensaje inmediatamente anterior y posterior como contexto; respuestas ambiguas que dependen de contexto lejano requieren revisar el original. La secuencia conserva las referencias explícitas sin fusionar automáticamente tareas por nombre de proyecto.

Si ni siquiera un fragmento aislado supera las comprobaciones, el trabajo falla con un mensaje explícito, conserva los pendientes y permite reintentar. No debe publicarse un resultado no verificado solo para terminar. Tampoco se garantiza una cantidad infinita: cuotas, capacidad de base de datos, memoria y disponibilidad de Gemini siguen siendo límites físicos. El snapshot completo se conserva en PostgreSQL y el proceso carga el contexto en memoria; volúmenes superiores a los ensayados requieren medir recursos. El tiempo y el coste aumentan con el texto y con las verificaciones y reintentos necesarios.

## Extensión y despliegue

La extensión no espera a `SYNC_NOW` antes de encolar el informe. La sincronización y recuperación periódicas continúan por separado, sin bloquear la selección disponible. Un fallo al refrescar la lista después de aceptar el trabajo no lo presenta como fallido.

El cambio principal requiere desplegar el backend y reiniciarlo. Esta política no añade tablas ni elimina datos. Las extensiones anteriores reciben el contador corregido y el informe, pero conservan las explicaciones visuales antiguas; las etiquetas actuales requieren distribuir una extensión con versión posterior a la publicada. Este documento no acredita un despliegue ni una publicación en Chrome Web Store.

## Verificación local

- El contador, la lista y el informe coinciden para textos normales y texto recuperable del campo original. Excluyen vacíos, adjuntos con pie de foto, salientes, mensajes internos y textos ya analizados.
- Cero, cinco o diez mil no leídos de WhatsApp no cambian la selección del mismo texto disponible. Un grupo sin contenido no bloquea los textos de otro.
- Sin contenido disponible, el trabajo termina con un aviso, sin llamadas a Evolution o Gemini y sin reencolar indefinidamente.
- Los mensajes recibidos después pasan a pendientes aunque el contador de WhatsApp sea cero. Una llegada durante el análisis queda para el siguiente informe.
- Los casos de 246 y 55 vacíos verifican el contador de textos, refrescos idempotentes y exclusión del historial todavía ausente.
- Regresión de 3.000 textos, adjuntos y textos ya revisados: se consumen exactamente los textos seleccionados y queda una llegada posterior.
- Regresión PostgreSQL aislada de 20.000 textos: lotes, fallo parcial, reanudación y guardado único. No consume mensajes nuevos ni llama a proveedores externos.
- Se mantienen las pruebas de paginación y recuperación como capacidades de sincronización, no como requisitos para generar informes.
- Las pruebas de evidencia rechazan citas inventadas, omisiones y resultados incompletos. El consumo de mensajes depende del guardado transaccional del informe verificado.
- La extensión distingue el alcance de textos disponibles de la cobertura de informes antiguos.

Las pruebas automáticas usan proveedores simulados y una base local aislada. No certifican cuotas, latencia ni calidad semántica del proveedor real ni un despliegue en producción.

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
