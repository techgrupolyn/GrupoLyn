# Recuperación de historial desde el teléfono

## Qué se implementa

La ruta autenticada de Evolution `POST /chat/requestHistory/:instanceName` recibe únicamente `remoteJid` de grupo. El cliente no puede aportar claves, fechas o cuentas arbitrarias. El controlador conserva la instancia de la ruta comprobada por los guards; el servicio consulta únicamente mensajes de esa instancia y de ese grupo. El mismo código sirve para todas las cuentas.

Baileys solicita lotes de 50 mensajes anteriores al más antiguo disponible mediante su operación interna hacia el teléfono. No envía texto al grupo ni activa confirmaciones de lectura. Los lotes posteriores utilizan la nueva referencia más antigua cuando llegue contenido. El backend continúa automáticamente el mismo informe mediante una espera durable en PostgreSQL, sin gastar intentos por el mero hecho de esperar. El despliegue añade la columna `summary_jobs.next_attempt_at`; no elimina ni reescribe mensajes o credenciales.

Las solicitudes simultáneas de un grupo se deduplican. Dos minutos sin cambiar la referencia se notifican como ausencia de progreso, no como éxito. Se admite un nuevo intento con esa referencia pasados diez minutos; las referencias nuevas continúan sin un máximo total de mensajes. La cola libera el turno de la cuenta mientras espera y deja continuar a otras cuentas.

Se evita imprimir el contenido del lote on-demand en los logs y no se aplica a esos lotes solicitados el filtro temporal global de importación de Chatwoot.

## Límites que no se deben ocultar

- Producción mostró siete grupos con 861 pendientes sin ningún mensaje entrante en Evolution. La ausencia de entrantes no demuestra que no exista una referencia saliente; el código busca ambas.
- Si no hay ningún mensaje utilizable, no se inventa un ID: se informa de que falta una referencia y se espera. Cuando llegue un mensaje real del grupo, la cola podrá solicitar anteriores automáticamente. No hay garantía de que WhatsApp entregue todos los mensajes históricos.
- Si una cuenta está desconectada, hay que restablecer su conexión autorizada. Este cambio no hace logout ni empareja cuentas por su cuenta.
- Los textos realmente vacíos, desconocidos o cifrados que no se recuperen continúan impidiendo el informe completo. Esta ruta no sustituye una recuperación individual de contenido cifrado.
- No se fuerza el contador a cero ni se mezclan cuentas para completar lo que falta. Los adjuntos siguen excluidos del análisis.

La función instalada y el [código de Baileys](https://github.com/WhiskeySockets/Baileys/blob/master/src/Socket/messages-recv.ts) muestran que la petición utiliza una clave y timestamp de referencia. Su [guía de historial](https://github.com/WhiskeySockets/Baileys/blob/master/README.md?plain=1) describe el máximo de 50 por consulta y la recepción posterior del evento; no es una garantía de transferencia completa.

## Validación

234 pruebas backend aprobadas con PostgreSQL local aislado, dos externas optativas omitidas; 41 pruebas de extensión; 19 pruebas de scripts (recuperación, despliegue y webhooks). TypeScript de backend/Evolution y compilación de Evolution aprobados. Los proveedores telefónico y Gemini están simulados: aún no se ha verificado la entrega real de los 861 pendientes.

Se prueba recuperación por referencia, timestamps, deduplicación concurrente, 401 lotes sucesivos, aislamiento entre instancias, ausencia de referencia/conexión/persistencia, falta de progreso, reintento tras fallo, validación de entrada, reanudación del mismo trabajo tras reinicio, espera de más de tres ciclos, contadores y avance de otra cuenta durante la espera. La prueba de compilación usa un directorio separado y no arranca ningún servicio local real.

## Despliegue y prueba real

Ejecutar la versión publicada de `deploy/scripts/deploy-global-summary.sh SHA_APROBADO phone-history` mediante una unidad nueva de systemd. No usar el modo backend por defecto: esta entrega requiere compilar y reiniciar Evolution además del backend. El script rechaza cambios de dependencias, Prisma o frontend; no ejecuta npm install ni modifica los archivos de entorno. Comprueba la persistencia histórica habilitada antes de continuar.

Se respaldan configuración, ambas bases de datos, Git, las unidades y el bundle anterior de Evolution. La compilación se hace en staging, sin detener servicios. Solo después de comprobar el resultado se detienen backend y Evolution, se conserva el dist antiguo en el respaldo, se publica el nuevo y se arrancan los servicios. Hay una interrupción breve de conexiones. Si falla, conservar el registro: no repetir ni restaurar bases de datos automáticamente.

No cambia la extensión: mantener 1.1.6. Tras `BACKEND ACTUALIZADO`, iniciar una vez el informe. Mantener el teléfono con WhatsApp conectado a Internet; comprobar `historyRecovery`, la fase de recuperación y los contadores. Un estado `queued` con `no_anchor` no acredita recuperación: significa esperar contenido de referencia. Comparar los conteos antes y después y comprobar que un informe completo solo descuente los textos seleccionados al guardarse.
