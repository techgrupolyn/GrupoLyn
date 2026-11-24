# Contexto real de Telegram

La interfaz de administración y la autorización por grupo pertenecen a Club LYN. El Superagente consulta y analiza únicamente los destinos autorizados en su base central. El puente HTTPS y los upgrades centrales se distribuyen en el paquete revisado de Club LYN, PR #122.

Este módulo conserva el modo de pruebas por defecto. Solo TELEGRAM_CONTEXT_PRODUCTION_ENABLE=true activa consultas a telegram_central_scope_ready con la finalidad y fecha del mensaje. Ver conversaciones requiere context; descargar adjuntos requiere media; analizar requiere además ai comprobado antes del enmascarado, la auditoría y la llamada al modelo. La revocación vuelve a comprobarse en cada petición. No se aceptan destinos por un parámetro del navegador ni se convierte la lectura en permiso de IA.

Instalar antes el esquema central y su política RLS para el usuario real del backend, con permisos acotados, respaldo y verificación. El interruptor por sí solo no habilita grupos ni genera mensajes. La decisión temporal de no publicar el aviso se conserva como pendiente de Legal en Club y central.

Desplegar solo este módulo desde el merge revisado tras los cuatro checks de Quality Gate, sobre la ruta activa verificada, con copia y comparación de hashes. Conservar las instrucciones v6, verificación de citas, privacidad, transportes, audio y demás archivos del backend. No sustituir el backend completo por una copia de Club LYN. La reversión recupera este módulo y el archivo de configuración respaldados; las nuevas autorizaciones se deshabilitan, sin borrar mensajes ni auditoría.

Las pruebas HTTP cubren el límite de pruebas por defecto y la autorización separada de contexto, adjuntos e IA, incluyendo revocación antes de la salida al modelo. Los escenarios reales de esquema y reversión se prueban en la CI del paquete central de Club LYN.
