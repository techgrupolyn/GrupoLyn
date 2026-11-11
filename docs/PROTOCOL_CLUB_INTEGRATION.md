# API privada de Protocolos para Club LYN

Contrato OpenAPI: `docs/protocol-club-openapi.yaml`.

La API `/api/club/protocolos` permite que el widget de Club LYN use el agente del Superagente sin que el navegador llame al Dashboard. Esta entrega implementa el lado del agente; el proxy y el interruptor del widget pertenecen a la subtarea de Club LYN. No activa ni retira el backend antiguo por sí sola.

## Configuración

- `PROTOCOL_AGENT_ENABLED=true` mantiene activo el agente existente.
- `PROTOCOL_CLUB_ENABLED=true` habilita esta API; por defecto es `false`.
- `CROSS_SSO_CLUB_TO_AGENT_TOKEN` reutiliza la credencial privada direccional del acceso cruzado existente (al menos 32 caracteres); no se crea otra clave. No se publica como variable `VITE_`, no se envía al navegador y no se registra en logs.
- `PROTOCOL_LEGACY_DRIVE_FOLDER_ID=1eFQofkx07Kfy5ZytF9XJRE3kGNhq9rrn` añade la carpeta histórica del widget de Club y sus subcarpetas como fuente complementaria; por defecto está vacía. `Protocolos` sigue siendo la fuente principal. El ID coincide con `scripts/deploy-protocol-assistant-production.mjs` de Club LYN. Antes de configurarla, confirmar el acceso OAuth, el inventario y qué documentos pueden consultar todos los usuarios internos. La sincronización prefiere el archivo principal si coincide el MD5 o el nombre normalizado; documentos del mismo tema con nombres distintos exigen revisión manual. Conserva la versión anterior si alguna carpeta no se puede leer. Verificar el informe de sincronización y el presupuesto de tokens antes de activar el modo `agente`.
- El directorio sincronizado de Club LYN debe incluir al empleado activo. El agente verifica el UUID y obtiene su cargo del directorio, sin recibir su token de sesión ni datos personales.

Club LYN debe validar su propia sesión y rol antes de llamar a esta API. En la llamada servidor a servidor envía `Authorization: Bearer <CROSS_SSO_CLUB_TO_AGENT_TOKEN>` y `X-Club-User-Id: <UUID del usuario verificado>`. No envía JWT, nombres, email ni teléfono. El agente comprueba que `usuario_id` coincida con el UUID de la cabecera y pertenezca a un empleado activo de su directorio; nunca confía en un cargo proporcionado por el cliente. No se admite una cabecera `Origin`, de modo que no es una API del navegador. Hay límite global de 600 solicitudes por minuto y de 20 consultas por minuto por usuario.

## Contrato

`GET /api/club/protocolos/estado` devuelve `versionId`, `updatedAt`, `lastSyncedAt`, `fileCount` y `desactualizado`. Se considera desactualizado si no consta una sincronización exitosa en las últimas 24 horas.

`POST /api/club/protocolos/consultas` recibe:

```json
{
  "usuario_id": "UUID del usuario de Club",
  "conversacion_id": "UUID de la conversación",
  "pregunta": "¿Qué indica el protocolo?",
  "canal": "club_lyn",
  "contexto": [{ "author": "user", "text": "Texto de un turno anterior" }]
}
```

`contexto` es opcional y admite como máximo los tres últimos intercambios (seis turnos). El agente enmascara su texto antes de enviarlo al modelo; no lo almacena en el registro. La respuesta contiene `consulta_id`, `clasificacion`, `respuesta`, `fuentes` (documento, sección, cita y URL cuando sea un archivo de Drive), `derivacion` y `corpus` con versión, fecha y estado de actualización. Las consultas se registran con `canal=club_lyn` y la versión real del corpus.

`POST /api/club/protocolos/consultas/:id/confirmacion` recibe `{ "resuelta": false }` o `{ "resuelta": true }`. Solo el mismo usuario puede confirmar su consulta; la confirmación no se puede repetir.

El proxy de Club debe conservar el chat local durante errores, ofrecer reintento y aplicar su límite de espera de 20 segundos. No debe usar Gemini ni leer Drive cuando el interruptor esté en «agente». Durante la transición, el interruptor «antiguo» puede volver al backend previo sin cambiar el agente. No revocar credenciales ni borrar ese backend hasta que Henry apruebe el juego de 25 preguntas, se comprueben las carpetas de Drive y se valide el cambio con usuarios reales.
