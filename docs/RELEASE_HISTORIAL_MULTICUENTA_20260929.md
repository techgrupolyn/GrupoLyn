# Corrección de clasificación e historial multicuenta

## Alcance

- Corrección común a todas las cuentas actuales y nuevas, sin IDs de producción codificados.
- Reacciones, álbumes, contactos, menciones de estado y vídeos circulares ya no se interpretan como textos vacíos cuando Evolution identifica esos tipos. Los adjuntos y eventos excluidos no se envían a Gemini ni se marcan como analizados.
- Los textos almacenados como cadenas en `raw.message` se recuperan sin perder el contenido al desenvolver el mensaje.
- Los registros realmente vacíos, desconocidos, cifrados o de protocolo sin texto recuperable siguen bloqueando un informe incompleto. No se eliminan ni se consume su contador para ocultar la falta de cobertura.
- Las plantillas de Evolution activan el guardado de mensajes históricos; preflight avisa si falta la configuración en un servidor existente. No se modifican automáticamente sus credenciales ni su entorno.

## Evidencias locales

- 226 pruebas backend aprobadas con PostgreSQL local aislado; dos pruebas externas optativas omitidas.
- 41 pruebas de extensión y cuatro pruebas de seguridad del despliegue aprobadas.
- TypeScript y sintaxis Bash verificados.
- Regresión nueva: dos cuentas distintas con el mismo JID de grupo y distintas instancias Evolution. El historial ausente de la primera deja sus pendientes intactos; la segunda recupera y analiza su texto, excluye su reacción y modifica únicamente su contador. Las llamadas externas y Gemini están simulados.
- Se mantienen las regresiones de 3.000 y 20.000 textos. Esta ejecución no es una validación de entrega completa del historial real ni una nueva prueba de Gemini real.

## Aplicación

Usar `deploy/scripts/deploy-global-summary.sh SHA_APROBADO` extraído del commit publicado, ejecutado mediante una unidad nueva de systemd. Crea y verifica respaldos de Git, configuración y ambas bases antes de actualizar. Reinicia solo el backend; no recompila el dashboard ni Evolution. Mantener la extensión 1.1.6: esta corrección no exige otra publicación en Chrome Web Store.

El administrador ya confirmó `DATABASE_SAVE_DATA_HISTORIC=true` y `DATABASE_SAVE_DATA_NEW_MESSAGE=true` en `/etc/lyn/evolution.env`, con Evolution y backend activos después del reinicio. Esto guarda los históricos que WhatsApp entregue, pero no garantiza recuperar automáticamente lo que no está almacenado.

Tras el marcador `BACKEND ACTUALIZADO`, ejecutar `sudo bash /opt/lyn/deploy/scripts/check-whatsapp-history.sh`. El diagnóstico es de solo lectura, abarca todas las cuentas e instancias y no muestra secretos ni contenido de mensajes. Los conteos históricos no equivalen al conjunto de textos pendientes. Si falla por esquema diferente, no editar ni crear tablas para adaptarlo; revisar el esquema del entorno.

Generar después un informe desde la cuenta que se esté usando. Si todavía informa contenido ausente, conservar el desglose: la incidencia de recuperación real sigue abierta. No desvincular cuentas, borrar mensajes, marcar WhatsApp como leído ni reducir artificialmente contadores. El éxito de las pruebas y el despliegue no permite declarar recuperados todos los historiales de producción.
