# Recuperación de síntesis — 2 de octubre de 2026

## Incidencia y alcance

El trabajo de Alex (`director-01`) alcanzó 5656 textos procesados y falló al validar la síntesis final. El registro del 02/10 a las 17:04:37 UTC no conservaba el motivo concreto de la auditoría. No demuestra un fallo de crédito ni de sincronización en ese intento.

La corrección conserva extracción, verificación y selección originales. Añade reparación dirigida, invalidación de borradores rechazados, checkpoints durables de apartados auditados y particiones, y diagnóstico privado cuando no existe una representación validada que pueda conservarse.

Cuando una reformulación falla, solo puede conservarse literalmente un hallazgo previamente verificado contra sus citas o un apartado ya auditado. No se acepta el texto rechazado. Los hallazgos cuya clasificación no pudo validarse quedan identificados como pendientes de agrupar; esta salida conservadora puede ser menos compacta que una síntesis completamente consolidada. Si falla el resumen ejecutivo se conserva el detalle validado con aviso. Errores de proveedor, almacenamiento o descripciones sin validar siguen bloqueando el guardado y los descuentos.

## Validación automatizada

- Suite backend sobre `lyn_qa_retest`, PostgreSQL local aislado: **271 aprobadas, 4 optativas omitidas**. Registro: `.runtime-logs/synthesis-recovery-backend-final.log`.
- Tras hacer atómica la actualización del diagnóstico y estado: **17 pruebas dirigidas aprobadas**, incluyendo integración PostgreSQL y síntesis. Registro: `.runtime-logs/synthesis-recovery-targeted.log`.
- TypeScript: `tsc --noEmit` aprobado.
- Extensión y scripts: **73 pruebas aprobadas**. Registro: `.runtime-logs/synthesis-recovery-extension.log`.
- Regresión de 5656 textos: fallo descriptivo individual, invalidación del borrador, conservación de particiones aprobadas y reanudación sin nuevas llamadas de extracción/verificación.
- Regresión de 20000 textos: interrupción, reanudación durable y llegada posterior que permanece pendiente.
- PostgreSQL verifica que una redacción rechazada nunca sustituye al hallazgo verificado, no se marca como omitido, se guarda un único informe y se descuenta una sola vez. Si no hay síntesis validada ni hallazgo verificado reutilizable, no se guarda ni se descuenta nada; el diagnóstico y selección quedan disponibles.
- La interfaz distingue 100 % de textos procesados de informe guardado. No muestra «0 % restante» como si no quedara síntesis pendiente.

## Gemini real

Prueba de rol por obra con **19 mensajes exclusivamente ficticios**, `gemini-3.6-flash`: **aprobada**, 58 llamadas y aproximadamente 313 segundos. Sin fallback local y sin mensajes omitidos. Se verificaron obras Dana, Pepe e Ivana, contradicción de entrega 3/7 de octubre, importe 130, permiso de acceso pendiente, fuga sin reparar y rechazo de instrucciones incluidas en los mensajes.

Se activó **una recuperación conservadora**: un hallazgo se conservó literalmente desde la extracción ya verificada, bajo «Asuntos verificados pendientes de agrupar». El resto del informe y su resumen ejecutivo pasaron la auditoría. Esta evidencia valida esa ejecución sintética, no todas las respuestas futuras del proveedor ni el resultado real de Alex.

Archivos: `.runtime-logs/synthesis-recovery-gemini.log`, `.runtime-logs/synthesis-live/report.txt`, `.runtime-logs/synthesis-live/evidence.json`. Los artefactos previos se preservaron en `.runtime-logs/synthesis-live-before-recovery-20261002/`. El primer intento bajo sandbox no conectó; la prueba aprobada se ejecutó con acceso de red autorizado.

## Entrega pendiente

- Paquete de extensión: `extension/dist/release-1.1.10/lyn-superagente-extension-1.1.10.zip` (15 archivos; sin `.env`, pruebas ni dependencias).
- SHA-256: `6A1D4099A219A76BF5D8A2FA4FEF7DD5DFF09811B9BE31DE1866E2B86E1250A3`.
- El backend es compatible con la extensión anterior. La explicación visual nueva requiere instalar/publicar 1.1.10.
- Este documento acredita pruebas locales, no el despliegue en producción ni la publicación en Chrome Web Store. La publicación del commit y su Quality Gate se verifican por separado.
- Después de desplegar el commit aprobado con respaldo, Alex debe reintentar el mismo trabajo desde `director-01`, rol `general`. No borrar trabajos, snapshots, lotes ni mensajes. Comprobar `status=completed`, informe guardado no vacío, contadores y visualización en su cuenta antes de cerrar la incidencia de producción.
