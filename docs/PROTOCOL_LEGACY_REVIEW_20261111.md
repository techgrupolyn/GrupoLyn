# Revisión de fuentes heredadas de Protocolos (11/11/2026)

La carpeta principal `Protocolos` sigue siendo la fuente de verdad y el lugar donde se actualizan los documentos. La carpeta histórica de Club LYN se separa del corpus general: Alejandro autorizó el 11/11/2026 guardar el contenido íntegro en almacenamiento privado, sin enviarlo a Gemini, para consultas literales de Dirección y administradores.

| Fuente histórica | Decisión | Motivo |
| --- | --- | --- |
| Seis protocolos con copia idéntica en la carpeta principal | No añadir | La sincronización ya prefiere la copia principal por MD5. |
| `Protocolo_presupuestos_Grupo_LYN_FINAL (1).docx` | Aprobado por Alejandro para consulta de todos los empleados internos mediante el agente el 11/11/2026 | Describe el presupuesto aproximado y definitivo, distinto del seguimiento posterior del PPTX principal. La revisión no encontró importes de clientes. La aprobación no modifica los permisos directos del archivo en Drive. |
| `Protocolo de Interiorismo y Planimetría (1) revisión2.pptx` | Almacén privado | No se considera protocolo general aprobado; citas literales solo para Dirección y administradores. |
| `01. Manual y tips Grupo LYN-2026.docx` | Almacén privado | Contiene instrucciones técnicas y Quantifier; no pasa al modelo ni al corpus general. |
| `explicación creacion de obra en drive` y notas de reuniones de `PM` | Almacén privado si la extracción es verificable | Pueden contener personas y obras concretas; no pasan al modelo. |
| `EXCEL PRESUPUESTOS RAPIDOS.xlsx`, plantilla de partidas y cotizador de clima | Almacén privado | Cifras y datos de obras/clientes solo para Dirección y administradores. |
| `Dudas` | Almacén privado si hay texto verificable | No sustituye la hoja de reparto de obras del corpus general. |
| `Sistema de Pago y Certificaciones` | Almacén privado si la extracción es verificable | No se expone a todos los empleados sin revisión adicional. |

El único ID heredado autorizado en el corpus general es `1C9veacxQSXAcr6v3a9Zhq2mR01T7O-sL`. Para habilitar la unión, configurar `PROTOCOL_LEGACY_DRIVE_FOLDER_ID=1eFQofkx07Kfy5ZytF9XJRE3kGNhq9rrn` y `PROTOCOL_LEGACY_DRIVE_FILE_IDS=1C9veacxQSXAcr6v3a9Zhq2mR01T7O-sL`. Los demás archivos heredados compatibles se extraen a generaciones privadas, sin mezclarse con `agente_protocolos_corpus`. Una extracción incompleta, formato no soportado o PDF pendiente de visión conserva la generación privada anterior; no se debe dar por activada la importación completa hasta que el informe marque `restricted.error=null` y el inventario real se revise con Dirección.

## Verificación previa a la activación

El 11/11/2026 se comprobó con `tech@grupolyn.com` que la carpeta histórica muestra 14 archivos y una subcarpeta `PM` con tres archivos adicionales: 17 archivos en total antes de deduplicar. Esta observación en navegador no prueba que el token OAuth del servidor pueda descargarlos ni que el extractor procese todas sus hojas.

Una copia temporal descargada de Drive confirmó 17 entradas: 7 DOCX, 6 PPTX, 3 XLSX y 1 PDF. El extractor local produjo texto sin avisos en los 16 archivos Office al elevar a 5000 filas el límite de las hojas privadas; dos plantillas XLSX quedaban truncadas con el límite anterior de 500. El PDF duplicado del corpus principal necesita visión en una página y no se debe importar de nuevo al almacén privado. Esta prueba no valida aún la descarga mediante el OAuth del servidor ni los permisos de PostgreSQL.

1. Mantener la función desactivada hasta validar la sincronización integrada: no configurar `PROTOCOL_LEGACY_DRIVE_FOLDER_ID` en producción todavía.
2. En la base local `superagente_preview`, la creación de `protocol_private`, una inserción sintética y las lecturas por rol pasaron dentro de una transacción revertida. `anon` y `authenticated` no tenían `USAGE` del esquema ni `SELECT` sobre sus tablas. En producción, el usuario del backend puede crear esquemas y `protocol_private` aún no existe; esa base no tiene roles `anon` ni `authenticated`.
3. La conexión OAuth de Tech ya configurada en Lightsail devolvió HTTP 200 al leer ambas carpetas: 12 entradas de primer nivel en `Protocolos` y 15 en la carpeta histórica (incluye `PM`). Falta ejecutar la sincronización integrada con este cambio y comprobar `restricted.error=null`, deduplicación y ausencia de páginas u hojas omitidas. Si aparece un error, la generación privada anterior debe permanecer activa.
4. Consultar un cotizador y unas notas con Dirección y admin: cita literal y enlace a Drive, sin llamada a Gemini ni texto sensible en el registro. Repetir con un perfil ordinario y confirmar que no lee la tabla privada ni obtiene cifras o datos de clientes.
5. Repetir la sincronización sin cambios: el número de generaciones y el volumen de la base no deben crecer. Cambiar una copia de prueba y verificar activación atómica; simular fallo de Drive/extractor y confirmar que la versión anterior sigue activa.

La suite local de Protocolos pasa (121 pruebas; 2 omitidas) y TypeScript compila. La extracción real de los 17 archivos desde una copia de Drive se comprobó en local; el acceso OAuth del servidor a ambas carpetas y el esquema SQL en la base local también se comprobaron. Quedan pendientes la sincronización integrada con la implementación nueva y las pruebas de autorización con usuarios de Club y Superagente antes de desplegar. Las consultas de cifras de perfiles ordinarios no se envían a Gemini; una coincidencia privada solo se acepta si todos los términos relevantes están en una misma línea verificable, nunca por aparecer en filas distintas de una hoja.
