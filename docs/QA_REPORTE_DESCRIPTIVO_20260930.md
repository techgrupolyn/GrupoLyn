# Reporte descriptivo cuando no hay hallazgos del rol

## Problema

Una selección de 343 textos podía terminar correctamente, descontarse y producir únicamente «No se identificaron asuntos relevantes para el alcance del rol seleccionado». Esto no explicaba qué se había revisado. La captura no permite conocer el contenido de esos 343 textos.

## Corrección

Si la síntesis del rol queda vacía y existen fuentes verificadas, una etapa explícita describe todos esos textos, agrupados por sus grupos originales. Resume temas, novedades, conversaciones y estados explícitos sin forzar una interpretación empresarial. Los saludos y repeticiones se consolidan en descripciones breves, no se enumeran mensaje a mensaje. El reporte se etiqueta como descriptivo, distinto del informe del rol; no se modifica el prompt del especialista.

Se mantiene el procesamiento acotado por lotes, la auditoría, la caché de reintentos, el aislamiento por cuenta y el guardado transaccional. Todas las fuentes deben estar representadas; la descripción no permite exclusiones por rutina ni por alcance. No se consideran analizables los textos antes omitidos por evidencia insuficiente. Un fallo del proveedor o de validación no guarda el reporte ni consume mensajes.

## Verificación

- Regresión sintética de 343 textos: se conserva evidencia de los 343, se genera descripción y el reintento usa la caché.
- Se cubre tanto extracción sin hallazgos como síntesis que excluye todos los hallazgos por alcance.
- Se rechazan descripciones vacías, fuentes excluidas y cambios de grupo.
- Regresión de 20.000 textos informativos: todos pasan por descripción con referencias completas y peticiones de tamaño acotado.
- Gemini real: diez textos ficticios de una familia y un grupo de intercambios, rol por obras sin ningún asunto de obra. Ocho llamadas a `gemini-3.6-flash`, aproximadamente 21 segundos, sin fallback ni mensajes omitidos. Produce descripciones de felicitaciones/cumpleaños/vacaciones, una venta de 40 dólares, una solicitud de compra de 20 y las normas de negociación privada.
- Evidencias locales: `.runtime-logs/descriptive-live/report.txt`, `.runtime-logs/descriptive-live/evidence.json`, `.runtime-logs/descriptive-live-test.log`.

No se enviaron conversaciones reales a Gemini ni se modificó producción. La prueba no garantiza interpretaciones infalibles en cualquier conversación.

## Informes existentes

Este cambio no reescribe informes guardados ni vuelve a poner sus mensajes como pendientes. Los originales y la selección del trabajo se conservan: para rehacer un informe anterior debe reutilizarse esa selección de forma controlada, sin reiniciar contadores ni consumir mensajes nuevos. La captura no contiene esos textos y no se ha reconstruido el informe real de 343 mensajes desde ella.

Requiere publicar y desplegar el backend; no requiere actualizar la extensión ni cambiar dependencias. Este documento no acredita despliegue.
