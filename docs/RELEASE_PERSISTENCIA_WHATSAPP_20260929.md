# Conservación y recuperación de mensajes — 29/09/2026

## Cambios

- Los webhooks de mensajes de grupos se guardan primero en `whatsapp_message_inbox`. Solo se confirma recepción si esa escritura durable termina. Un error de base de datos antes de guardar la recepción devuelve HTTP 500, no un éxito ficticio.
- `persistMessage` propaga los fallos: antes podía devolver el ID pese a una escritura rechazada. El mensaje y su incremento de contador ahora se guardan en una misma sentencia atómica. Repetir la recepción no duplica el mensaje ni incrementa dos veces el contador.
- El ejecutor reintenta recepciones pendientes cada cinco segundos. El retroceso por fallo llega hasta cinco minutos, sin descartar por número de intentos. Procesa hasta 25 recepciones por pasada para proteger memoria y conexiones; las restantes permanecen en PostgreSQL. No es un límite de mensajes del informe.
- Los reintentos se conservan tras reiniciar el backend; tienen exclusión por cuenta y conservan cada variante del contenido recibido hasta procesarla. Las cuentas inactivas conservan su cola, pero no la ejecutan. La recepción se elimina de la cola únicamente tras terminar su persistencia.
- Una copia textual vacía no sustituye texto o adjuntos conocidos. Los stickers Lottie dejan de clasificarse como texto vacío. La preparación del informe consulta Evolution también cuando los registros presentes incluyen textos vacíos.
- La sincronización completa periódica examina las cuentas activas secuencialmente, conserva su resultado en `whatsapp_sync_health` y solicita historial a Evolution cuando detecta registros pendientes ausentes. También se intenta una sincronización completa al recibir una reconexión `open`. Los errores de una cuenta no impiden procesar las otras.

## Vigilancia operativa

- `GET /api/whatsapp-accounts/:id/sync-health`: acceso administrativo, sin cuerpos de mensajes. Muestra la última comprobación y el número de recepciones pendientes/reintentadas.
- `sudo bash /opt/lyn/deploy/scripts/check-whatsapp-history.sh`: diagnóstico de solo lectura para todas las cuentas, incluyendo salud y cola.
- Registros de servicio: `[whatsapp-sync-health]` informa cambios de estado y `[whatsapp-inbox]` fallos de persistencia. No se envían correos, notificaciones externas ni mensajes de WhatsApp. No se ha añadido un indicador visual al dashboard en esta entrega.
- `gaps_detected` significa que faltan registros o texto; `error` significa que la sincronización no terminó; `no_known_gaps` solo indica que no se detectaron diferencias en la ventana de pendientes. No certifica la integridad de todo el historial del teléfono. Comprobar también `checked_at` y la cola; una revisión antigua no acredita salud actual.
- La vigilancia periódica requiere `EVOLUTION_BACKGROUND_SYNC_ENABLED` habilitado y el backend en ejecución. La cola de recepciones arranca con el backend, independientemente de esa opción.

## Verificación y límites

Pruebas contra PostgreSQL local aislado, con WhatsApp/Evolution simulados: fallo de persistencia, reinicio del ejecutor, interrupción posterior al guardado y anterior a confirmar, ejecución concurrente, separación de cuentas con el mismo ID externo, repetición de historial sin modificar sus contadores, rechazo de confirmación si falla la cola y un fallo real de restricción PostgreSQL durante la actualización del contador. La recuperación simulada comprueba IDs y texto exactos después de desconectar/reconectar, no solo cantidades.

Validación local: TypeScript aprobado; 244 pruebas de backend aprobadas y dos optativas externas omitidas; 41 pruebas de extensión y 20 de despliegue, lotes y recuperación aprobadas. Los proveedores de estas regresiones están simulados: no se enviaron conversaciones reales a Gemini.

Estas pruebas no sustituyen una desconexión/reconexión del teléfono real. No se ha desvinculado ninguna cuenta de producción ni enviado mensajes o confirmaciones de lectura. El código no puede reconstruir contenido que no recibe: los ocho grupos sin referencia y los registros cifrados/desconocidos siguen necesitando datos reales. Solicitar historial no garantiza que WhatsApp lo entregue.

Una caída completa de PostgreSQL impide incluso guardar en la cola: se rechaza el webhook y la recuperación depende del reenvío de Evolution o de su historial persistido. El servidor también necesita espacio, respaldos y supervisión. No se promete pérdida cero bajo cualquier fallo.

## Despliegue

Usar `deploy/scripts/deploy-global-summary.sh` en modo `backend` con el commit completo publicado. No cambia dependencias, frontend, extensión ni Evolution. El script respalda repositorio, configuración y ambas bases antes de actualizar; reinicia solo `lyn-backend` y comprueba las tablas nuevas y la salud del servicio. No ejecuta TypeScript en el servidor limitado.

La migración es aditiva. No borrar las tablas nuevas al revertir código: podrían contener recepciones pendientes. Conservar el respaldo y revisar el commit previo antes de cualquier reversión. Después del despliegue comprobar los registros, la cola y los cambios de cobertura; la confirmación de despliegue no demuestra recuperación del historial ausente.
