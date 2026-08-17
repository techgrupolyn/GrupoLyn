# Publicación pública en Chrome Web Store

## Artefacto de subida

Sube `extension/dist/lyn-superagente-extension.zip` desde Chrome Web Store Developer Dashboard. El ZIP ya excluye secretos, dependencias y archivos locales.

## Ficha de tienda

- **Nombre:** LYN Superagente
- **Resumen:** Asistente interno para revisar chats grupales de WhatsApp Web, sincronizar pendientes y preparar respuestas con IA.
- **Categoría:** Productividad
- **Visibilidad:** Public / Pública
- **URL de política de privacidad:** `https://ceo.grupolyn.com/privacy.html`
- **Sitio web:** `https://ceo.grupolyn.com`

### Descripción detallada

LYN Superagente ayuda a equipos autorizados de Grupo LYN a revisar chats grupales de WhatsApp Web desde un panel lateral. Sincroniza mensajes pendientes con la plataforma central, genera resúmenes y respuestas sugeridas con el especialista de IA elegido por el usuario. Cada instalación requiere un código de activación de un solo uso emitido por un administrador y queda vinculada a una cuenta de WhatsApp concreta.

La extensión opera únicamente en WhatsApp Web y se conecta por HTTPS a `ceo.grupolyn.com`. No muestra publicidad, no vende datos ni permite usarla con cuentas no autorizadas.

## Privacidad y permisos

Declara en la pestaña Privacy que la extensión trata:

- **Información personal:** nombres de contactos/grupos y números cuando no existe nombre.
- **Comunicaciones personales y contenido web:** mensajes, adjuntos, marcas de lectura y metadatos de chats grupales de WhatsApp Web.
- **Información de autenticación:** identificador de activación de la extensión.

Finalidades: funcionalidad principal, sincronización, seguridad, trazabilidad y generación de análisis/resúmenes/respuestas solicitados por el usuario. Indica que los datos se transfieren por HTTPS al servicio de Grupo LYN y, cuando se solicita IA, al proveedor Google Gemini configurado por Grupo LYN. Marca que no se venden datos ni se usan para publicidad.

## Revisión de Chrome

Antes de enviar, crea una cuenta de prueba y un código de activación temporal exclusivo para el revisor. En **Test instructions** explica:

1. Instalar la extensión y abrir sus opciones.
2. Pegar el código de prueba proporcionado de forma privada.
3. Abrir WhatsApp Web con la cuenta de prueba, pulsar el icono de la extensión y abrir el panel lateral.
4. Elegir un especialista y consultar un chat grupal de prueba.

No publiques códigos reales ni credenciales de empleados en la ficha pública.

## Material manual pendiente

Chrome Web Store exige material visual real de la extensión. Antes de enviar, captura al menos una imagen del panel lateral activado y otra de la pantalla de activación. Las capturas deben corresponder a la versión que se sube y no contener datos reales de clientes.

## Distribución a empleados

Tras aprobarse, selecciona **Public**. La ficha será visible en Chrome Web Store, pero la plataforma no permite operar sin un código de activación `LYN1` válido, de un solo uso, vinculado a una cuenta y revocable por el CEO. Comparte la URL de Chrome Web Store con cada empleado. Cada persona instala con un clic, recibe su código único, lo pega una vez y vincula su WhatsApp mediante QR. Las actualizaciones posteriores se entregan automáticamente por Chrome.