# Textos disponibles no analizados — 1.1.8

## Política aprobada

«Por analizar» incluye únicamente textos entrantes de grupos disponibles en la base de datos y todavía no analizados. El contador y la selección del informe comparten ese criterio, independientemente de los no leídos de WhatsApp. Se excluyen vacíos, adjuntos, mensajes salientes, entradas internas del dashboard y los IDs ya revisados.

El informe global no consulta ni espera historial de Evolution. Una cuenta con miles de no leídos sin contenido no bloquea los textos disponibles. La sincronización permanece activa por separado: un texto que llegue después se incorpora a pendientes. No se borran registros ni se marcan mensajes ausentes como analizados.

`selectionVersion: 4` y `coverage.scope: available_texts` identifican esta política. Las selecciones antiguas se reconstruyen; los mensajes posteriores a la selección quedan para el próximo informe. Todos los textos seleccionados deben superar la verificación y guardarse en la misma transacción antes de consumirse.

## Validación local

TypeScript aprobado; 244 pruebas de backend, 43 de extensión y 20 de scripts aprobadas. Dos pruebas externas optativas omitidas. Incluye contador/lista/informe coincidentes, cuentas aisladas, textos disponibles con cero no leídos, contadores vacíos de 10.000/20.000, entradas tardías, adjuntos y vacíos excluidos, reanudación y 20.000 textos sintéticos. PostgreSQL local aislado y proveedores simulados; no se enviaron conversaciones reales a Gemini.

## Despliegue

Usar `deploy/scripts/deploy-global-summary.sh COMMIT backend`. Respalda repositorio, configuración y ambas bases antes de actualizar; reinicia solo `lyn-backend`, sin recompilar Evolution ni borrar sesiones. No añade migraciones ni exige cambiar credenciales.

La selección y el contador funcionan con extensiones 1.1.6/1.1.7. El ZIP de producción 1.1.8 actualiza las explicaciones visuales; se publica por separado. No sustituir los no leídos de WhatsApp ni reiniciar los contadores internos manualmente.

Tras confirmar el despliegue, refrescar el panel y generar un nuevo informe. Los errores de trabajos antiguos permanecen guardados: verlos al reabrir no demuestra que un trabajo nuevo esté usando la política antigua. El resultado nuevo debe llevar `coverage.scope: available_texts`. Si no hay textos disponibles, se indica sin llamar a Gemini ni esperar historial. Esta documentación no certifica ejecución en producción ni publicación en Chrome Web Store.
