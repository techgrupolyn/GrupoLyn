# Contexto de Telegram entre releases

La página se conserva en frontend/public/telegram-context.html y Vite la incluye en cada compilación. El backend registra las rutas de contexto, los controles de acceso corporativo y el enmascarado auditado antes del transporte Gemini. La recepción durable de mensajes directos de WhatsApp conserva la identidad canónica; el análisis automático y la distribución a empleados siguen limitados a grupos.

## Configuración y datos

Se reutilizan el receptor, el puente y la base central de Telegram ya provisionados. El esquema de auditoría y resultados está en backend/telegram-context-schema.sql; su aplicación requiere comprobar el destino y los permisos de la base central. La tabla telegram_ingestion_targets limita el contexto a los grupos de prueba habilitados. TELEGRAM_CONTEXT_PRIVACY_KEY se conserva en la configuración privada del servicio: se necesitan al menos 32 caracteres. La ausencia de esa configuración bloquea las rutas de contexto. El aviso de privacidad conserva su aprobación y configuración separadas en Club LYN.

## Publicación y comprobación

1. Verificar WorkingDirectory y DropInPaths de lyn-backend. Confirmar la carpeta del proceso activo antes de modificar código: una copia en /opt/lyn/backend puede pertenecer a una release anterior.
2. Instalar los módulos de esta entrega en esa misma release, conservando sus variables y archivos privados.
3. Comprobar dist/telegram-context.html al compilar y publicarlo junto al dashboard.
4. Con sesión del equipo, verificar conversaciones, periodo, audio transcrito y descarga privada. El análisis debe indicar Telegram y el número de mensajes seleccionado. La auditoría enmascarada se guarda en telegram_ai_egress; el resultado y su periodo, en telegram_agent_runs.
5. Conservar código, configuración e interacciones durante una reversión. Verificar salud de los servicios existentes después del cambio.

CI ejecuta 131 regresiones de contexto y privacidad, seis pruebas de la página y la conservación del HTML compilado, además de las comprobaciones existentes. La aceptación física de dos titulares y el alta de una cuenta nueva necesitan las cuentas correspondientes; la aprobación legal se gestiona por separado.
