# Correcciones de la segunda revisión QA

## Convención de nombrado

El valor predeterminado pasa a `Comité de obra · NOMBRE DEL PMC | Reunión cliente · NOMBRE DE LA OBRA`. Se corrigen creación de tabla, valor por defecto de la columna y fallback del análisis. Una migración idempotente actualiza únicamente el texto predeterminado antiguo; las convenciones personalizadas se conservan.

La prueba de integración comprueba la configuración devuelta por HTTP, el default SQL, la segunda ejecución sin cambios y la conservación de una convención personalizada. El backend local se reinició y la base QA ya muestra el texto corregido.

## Mis pendientes

La lista de vistas permitidas para usuarios limitados omitía `work`, aunque el menú sí mostraba el botón. Se admite esa vista y se añade a las rutas del contenedor CEO para enlaces directos y recargas, sin activar el flujo de conexión WhatsApp. La cabecera muestra «Mis pendientes».

Seis regresiones frontend recorren menú con Delineante, PMC, Interiorista y superadmin; entrada directa; acceso desde «Ver todo» de notificaciones; y apertura de una reunión desde su pendiente con marcado de notificación. Los usuarios limitados no reciben acceso al Backoffice.

## Validación

- Backend: 152 pruebas aprobadas, una prueba externa de Gemini omitida.
- Frontend: 75 pruebas aprobadas.
- Tipos backend y compilación frontend correctos.
- Correcciones activadas localmente. No se desplegó producción ni se publicaron estas correcciones adicionales en GitHub en esta ejecución.

Evidencias: `.runtime-logs/qa-two-observations-backend.log`, `qa-two-observations-frontend.log`, `qa-two-observations-build.log`.

## Aclaración posterior de bandejas personales

- Mis pendientes muestra exclusivamente tareas pendientes del usuario, como responsable principal o adicional. No mezcla revisiones ni incidencias de importación. Los directores y superadministradores vinculados a un empleado también ven sus propias tareas, no las de todo el equipo. Leer una notificación no finaliza una tarea.
- Mi turno muestra reuniones con análisis terminado, aún no aprobadas, cuya etapa y proyecto corresponden al cargo asignado al usuario. Sin persona/cargo vinculado no se presenta toda la cola como si fuera su turno. El permiso administrativo para intervenir sigue siendo independiente de la asignación personal.
- Aprobadas muestra reuniones con aprobación final dentro del alcance de acceso del usuario: los usuarios limitados solo las vinculadas; dirección y superadministración conservan la vista global autorizada. Una reunión aprobada puede seguir teniendo tareas por realizar.
- Las notificaciones mantienen los avisos de revisión, tareas e importación según sus permisos. El contador del enlace Mis pendientes cuenta únicamente avisos nuevos de tareas.
- Se evita truncar las tareas y revisiones a las primeras 250 antes de calcular la bandeja personal. Mis pendientes pagina visualmente en grupos de 25.

Nueva validación: 155 pruebas backend aprobadas (una live omitida), 77 frontend aprobadas, tipos y build correctos. Las dos cadenas completas contrastan Mi turno y Aprobadas en cada transición y al finalizar. Tres regresiones verifican tareas principales/adicionales para Interiorista, Director General y superadmin, lectura sin completar, retirada de asignaciones y tareas finalizadas. Correcciones activas solo en local, pendientes de publicación en QA.

Evidencias: `.runtime-logs/qa-personal-work-backend.log`, `qa-personal-work-frontend.log`, `qa-personal-work-build.log`.

## Aprobación para integrar

El 28/09/2026 el usuario confirmó la aprobación de QA y autorizó integrar en `main`. La validación final local acumuló 278 pruebas aprobadas y una prueba opcional de IA real omitida; backend, dashboard y Evolution compilaron. La aprobación y la integración no sustituyen la comprobación del Quality Gate remoto ni constituyen un despliegue en producción.
