# Estimación de Tiempos — Copiloto IA Híbrido para WhatsApp (Club LYN)

**Fecha:** 24 de Julio de 2026
**Versión del documento:** 3.0 — post Revisión de Sprint 24/07/2026
**Versión de especificación:** 2.1 — Arquitectura Híbrida Descentralizada + Capa de Identidad y Contexto
**Estado Actual:** Backend + Dashboard operativo funcionales. Dashboard CEO operativo con consultas IA. Extensión Chrome funcional contra BD (inyección real en WA Web pendiente). Media resuelto vía Evolution.
**Ubicación:** `c:\Users\albin\Projects\superagente-whatsapp`

---

## 0. CHANGELOG vs. Versión 2.0 (23/07/2026)

> Esta sección existe para que el equipo identifique en 2 minutos qué cambió respecto al documento anterior. Fuente única: *Revisión de Sprint 24/07/2026*.

### 0.1 Requisitos NUEVOS (no existían en v2.0)

| # | Cambio | Impacto | Fuente |
|---|--------|---------|--------|
| N1 | **Backoffice de usuarios/empleados** en el dashboard: alta de empleado con nombre, teléfono, rol y empresa. | Nuevo módulo CRUD + schema. +14 h | (01:04:02) (01:05:16) |
| N2 | **Mapeo teléfono → rol** para control de acceso a la extensión. Cada número habilitado ve solo su rol. | Bloquea el sistema de alertas. Requiere input de Alex. +8 h | (00:55:22) |
| N3 | **Desacople rol-de-persona vs. rol-de-respuesta.** El rol laboral (para notificar) es independiente del especialista IA con que se redacta la respuesta. | Cambio de modelo de datos. Antes se asumía 1:1. +6 h | (00:56:29) (00:58:55) |
| N4 | **Detección automática de cliente vs. empleado.** Número presente en grupo y ausente del registro de empleados ⇒ cliente. | Nueva lógica de clasificación. +6 h | (01:04:02) (01:06:29) |
| N5 | **Estandarización y parseo de nombres de grupo** con delimitador ` - ` → `<Proyecto> - Obra` (interno) / `<Proyecto> - Proyecto` (con cliente). | Extractor de contexto de proyecto. +8 h | (01:02:52) (01:04:02) |
| N6 | **Registro de participantes por mensaje/chat** (qué `user_id` tuvo visibilidad de cada mensaje) en lugar de solo remitente. | Cambio de schema: tabla puente. +8 h | (01:01:35) (01:20:09) |
| N7 | **Importador de historiales exportados de WhatsApp** (.zip/.txt nativo, carga manual por integrante). | Nuevo módulo de ingesta. +16 h | (01:09:22) (01:10:39) |
| N8 | **Resumen adaptable al rango disponible.** Si se pide "últimos 7 días" y no hay data, degradar al rango real en lugar de devolver vacío. | Bug funcional detectado en demo. +3 h | (01:17:51) |
| N9 | **Manual de onboarding de equipo** (registro obligatorio del número antes de usar WhatsApp corporativo). | Entregable de documentación. +4 h | (01:05:16) |
| N10 | **Campo `empresa` / franquicia** en el modelo de identidad, para segmentación futura por punto. | Solo el campo en el schema. Lógica de segmentación es fase 2. +2 h | (00:54:13) |

### 0.2 Requisitos MODIFICADOS

| # | Antes (v2.0) | Ahora (v3.0) | Fuente |
|---|--------------|--------------|--------|
| M1 | "Sistema de alertas visuales por rol" dentro del MVP (6 h). | **Clasificación de urgencia SÍ en MVP. Entrega de notificaciones (push/Firebase) fuera del MVP → Fase 2.** | (01:18:43) |
| M2 | Notificar a todos los roles según urgencia. | **NO notificar al Director/CEO.** Destinatarios: planimetrista, interiorista y administración/contabilidad. | (01:00:17) |
| M3 | Roles definidos: genérico. | **Roles cerrados: Director/CEO, Planimetrista, Interiorista, Administración/Contabilidad, Comercial. `Legal` NO es un usuario — es un especialista de respuesta.** | (00:55:22) (00:56:29) |
| M4 | Extensión Chrome como camino único descrito en el PDF. | **Enfoque dual confirmado y aprobado: Extensión Chrome + Evolution API.** Se mantienen ambas líneas; la extensión es la UX preferida, Evolution es el proveedor de datos estable. | (01:12:44) (01:13:42) (01:16:46) |
| M5 | Dashboard CEO 5% de avance. | **Dashboard CEO operativo:** métricas de volumen, distribución por tipo, chats más activos, consulta en lenguaje natural funcionando end-to-end. ~60%. | (01:07:45) (01:09:22) |

### 0.3 Requisitos DIFERIDOS (Out-of-scope del MVP)

| # | Elemento | Motivo | Fuente |
|---|----------|--------|--------|
| D1 | Notificaciones push / Firebase Cloud Messaging | Priorizar captura y almacenamiento estable de datos | (01:18:43) |
| D2 | Segmentación por franquicia / multi-empresa | La franquicia aún no existe operativamente | (00:54:13) |
| D3 | Acoplamiento con el **módulo de reuniones** (canal voz) | Se integrará a nivel de BD centralizada cuando ese módulo arranque | (00:54:13) |
| D4 | Unificación con canales correo y llamadas | Fase posterior del "cerebro único" | (00:54:13) |
| D5 | Mezcla de especialistas IA (ej. respuesta interiorista con tono legal) | Alex descartó por complejidad: "unos X roles y ya está" | (00:57:48) |
| D6 | Descifrado automático de multimedia de exportaciones históricas | La importación de texto es suficiente para el MVP | (01:09:22) |

---

## 1. Estado Real del Proyecto (Contrastado contra Especificación)

| Módulo | Estado Actual | Cumplimiento |
|--------|--------------|--------------|
| **Evolution API** | Instancia `lyn-local` conectada en `localhost:8080`; webhook activo hacia backend | 🟢 95% |
| **Backend Node/Express + TS** | Escuchando en `localhost:3003`; webhook, SSE, deduplicación, sync, media proxy, classify, resumen, auto-reply y notificaciones funcionando | 🟢 90% |
| **PostgreSQL** | Schema completo aplicado (`chats`, `mensajes`, `grupos`, `analisis_ia`, `roles`, `empleados`, `usuario_rol`, `chat_participantes`, `proyectos`); función idempotente activa; constraint única en `analisis_ia.mensaje_id` | 🟢 100% |
| **Integración Evolution API** | `evolutionFetch` tipada, manejo de eventos, retry, nombres y medios normalizados | 🟢 100% |
| **Frontend Dashboard Operativo** | React + Vite + Tailwind en `localhost:5173`; dark-mode, listado de chats, timeline, render multimedia, notificaciones navegador, dedup, filtro de mensajes propios, badge urgencia sincronizado, panel IA con copiado | 🟢 85% |
| **Dashboard CEO** | Panel en `localhost:5174`; métricas, distribución por tipo, top chats, consulta IA en lenguaje natural, centro de notificaciones | 🟡 70% |
| **Gemini IA** | `/api/classify`, `/api/resumen`, `/api/ai/auto-reply` operativos; respuestas completas con modelo `pro`; clasificación persistida en `analisis_ia` | 🟢 70% |
| **Extensión Chrome** | Scaffolding + UI funcional contra BD; inyección real en WA Web no operativa | 🔴 25% |
| **Capa de Identidad (CRUD)** | Schema y endpoints `/api/roles`, `/api/empleados`, `/api/auth/authorize` creados; backoffice UI no implementado | 🔴 25% |
| **Importador de historiales** | No iniciado | 🔴 0% |
| **Testing & QA** | Smoke tests backend/frontend/Evolution ejecutados; suite automatizada no existe | 🟡 20% |

**Lectura ejecutiva:** el sistema está operativo end-to-end para el flujo principal: mensajes → BD → clasificación → resumen IA → notificaciones → dashboard. Los dos frentes críticos restantes son (a) la **capa de identidad operativa** (CRUD UI + control acceso teléfono→rol) y (b) la **captura estable desde WhatsApp Web** en la extensión.

---

## 2. Hitos Ya Alcanzados

1. Evolution API inicializada con instancia `lyn-local` y webhook `http://localhost:3003/webhook/evolution`.
2. Backend TypeScript tipado, con errores propagados como `Error`.
3. Ingesta y deduplicación con `insert_mensaje_idempotente` y sincronización incremental.
4. Frontend con listado de chats, avatares, nombres amigables, timeline y render de `image/video/audio/ptt/sticker/document`.
5. Estilos oscuros minimalistas alineados al design system (`#0D0D0D`, `#141414`, `#2E2E2E`).
6. Media backend funcionando: proxy, base64 y detección de tipo.
7. Clasificación y resumen IA operativos (`/api/classify`, `/api/resumen`, `/api/ai/auto-reply`) con respuestas completas.
8. Notificaciones flotantes y badge “Urgente” sincronizado desde `/api/chats`.
9. Filtro de mensajes propios y deduplicación compuesta en SSE y polling.
10. Extensión Chrome: scaffolding + UI funcional contra BD; inyección real en WA Web postergada por bloqueo de Meta.
11. **[NUEVO 30/07]** Dashboard CEO operativo con centro de notificaciones y panel IA mejorado.
12. **[NUEVO 30/07]** Schema completo aplicado con constraint única en `analisis_ia.mensaje_id`; `schema.sql` y `start.bat` listos para instalación desde cero.

---

## 3. Trabajo Restante por Módulo

### 3.1 Backend (14 h)

| Tarea | Tiempo | Origen |
|-------|--------|--------|
| Endpoint de rango adaptable para resúmenes (`/api/resumen`) | 3 h | **N8** |
| Normalizar salida IA y logging estructurado en endpoints críticos | 3 h | v2.0 |
| CRUD backoffice de identidad (empleados/roles/proyectos) | 8 h | **N1, N2, N3** |

### 3.2 Capa de Identidad y Contexto — MÓDULO NUEVO (24 h)

| Tarea | Tiempo | Origen |
|-------|--------|--------|
| CRUD backoffice de empleados en UI (alta, edición, baja, asignación de rol y empresa) | 14 h | **N1** |
| Control de acceso teléfono → rol en el dashboard operativo | 6 h | **N2** |
| Parser de nombres de grupo con delimitador ` - ` y extracción de proyecto/contexto | 4 h | **N5** |

### 3.3 Frontend / Extensión Chrome (22 h)

| Tarea | Tiempo | Origen |
|-------|--------|--------|
| Captura real desde WA Web (`data-id`/`@g.us`) — **BLOQUEANTE ACTIVO** | 14 h | v2.0 |
| Human-in-the-Loop (borrador asistido + selector de inserción) | 8 h | v2.0 |

### 3.4 Dashboard CEO (8 h)

| Tarea | Tiempo | Origen |
|-------|--------|--------|
| Historial de consultas IA y filtros adicionales | 5 h | D3 |
| Campo empresa/franquicia en UI existente | 3 h | **N10** |

### 3.5 Importador de Historiales — MÓDULO NUEVO (16 h)

| Tarea | Tiempo | Origen |
|-------|--------|--------|
| Parser del formato nativo `_chat.txt` de WhatsApp (multi-idioma, multiplataforma) | 8 h | **N7** |
| Ingesta con deduplicación contra mensajes ya capturados | 5 h | **N7** |
| UI de carga y reporte de resultado de importación | 3 h | **N7** |

### 3.6 Testing, QA y Documentación (18 h)

| Tarea | Tiempo | Origen |
|-------|--------|--------|
| Suite automatizada de smoke tests (backend + frontend + Evolution) | 8 h | v2.0 |
| Manual de onboarding de equipo (registro obligatorio del número) | 4 h | **N9** |
| Pruebas de integración IA (roles, resúmenes, costos) y ajuste de prompts | 6 h | v2.0 |

---

## 4. Cronograma Acotado a lo Real

### Estado actual (30/07)
- Backend + Evolution + Frontend operativos.
- IA funcional: classify, resumen, auto-reply.
- Schema de identidad creado, pero **sin UI**.
- Extensión Chrome con scaffolding; **inyección real en WA Web bloqueada por Meta**.

### Próximas ventanas sugeridas

#### Ventana A — Cierre MVP operativo (5 días)
- Día 1: CRUD backoffice identidad (backend + UI simple).
- Día 2: Control acceso teléfono → rol y filtrado por rol.
- Día 3: Rango adaptable en `/api/resumen` y ajuste de prompts IA.
- Día 4: Smoke tests automatizados y documentación.
- Día 5: Pulido UI/UX y verificación E2E.

#### Ventana B — Features avanzadas (10 días)
- Día 6-8: Importador de historiales (`_chat.txt`).
- Día 9-10: Parser de nombres de grupo.
- Día 11-14: Extensión Chrome: captura real WA Web + HITL.

> Nota: si la captura estable desde WA Web no se resuelve en 14 horas, mantener Evolution API como fuente principal y no reinvertir en extensión hasta tener evidencia de estabilidad.

---

## 5. Costo Actualizado

| Módulo | Horas | Costo Mín ($50/h) | Costo Máx ($80/h) | Estado |
|--------|-------|-------------------|-------------------|--------|
| Backend | 14 h | $700 | $1.120 | 🟢 En avance |
| **Capa de Identidad y Contexto** | **24 h** | **$1.200** | **$1.920** | 🔴 Pendiente UI |
| Dashboard CEO | 8 h | $400 | $640 | 🟡 Mejoras menores |
| **Importador de historiales** | **16 h** | **$800** | **$1.280** | 🔴 No iniciado |
| Integración Gemini | 0 h | $0 | $0 | 🟢 Operativo |
| Testing, QA y Documentación | 18 h | $900 | $1.440 | 🟡 Parcial |
| **TOTAL** | **80 h** | **$4.000** | **$6.400** | **Pendiente** |

**Notas:**
- Las horas backend se redujeron porque la mayoría del endpoint y schema ya existe.
- La **capa de identidad** sigue siendo el bloqueo principal porque sin UI no hay forma de asignar roles en producción.
- **Extensión Chrome** queda como contingencia: si la captura desde WA Web no se estabiliza en 14 h de debugging, se mantiene Evolution API como fuente oficial y no se invierte más tiempo en la extensión hasta nueva orden.
- El costo anterior de **152 h** correspondía al plan completo original; el estado real verificado indica que el **cierre del MVP operativo ronda las 80 h**.

---

## 6. Checklist de Completación (Revisado)

### Backend Operativo
- [x] Webhook MESSAGES_UPSERT + deduplicación
- [x] Sync historial y SSE
- [x] Nombres amigables y backfill desde mensajes
- [x] Endpoints de chats/mensajes y envío de texto
- [x] Media backend delegando a Evolution
- [x] Schema de identidad creado en BD (`empleados`, `roles`, `usuario_rol`, `chat_participantes`, `proyectos`)
- [x] `/api/classify`, `/api/resumen`, `/api/ai/auto-reply`
- [x] `/api/mensajes/:chatId/classify` con constraint única
- [ ] Rango adaptable en `/api/resumen`
- [ ] Suite automatizada de smoke tests

### Capa de Identidad
- [x] Schema y endpoints básicos creados
- [ ] Backoffice CRUD de empleados en UI
- [ ] Control acceso teléfono → rol en dashboard
- [ ] Parser de nombres de grupo (`<Proyecto> - Obra` / `- Proyecto`)

### Frontend / Dashboard
- [x] Dashboard operativo funcional
- [x] Panel IA con copiado y scroll
- [x] Notificaciones y badge urgencia sincronizado
- [x] CEO Dashboard operativo
- [ ] Backoffice usuarios en UI
- [ ] Importador de historiales

### Extensión Chrome
- [x] Scaffolding + UI funcional contra BD
- [ ] Captura real desde WA Web

### Criterio de cierre MVP
El MVP se considera cerrado cuando:
1. Un empleado puede loguearse por número y ver solo sus chats/roles.
2. Los resúmenes y respuestas IA se generan completos y sin cortes.
3. El dashboard operativo y el CEO están estables sin logs de debug.
4. Evolution API es la fuente estable de mensajes y la extensión es opcional.

---

## 7. Riesgos y Supuestos Actualizados

| # | Riesgo | Severidad | Mitigación |
|---|--------|-----------|------------|
| R1 | **WhatsApp bloquea activamente la extracción de datos.** Reconocido explícitamente en sesión: el riesgo es pequeño pero permanente y no se elimina con buenas prácticas de desarrollo. | 🔴 Alta | Enfoque dual aprobado: extensión + Evolution API. Si la extensión cae, Evolution sostiene la captura. |
| R2 | **Cambios en el DOM de Meta** rompen los selectores de la extensión. | 🟠 Media | MutationObserver + selectores semánticos + fallbacks. Presupuestadas 8 h de debugging recurrente. |
| R3 | **Dependencia de input humano:** el mapeo teléfono → rol depende de Alex; la estandarización de nombres de grupo depende de disciplina del equipo. | 🟠 Media | Bloquea Semana 1 y 2. Escalar si no llega a tiempo. El parser debe degradar con elegancia ante nombres no estandarizados. |
| R4 | **Ausencia de historial previo a la conexión** limita el valor de la IA en el arranque. | 🟡 Baja | Importador de historiales (N7). Requiere exportación manual por cada integrante. |
| R5 | **Coste de tokens en el flujo caliente** con contexto creciente por sesión. | 🟠 Media | Paginación semántica, contexto híbrido, uso de Flash para clasificación y Pro solo para resúmenes. |
| R6 | **PII en el flujo hacia la API de IA:** los mensajes contienen datos de clientes, presupuestos y contactos. | 🔴 Alta | **Pendiente de definir.** Requiere enmascaramiento de teléfonos/emails antes de enviar contexto a Gemini, o acuerdo formal de tratamiento de datos. No se discutió en la reunión — se levanta aquí como deuda de compliance. |
| R7 | **Duplicación de esfuerzo extensión vs. dashboard.** Cuestionado en sesión si la extensión "sale a cuenta". | 🟡 Baja | Decisión tomada: se mantienen ambas vías. Revisar en el sprint del 22/08 con criterio de corte explícito. |

---

## 8. Siguientes Pasos Recomendados

1. **[Bloqueante] Solicitar a Alex el mapeo teléfono → rol** de los 5 roles definidos. Sin esto, la Semana 1 se ejecuta a ciegas.
2. **Comunicar y aplicar la convención de nombres de grupo** (`<Proyecto> - Obra` / `<Proyecto> - Proyecto`) antes de construir el parser.
3. **Diseñar el schema de identidad completo** antes de escribir código de CRUD — es el cambio de mayor blast radius del sprint.
4. **Resolver o timeboxear el bloqueo de captura desde WA Web.** Si en 14 h no hay captura estable, activar el escenario reducido de la Sección 5.
5. **Levantar la decisión de PII (R6)** con Dirección antes de escalar el volumen de mensajes enviados a Gemini.
6. Cada integrante exporta su historial de WhatsApp para alimentar el importador.

---

_Documento actualizado el 24/07/2026 a partir de la Revisión de Sprint del 24/07/2026 (notas Gemini + transcripción completa). Todos los cambios llevan referencia de timestamp a la fuente._
