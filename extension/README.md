# LYN Superagente — Extensión multi-cuenta

La misma extensión se distribuye a toda la empresa. Cada instalación queda asignada a una única cuenta de WhatsApp mediante un código emitido desde el Dashboard CEO. No configura directamente Evolution API ni selecciona instancias.

## Flujo de empleado

1. El CEO crea la cuenta en **Configuración → Cuentas WhatsApp** y genera un código para ella.
2. El empleado instala el paquete ZIP o carga esta carpeta en `chrome://extensions` con modo desarrollador.
3. Abre **Opciones**, pega el código `LYN1...` y activa la extensión una sola vez.
4. Abre el panel lateral y escanea el QR de la cuenta asignada.
5. Elige su rol predeterminado. Chats, mensajes, resúmenes y respuestas quedan aislados de otras cuentas.

La URL del backend solo admite `https://` en producción; `http://localhost` se permite únicamente para desarrollo local.

## Empaquetado

```powershell
cd extension
npm run check
npm run package
```

El artefacto queda en `extension/dist/lyn-superagente-extension.zip`. Para actualizar una instalación de desarrollo, Chrome requiere recargar la extensión desde `chrome://extensions`.

## Desarrollo y pruebas

```powershell
cd extension
npm test
npm run check
```

## Seguridad

- El código de activación se canjea una sola vez y tiene vencimiento.
- La extensión solo llama rutas explícitamente aisladas por cuenta.
- El backend valida la activación, cuenta activa y origen de los eventos en vivo.
- Las operaciones globales y administrativas pertenecen al Dashboard CEO.
