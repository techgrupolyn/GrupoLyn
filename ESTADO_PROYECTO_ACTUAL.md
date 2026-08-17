# Estado del Proyecto — Superagente WhatsApp
**Fecha:** 30/07/2026
**Responsable:** Kilo / equipo técnico
**Objetivo:** Cierre honesto del estado real contra `ESTIMACION_TIEMPOS_PROYECTO.md` y `ANALISIS_PROYECTO_VS_ESPECIFICACIONES.md`.

---

## 1. Estado real verificado (producción local)

| Componente | Estado | Cumplimiento |
|---|---|---|
| **Backend API** | Corriendo en `localhost:3003`; `/health`, `/api/chats`, `/api/mensajes`, `/api/enviar`, `/api/resumen`, `/api/classify`, `/api/ai/auto-reply`, `/api/mensajes/:chatId/classify`, media proxy, SSE, webhook, **MESSAGES_UPDATE handler para ticks, endpoint /api/chats/:chatId/read para marcar como leído** | 🟢 97% |
| **Evolution API** | Instancia `lyn-local` conectada en `localhost:8080`; webhook activo con evento `MESSAGES_UPDATE`; `readMessages=true`, `readStatus=true` | 🟢 97% |
| **PostgreSQL** | Schema completo aplicado: `chats`, `mensajes` (con `estado`), `grupos`, `analisis_ia`, `roles`, `empleados`, `usuario_rol`, `chat_participantes`, `proyectos`; función idempotente | 🟢 100% |
| **Frontend Dashboard** | Corriendo en `localhost:5173`; listado chats, timeline, media, notificaciones navegador, dedup, filtro mensajes propios, badge urgencia sincronizado, panel IA con copiado, **ticks de lectura (enviado/entregado/leído) con colores correctos, marca como leído al abrir chat** | 🟢 95% |
| **CEO Dashboard** | Corriendo en `localhost:5174`; métricas, distribución por tipo, top chats, consulta IA en lenguaje natural, centro de notificaciones | 🟡 70% |
| **IA / Gemini** | `/api/classify`, `/api/resumen`, `/api/ai/auto-reply` funcionando; prompts mejorados para respuestas completas; clasificación persistida en `analisis_ia` | 🟢 70% |
| **Extensión Chrome** | Scaffolding + UI funcional contra BD; **inyección real en WA Web NO operativa** | 🔴 25% |
| **Capa de Identidad (CRUD)** | Schema creado; endpoints `/api/roles` y `/api/empleados` existen; **backoffice UI NO implementado** | 🔴 20% |
| **Importador de historiales** | No iniciado | 🔴 0% |
| **Testing & QA** | Smoke tests backend/frontend/Evolución ejecutados; **suite automatizada NO existe** | 🟡 20% |

---

## 2. Cierre de gaps conocidos

### Bloqueadores reales
1. **Extensión Chrome → inyección real en WA Web**  
   – Estado actual: scaffolding existente, pero la captura estable desde WhatsApp Web sigue bloqueada por cambios de DOM/Meta.  
   – Acción: mantener Evolution API como fuente estable de datos; posponer inyección real hasta tener 1–2 sprints de debugging específico.

2. **Capa de Identidad → backoffice operativo**  
   – Estado actual: tablas y endpoints creados, pero el dashboard no tiene pantalla de CRUD de empleados/roles.  
   – Acción: priorizar pantalla simple de alta/edición de empleado con número → rol, sin cambiar schema.

3. **Testing automatizado**  
   – Estado actual: validación manual.  
   – Acción: agregar 1 script de smoke test PowerShell + 1 suite mínima de Jest para backend (webhook + classify + resumen).

### Deuda técnica menor
4. `/api/resumen` y `/api/ai/auto-reply` ya usan modelo `pro` y prompts completos, pero falta paginación semántica para chats con +10k mensajes.
5. `NotificationSidebar` quedó bien, pero falta integrarla en `ceo-dashboard/src/App.jsx` para que el CEO vea el centro de notificaciones completo.
6. ✅ **Ticks de lectura corregidos (Jul 2026):**  
   - Se agregó `MESSAGES_UPDATE` a los eventos del webhook (antes faltaba, solo se escuchaban `MESSAGES_SET`, `MESSAGES_UPSERT`, `CHATS_SET`, `CHATS_UPSERT`, `CONNECTION_UPDATE`).  
   - Se corrigió el nombre del evento en el handler: `MESSAGE_UPDATE` → `MESSAGES_UPDATE` (plural, con S).  
   - Se habilitaron `readMessages: true` y `readStatus: true` en la configuración de Evolution API (antes `false`).  
   - Se agregaron `SERVER_ACK` y `DELIVERY_ACK` al mapeo de `normalizeStatus` (antes no se reconocían, se marcaban como 'enviado').  
   - Se agregó soporte para valores numéricos de estado (0-5) de Baileys en `resolveMessageStatus` y el handler de webhook.  
   - Se captura el ID real del mensaje de la respuesta de Evolution API en `/api/enviar` (antes se generaba un ID sintético que no coincidía).  
   - Se agregó fallback en el handler de `MESSAGES_UPDATE` para mensajes no encontrados por ID exacto (busca por `chat_id`).  
   - Se creó el endpoint `POST /api/chats/:chatId/read` para marcar mensajes como leídos.  
   - El frontend ahora llama a `/api/chats/:chatId/read` al seleccionar un chat.  
   - Se agregó `PLAYED` al mapeo de 'leido'.  
   - Resultado: los ticks ahora funcionan correctamente: ✓ (enviado, gris) → ✓✓ (entregado, gris) → ✓✓ (leído, azul #4fc3f7).

---

## 3. Actualización del MD de estimación

Se actualiza `ESTIMACION_TIEMPOS_PROYECTO.md` para reflejar el estado real verificado y reducir la estimación de items ya completados.
