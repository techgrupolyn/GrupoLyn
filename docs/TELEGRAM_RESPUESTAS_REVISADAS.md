# Procesamiento de respuestas de Telegram

PR complementario de Club LYN: rama `feat/telegram-response-workflow-20261126`. El frontend, la bandeja, la migración y la cola revisada se entregan allí; este repositorio mantiene el procesamiento central.

`POST /api/telegram/response-processing` admite únicamente metadata, classify y draft. La ruta usa el token privado de la integración central y rechaza Origin/sesiones de navegador. No expone SQL, no envía mensajes y limita la concurrencia a dos operaciones. Registro antes del middleware general para no confundir el token de servidor con el SSO de una persona.

La configuración se lee desde `TELEGRAM_CENTRAL_CONFIG_FILE`, por defecto `/etc/club-telegram-central/config.json`. Antes de instalar hay que comprobar que el usuario del backend puede leerla mediante los permisos privados existentes; nunca publicar su contenido. No se crean nuevas claves, permisos SSH ni instalaciones automáticamente.

Se consultan solo mensajes de Telegram de una obra activa y un destino habilitado. En grupos reales se comprueban por separado context/ai. Las versiones de los mensajes solicitados deben coincidir con las versiones centrales. Más de 1.000 mensajes bloquea con un error, manteniendo el límite de contexto de C-4 sin truncar silenciosamente.

La clasificación devuelve asunto, prioridad, necesidad de respuesta y roles. Los borradores reutilizan especialistas activos existentes y sus apoyos. Todo prompt e instrucción pasa por el enmascarado/auditoría C-3 y por el transporte real ya auditado. Salidas inválidas, fallback y fallo de auditoría se rechazan; no se presentan como una respuesta generada correctamente.

La aprobación humana y el envío se ejecutan en la cola de Club LYN, con revisión de contexto/versión y permisos inmediatamente antes del transporte del bot. Ninguna operación de este módulo equivale a una aprobación o a un envío.

Para instalar: integrar tras revisión y CI, conservar copia del release y reiniciar solo lyn-backend después de verificar el acceso privado anterior. Instalar después la migración y la imagen de gestión/receptor de Club LYN, y finalmente su frontend. Comprobar primero un grupo de prueba. Legal y la habilitación de grupos conservan su estado actual.

Reversión: restituir server.ts y retirar únicamente el módulo nuevo; no cambiar geminiService.ts, audio, reuniones, WhatsApp, esquema ni claves. La retirada de la bandeja/cola tiene su reversión independiente en Club LYN.

Pruebas: `node node_modules/tsx/dist/cli.mjs --test telegram-response-processing.test.ts` desde backend, más el bloque completo de Telegram/privacidad en quality.yml y el typecheck existente. Todas las pruebas nuevas usan datos y transporte sintéticos.

