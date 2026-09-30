# Síntesis guiada por el rol: validación del 30/09/2026

## Causa y corrección

El informe anterior extraía y verificaba hallazgos por lotes, pero el formato final era una lista fija por chat con todas las citas. El prompt del especialista no controlaba esa composición y el auditor exigía relevancia genérica, incluso para conversaciones ajenas a las obras.

El alcance configurado ahora se utiliza en extracción, auditoría y síntesis. El formato JSON de las llamadas es un protocolo interno: no sustituye el objetivo del rol. Se agrupan entidades explícitas y se redactan puntos por apartado; se consolidan entidades presentes en distintos chats. Los hallazgos y citas se conservan separadamente como evidencia. No se cambia el prompt guardado de ningún especialista ni se impone una plantilla de obras a todos los roles.

## Gemini real

Prueba: `backend/tests/summary-synthesis.live.test.ts`, habilitada explícitamente con `QA_LIVE_SYNTHESIS=true`.

- 19 mensajes ficticios en cuatro grupos. Sin conversaciones reales, lectura de WhatsApp ni cambios en producción.
- Modelo observado: `gemini-3.6-flash`, proveedor Gemini, sin fallback.
- Ensayo final aprobado: 27 llamadas, aproximadamente 106 segundos. Cero mensajes omitidos.
- Ocho hallazgos verificados, seis puntos de detalle y cuatro puntos ejecutivos.
- Obras Dana, Pepe e Ivana separadas; Dana consolidada desde dos chats.
- Fuga de Dana conservada como problema sin reparar, no como una solución ejecutada.
- Cambio de revestimiento aprobado por Ana: coste de 100 a 130 euros; instalación pendiente.
- Contradicción entre entrega del 3 y del 7 de octubre expresada como pendiente de confirmación.
- Plano de Pepe cerrado sin cerrar el permiso de acceso, todavía pendiente a cargo de Luis.
- Grifería de Ivana sin responsable ni fecha inventados.
- Se excluyen conversaciones de divisas, saludos y la obra sin novedades. Una instrucción maliciosa dentro del chat no altera el informe.

La primera ejecución detectó una comprobación textual demasiado restrictiva: la prueba exigía una fórmula concreta mientras el informe decía correctamente «no hay responsable asignado». Se amplió la comprobación a esa expresión equivalente. También se corrigió la duplicación del encabezado ejecutivo en cada punto. El segundo ensayo aprobó las comprobaciones y se revisó su texto completo manualmente.

Evidencias locales ignoradas por Git: `.runtime-logs/synthesis-live/report.txt`, `.runtime-logs/synthesis-live/evidence.json` y `.runtime-logs/synthesis-live-test.log`. No contienen credenciales.

## Regresión y límites

Las pruebas estructurales comprueban cobertura de fuentes, referencias válidas, consolidación sin cambios de entidad, reintentos de auditoría, exclusiones justificadas, prompts excesivos, deduplicación exacta y roles no empresariales. La regresión de 20.000 tareas conserva todas las tareas distintas y limita el tamaño de las peticiones, con proveedor simulado.

PostgreSQL aislado comprueba que un fallo de auditoría de síntesis no guarda el informe, no consume mensajes ni los clasifica como omitidos; un reintento conserva las extracciones verificadas y solo descuenta al guardar. Los originales y los contadores de WhatsApp se conservan.

Una prueba sintética no demuestra perfección semántica en cualquier conversación. El auditor usa el mismo modelo con otras instrucciones. Las obras muy extensas pueden necesitar varios bloques de consolidación; se conserva su detalle sin truncarlo, aunque la deduplicación semántica entre bloques no es infalible.

## Publicación

Cambio de backend, sin nuevos paquetes, migraciones destructivas ni versión de extensión requerida. La extensión 1.1.9 puede mostrar el nuevo texto y la fase de consolidación. El porcentaje sigue midiendo mensajes verificados/procesados, no el tiempo restante de redacción.

Los informes ya guardados no se reescriben ni se vuelven a poner sus mensajes como pendientes. Los nuevos informes usarán la síntesis después de publicar y desplegar el backend. Este documento registra validación local, no acredita publicación en GitHub ni despliegue en producción.
