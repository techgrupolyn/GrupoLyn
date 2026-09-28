# Rutas del Dashboard

La navegación del Dashboard separa las vistas de operación de la configuración de cada dominio. Esta reorganización es únicamente de interfaz y rutas: no altera endpoints ni datos almacenados.

## Vistas operativas

| Área | Ruta | Uso |
| --- | --- | --- |
| General | `/?view=dashboard` | Resumen ejecutivo |
| General | `/?view=ai` | Consultas a la IA |
| Agente de reuniones | `/?view=meetings` | Bandeja de revisión, acciones, bloqueos y aprobación de reuniones |
| Superagente WhatsApp | `/?view=groups`, `labels`, `templates`, `business` | Operación de WhatsApp |

## Configuración

La configuración se abre en `/?view=settings`. Si no se indica `tab`, se muestra `general`.

| Sección | Ruta |
| --- | --- |
| General | `/?view=settings&tab=general` |
| WhatsApp | `/?view=settings&tab=whatsapp` |
| Agente de reuniones / Google Drive | `/?view=settings&tab=meetings` |
| Router de agentes | `/?view=settings&tab=router` |
| Integraciones | `/?view=settings&tab=integrations` |

`/?view=meetings` muestra un aviso descartable que indica la nueva ubicación de la configuración de Google Drive. El aviso se guarda solamente en el navegador del usuario.

## Desvincular WhatsApp

En **Configuración > WhatsApp > Cuentas WhatsApp**, un desplegable permite seleccionar una sola cuenta. Su conexión se consulta en Evolution mediante `GET /api/whatsapp-accounts/:id/status`, sin caché, al seleccionar o actualizar las cuentas. Solo una cuenta conectada muestra **Desvincular**; una sesión cerrada muestra **Desvinculada**, y un QR pendiente muestra **Pendiente de vincular**. Los fallos de consulta muestran **Estado no disponible**, nunca una falsa desconexión. El formulario **Añadir una cuenta** permanece plegado por defecto.

El botón **Desvincular** solicita confirmación con el nombre e instancia y cierra únicamente esa sesión mediante `POST /api/whatsapp-accounts/:id/disconnect`. Ambos endpoints están restringidos a administradores del dashboard. No se eliminan la instancia, la cuenta, los chats, los mensajes ni los informes almacenados; tampoco se revoca la activación de la extensión. Tras confirmar la desvinculación desaparece el botón. Para reconectar se debe escanear un nuevo QR desde la extensión asociada. La etiqueta «Cuenta habilitada» describe su habilitación en el dashboard, no su conexión a WhatsApp. Si Evolution falla, se muestra el error y se permite reintentar sin anunciar una desvinculación exitosa.

## Compatibilidad

- Las rutas existentes de WhatsApp, Evolution y Google Drive se mantienen.
- Las cuentas, chats y archivos importados conservan su estado.
- Las pestañas `router` e `integrations` reservan el espacio para sus entregas funcionales futuras.

## Gestión de reuniones

Al seleccionar una reunión se abre un panel lateral operativo. Permite editar resumen y decisiones, añadir/editar/eliminar acciones, asignar obra, responsable y fecha, consultar la transcripción, revisar la trazabilidad y aprobar o devolver el borrador. La aprobación queda bloqueada mientras haya acciones pendientes sin responsable o fecha.
