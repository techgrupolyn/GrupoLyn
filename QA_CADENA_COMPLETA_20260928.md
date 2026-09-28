# Validación local de la cadena completa de reuniones

Fecha: 28 de septiembre de 2026. Alcance: aplicación local y base sintética `lyn_qa_retest`, exclusivamente en `127.0.0.1:55439`.

## Resultado

Las dos cadenas completas pasan: comité de obra y reunión con cliente. Se crearon cuatro usuarios distintos para cada escenario, con cargos y asignaciones al proyecto: Delineante, PMC/Jefe de Proyectos, Dirección de Operaciones y Director General. Se usaron sesiones firmadas sintéticas que recorren los middleware reales y endpoints HTTP de la aplicación, con persistencia en PostgreSQL. Esto no es una prueba de login de ocho usuarios en Supabase ni un recorrido manual en ocho navegadores.

No se modificaron usuarios ni credenciales en Supabase. Los ocho usuarios, sus empleados, proyectos, reuniones y asignaciones temporales se retiraron al terminar. Consulta posterior: cero usuarios, empleados o proyectos con el prefijo de este ensayo. Se restauró la configuración original de ambas cadenas.

## Escenarios verificados en ambos tipos de reunión

| Operación | Resultado |
| --- | --- |
| Aprobar una acción sin responsable | HTTP 409, no avanza. |
| Guardar el borrador inicial con responsable y sin fecha | HTTP 200, entra en Delineante; fechas opcionales según decisión de producto. |
| Intentar aprobar desde PMC durante el turno del Delineante | HTTP 403. |
| Editar la acción como Delineante | Persistencia y evento de auditoría. |
| Avanzar Delineante → PMC → Operaciones | HTTP 200 en cada etapa. |
| Volver a aprobar con el usuario del turno anterior | HTTP 403. |
| Devolver desde Operaciones a PMC | Se conserva motivo y estado devuelto. |
| Guardar desde PMC tras la devolución | Conserva la etapa sin aprobar. |
| Avanzar PMC → Operaciones → Director General | HTTP 200 en cada etapa. |
| Aprobar como Director General | Estado aprobado, fecha y nombre del aprobador persistidos. |
| Notificaciones personales | Solo el usuario del turno recibe la revisión; desaparece tras aprobación final. |
| Auditoría y contenido histórico | Nueve versiones por escenario, con identidad estable, cargo/rol, snapshot de reunión/acciones y evento de devolución. |

La suite existente también comprueba omisión de cargos vacíos, fusión de cargos consecutivos ocupados por una misma persona, devolución a la etapa realmente recorrida, aislamiento por proyecto y reversión transaccional si falla la auditoría.

## Regresión final de esta ejecución

- Backend: 151 pruebas aprobadas; una prueba externa optativa de Gemini omitida.
- Frontend: 69 pruebas aprobadas y compilación de producción correcta.
- Extensión: 30 pruebas aprobadas.
- Seguridad de publicación, compatibilidad y lotes de webhook: 16 pruebas aprobadas.
- Total ejecutado: 266 pruebas aprobadas, una omitida.
- Tipos backend correctos; análisis estático de 31 archivos sin errores.

Evidencia local ignorada por Git: `.runtime-logs/qa-full-chain.log`, `qa-chain-frontend.log`, `qa-chain-build.log`, `qa-chain-extension.log` y `qa-chain-release.log`.

## Credenciales y decisión de despliegue

La revocación remota de credenciales QA todavía NO está acreditada. Google Cloud requiere inicio de sesión y el usuario gestiona ese acceso desde Chrome. Se solicitó eliminar únicamente la clave identificada como `Gemini API Key qa` y confirmar que el cliente `LYN QA local` es exclusivo de QA antes de retirar sus secretos. No se han borrado claves de uso incierto ni se ha confundido eliminar un archivo local con revocar una credencial en Google.

La cadena queda validada localmente. El candidato puede prepararse para un despliegue controlado, pero no se declara terminada la retirada de credenciales ni comprobada producción. No se hizo commit, push, despliegue ni respaldo productivo en esta ejecución.
