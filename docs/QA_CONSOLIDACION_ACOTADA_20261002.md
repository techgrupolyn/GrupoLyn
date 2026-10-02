# Consolidación acotada de informes globales

## Incidencia observada

El diagnóstico de producción aportado el 02/10/2026 a las 22:44 UTC mostraba el trabajo de `director-01` todavía consolidando: 439 partes validadas, 392 subdivisiones y 150 recuperaciones. El análisis de 5.656 textos ya había terminado. Los motivos incluían cambio de entidad, referencias desconocidas o duplicadas y exigencia del resumen ejecutivo en un lote intermedio.

El algoritmo anterior aplicaba hasta tres intentos a cada nodo de un árbol que podía llegar a una hoja por fuente, también al reformular detalle ya validado. Aunque progresaba, ese mecanismo multiplicaba las llamadas. Además, las instrucciones por etapa no delimitaban suficientemente los requisitos globales del rol y el validador impedía citar una misma fuente en asuntos distintos.

## Corrección

- Generación y auditoría delimitadas por etapa: no exigir el informe completo a cada lote. La consolidación conserva literalmente la entidad original.
- Referencias compartidas entre asuntos distintos permitidas, con auditoría semántica. Se siguen rechazando referencias ajenas, duplicados dentro de un punto, exclusiones contradictorias y cambios de entidad.
- Un nivel nuevo de subdivisión del detalle, con seis intentos de generación compartidos por lote raíz. Tres intentos como máximo por nodo.
- Sin subdivisión recursiva en consolidación por entidad ni selección ejecutiva; como máximo tres niveles de reducción ejecutiva.
- Si falla una reformulación, conservar todos los puntos previamente verificados, no el borrador rechazado. Una selección ejecutiva inválida se omite con aviso, manteniendo el detalle completo.
- Los hallazgos sin clasificación no se reformulan como si fueran una sola obra.
- Checkpoints v3 compatibles. Las hojas aprobadas anteriores se reutilizan; las hojas profundas sin resultado no abren nuevas llamadas. Extracción, verificación, selección original, contador y transacción de guardado no cambian.
- Progreso administrativo en `result.progress.synthesis`: etapa, operación, partes validadas/recuperadas e intentos de generación de esta ejecución. No es un porcentaje ni un contador de llamadas facturadas.

## Evidencias locales

- TypeScript: `tsc --noEmit` correcto.
- Backend con PostgreSQL local QA aislado: 277 pruebas aprobadas, 4 opcionales omitidas.
- Síntesis: 21 pruebas, incluyendo rechazos masivos de 500 hallazgos, recuperación de árboles v3 profundos, reutilización de selección de 5.656 textos, cobertura completa y reducción ejecutiva acotada.
- La suite de integración incluye 20.000 textos, interrupción, reanudación, guardado único y conservación de una llegada posterior como pendiente.
- Gemini real: prueba existente de 19 mensajes ficticios por obra, 16 llamadas, aproximadamente 55 segundos, modelo `gemini-3.6-flash`, sin fallback, sin mensajes omitidos ni recuperaciones conservadoras. Resultado: resumen ejecutivo y seis puntos de detalle de Dana, Pepe e Ivana. Se mantienen fuga sin reparar, coste 100 a 130, contradicción de fechas, permiso pendiente y responsable no definido.
- Evidencias locales: `.runtime-logs/synthesis-bounded-backend.log`, `.runtime-logs/synthesis-bounded-gemini.log`, `.runtime-logs/synthesis-live/report.txt` y `.runtime-logs/synthesis-live/evidence.json`. El ensayo anterior se respaldó antes de ejecutar el nuevo.

La prueba real usa datos sintéticos, no conversaciones de Alex. No acredita el tiempo ni la calidad final de su informe en producción. La recuperación literal puede resultar menos compacta; no se certifica ausencia absoluta de errores semánticos. Los errores de red, cuota o almacenamiento siguen siendo fallos explícitos, no motivos para publicar contenido no validado.

## Despliegue y comprobación

Corrección solo backend, sin dependencias nuevas, migraciones ni nueva extensión. Utilizar `deploy/scripts/deploy-global-summary.sh` en modo `backend` con el commit exacto aprobado. El script respalda repositorio, configuración y bases antes de actualizar y reinicia el backend. No borrar `summary_job_batches` ni `summary_job_contexts`, no poner contadores a cero y no iniciar un segundo trabajo mientras el actual siga activo.

La cola puede recuperar un trabajo `running` tras el reinicio. Si ya había agotado su límite de interrupciones, debe reintentarse el mismo trabajo fallido con la misma cuenta y rol, conservando su snapshot. El despliegue no equivale a informe finalizado.

Comprobar con una transacción de solo lectura:

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SELECT id, status, updated_at,
       result->'progress' AS progreso,
       LENGTH(COALESCE(result->>'resumen', '')) AS caracteres_resumen,
       error, result->'synthesisDiagnostic' AS diagnostico
FROM summary_jobs
WHERE account_id = 'director-01'
ORDER BY created_at DESC
LIMIT 1;
COMMIT;
```

Antes de avisar de resolución, confirmar `completed`, informe persistido con contenido, contador coherente y revisar el reporte. No anunciar éxito basándose únicamente en salud del servicio o actividad de la cola.
