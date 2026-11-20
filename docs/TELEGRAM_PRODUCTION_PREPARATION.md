# Telegram: soporte de producción desactivado

Esta entrega prepara el módulo de contexto; no despliega, no aplica SQL remoto, no activa grupos y no publica avisos. Legal y la selección de grupos reales siguen pendientes.

El receptor, el puente central y las migraciones de alcance se mantienen en `DuarCas-maker/CLUB-LYN-FINAL`, bajo `services/telegram-worker/central-production-scope.sql` y `supabase/deployments/telegram/production-scope.sql`. Deben revisarse conjuntamente; no son migraciones automáticas de este backend. La guía operativa completa está en `docs/agentes/telegram-produccion-preparacion.md` de Club.

Sin `TELEGRAM_CONTEXT_PRODUCTION_ENABLE=true`, las consultas conservan el alcance de prueba. La variable por sí sola no autoriza grupos: la función central exige autorización vigente, aviso verificado y finalidad explícita. La consulta usa `context`, los adjuntos `media` y la salida al modelo exige además `ai` antes de crear la auditoría de egreso o llamar al proveedor. La revocación bloquea las operaciones nuevas y conserva la historia.

La futura instalación requiere comparar la versión activa del servidor, un respaldo y la revisión humana del último commit. Primero se instala el SQL central revisado de Club. `node backend/telegram-configure-database.mjs --plan --production-scope` solo prepara el plan local al servidor; `--apply` es una operación administrativa posterior que no se ejecuta en esta entrega. No se añade ninguna variable a la configuración del servidor ni ninguna autorización real.

Para revertir una futura habilitación: desactivar las autorizaciones centrales, retirar el flag y la política `telegram_context_backend_production_targets`, restaurar los archivos e imagen respaldados y verificar el alcance de prueba. No borrar mensajes ni retroceder offsets. Los scripts de reversión y la secuencia del receptor pertenecen a la entrega coordinada de Club.

Las pruebas `telegram-production-routes.test.ts` usan un servidor efímero en loopback y un modelo simulado. Verifican la separación de consulta e IA, revocación y política de acceso. No contactan Telegram, una base remota ni un proveedor de IA. El Quality Gate conserva los controles habituales y añade estas regresiones.
