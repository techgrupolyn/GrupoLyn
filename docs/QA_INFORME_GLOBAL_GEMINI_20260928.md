# QA real: informe global con 20.000 mensajes

> Evidencia histórica del algoritmo anterior de compresión. La prueba posterior con citas verificables y segundo pase semántico está en `QA_INFORME_GLOBAL_EVIDENCIAS_20260928.md`. El test opt-in actual ejecuta ese nuevo algoritmo, no reproduce exactamente esta versión anterior.

## Resultado técnico

**APROBADO el procesamiento de volumen con Gemini real**, realizado el 28/09/2026 sobre los cambios locales de procesamiento por lotes. No es una acreditación de despliegue ni una garantía de precisión absoluta de la IA.

| Comprobación | Resultado observado |
| --- | --- |
| Modelo | `gemini-3.6-flash`, proveedor real, sin fallback |
| Datos | 20.000 mensajes de texto sintéticos en 10 grupos |
| Envío a Gemini | 20.000 identificadores de texto distintos incluidos en los lotes |
| Lotes de análisis | 70 |
| Consolidaciones | 11 |
| Respuestas HTTP del proveedor | 81 respuestas, todas HTTP 200 |
| Duración medida del ensayo | 241,86 segundos, aproximadamente 4 minutos y 2 segundos |
| Petición más grande | 48.575 caracteres de prompt; no se enviaron los 20.000 textos juntos |
| API de extensión | Encolado HTTP 202 y consultas de estado HTTP 200 durante el proceso |
| Persistencia | Un único informe, 20.000 identificadores únicos asociados |
| Tareas pendientes de control | 20/20 referencias conservadas en el informe |
| Actualizaciones de tareas | Los 10 expedientes inicialmente abiertos aparecen completados tras sus actualizaciones posteriores |
| Contadores internos | No disminuyeron durante el análisis parcial; se descontaron 20.000 al guardar el resultado |
| Mensaje posterior al inicio | Quedó pendiente: contador final 1 |
| Contador espejo de WhatsApp | Permaneció en 20.001; no se enviaron confirmaciones de lectura |
| Limpieza | Cero cuentas, mensajes, trabajos o especialistas de esta prueba tras finalizar |

## Alcance y aislamiento

- Se ejecutaron las rutas HTTP locales de la extensión, la cola, la preparación de lotes, las llamadas reales al proveedor y el guardado transaccional en PostgreSQL.
- Base exclusiva: `lyn_qa_global_gemini`, en `127.0.0.1:55439`.
- La prueba rechazaba cualquier petición `fetch` a un destino distinto de Gemini Interactions. No utilizó conversaciones reales ni se conectó a WhatsApp, Drive o Supabase.
- Se utilizó una copia del prompt base del Copiloto General, en un especialista sintético exclusivo de la prueba. No se modificó el especialista de producción.
- Se comprobó por API el progreso y la conservación de contadores. No fue una sesión manual de Chrome Web Store ni una prueba de infraestructura productiva.
- Los fixtures, activaciones y contexto temporal se eliminaron. La evidencia sintética y las métricas se guardaron localmente, sin claves.

## Revisión del contenido

Las tareas `MEDIO-01` a `MEDIO-10` conservaron a Marta, el presupuesto de 1.200 euros y el vencimiento del 05/10/2026. Las tareas `FINAL-01` a `FINAL-10` conservaron a Luis, el permiso de acceso y el vencimiento del 08/10/2026. Los expedientes `INICIO-01` a `INICIO-10` quedaron descritos como completados tras el envío de los planos.

**Limitación observada:** en algunos párrafos informativos, la IA generalizó incorrectamente rangos de referencias `MSG` del material sintético. Por ejemplo, el detalle de Proyecto sintético 08 incluyó referencias abreviadas ajenas a su rango y el de Proyecto sintético 03 amplió el intervalo inicial. Estas referencias generadas no se usan para guardar el informe ni para descontar pendientes: esa operación usa exclusivamente los identificadores originales de PostgreSQL, verificados en la prueba. El resultado valida el procesamiento y las tareas de control, no permite certificar que cada frase o referencia generada por la IA sea exacta.

El informe también repite parte del detalle entre la síntesis transversal y la sección de grupos; es una observación de presentación, no un bloqueo del procesamiento.

## Evidencia y repetición

- Prueba opt-in: `backend/tests/global-summary-gemini.live.test.ts`.
- Evidencia completa local: `.runtime-logs/global-summary-gemini-live-evidence.json`.
- Salida de ejecución: `.runtime-logs/global-summary-gemini-live.log`.
- Instrucciones de repetición y requisitos: `docs/INFORMES_GLOBALES.md`.

El tiempo obtenido corresponde a este conjunto sintético y a la disponibilidad del proveedor durante la ejecución. No es un tiempo máximo para cualquier historial. Esta validación no despliega cambios, no publica una extensión ni acredita que producción ya tenga la corrección.
