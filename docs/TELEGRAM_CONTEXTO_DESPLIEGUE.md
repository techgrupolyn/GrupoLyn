# Contexto de Telegram entre releases


## Control de citas de C-4

La política v5 comprueba la matriz después de recibir la respuesta del agente usando únicamente el texto enmascarado enviado al proveedor. No busca citas en las instrucciones del sistema ni en la introducción del prompt. Compara fragmentos continuos con normalización de Unicode y espacios y exige vocabulario correspondiente al tipo de fila. Esta comprobación literal y temática no equivale a una verificación semántica completa de todas las conclusiones.

Las filas de aprobación o inicio que expresan ausencia de evidencia se muestran como conclusiones sin cita literal. El texto presentado incluye una nota que las distingue de los fragmentos. Una cita inventada para una afirmación, una matriz ausente o una estructura inválida impiden aceptar el análisis.

Los resultados aceptados conservan el texto original del agente y el detalle del control en el contexto de la ejecución. Las respuestas rechazadas también se guardan con estado de validación rechazado y se devuelve un error, sin presentar su texto como un análisis aceptado. La API no incluye la respuesta original ni los fragmentos retirados; permanecen en el registro protegido para revisión.

La vista explica el rechazo y retira el análisis anterior al iniciar otra solicitud. Desplegar juntos el módulo y la página estática correspondiente para evitar mensajes antiguos. No modificar los mensajes del caso original al repetir las pruebas.
La página se conserva en frontend/public/telegram-context.html y Vite la incluye en cada compilación. El backend registra las rutas de contexto, los controles de acceso corporativo y el enmascarado auditado antes del transporte Gemini. La recepción durable de mensajes directos de WhatsApp conserva la identidad canónica; el análisis automático y la distribución a empleados siguen limitados a grupos.

## Configuración y datos

Se reutilizan el receptor, el puente y la base central de Telegram ya provisionados. El esquema de auditoría y resultados está en backend/telegram-context-schema.sql; su aplicación requiere comprobar el destino y los permisos de la base central. La tabla telegram_ingestion_targets limita el contexto a los grupos de prueba habilitados. TELEGRAM_CONTEXT_PRIVACY_KEY se conserva en la configuración privada del servicio: se necesitan al menos 32 caracteres. La ausencia de esa configuración bloquea las rutas de contexto. El aviso de privacidad conserva su aprobación y configuración separadas en Club LYN.

## Publicación y comprobación

1. Verificar WorkingDirectory y DropInPaths de lyn-backend. Confirmar la carpeta del proceso activo antes de modificar código: una copia en /opt/lyn/backend puede pertenecer a una release anterior.
2. Instalar los módulos de esta entrega en esa misma release, conservando sus variables y archivos privados.
3. Comprobar dist/telegram-context.html al compilar y publicarlo junto al dashboard.
4. Con sesión del equipo, verificar conversaciones, periodo, audio transcrito y descarga privada. El análisis debe indicar Telegram y el número de mensajes seleccionado. La auditoría enmascarada se guarda en telegram_ai_egress; el resultado y su periodo, en telegram_agent_runs.
5. Conservar código, configuración e interacciones durante una reversión. Verificar salud de los servicios existentes después del cambio.

CI ejecuta las regresiones de contexto y privacidad, las pruebas de la página y la conservación del HTML compilado, además de las comprobaciones existentes. Los ejecutores registran sus recuentos sin sumar tandas repetidas. La aceptación física de dos titulares y el alta de una cuenta nueva necesitan las cuentas correspondientes; la aprobación legal se gestiona por separado.

## Conservación del texto de las citas

La política v6 conserva el control literal de v5 y exige una matriz completa: las referencias al plano ausente pertenecen a plano y la anotación del binario pertenece a adjunto. Las recomendaciones no deben presuponer condiciones pactadas que no aparecen en el periodo.

El formateador de Gemini elimina únicamente los delimitadores de código en línea, conservando su contenido. La versión anterior eliminaba también ese contenido y podía vaciar las celdas antes de que el control de citas recibiera la respuesta. El cambio afecta al formateo de texto, también fuera de Telegram; JSON válido conserva su tratamiento anterior. No se reduce el enmascarado ni se admiten celdas vacías o citas de otro evento.

La regresión telegram-context-transport-evidence.test.ts usa el transporte Gemini simulado y el control real de Telegram. Reproduce la pérdida de citas con el formateador anterior y verifica que el corregido conserva los fragmentos; también comprueba que se siguen rechazando una celda vacía y una referencia al plano presentada como adjunto. Para esta prueba se utiliza tsx, igual que en el backend; GeminiError contiene sintaxis TypeScript que el modo strip-only de Node no admite.
