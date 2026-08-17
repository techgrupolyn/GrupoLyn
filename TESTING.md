# Pruebas y validación

Ejecuta la validación completa desde la raíz del proyecto:

```powershell
.\scripts\test-all.ps1
```

El comando verifica, en este orden:

1. Tipos y pruebas unitarias/de rutas del backend.
2. Pruebas de componentes del dashboard y su compilación de producción.
3. Pruebas unitarias de la sincronización de la extensión y sintaxis de todos sus scripts Manifest V3.

Las pruebas automatizadas cubren autenticación CEO, rechazo de extensiones no activadas, protección de rutas sensibles, render del acceso CEO, listas y mensajes, sincronización de extensión (orden, deduplicación, actualización y límite de caché), rutas principales y construcción de solicitudes Gemini con texto, imagen, audio, vídeo y documentos.

## Límite actual de sesiones

El backend actual trabaja con una sola cuenta de Evolution configurada en `INSTANCE_NAME`. Por diseño, dos extensiones que apunten al mismo backend comparten la misma cuenta y los mismos datos. No se debe desplegar como sistema multiempresa o multicuentas hasta migrar las tablas y rutas a un identificador de cuenta/tenant y exigir una credencial de extensión por usuario.

Para instalaciones aisladas hoy, usa un backend, una base de datos y un `INSTANCE_NAME` distintos por cuenta de WhatsApp. El Dashboard CEO centralizado requerirá una fase adicional de agregación con control de acceso por tenant.