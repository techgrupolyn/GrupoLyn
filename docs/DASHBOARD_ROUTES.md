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

## Compatibilidad

- Las llamadas API de WhatsApp, Evolution y Google Drive no cambian.
- Las cuentas, chats y archivos importados conservan su estado.
- Las pestañas `router` e `integrations` reservan el espacio para sus entregas funcionales futuras.

## Gestión de reuniones

Al seleccionar una reunión se abre un panel lateral operativo. Permite editar resumen y decisiones, añadir/editar/eliminar acciones, asignar obra, responsable y fecha, consultar la transcripción, revisar la trazabilidad y aprobar o devolver el borrador. La aprobación queda bloqueada mientras haya acciones pendientes sin responsable o fecha.
