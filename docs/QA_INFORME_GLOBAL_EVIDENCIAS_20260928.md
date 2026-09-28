# QA: informes globales con evidencia y verificación

## Resultado

**APROBADO el escenario local de 20.000 textos sintéticos con Gemini real** el 28/09/2026. La prueba recorrió encolado HTTP, PostgreSQL, procesamiento real por lotes, consultas de progreso y guardado transaccional. No constituye una garantía de razonamiento perfecto, capacidad ilimitada ni despliegue en producción.

| Comprobación | Resultado |
| --- | --- |
| Modelo real | `gemini-3.6-flash`, sin fallback |
| Entrada | 20.000 mensajes sintéticos, 10 grupos |
| Textos distintos enviados | 20.000 |
| Lotes previstos | 160 |
| Llamadas reales | 322: 161 extracciones y 161 verificaciones, incluyendo intentos adicionales |
| Respuestas del proveedor | Todas HTTP 200 |
| Mayor petición | 26.255 caracteres de prompt |
| Duración medida | 702.677 ms: aproximadamente 11 min 43 s |
| Límite global de diez minutos | No interrumpió el trabajo; cada llamada individual conserva su timeout |
| Hallazgos guardados | 42, con fuentes y citas literales contrastadas |
| Tareas pendientes de control | 20/20 conservadas |
| Historial de cierres | 10 tareas iniciales y sus 10 actualizaciones de cierre conservadas |
| Negación | El pago de 900 euros no figura como pagado ni autorizado |
| Incertidumbre | La llamada a la comunidad sigue sin responsable ni fecha inventados |
| Contadores durante el análisis | Permanecieron pendientes hasta guardar el informe completo |
| Mensaje llegado después del snapshot | Conservado como pendiente; contador final 1 |
| Contador espejo de WhatsApp | 20.001; sin envío de confirmaciones de lectura |
| Persistencia | Un solo informe con 20.000 identificadores únicos |
| Limpieza | Cero cuentas, mensajes, trabajos o especialistas de este ensayo tras finalizar |

Se revisaron además los 42 hallazgos resultantes: las tareas de presupuesto mantienen Marta, 1.200 euros y el 05/10/2026; las de acceso mantienen Luis y el 08/10/2026. Las citas se validaron contra el texto guardado y sus identificadores originales, no contra texto inventado por el modelo.

## Comparación con el ensayo anterior

| Aspecto | Compresión anterior | Extracción con evidencia |
| --- | --- | --- |
| Tiempo en este conjunto | 4 min 2 s | 11 min 43 s |
| Llamadas | 81 | 322 |
| Construcción final | Resúmenes y consolidaciones de IA | Todos los hallazgos verificados, composición determinista |
| Referencias | Se observaron rangos narrativos imprecisos | Identificadores válidos y citas literales comprobados por código |
| Revisión semántica | Sin segunda revisión independiente por lote | Segunda llamada al mismo modelo contra los originales |
| Cobertura | Envío completo comprobado | Envío completo y cobertura estructurada de todos los fragmentos |

La mejora tiene un coste de latencia y de llamadas. Los tiempos proceden de ejecuciones distintas del mismo día y no son una garantía de duración en producción. El ensayo previo se conserva en `QA_INFORME_GLOBAL_GEMINI_20260928.md` como evidencia histórica, no como validación del algoritmo nuevo.

## Regresión y seguridad de los contadores

- Backend: **197 pruebas aprobadas**, con las dos pruebas reales opt-in omitidas en la ejecución habitual. La prueba real de este documento pasó por separado.
- Extensión: **32 pruebas aprobadas**; comprobación de sintaxis correcta.
- Typecheck y compilación TypeScript del backend correctos.
- Prueba simulada con **20.000 tareas distintas**: se conservan todas, sin comprimirlas a un máximo global de caracteres. Este escenario denso no se ejecutó con el proveedor real.
- PostgreSQL: una cita inventada hace fallar el trabajo sin publicar ni descontar mensajes; al corregir la respuesta, el mismo trabajo se reanuda y guarda su evidencia.
- Recuperación tras interrupción, caché de pasos válidos, mensajes nuevos fuera del snapshot, aislamiento de cuentas, exclusión de adjuntos y reintentos temporales cubiertos por las regresiones.
- Una actualización completada de una referencia compartida no elimina otras tareas de esa obra. El informe muestra la última mención y conserva la secuencia completa.

## Límites que siguen existiendo

- El modelo puede equivocarse incluso con citas y un segundo pase. La auditoría es independiente en instrucciones, no en proveedor/modelo.
- Los lotes tienen contexto adyacente acotado. Referencias ambiguas a mensajes muy lejanos no acreditan una interpretación correcta; se debe revisar el original.
- No hay máximo total de mensajes configurado en este flujo, pero memoria, almacenamiento, cuotas y disponibilidad siguen siendo límites reales. No se ha ensayado volumen ilimitado ni este trabajo en el servidor productivo de 909 MiB de RAM.
- Un fragmento que no supera la verificación tras corregir y subdividir detiene la publicación y conserva pendientes. No se oculta el fallo ni se publica como completo.
- Este ensayo real usa principalmente mensajes informativos y 42 eventos de control: no representa todas las conversaciones naturales ni todas las distribuciones de tareas.
- No se han enviado conversaciones reales, mensajes de WhatsApp ni confirmaciones de lectura. No se conectó con Drive o Supabase durante el ensayo.
- No se han subido estos cambios ni desplegado producción ni publicado una nueva extensión en este trabajo.

## Evidencia reproducible

- Prueba: `backend/tests/global-summary-gemini.live.test.ts`.
- Evidencia sintética completa local: `.runtime-logs/global-summary-grounded-gemini-live-evidence.json`.
- Salida del ensayo real: `.runtime-logs/global-summary-grounded-live.log`.
- Salida de regresión: `.runtime-logs/grounded-backend-regression.log`.
- Protocolo, requisitos y comando opt-in: `docs/INFORMES_GLOBALES.md`.

El ensayo conserva el texto generado durante la ejecución; después solo se aclaró el encabezado de últimas menciones para evitar presentar una referencia compartida como estado global de una obra. Ese ajuste de presentación está cubierto por la regresión, no requiere nuevas inferencias del proveedor.
