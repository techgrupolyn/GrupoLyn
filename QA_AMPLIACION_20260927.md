# Informe de ampliación y regresión local — 27/09/2026

> Actualización posterior: el dictamen global de preproducción está en `QA_PROYECTO_COMPLETO_20260927.md`. La revisión transversal encontró bloqueantes fuera del alcance de esta ampliación; este informe conserva su evidencia local histórica.

## Dictamen

Se implementó la ampliación autorizada de organigrama, escalaciones y CRM y se corrigieron los defectos restantes reproducidos en esta ejecución. Las 182 pruebas ejecutadas pasan. Esto acredita los escenarios probados, no una garantía universal de cero bugs ni una certificación del despliegue productivo.

No se modificó producción ni el origen Supabase. No se hizo commit, push ni despliegue. Los cambios previos de extensión se conservaron. Este informe sustituye el estado final del PDF anterior y complementa la bitácora `QA_REVALIDACION_20260927.md`.

## Comparación con el informe anterior

| Punto | Antes | Resultado actual y evidencia |
| --- | --- | --- |
| N-01: responsables duplicados | El primario aparecía también como adicional en las acciones de Alan. | Corregido en escritura IA, reparación idempotente de tipos antiguos y deduplicación de referencias. Test PostgreSQL y dos regresiones frontend. En la reunión A real se comprobó «Sin responsables adicionales» al expandir la acción, conservando al primario. |
| M-03: organizador | Solo selección manual fiable; no se deducía del propietario de Drive. | Calendar permite vincular por adjunto exacto o código Meet único y correo exacto de empleado activo. Se conserva la selección manual. Cuatro pruebas del resolver y una integración HTTP controlada. No se atribuye organizador si falta fecha, permiso, evento inequívoco o persona activa. No se afirma haber resuelto automáticamente el documento C vacío. |
| P-06: organigrama | Faltaban vistas operativas. | Vista global/por proyecto, cargos, dependencia jerárquica y miembros reales del directorio local. Altas y retiradas de asignaciones locales auditadas; asignaciones importadas protegidas. La sincronización conserva las altas locales. |
| P-06: escalado | No había una operación explícita. | Escalado al siguiente peldaño ocupado, con motivo, actor e historial transaccional. No equivale a aprobar. Devuelve conflicto cuando no existe siguiente etapa. Prueba de transición real en PostgreSQL. |
| P-06: CRM | Faltaban paneles funcionales. | Leads: alta/edición, estados, vínculo a cliente e historial. Clientes: ficha y proyectos/equipo asociados en lectura. Identidades: acciones de reuniones sin persona vinculada y resolución mediante asignación auditada. No es una nueva plataforma CRM omnicanal ni altera usuarios de Supabase. |
| P-06: incidencias | Sin circuito propio. | Bloqueos de reuniones visibles en Control de obra, resolución/reapertura con motivo y auditoría. El estado se refleja también en el panel lateral, tanto en lectura como edición. Se protege la revisión manual frente al reprocesado automático. |
| P-06: estética | Acentos generales azules. | Acentos generales ámbar y verdes, conservando los colores semánticos de los roles. |
| Usuarios corporativos | Faltaban sesiones reales para repetir login. | El usuario confirma que Supabase ya valida las cuentas. No se cambió esa autenticación ni se presenta esta aceptación como una prueba de login real. Los permisos de los endpoints nuevos sí se verificaron con identidades controladas. |

## Pruebas ejecutadas

- Backend: **131 aprobadas**, 12 archivos; 1 prueba optativa de Gemini real omitida en esta última ejecución. Incluye **36 integraciones HTTP/PostgreSQL** en `lyn_qa_retest` de `127.0.0.1:55439`.
- Frontend: **51 aprobadas**, 14 archivos. Incluye responsables, organizador, operaciones y coherencia de incidencias resueltas.
- `tsc --noEmit`: aprobado.
- Build Vite: aprobado; queda un aviso de tamaño de chunk `App` de **536,92 kB** sin comprimir. No es un fallo de compilación, pero merece optimización posterior.
- `git diff --check`: sin errores de whitespace; Git informa normalización LF/CRLF en Windows.
- Navegador local: organigrama con datos importados, pestaña en Configuración, ficha de cliente con proyectos, creación e historial de lead sintético, incidencias, identidades pendientes y acción de la reunión A sin duplicado del responsable.
- Se retiraron el prospecto sintético y la cuenta temporal después de cerrar sesión. No se asignaron personas reales a nuevos cargos durante las pruebas visuales.

## Límites y condiciones operativas

- La detección de organizador consulta el calendario principal de la cuenta conectada con permiso Calendar de lectura. Sin evidencia única se mantiene la alternativa manual; nunca se inventa una asignación.
- Organigrama/CRM/escalado/incidencias son administración: superadministradores y directores. Los demás conservan su acceso restringido a las reuniones autorizadas; las rutas administrativas nuevas rechazan sus peticiones con 403.
- Las identidades sin resolver de esta entrega son menciones/responsables de acciones del gestor de reuniones. Las incidencias son sus bloqueos detectados; no incluye un sistema independiente de tickets de obra.
- El escalado es una operación explícita y auditada; no se ha añadido un SLA temporal automático no especificado.
- El origen Supabase sigue siendo de solo lectura. Los datos nuevos se guardan en la base del dashboard, con auditoría, no en Supabase.
- El siguiente paso productivo requiere publicar y desplegar esta versión y comprobarla en ese entorno. Esta ejecución se mantuvo en local.
