# Revalidación QA — Agente de reuniones
Fecha: 27/09/2026. Base Git: `1c4fc71`, más cambios locales de esta revisión.

> **Estado vigente — ampliación local de organigrama, escalado y CRM:** 131 pruebas backend (36 integraciones incluidas) y 51 frontend aprobadas; tipos y build aprobados. N-01 corregido; M-03 incorpora detección por Calendar con alternativa manual; P-06 incorpora módulos operativos. El informe actualizado es `QA_AMPLIACION_20260927.md`. El PDF y las secciones siguientes son evidencia histórica anterior a esta ampliación, no el estado vigente. No se ha desplegado en producción. La validación de usuarios Supabase se acepta por confirmación del usuario, no por un nuevo inicio de sesión corporativo realizado por el agente.

Documento de referencia: `QA_Agente_de_Reuniones_869e4t8py_20260925.docx`, Henry Romero, 25/09/2026, referencia original `3e99002`.

## Dictamen

Las regresiones ejecutadas pasan y se corrigieron fallos adicionales que no estaban cubiertos por la compilación. **No se declara cierre total de QA ni ausencia absoluta de bugs**: falta repetir el circuito OAuth/Drive con las carpetas originales y aceptar los resultados con las cuentas reales por rol.

No se modificó producción ni Supabase, no se hizo commit, push ni despliegue. Los cambios previos de extensión se conservaron sin modificarlos en esta revisión.

## Evidencia ejecutada y comparación

| Validación | Primera revalidación local | Nueva revalidación |
| --- | --- | --- |
| Backend | 104 aprobadas | **118 aprobadas**; una prueba optativa Gemini omitida en esta ejecución |
| HTTP + PostgreSQL, incluidas en backend | 16 casos | **30 casos aprobados** |
| Frontend | 34 aprobadas | **41 aprobadas**, 13 archivos |
| Gemini real | No ejecutado | **1 prueba optativa aprobada**, respuesta en aproximadamente 6,2 s, texto sintético |
| Tipos backend | Aprobado | `tsc --noEmit` aprobado |
| Build frontend | Aprobado | Aprobado; advertencia de chunk App de 520,84 kB |
| Navegador | No ejecutado | Inspección visual del panel, registro de aviso, apertura de snapshot y selección del organizador, con fixture local sintético |
| Migración repetida | No comprobada expresamente | Aprobada contra PostgreSQL aislado, sin perder avisos ni versiones |
| Integridad de cambios | Aprobada | `git diff --check` sin errores |
| OAuth/Drive real y producción | No ejecutados | Pendientes; las pruebas Drive usan respuestas HTTP controladas |

Total de pruebas automatizadas aprobadas: **160** (118 backend + 41 frontend + 1 Gemini real separado). No equivalen a 160 escenarios manuales del documento original.

PostgreSQL 16 se ejecutó exclusivamente en `127.0.0.1:55439`, base `lyn_qa_retest`. La suite rechaza cualquier URL que no use esa base local. Se eliminan los fixtures al terminar y se desactivan los workers externos del proceso de prueba. No se utilizó la base habitual de desarrollo ni la de producción.

El ensayo de Gemini envió únicamente un texto sintético de QA. Verificó tareas sin obra/responsable, marcas temporales, información de sanitarios +5 %, decisiones, bloqueos y clasificación genérica sin PMC inventado. Una respuesta correcta no acredita todos los resultados futuros del modelo.

La revisión visual usó los componentes reales con servicios simulados en memoria y sin credenciales ni llamadas a producción. Verificó legibilidad, estado inicial sin confirmación, confirmación visible tras guardar y apertura de versiones. La persistencia se comprobó por separado en PostgreSQL, no mediante esa página visual.

## Comparación con incidencias originales

| ID | Hallazgo original | Corrección y evidencia actual | Alcance pendiente |
| --- | --- | --- | --- |
| A-01 | Guardar/aprobar/devolver genera error SQL; cadena no verificable. | Comandos 200 en PostgreSQL; eventos transaccionales; omisión de cargos vacíos; fusión de cargos consecutivos ocupados por la misma persona; devolución a la etapa realmente recorrida; copia final aprobada. | Aceptación con el organigrama y usuarios reales. |
| A-02 | Desactivar carpeta no detiene importación/análisis. | Pruebas de desactivación durante paginación, extracción y respuesta IA: no continúa importando ni persiste el resultado tardío. Worker y análisis manual comprueban carpeta/cuenta activa. Timeout HTTP de Drive de 30 s. | El proveedor puede terminar una petición ya enviada; no se promete cancelar su cómputo/facturación. Repetir con Drive real. |
| A-03 | Cuenta genérica Planos/visor asignada como responsable. | Se rechazan genéricos y IDs emitidos por el modelo sin nombre resoluble. Regresiones locales aprobadas; Gemini sintético conserva responsables desconocidos en null. | Revisar asignaciones históricas con directorio real. |
| A-04 | Título genérico se convierte en comité y Laura incorrecta queda como PMC. | Clasificación contrastada con fuente explícita y rol de PMC comprobado en directorio completo. IA controlada que inventa Laura no se acepta. Gemini real conserva MEET y PMC nulo en texto genérico. | Repetir documento original con ambas Lauras y sus proyectos reales. |
| M-01 | Se pierde tarea de comunidad por carecer de obra. | Conservación de compromisos incompletos, deduplicación corregida y `project_unresolved` para no heredar obra indebidamente. La tarea aparece también en el ensayo real de Gemini. | No se garantiza extracción perfecta para cualquier redacción. |
| M-02 | Se omite incremento del 5 % de sanitarios. | Se genera en prueba real, persiste en API y aparece en lectura/edición; frontend y navegador lo muestran. | Validar el documento original completo. |
| M-03 | Documento vacío crea borrador y no avisa. | Importación registra incidencia sin borrador ni envío a IA; llega a administradores y al organizador explícitamente vinculado. Modal permite a administración seleccionar empleado activo; usuarios ajenos no reciben la incidencia. MP4 se conserva solo como referencia. | El organizador no se deduce del propietario de Drive. Falta fuente automática fiable, si se desea evitar vínculo manual. Notificación del dashboard, no correo. |
| M-04 | 500 después de guardar, minutos vacíos = 0, historial solo textual. | Rollback probado al fallar auditoría en guardar/crear/editar/borrar/flujo. Minutos vacíos null. Nuevas versiones guardan snapshot, actor estable, rol, etapa anterior y evento de transición. Bloqueo de fila antes de mutaciones de acciones. | Las versiones antiguas sin snapshot/identidad no se reconstruyen ni se inventan. |
| M-05 | Proyecto libre o fuera de alcance del PMC. | Selección por ID y rechazo de obra ajena/texto libre. PMC global no hereda todas las obras. Ser responsable de una tarea no permite editar otra obra como PMC. | Validar asignaciones múltiples de datos reales. |
| M-06 | Configuración de nombres, cadenas y aviso insuficiente. | Configuración existente consumida; cadena cliente probada. Aviso realizado en Meet registrable con confirmación explícita, fecha, referencia y actor. | Aceptación de convenciones reales; no se afirma verificar automáticamente lo ocurrido en Meet. |
| B-01 | Diferencias en pendientes entre lista/detalle. | Contador exige ID o relación real de responsable. Además se corrigió alias SQL del proyecto que dejaba revisiones personales vacías y “Mi turno” fijo en PMC: ahora usa etapa y proyecto del usuario, probado por API. | Contrastar totales con histórico real; el feed de notificaciones conserva el límite existente de 250 elementos. |
| B-02 | Mensajes JSON/HTML crudos. | Mensajes legibles, regresiones específicas aprobadas. | Recorrido de errores con proxy real pendiente. |
| B-03 | OAuth vuelve a vista antigua. | Ruta de regreso configurada a Configuración/Reuniones, comprobada en código/pruebas existentes. | Completar OAuth real. |
| B-04 | Variables técnicas expuestas en configuración. | Mensajes de configuración en lenguaje de usuario. | Inspección de instalación incompleta real. |
| B-05 | Sin obra aparece verde. | Ámbar en tarjeta/cabecera/lectura; prueba y verificación visual. | Sin pendiente local identificado. |
| B-06 | Breadcrumb de Configuración muestra Operaciones. | Corregido el contenedor principal; build aprobado. | Aceptación en dashboard con sesión real. |

## Decisiones funcionales

- **P-01 — Fechas opcionales:** se mantiene la decisión explícita previa del usuario. Se advierte ausencia de fecha, pero no bloquea por sí sola.
- **P-02 — Aviso de grabación (decisión actualizada):** el usuario pidió **“Quitar el requisito de aviso en Meet”**. El registro permanece opcional y plegado, sin bloquear el análisis. Si se utiliza, conserva confirmación explícita, fecha, referencia y actor, sin sobrescritura. No se envían correos ni se presupone un aviso real.
- **Consecuencia de P-02:** análisis manual, automático y reencolado de PMC no requieren constancia. Se retiró el mensaje de espera de la tabla y la obligatoriedad del texto de aviso en configuración. No se crea evidencia retroactiva ni se elimina evidencia existente.
- **P-03 — Cadena cliente:** probada con configuración separada de comité.
- **P-04 — Duplicado del backoffice:** se mantiene retirado por decisión previa; fuentes/configuración permanecen disponibles.
- **P-05 — Webhook WhatsApp:** no se añadió a reuniones. No mezclar Evolution con este módulo.
- **P-06 — Cambios de producto más amplios:** organigrama/escalaciones/CRM/incidencias generales/paleta requieren concretar aceptación; no se presentan como funcionalidades nuevas terminadas.
- **P-07 — Desconectar Drive:** probado con fixtures: desactiva carpetas, evita solicitudes y conserva histórico. No se revocó ninguna cuenta real.

## Protecciones adicionales

1. Una edición humana durante la espera de Gemini no se sobrescribe: se descarta el resultado tardío y se conserva el contenido guardado.
2. `manual_revision` protege reuniones editadas/aprobadas/devueltas frente a IA, reencolado masivo y retag automático. La migración protege también registros con eventos históricos de edición.
3. La revisión de origen activo y protección de ediciones humanas se repite antes de persistir, no solo al iniciar. El aviso de Meet ya no es una condición de análisis.
4. Las mutaciones manuales ya no ejecutan un retag global ajeno a su evento.
5. Operaciones globales requieren acceso global; tener una acción asignada no amplía permisos a todo el proyecto.
6. Autor y rol se fijan dentro de la transacción y no contaminan otras conexiones.
7. Un organizador no identificado recibe tratamiento administrativo pendiente; nunca se adivina a partir del dueño de Drive.

## Reproducir

Desde backend, con PostgreSQL aislado ya iniciado:

```powershell
$env:QA_TEST_DATABASE_URL = 'postgresql://postgres@127.0.0.1:55439/lyn_qa_retest'
npm test -- --maxWorkers=2
npm run typecheck
```

Prueba externa opcional, requiere una clave Gemini válida en el entorno; envía solo el fixture sintético y puede consumir cuota:

```powershell
$env:QA_LIVE_GEMINI = 'true'
npm test -- tests/meeting-gemini.live.test.ts
Remove-Item Env:QA_LIVE_GEMINI
```

Frontend: `npm test` y `npm run build`.

La prueba PostgreSQL se omite sin `QA_TEST_DATABASE_URL`; Gemini se omite sin `QA_LIVE_GEMINI=true`. En esta sesión se invocaron los ejecutables locales con el Node incluido en Codex porque el npm del entorno no funcionaba.

## Antes de cerrar QA y desplegar

1. OAuth, importación, análisis de originales y vinculación con copia del directorio real comprobados (ver evidencia adicional abajo). Siguen pendientes las sesiones reales por rol y aceptación de las referencias sin coincidencia; la conexión por sí sola no acredita esos escenarios.
2. Confirmar la fuente del organizador si se requiere detección automática. El vínculo manual administrativo ya funciona; no sustituye esa integración.
3. Aceptar por producto las fechas opcionales y el alcance P-06.
4. Revisar el histórico sin sobrescribir revisiones humanas; no se ejecutó un reprocesamiento masivo real.
5. Verificar rotación/revocación de credenciales QA citadas en el documento (Gemini “Gemini API Key qa” y OAuth “LYN QA local”, proyecto “Agente Operativo LYN”). No se imprimieron ni revocaron secretos de producción.
6. Con respaldo y aceptación, desplegar y validar migraciones/health y flujos reales. Esta revisión permanece local.

**Conclusión:** hay evidencia nueva y correcciones concretas, no solo una compilación exitosa. Los escenarios locales ejecutados pasan; la aceptación externa pendiente está enumerada y no se oculta bajo “0 errores”.

## Evidencia adicional: OAuth y Drive reales

Ejecución del 27 de septiembre de 2026, hora de Caracas (28 de septiembre UTC). Entorno exclusivamente local, base aislada `lyn_qa_drive` en loopback, puerto 55439. Sin escritura en Google Drive, Supabase ni producción. Credenciales en archivos locales ignorados por Git; no incluidas en este informe.

- Autorización OAuth completada por el usuario con `tech@grupolyn.com`. Conexión persistida y tokens cifrados en la base local.
- Localizada la carpeta original `vvs-nyjd-dzk - 2026/09/25 09:10 GMT-05:00`, que contiene los casos A, B, C y D, las notas reales de Gemini y la grabación.
- Primera sincronización: **6 importados, 0 actualizados**. Segunda sincronización: **0 importados, 0 actualizados, 6 encontrados**. Sin duplicados.
- Extracción real: A = 1.441 caracteres; B = 349; D = 543; notas de Gemini = 29.010. Fechas detectadas: 22, 23, 24 y 25 de septiembre, respectivamente.
- Caso C vacío: 0 caracteres, error de importación persistido, sin borrador de reunión; solicitud de análisis rechazada con HTTP 409. Grabación MP4 conservada solo como referencia, sin texto ni borrador.
- Lista de reuniones: HTTP 200. Antes del cambio de decisión de P-02, se verificó HTTP 409 con `recording_notice_required`. Ese bloqueo se retiró posteriormente por petición explícita; no describe el comportamiento vigente.
- Renovación OAuth real: se venció únicamente la fecha de expiración local, se ejecutó sincronización y el backend obtuvo un nuevo token; nueva expiración futura verificada. La sincronización volvió a producir 0 importados/actualizados.
- Pausa local de carpeta: sincronización rechazada con “Carpeta de Google Drive no disponible”; los seis archivos permanecen en la base. La carpeta se dejó desactivada al finalizar estas comprobaciones.

Estas comprobaciones manuales adicionales no se suman a los 160 tests automatizados anteriores. No validan todavía los permisos con sesiones de empleados reales. No existe confirmación del aviso de Meet y **no se creó una constancia ficticia**. Tras retirar el requisito se repitieron las suites: 118 pruebas backend y 41 frontend aprobadas; typecheck y build aprobados (permanece advertencia no bloqueante de bundle mayor de 500 kB). La prueba de análisis manual demuestra éxito sin constancia, conservando el rechazo de revisiones humanas protegidas.

### Análisis de los originales tras retirar el requisito

Gemini real devolvió HTTP 200 y análisis persistido para los cuatro documentos con texto: A (4 acciones, 1 bloqueo, 5 s), B (1 acción, 6 s), D (1 acción, 3 s) y notas reales (4 acciones, 2 bloqueos, 13 s). La base conserva **cero registros de aviso**; no se simularon confirmaciones. Son tiempos observados, no garantías de latencia.

La revisión semántica detectó una incidencia adicional en A: sin coincidencia en el directorio, el enlazador descartaba la obra específica y la persistencia heredaba la etiqueta multiobra global. Se corrigió para conservar nombres explícitos sin inventar IDs y mantener sin obra las acciones ambiguas. Se añadieron dos regresiones y se repitió A con Gemini: carpintería y electricidad pertenecen a **Torre del Cura**, plano de iluminación a **Mirador 9**, y llamada a la comunidad permanece **sin obra ni responsable**. Decisión, subida de precios del 5 %, bloqueo y referencias temporales se conservan.

**Última ejecución automatizada:** 120 pruebas backend aprobadas, 1 prueba live opt-in omitida en esa suite; 41 frontend aprobadas en la ejecución previa al ajuste exclusivo de backend. Typecheck aprobado tras el ajuste. El test live sintético anterior y las llamadas reales de esta sección se contabilizan aparte, no como parte de las 161 pruebas de estas suites.

En esa primera ejecución la base OAuth aislada aún no contenía el directorio empresarial. Esa evidencia acreditaba extracción, persistencia y atribución textual, no IDs empresariales. La siguiente sección documenta la validación posterior con el directorio copiado. No se ha desplegado.

## Validación con directorio empresarial de solo lectura

Se copiaron exclusivamente mediante GET REST de Supabase **107 perfiles (79 empleados y 28 clientes), 32 proyectos, 541 asignaciones, 22 cargos y 29 asignaciones de organigrama** a la base local aislada. La segunda sincronización conservó los mismos conteos. El ejecutor bloquea métodos diferentes de GET y destinos distintos del origen configurado. No se modificaron tablas, permisos ni cuentas en Supabase.

Se repitió el análisis con Gemini y el directorio real. Se corrigieron tres problemas adicionales detectados en esa validación:

1. La referencia corta “Torre del Cura” no coincidía con “TORRE DEL CURA - JOSE MOYA”. Se admite el segmento completo anterior al separador solo cuando identifica una única obra; una abreviatura ambigua queda sin resolver y el nombre completo tiene prioridad. Regresión con nombres duplicados aprobada.
2. La vinculación determinista de acciones usaba la lista recortada para el prompt. Ahora contrasta los resultados con el directorio completo cargado, sin depender del recorte del contexto enviado a IA.
3. Una rama de la consulta del directorio podía incluir empleados inactivos con asignaciones antiguas. Se excluyen; prueba HTTP con PostgreSQL e IA controlada verifica que no se vinculan como responsables primarios ni adicionales.

### Resultado persistido de los originales

- **A, comité multiobra:** 4 acciones y 1 bloqueo. Carpintería y electricidad vinculadas al ID de Torre del Cura; plano de iluminación al ID de Mirador 9. Alan David enlazado por su ID real en las dos tareas explícitas. Comunidad conservada sin obra/responsable, con `project_unresolved = true`.
- **B, reunión semanal:** permanece `MEET`, no se convierte en comité ni se inventa un PMC. Florida 7 y Alan David enlazados por ID.
- **D, cliente:** Torre del Cura enlazada tanto en la reunión como en su acción. Jean Parra vinculado como responsable por su ID.
- **Notas reales:** análisis completado; las menciones sin coincidencia única en el directorio se mantienen sin ID. No se inventan empleados.
- Los cuatro análisis figuran completados en PostgreSQL. Se comprobaron lista, filtros, notificaciones y directorio con sesión administrativa local: HTTP 200. No hay responsables vinculados a empleados inactivos ni a la cuenta genérica Planos; cero constancias de aviso fabricadas.

**Dato de origen relevante:** Jean Parra tiene cargo global **PMT**, no PMC. Laura Garcia tiene **PMC / Proyectos** y Laura Vanegas **CFO /**. No se convierte a Jean en PMC ni se elige una Laura solo por su primer nombre. Esto exige aceptar/corregir los datos de negocio cuando se espere una asignación diferente, no alterar Supabase automáticamente.

Permanecen **6 acciones sin responsable enlazado**: dos del comité sin responsable explícito y cuatro de las notas reales sin coincidencia verificable. Un análisis completado no significa que toda referencia se pueda resolver de forma segura.

**Pruebas actuales:** 122 backend aprobadas (incluye 31 integraciones HTTP/PostgreSQL); 1 live opt-in omitida en la suite, con pruebas Gemini reales documentadas aparte. Typecheck aprobado. Frontend permanece en 41 pruebas aprobadas y build correcto de la ejecución anterior; no se cambió frontend en esta continuación.

**Pendiente de cierre:** autenticación y recorrido con director y empleado/PMC reales. Se habilitó el login corporativo en el backend local; el usuario indicó que no tiene acceso a la cuenta de QA. No se recibió ni se utilizó ninguna contraseña empresarial, y la base local no registra aún logins Supabase. Las regresiones automatizadas de permisos pasan, pero no sustituyen esa validación con sesiones reales. No se ha desplegado ni alterado producción.

## Reprueba visual final y nuevo informe comparativo

Se repitieron las suites: **122 backend + 41 frontend = 163 aprobadas**, con una prueba live optativa omitida; las 31 integraciones están incluidas en backend. Typecheck, build y `git diff --check` aprobados. Permanece aviso de bundle App de 520,72 kB y avisos Git de conversión LF/CRLF.

La interfaz real, con cuenta local temporal y los documentos/directorio originales copiados, confirma cuatro reuniones analizadas, cuatro en cadena/revisión administrativa, seis acciones sin responsable vinculado y dos reuniones sin obra única. El comité A coincide entre tabla y detalle: cuatro acciones, dos sin responsable, tres sin fecha. Se abrió el snapshot y se guardó un borrador: apareció el evento con actor y rol. Información relevante incluye sanitarios +5 % y minuto 00:10:05. La incidencia del documento vacío aparece en Mis pendientes; abrirla reduce el contador de no leídas.

**N-01, nuevo defecto abierto:** en A, la primera acción con Alan David Pizarro Pacheco muestra “Ver 1” y, al desplegar, repite al mismo responsable principal bajo “Otros responsables”. La colección comprobada contiene solo la persona primaria. Se requiere normalizar la identidad al excluir el principal de los adicionales, corregir contador/lista y verificar altas, reemplazos y bajas. No se afirma duplicación de asignaciones persistidas; causa raíz no cerrada.

**Actualización de P-04:** Configuración/Reuniones sí muestra “Últimos archivos importados” con los seis documentos de QA; es una lista informativa, no un segundo panel de aprobación. Botón Desconectar visible, sin revocar la cuenta Google real. Breadcrumb Dashboard/Configuración correcto.

Se cerró la sesión y se eliminó únicamente la cuenta temporal `qa_retest_visual` de `lyn_qa_drive`. Se conservan los datos locales de prueba y la carpeta pausada. El informe PDF compara las 16 incidencias técnicas, las siete observaciones de producto y los 16 criterios de aceptación. **Dictamen: no aprobado para cierre total**, por M-03 parcial, N-01 abierto y validaciones/alcance pendientes. Sin commit, push ni despliegue.
