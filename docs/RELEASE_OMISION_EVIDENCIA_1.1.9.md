# Omisión individual por evidencia insuficiente — 1.1.9

## Comportamiento

Un mensaje que no supera la validación de evidencia después de corregir, subdividir y reintentar individualmente ya no detiene el informe. Se omite su ID completo, incluidos todos sus fragmentos. Se reconstruye el grupo sin utilizar el omitido como fuente o contexto, reutilizando resultados verificados cuyos prompts no cambian. Los demás grupos continúan.

Solo al guardar el informe en una transacción se registran sus IDs omitidos y el motivo `insufficient_evidence` en `summary_skipped_messages`. Salen del contador de análisis, sin borrar los originales, sin marcarlos como analizados y sin enviar confirmaciones de lectura a WhatsApp. Los IDs verificados permanecen separados en `summary_reviewed_messages` y `resumenes_globales_chat.mensaje_ids`. Las exclusiones se aplican por cuenta.

El informe indica cuántos mensajes se omitieron; `evidence.skippedMessages` conserva IDs y motivo, y `coverage` separa `verified` de `skipped`. Si todos se omiten, se guarda un resultado explícito con cero verificados y sin hallazgos. No se afirma que los omitidos hayan sido comprendidos. Cuotas, red, fallback y errores de guardado siguen provocando un fallo recuperable sin descontar mensajes.

El contador permanece visible. La extensión distingue mensajes verificados de omitidos: cuando existen omisiones, el porcentaje mide procesados, no verificados ni tiempo restante. Se conserva `selectionVersion: 4` para poder reintentar selecciones fallidas de textos disponibles y aprovechar su caché. Al reconstruir un grupo el avance puede retroceder mientras se vuelven a validar sus resultados.

## Validación local

- TypeScript aprobado.
- 249 pruebas de backend, 45 de extensión y 20 de scripts aprobadas: 314 en total. Dos pruebas externas opcionales omitidas.
- Regresiones de 20.000 textos, lotes y reanudación existentes aprobadas.
- Nuevos casos: mensaje aislado inválido entre válidos, fragmento inválido de un mensaje extenso, todos omitidos, reutilización de caché y errores 429/503 sin exclusión.
- PostgreSQL aislado: rollback después de guardar omisiones no consume mensajes; reintento guarda una sola vez, mantiene originales, conserva aislamiento por cuenta y deja a cero el contador cuando no hay más textos disponibles.
- Proveedor simulado; no se enviaron conversaciones reales a Gemini ni se accedió a producción.

## Preparación del despliegue

El backend crea la nueva tabla al iniciar. El script `deploy/scripts/deploy-global-summary.sh COMMIT backend` conserva el respaldo previo y comprueba que la tabla exista después del reinicio. No requiere recompilar Evolution ni cambiar sesiones o credenciales. Estos cambios todavía deben publicarse en Git y desplegarse antes de probarlos en el servidor.

El ZIP de producción se preparó en `extension/dist/release-1.1.9/lyn-superagente-extension-1.1.9.zip`, con manifiesto y código visual verificados. SHA256: `DF8D7C5028C700793CFA96D6AAA12EDF5CC7841DD360BC92509A0709EDE17F5D`.

Actualizar también la extensión para mostrar los porcentajes procesados y las omisiones correctamente. Después del despliegue, reintentar el informe fallido; comprobar `mensajes_analizados`, `mensajes_omitidos`, el contador y la conservación de originales. La validación local no certifica publicación en Chrome Web Store, despliegue ni calidad semántica del proveedor real.
