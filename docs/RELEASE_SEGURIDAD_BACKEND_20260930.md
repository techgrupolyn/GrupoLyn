# Dependencias de seguridad del backend

## Alcance

- `engine.io`: 6.6.9 → 6.6.10, compatible con el rango de Socket.IO 4.8.3. Corrige el rechazo de revisiones de protocolo incompatibles durante la actualización WebSocket: https://github.com/advisories/GHSA-2gc4-cqfq-p2gv.
- `ip-address`: 10.3.1 → 10.7.2, compatible con express-rate-limit 8.6.1. Incluye correcciones de clasificación y comparación de direcciones: https://github.com/advisories/GHSA-j6r3-76f7-8jcv.
- Solo se actualiza el lock del backend; no se añaden overrides ni dependencias directas. El lock conserva `base64id` para Socket.IO, pero Engine.IO ya no depende de él.
- No cambia el ZIP de extensión 1.1.9, ni se recompila Evolution.

## Validación local

- Instalación limpia del backend y TypeScript aprobados.
- Backend: 254 pruebas aprobadas, 2 pruebas externas opcionales omitidas, PostgreSQL QA aislado.
- Cuatro regresiones nuevas: rechazo WebSocket con EIO incompatible u omitido sin detener el servidor, detección link-local y separación de familias IP.
- Scripts: 21 pruebas aprobadas; sintaxis Bash validada.
- `npm audit --omit=dev --json`: cero vulnerabilidades notificadas al validar esta revisión.
- Instalación adicional aislada con `npm ci --omit=dev`, verificación de versiones y carga de Socket.IO, pg y tsx aprobadas.
- No se enviaron conversaciones a Gemini ni se modificó producción durante estas pruebas. La auditoría no garantiza ausencia de vulnerabilidades desconocidas.

## Despliegue

Usar `deploy/scripts/deploy-global-summary.sh COMMIT_APROBADO backend-deps`. El modo `backend` anterior rechaza correctamente cambios del lock: no sirve para esta actualización.

El nuevo modo exige que no cambien `backend/package.json`, Evolution ni frontend respecto al servidor. Verifica el respaldo de código, configuración y bases; instala dependencias de producción en staging y comprueba las versiones contra el lock aprobado antes de detener el backend. Conserva el `node_modules` anterior en `backend-node_modules-before` dentro del respaldo y sustituye las dependencias con el backend detenido. Después reinicia solo el backend y comprueba readiness, esquema y salud pública.

Un fallo de instalación detiene el despliegue antes de actualizar código o parar servicios. Un fallo al mover las nuevas dependencias intenta restaurar las anteriores y arrancar el backend. Si falla readiness después del cambio, se conserva el respaldo y se detiene el script: no hay rollback automático de código, dependencias ni datos en ese caso. Revisar el registro antes de reintentar; nunca restaurar una base antigua automáticamente porque podría perder mensajes nuevos.

Tras publicar, verificar Quality Gate del commit exacto antes del despliegue. El éxito local no certifica el despliegue: deben terminar el servicio de actualización con `ExecMainStatus=0`, el control de salud y una prueba funcional del informe y su contador en producción.
