# Publicación de informes globales y extensión 1.1.6

## Qué cambia

- El backend recupera el historial faltante de cada grupo antes de seleccionar los textos; utiliza la paginación real de Evolution (`offset`) y filtros de grupo explícitos.
- Una ejecución analiza todos los textos pendientes de todos los grupos de la cuenta, sin tope total de cantidad. Los lotes internos son automáticos y producen un solo informe.
- Si sigue faltando historial o hay textos vacíos, no llama a Gemini, no publica un informe parcial y no consume pendientes. Evolution no puede recuperar por esta ruta mensajes que WhatsApp nunca le entregó.
- Se descartan selecciones antiguas sin comprobación de cobertura al reanudar. Las selecciones completas se conservan para retomar un fallo de IA; los mensajes posteriores quedan para el siguiente informe.
- `resumenes_globales_chat.coverage` conserva el desglose de textos y adjuntos. La extensión aclara el denominador de la barra y la falta de cobertura comprobada en informes antiguos.
- No cambia cuentas, sesiones, credenciales, dependencias, Evolution ni el frontend CEO. Los adjuntos siguen excluidos y no se envían confirmaciones de lectura.

## Validación local

210 pruebas backend aprobadas y dos pruebas externas optativas omitidas; 41 pruebas de extensión aprobadas. TypeScript y comprobaciones de sintaxis correctos.

La regresión de 3.035 pendientes verifica un único informe con 3.000 textos en tres grupos, 35 adjuntos excluidos, 144 mensajes ya revisados que no se repiten y una llegada nueva que queda pendiente. La prueba de 20.000 textos sigue pasando. La recuperación de historial se prueba contra respuestas simuladas de Evolution y PostgreSQL local aislado: paginación, grupos, fallo de conexión e historial ausente. No se ha repetido el ensayo facturado de Gemini ni se ha confirmado todavía la recuperación del historial real de producción.

## Despliegue

Usar `deploy/scripts/deploy-global-summary.sh SHA_APROBADO` como root, extraído del commit aprobado y lanzado con una unidad nueva de `systemd-run`. Comprueba `origin/main`, preflight, cambios locales y espacio; crea y verifica un bundle, parches, configuración y dumps de `superagente` y `evolution_db` antes de avanzar con fast-forward. Reinicia solo `lyn-backend` y comprueba readiness, servicios, columnas `evidence` y `coverage`, y salud pública. No requiere recompilar Evolution ni instalar paquetes.

El marcador de éxito es `BACKEND ACTUALIZADO: SHA_APROBADO`, con `ExecMainStatus=0`. Un push a GitHub no equivale a desplegar el servidor. Si falla, conservar el registro y no repetir ni restaurar bases automáticamente.

## Extensión y comprobación real

ZIP de producción: `extension/dist/release-1.1.6/lyn-superagente-extension-1.1.6.zip`. Publicar en la misma ficha de Chrome Web Store, sin desinstalar ni cambiar el ID. Verificar que no exista un borrador con versión igual o superior. La nueva versión conserva la activación existente y solo permite los hosts de producción y WhatsApp Web.

Tras desplegar, generar un informe y comprobar la fase de recuperación, la cobertura y los contadores. El backend 1.1.6 también aplica la recuperación y el rechazo de selecciones incompletas con la extensión anterior; la actualización de extensión es necesaria para las nuevas etiquetas. Si falla por historial ausente, revisar qué registros conserva Evolution para esa cuenta: no reducir los contadores para ocultar el problema. El contador de chats puede seguir mostrando adjuntos excluidos y mensajes nuevos después de analizar todos los textos seleccionados.
