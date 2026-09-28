# Pruebas y validación

Ejecuta la validación completa desde la raíz del proyecto:

```powershell
$env:QA_TEST_DATABASE_URL = 'postgresql://postgres@127.0.0.1:55439/lyn_qa_retest'
.\scripts\test-all.ps1
```

La base debe existir en un PostgreSQL local aislado, nunca ser la de producción. La suite de integración rechaza otro host/nombre. Sin esta variable, el comando completo falla para evitar informar falsamente que se validó la persistencia. `-SkipDatabaseIntegration` permite una revisión parcial explícita. CI crea su propia `lyn_qa_retest` y activa estas pruebas.

El comando verifica, en este orden:

1. Tipos y pruebas unitarias/de rutas del backend.
2. Pruebas de componentes del dashboard y su compilación de producción.
3. Pruebas unitarias de la sincronización de la extensión y sintaxis de todos sus scripts Manifest V3.
4. Comprobaciones de publicación/CI y comportamiento de readiness con comandos simulados.
5. Generación de Prisma sin migrar Evolution, build del servicio y compatibilidad de Baileys, MinIO, Chatwoot, cron, sharp y previsualizaciones.
6. Análisis estático de los 31 archivos JS/JSX del dashboard/extensión: referencias y componentes JSX no definidos, código inalcanzable y otros errores básicos.
7. Auditorías npm de dependencias productivas de backend, frontend y Evolution.

Las pruebas automatizadas cubren autenticación CEO, rechazo de extensiones no activadas, protección de rutas sensibles, render del acceso CEO, listas y mensajes, sincronización de extensión (orden, deduplicación, actualización y límite de caché), rutas principales y construcción de solicitudes Gemini con texto, imagen, audio, vídeo y documentos.

## Alcance y límites

El backend identifica cuentas WhatsApp mediante `account_id` y vincula cada activación a una cuenta. La regresión PostgreSQL prueba que una activación no lee mensajes de otra cuenta y que el resumen individual modifica solo el contador interno del chat seleccionado, sin llamadas de lectura a WhatsApp. Esto no acredita aislamiento multiempresa completo de todos los módulos del dashboard.

Las pruebas simuladas no sustituyen una sesión real de Chrome/WhatsApp, pruebas de carga con mensajes reales ni el despliegue Linux con nginx/systemd. Una compilación correcta tampoco implica ausencia de vulnerabilidades de dependencias. Consultar `QA_CIERRE_TECNICO_20260927.md` antes de autorizar la publicación.

La cola se prueba con 1105 mensajes sintéticos, una llegada durante la generación, peticiones duplicadas, conflicto con resumen individual, caída de un proceso con advisory lock y recuperación desde PostgreSQL. Un fallo transaccional no consume mensajes. Los eventos de lectura de WhatsApp restablecen la base del contador interno.

`QA_LIVE_GEMINI=true` habilita la prueba separada `backend/tests/meeting-gemini.live.test.ts`, con datos exclusivamente sintéticos. Usa la clave ya configurada en local, puede consumir cuota y no necesita datos de producción. Su omisión por defecto se informa como omitida, nunca como aprobada.

El modo parcial también exige `DATABASE_URL` dirigida a `127.0.0.1/lyn_qa_retest`: las pruebas básicas de rutas pueden escribir fixtures. Nunca usar una base real.

Después de instalar Evolution con `--ignore-scripts`, ejecutar `node scripts/patch-minio.cjs` dentro de `evolution-api` antes de sus pruebas/build. La instalación normal ejecuta este adaptador por `postinstall`. Conserva las notificaciones de MinIO 8.0.7 al usar stream-json 3; falla si cambia esa versión y requiere revisión.
