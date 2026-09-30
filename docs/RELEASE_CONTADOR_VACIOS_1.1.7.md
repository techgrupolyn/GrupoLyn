# Textos vacíos y contador de análisis — extensión 1.1.7

## Alcance

- Los textos vacíos conocidos no bloquean el informe y no suman en el contador de análisis devuelto por `/api/chats` y `/api/pendientes`. El resultado del informe calcula sus pendientes restantes con la misma política.
- La exclusión no elimina registros, no los marca como analizados y no modifica los no leídos de WhatsApp. Un texto recuperado vuelve a contar. Los contadores internos originales se conservan para comprobar cobertura; consultarlos directamente en SQL no equivale al contador de análisis de la extensión.
- El historial ausente no se descuenta: no se puede afirmar que un mensaje no recibido sea vacío. Los adjuntos mantienen su política anterior y no se envían a Gemini.
- La extensión 1.1.7 distingue los vacíos excluidos de un informe parcial. El backend actualizado reduce el contador también con 1.1.6; esa versión conserva las etiquetas antiguas del informe.
- Las selecciones antiguas se reconstruyen para aplicar la política actual. La ejecución continúa usando lotes internos y un único informe final.

## Verificación local

TypeScript aprobado. 248 pruebas de backend, 42 de extensión y 20 de scripts aprobadas; dos pruebas externas optativas omitidas. Incluye 246 y 55 vacíos, grupos solo con vacíos, contador cero tras analizar los textos, refrescos sin descuento duplicado, contenido recuperado que vuelve a contar, historial ausente que no se oculta y regresión de 20.000 textos. PostgreSQL local aislado y proveedores simulados, sin conversaciones reales enviadas a Gemini.

## Despliegue

Ejecutar `deploy/scripts/deploy-global-summary.sh` con el commit completo aprobado y modo `backend`. Conserva y verifica respaldo de repositorio, configuración y ambas bases antes de actualizar. Reinicia únicamente `lyn-backend`; no reinstala dependencias, no compila Evolution y no elimina sesiones. La extensión se publica por separado desde el ZIP de producción 1.1.7.

Después de confirmar el éxito del servicio de despliegue, reabrir la extensión y comprobar el contador de la cuenta. Los vacíos conocidos deben quedar fuera antes de generar un informe. Tras guardar el informe deben descontarse sus textos, sin alterar los adjuntos ni inventar la recuperación de historial faltante. No iniciar análisis de conversaciones de terceros solo para comprobar el despliegue.

Si falla el despliegue, conservar sus registros y no repetirlo ni restaurar bases automáticamente. El respaldo contiene el commit anterior; evaluar el estado de los servicios antes de revertir código. Este documento no certifica una ejecución en producción ni una publicación en Chrome Web Store.
