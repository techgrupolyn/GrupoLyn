# Netelip en local: hacer y recibir llamadas con Linphone

Guía para QA. Sirve para probar en un portátil el flujo completo de [NETELIP_LLAMADAS.md](NETELIP_LLAMADAS.md):

1. aviso;
2. grabación;
3. conexión;
4. transcripción;
5. **Netelip › Historial de llamadas**.

Linphone hace de teléfono de la extensión.

```text
 Móvil de prueba ──► número de Netelip ──► API Voice ──► túnel HTTPS ──► backend local :3003
                                              │                          (/webhook/netelip/<token>/control)
                                              ▼
                                 extensión SIP ◄──► Linphone (portátil del QA)
```

Netelip no puede llamar a `localhost`. El backend se publica con un **túnel HTTPS** (Cloudflare Tunnel) y esa URL se configura en el panel de API Voice.

> **Una sola URL de control por cuenta.** Mientras el panel de API Voice apunte a tu túnel, todas las llamadas de las rutas que pasan por API Voice llegan a **tu** portátil. Si apagas el backend o el túnel, **esas líneas no pueden llamar**. Coordina con desarrollo antes de cambiar el panel y devuélvelo a su valor al terminar (ver [Al terminar](#al-terminar)).

## Qué necesitas

| Qué | Para qué | Quién lo da |
|---|---|---|
| Repo funcionando en local (PostgreSQL, backend, frontend) | Ver [README.md](../README.md) | — |
| Usuario del Dashboard con rol `superadmin`, `admin` o director | Ver la sección Historial de llamadas | Desarrollo |
| **Extensión SIP de Netelip** de prueba (número, usuario, contraseña y dominio/servidor SIP) | Registrar Linphone | Desarrollo / panel de Netelip |
| Acceso al **panel de Netelip › API Voice** (o alguien que lo cambie por ti) | Apuntar la URL de control a tu túnel | Desarrollo |
| Número de Netelip enrutado a API Voice | Llamadas entrantes | Desarrollo |
| Un móvil | Hacer de cliente | QA |
| [Linphone](https://www.linphone.org/) (escritorio o móvil) | Teléfono de la extensión | QA |
| `cloudflared` | Túnel HTTPS | QA |
| Python 3.10+ y `ffmpeg` (opcional) | Transcribir con Whisper en local | QA |

Instalación en macOS:

```bash
brew install cloudflared ffmpeg
brew install --cask linphone
```

En Windows: instaladores de [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), [Linphone](https://www.linphone.org/) y [ffmpeg](https://ffmpeg.org/download.html), con `ffmpeg` en el `PATH`.

## 1. Configurar Linphone con la extensión

1. Abrir Linphone y elegir **Usar una cuenta SIP**. No usar «Crear cuenta Linphone».
2. Rellenar con los datos de la extensión de prueba:

   | Campo | Valor |
   |---|---|
   | Nombre de usuario | Usuario SIP de la extensión |
   | Contraseña | Contraseña SIP de la extensión |
   | Dominio | Servidor SIP que indica el panel de Netelip para la extensión |
   | Transporte | `UDP`, salvo que el panel indique otro |
   | Nombre visible | Libre, p. ej. `QA LYN` |

3. Comprobar que la cuenta aparece **conectada** (indicador verde). Si no:
   - revisar usuario, contraseña y dominio;
   - probar con otra red: algunas redes de oficina o de invitados bloquean SIP/UDP.
4. En **Preferencias › Audio**, elegir el micrófono y los auriculares correctos y probar el micrófono.
5. Anotar el **número de la extensión** (p. ej. `113`). Se usa en `NETELIP_CONTROL_DEFAULT_EXTENSION`.

> Una extensión solo puede estar registrada en un dispositivo a la vez. Si la tiene otro teléfono, pide una extensión propia para QA.

## 2. Levantar el túnel

Con el backend en el puerto 3003:

```bash
cloudflared tunnel --url http://localhost:3003
```

Copia la URL que imprime, del tipo `https://<algo>.trycloudflare.com`. **Cambia cada vez que se arranca el túnel**: si lo reinicias, hay que actualizar el panel de Netelip y `NETELIP_AVISO_ANNOUNCE`.

Deja esta terminal abierta durante toda la prueba.

## 3. Variables del backend

Añade este bloque a `backend/.env`. El fichero no se sube a git.

```bash
# Netelip (pruebas locales)
NETELIP_WEBHOOK_TOKEN=<openssl rand -hex 24>     # propio de tu máquina, nunca el de producción
NETELIP_TRUSTED_NETWORKS=185.8.244.0/24,192.99.91.144/29

# Aviso que oye quien llama (entrantes) y locución para salientes
NETELIP_AVISO_TEXT=Esta llamada puede ser grabada y transcrita. Si no está de acuerdo, cuelgue.
NETELIP_AVISO_VOICE=Silvia
NETELIP_AVISO_FILE=/ruta/absoluta/al/repo/backend/netelip/aviso-pruebas.mp3
NETELIP_AVISO_ANNOUNCE=remote|https://<algo>.trycloudflare.com/webhook/netelip/<token>/aviso.mp3

# A qué extensión se conectan las entrantes: la de tu Linphone
NETELIP_CONTROL_DEFAULT_EXTENSION=113
# Saliente: «nombre;número», con un número asignado a la cuenta de Netelip
NETELIP_OUTBOUND_CALLERID=Grupo LYN;34XXXXXXXXX

# Transcripción (opcional, ver paso 4). Sin motor, las llamadas quedan «pendientes de transcripción».
NETELIP_TRANSCRIPTION_ENGINE=local_whisper
NETELIP_WHISPER_COMMAND=/ruta/al/venv/bin/python /ruta/absoluta/al/repo/backend/netelip/whisper_transcribe.py
NETELIP_DEBUG_AUDIO_DIR=/ruta/absoluta/al/repo/.local-secrets/audio   # copia los audios: SOLO en local

# Recuperación de grabaciones desde vDrive (opcional)
NETELIP_VDRIVE_USER=
NETELIP_VDRIVE_APP_PASSWORD=
```

Notas:

- **`NETELIP_TRUSTED_NETWORKS`**: déjalo con las redes de Netelip. El backend confía en `X-Forwarded-For` del túnel, así que la IP que comprueba es la de Netelip. Una petición desde tu máquina (curl, navegador) **debe** dar 403.
- **Locución del aviso**: para pruebas está en el repo, `backend/netelip/aviso-pruebas.mp3` (texto de `NETELIP_AVISO_TEXT` con voz sintética). **No es la locución de producción**, que la aprueba Legal y vive en `/etc/lyn/netelip/aviso.mp3`. Sin `NETELIP_AVISO_ANNOUNCE`, las **salientes no se graban**.
- **`NETELIP_OUTBOUND_CALLERID`**: sin él, Netelip responde **ocupado** en todas las salientes.
- **`NETELIP_CONTROL_ROUTES`** (opcional): JSON `{"34XXXXXXXXX":"113"}` para enrutar un número concreto a una extensión. `"pstn:6XXXXXXXX"` desvía a un teléfono externo, útil si no tienes Linphone.
- **`NETELIP_RECORD_AUDIO`**: déjalo sin definir (mono) salvo que desarrollo pida probar `stereo`.

Reinicia el backend y comprueba el arranque:

```bash
cd backend && npm run dev
```

En el log no deben aparecer errores `[netelip]`. Los avisos «Sin motor de transcripción», «Retención sin configurar» o «Sin acceso a vDrive» son normales si no configuraste esas partes.

## 4. Transcripción en local (opcional)

Whisper necesita varios GB de RAM y la primera vez descarga el modelo (≈1,5 GB).

```bash
python3 -m venv .local-secrets/whisper-venv
.local-secrets/whisper-venv/bin/pip install faster-whisper numpy
```

`NETELIP_WHISPER_COMMAND` es la ruta al `python` de ese venv, seguida de la ruta a `backend/netelip/whisper_transcribe.py`, ambas absolutas. Para un modelo más ligero (menos preciso), añade `WHISPER_MODEL=medium` al entorno del backend.

Prueba rápida con cualquier audio:

```bash
.local-secrets/whisper-venv/bin/python backend/netelip/whisper_transcribe.py prueba.mp3
```

Debe imprimir un JSON con el texto.

## 5. Panel de Netelip › API Voice

Con `BASE=https://<algo>.trycloudflare.com/webhook/netelip/<token>`:

| Campo del panel | URL |
|---|---|
| Recepción y realización de llamadas (URL de control) | `$BASE/control` |
| Eventos de llamada | `$BASE/callrecording` |
| Reporte de llamadas | `$BASE/report` |

Además:

- **Entrantes:** el número de prueba debe tener como plan de marcado **API Voice**.
- **Salientes:** la extensión de Linphone debe tener las salidas por **API Voice**. Si no, la llamada sale directa y no pasa por el backend: no hay aviso ni grabación.

Antes de llamar, comprueba que el túnel llega al backend:

```bash
curl -i -X POST "$BASE/control"
```

Debe responder **403**: tu IP no es de Netelip. Eso confirma que el túnel y la ruta funcionan. Si da 502 o 404 de Cloudflare, el backend no está levantado o el puerto no es 3003.

## 6. Recibir una llamada (entrante)

1. Linphone conectado y backend + túnel en marcha.
2. Desde el móvil, llamar al **número de prueba de Netelip**.
3. **Esperado en el móvil:** se oye el aviso con voz sintética (Silvia).
4. **Esperado en Linphone:** suena cuando termina el aviso. Contestar y hablar 20–30 s. Para comprobar la transcripción, leer un texto conocido.
5. Colgar desde cualquiera de los dos lados.
6. Comprobar el resultado (paso 8).

Casos a cubrir:

| Caso | Resultado esperado |
|---|---|
| Contestada, conversación normal | Llamada `Entrante`, con duración, audio y transcripción |
| Quien llama cuelga durante el aviso | No suena Linphone; no se crea grabación |
| No se contesta en Linphone (30 s) | No hay grabación ni transcripción |
| Llamada desde número oculto | Estado de contacto `oculto` |
| Llamada desde el teléfono de un lead o cliente existente | Vinculada a ese lead/cliente |
| Llamada desde un número desconocido | Contacto `desconocido`; se vincula si después se crea el lead con ese teléfono (≤ 5 min) |

## 7. Hacer una llamada (saliente)

1. En Linphone, marcar el número del móvil de prueba y llamar.
2. **Esperado en el móvil:** sale el número de `NETELIP_OUTBOUND_CALLERID`. Al contestar se oye la locución del aviso (`aviso-pruebas.mp3`) y después la conversación conecta.
3. Hablar 20–30 s y colgar.
4. Comprobar el resultado (paso 8).

Casos a cubrir:

| Caso | Resultado esperado |
|---|---|
| Contestada | Llamada `Saliente`, extensión del agente = la de Linphone, audio y transcripción. La transcripción no incluye el aviso |
| El móvil rechaza o no contesta | No hay grabación |
| Llamada entre dos extensiones (p. ej. a otra extensión interna) | No aparece en el historial (fuera de alcance) |

## 8. Dónde comprobar el resultado

1. **Dashboard:**
   - abrir `http://127.0.0.1:5173/?view=ceo` con un usuario con acceso;
   - ir a **Netelip › Historial de llamadas**;
   - la llamada aparece en segundos tras colgar;
   - la transcripción tarda más: con Whisper en CPU, aproximadamente lo que dura la llamada o más. Se ve el progreso.
2. **Log del backend:** buscar líneas `netelip`. `netelip_rejected_ip` indica que algo llegó desde una IP que no es de Netelip.
3. **Base de datos:**

   ```sql
   SELECT id, kind, status, attempts, last_error, received_at FROM netelip_inbox ORDER BY id DESC LIMIT 10;
   SELECT id, direction, counterpart_phone, contact_status, agent_extension, duration_seconds, call_status, audio_ref
     FROM netelip_calls ORDER BY id DESC LIMIT 10;
   SELECT call_id, status FROM netelip_call_transcriptions ORDER BY call_id DESC LIMIT 10;
   ```

4. **Audio:** si definiste `NETELIP_DEBUG_AUDIO_DIR`, ahí queda una copia del MP3 transcrito.

## Problemas frecuentes

| Síntoma | Causa probable |
|---|---|
| Linphone no se conecta | Credenciales o dominio SIP incorrectos, red que bloquea SIP, o la extensión ya está registrada en otro dispositivo |
| La entrante no suena y el móvil oye un tono de fin | La ruta del número no está en API Voice, el túnel está caído o `NETELIP_CONTROL_DEFAULT_EXTENSION` no es la extensión de Linphone |
| La saliente da **ocupado** al instante | Falta `NETELIP_OUTBOUND_CALLERID` o el número no está asignado a la cuenta |
| La saliente funciona pero no aparece en el historial | La extensión no sale por API Voice, o falta `NETELIP_AVISO_ANNOUNCE` (sin locución no se graba) |
| No se oye la locución en salientes | `NETELIP_AVISO_ANNOUNCE` apunta a un túnel antiguo, o `NETELIP_AVISO_FILE` no existe |
| Nada llega al backend (sin líneas `netelip` en el log) | URL del panel con un túnel antiguo o con un token distinto del de `.env` |
| `netelip_rejected_ip` en el log | Se cambió `NETELIP_TRUSTED_NETWORKS`, o la petición no viene de Netelip |
| La llamada aparece pero la transcripción sigue «pendiente» | Sin `NETELIP_TRANSCRIPTION_ENGINE`, o `NETELIP_WHISPER_COMMAND` con rutas incorrectas (ver `last_error` en `netelip_call_transcriptions` y el log) |
| Transcripción con errores | Esperado: la precisión medida ronda el 72–76 % (ver [NETELIP_LLAMADAS.md](NETELIP_LLAMADAS.md#transcripción)). Repórtalo con el audio y el texto leído |
| Llamada perdida tras reiniciar el backend a mitad de llamada | Limitación conocida: el estado de la llamada vive en memoria |

## Al terminar

1. **Devolver el panel de Netelip** (URL de control, eventos, reporte y planes de marcado) a los valores que tenía, o avisar a desarrollo.
2. Parar el túnel (`Ctrl+C`).
3. Cerrar sesión de la extensión en Linphone si la va a usar otra persona.
4. Las grabaciones de prueba quedan en `.local-secrets/` y en la base local: borrarlas si contienen voz de terceros.
