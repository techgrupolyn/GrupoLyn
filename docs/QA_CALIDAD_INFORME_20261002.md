# Calidad del informe: agrupación, autoría y estados

## Alcance

La revisión del informe descargado de Alex detectó obras fragmentadas por prefijos o acentos, proveedores usados como obras, duplicados, estados aparentemente contradictorios, inversión de actores en el ejecutivo y unidades alteradas. Se corrigió el generador local. No se ha modificado producción, reescrito el informe guardado ni consumido nuevamente sus mensajes.

## Cambios

- Agrupación conservadora de nombres equivalentes por prefijos Obra/Proyecto, espacios, caja y acentos. No fusionar nombres parecidos, apellidos o direcciones por intuición; tampoco confundir n y ñ.
- Comprobación de que una obra figure en los hallazgos citados o en un chat identificado explícitamente como obra. Un proveedor no se convierte automáticamente en obra ni en autor de una confirmación.
- Ordenación por asunto y eliminación de duplicados textuales entre apartados, conservando la trazabilidad completa.
- Consolidación con citas originales, contexto temporal y autor, además de los puntos redactados. La auditoría exige cinco comprobaciones explícitas: entidades, actores, cantidades, cronología y cobertura.
- Separar asignación de coste, decisión, entrega y ejecución. Conservar incertidumbre si no se puede demostrar que dos mensajes se refieren a la misma tarea o su secuencia.
- Medidas e importes con unidad contrastados estructuralmente contra las citas disponibles. Si el hallazgo anterior ya tiene una unidad errónea y no se logra corregirlo, conservar las citas originales en un apartado de revisión, no publicar esa unidad ni perder los otros asuntos.
- Ejecutivo extractivo: selecciona prioridades del detalle sin cambiar su redacción ni su obra. Impide que esa etapa cambie quién impidió el acceso, convierta dos reclamaciones en un rango o altere una unidad.
- Ocultar referencias internas y patrones reconocibles de códigos de acceso en el texto público, sin borrar fuentes.
- Checkpoints `synthesis-v5`; las síntesis v3 no se reutilizan como aprobadas. Las extracciones existentes sí se conservan. No hay nueva migración, dependencias o versión de extensión.

## Prueba real

`backend/tests/summary-quality.live.test.ts`, optativa con `QA_LIVE_SYNTHESIS=true`, usa una reconstrucción sintética de los errores observados, no conversaciones extraídas de producción. Contiene 36 mensajes/hallazgos entre distintos chats y lotes, con repeticiones y variantes de ocho obras. Límite de 60 llamadas por ejecución.

Última ejecución: aprobada, 23 llamadas a Gemini, unos 81 segundos, sin fallback ni recuperación conservadora. Las 36 referencias quedan representadas en ocho puntos de detalle y siete prioridades ejecutivas. Revisión del resultado:

- Patricia: rodapiés instalados, ya no pendientes de instalación.
- Dana: plato entregado pero no instalado; isla de 1,80 m, no centímetros.
- Rómulo: medición realizada, presupuesto aún pendiente.
- Catral: asumir el coste no implica reparar la caja.
- Varadero y Armada Española: conserva quién restringió el acceso.
- Hakoon: reclamaciones separadas de 285 y 1500 euros.
- Mar Jónica: un solo asunto tras reunir variantes y repeticiones.

Una ejecución intermedia terminó con un fallo de aserción porque el modelo usó «finalizada» y el test solo aceptaba «instalada/terminada/completada». Se añadió ese sinónimo legítimo y se repitió la prueba real; no se eliminó el requisito de que la instalación dejase de figurar pendiente.

Evidencias locales excluidas de Git: `.runtime-logs/quality-live-final.log`, `.runtime-logs/quality-live/report.txt` y `.runtime-logs/quality-live/evidence.json`.

## Regresiones locales iniciales

- TypeScript: `tsc --noEmit` aprobado.
- Síntesis y calidad: 32 pruebas aprobadas sobre el código final, incluyendo unidades erróneas ya presentes en un hallazgo anterior, cambios de actor, proveedores como obras, autoría inferida del chat, citas originales en la consolidación y conservación de fuentes.
- Extensión y scripts: 73 pruebas aprobadas.
- Backend con PostgreSQL aislado: última suite completa con 287 pruebas aprobadas, 5 opcionales omitidas y un timeout de 60 segundos en Q-20000. La repetición aislada de Q-20000 aprobó en unos 54 segundos, comprobando fallo parcial, reanudación, guardado único y que una llegada posterior sigue pendiente. No se aumentó el timeout ni se cambiaron las consultas o las aserciones para ocultar el resultado.
- Durante ese timeout la síntesis ya había terminado y la consulta de mensajes pendientes seguía activa en PostgreSQL. Esto merece seguimiento de rendimiento; no se declara una ejecución completa totalmente verde ni se atribuye a Gemini, que está simulado en esa prueba.
- Una ejecución previa se hizo mientras se añadía la regresión de n/ñ; se descartó como validación final por cargar versiones distintas del módulo y del test. La repetición final de las 32 pruebas enfocadas pasó.

Registros: `.runtime-logs/quality-focused-final.log`, `.runtime-logs/quality-backend-final.log`, `.runtime-logs/quality-20k.log`, `.runtime-logs/quality-extension.log`. La base QA local se detuvo al terminar.

## Preparación del despliegue y 50.000 mensajes

Se amplió la regresión de volumen a 300, 20.000 y 50.000 mensajes disponibles, con fallo simulado del proveedor, reanudación del mismo trabajo, conservación de la selección, guardado único y una llegada posterior que permanece pendiente. El timeout del caso de estrés se amplió a cinco minutos para permitir diagnosticar el nuevo volumen; no es un límite del producto ni descarta mensajes.

La primera prueba de 50.000 reveló un cuello de botella en PostgreSQL, no en la IA: estadísticas desactualizadas estimaban un registro revisado donde la transacción acababa de insertar decenas de miles. `EXPLAIN` mostraba un `Nested Loop Anti Join` con materialización y comparaciones repetidas. La consulta llevaba más de tres minutos al cancelarla expresamente en la base QA; no se canceló ninguna consulta de producción.

La selección ahora resta conjuntos de identificadores de mensajes revisados y omitidos mediante `EXCEPT`, siempre por cuenta, y recupera cada candidato con una búsqueda por su clave primaria. La subconsulta lateral devuelve como máximo la única fila de ese identificador; ese `LIMIT 1` no limita la selección total. Así se evita también que una estimación de un solo candidato genere un cruce repetido contra todos los mensajes de la cuenta. No cambia qué textos se seleccionan ni cómo se descuentan.

Resultado posterior: los tres volúmenes aprobaron en 36 segundos en conjunto, con proveedor simulado y sin red. Se cubrieron los 50.000 identificadores exactos, sin recorte. Registro: `.runtime-logs/release-volume-final.log`. Esto comprueba el flujo y la persistencia, no el coste, duración o calidad semántica de 50.000 mensajes con Gemini real.

Validación completa posterior a la corrección de la consulta: 290 pruebas backend aprobadas, 5 opcionales omitidas, en unos 105 segundos, incluyendo los tres volúmenes; TypeScript correcto. Extensión y scripts: 73 pruebas aprobadas. Registros: `.runtime-logs/release-quality-backend.log` y `.runtime-logs/release-quality-extension.log`. La advertencia de timeout de la ejecución inicial no se repitió en esta suite.

No hay nombres fijos de obras en la lógica de producción: los nombres de las pruebas son ejemplos. La normalización y la agrupación dependen de los mensajes y del rol solicitado.

## Límites y entrega

Las garantías estructurales no hacen infalible al modelo: las equivalencias no triviales de obras, contradicciones y duplicados semánticos aún requieren auditoría. La prueba de 36 hallazgos no certifica la calidad del informe real de 5656 mensajes. No se han enviado esos mensajes a Gemini durante este cambio.

Antes de avisar a Alex, desplegar el commit aprobado con respaldo y preparar una copia revisada desde la evidencia guardada del informe terminado. No poner contadores a cero, no borrar el informe anterior y no tratar sus mensajes como nuevos pendientes para regenerarlo. Comparar la copia contra las fuentes y verificar su acceso desde la extensión antes de sustituir o publicar un informe histórico.
