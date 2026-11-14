# Llamadas de Netelip: aviso, grabación y transcripción

Ticket ClickUp **869fcamvx** y subtareas. Código en `backend/netelip/` y vista **Netelip › Historial de llamadas** en `frontend/src/ceo-dashboard/views/NetelipCallsView.jsx`.

Pruebas en local con Linphone (QA): [NETELIP_PRUEBAS_LOCALES_LINPHONE.md](NETELIP_PRUEBAS_LOCALES_LINPHONE.md).

## Cómo funciona

```text
Llamada ─► Netelip API Voice ─► /webhook/netelip/<token>/control   (aviso → grabación → conexión)
                    │
                    └─ al colgar: aviso de grabación (ruta en vDrive + URLDownload) a la URL de control
                                         │
              backend: bandeja netelip_inbox ─► netelip_calls (vínculo con lead o cliente)
                                         │
                       netelip_call_transcriptions ─► motor de transcripción ─► Historial de llamadas
```

- **Receptor** (`routes.ts`), fuera de `/api`: solo IP de Netelip (185.8.244.0/24 y 192.99.91.144/29) y token no adivinable en la ruta. Responde en cuanto el evento queda guardado en la bandeja.
- **Controlador de API Voice** (`control.ts`):
  - Entrantes: aviso con voz sintética; graba solo si el aviso terminó bien; después conecta con la extensión.
  - Salientes: `callerid`, después `record`, después `dial` con la locución del aviso (`announce`).
  - Sin `callerid`, la red pública devuelve BUSY: API Voice no hereda el identificador de la extensión.
- **Grabación**: Netelip la notifica al colgar con un POST sin `command` a la URL de control. Hay un fichero por grabación: la conversación y, en salientes, la locución (`…_announce.mp3`, se ignora).
- **Vinculación** (`contacts.ts`): por teléfono E.164 contra `clientes` y `crm_leads`. Estados posibles:
  - `matched`: vinculada a un lead o cliente;
  - `unknown`: teléfono pendiente de resolución;
  - `hidden`: número oculto, sin contacto ni identidad pendiente;
  - `multiple`: el teléfono coincide con varios contactos y no se vincula a ninguno.
- **Re-vinculación**: cada 5 minutos, al guardar un lead y tras sincronizar el directorio de Supabase.
- **Procesos en segundo plano** (`index.ts`), sobre PostgreSQL con reintentos:
  - bandeja: cada 5 s;
  - transcripción: una cada vez, con 3 intentos;
  - re-vinculación: cada 5 min;
  - conciliación con el informe de Netelip: cada hora, para llamadas de más de 24 h;
  - retención: diaria.
- **Acceso**:
  - La sección y la API solo están disponibles para `superadmin`, `admin`, `employee:director` y `employee:director_general` (`NETELIP_ACCESS_ROLES`).
  - El texto lo leen esos mismos roles mientras Producto no decida otra cosa (P6, `NETELIP_TRANSCRIPT_READER_ROLES`).
  - «Consultas IA» no lee las tablas `netelip_*`.
- **Esquema** (`schema.ts`): solo tablas nuevas `netelip_*`, aplicadas en cada arranque. Reversión: `backend/netelip/schema-down.sql`.

## Registro de todas las llamadas de una extensión

Hasta ahora solo existían en el Historial las llamadas **grabadas**. Con `NETELIP_REGISTRO_EXTENSIONES=115`, quedan registradas **todas** las llamadas de esa extensión, entrantes y salientes, se contesten o no, y pasen o no por API Voice (`backend/netelip/status-events.ts`):

- **Fuente:** las *notificaciones de estado* de API Voice (índice `call`: `ring`, `answer`, `hangup`, `busy`, `noanswer`, `notavailable`). Llegan a la **URL eventos de llamadas** (`…/callrecording`) de las extensiones marcadas en *API Voice › Notificaciones de estado*. Las de otras extensiones se siguen ignorando.
- **Agrupación:** los eventos se guardan en `netelip_call_events` y se agrupan por `uniqueid`.
- **Resultado:** contestada, no contestada, colgada antes de contestar, ocupado o no disponible. La duración va de que se contesta a que se cuelga.
- **Llamada con grabación:** la grabación completa **la misma fila** de `netelip_calls` y se transcribe como siempre. Se une por `idapivoice` o, si no, por extensión, teléfono y una diferencia de 3 minutos como mucho, llegue antes la grabación o los eventos.
- **Llamada sin grabación:** queda con `audio_ref` vacío, sin transcripción, y el Dashboard la muestra como «Sin grabación».
- **Dashboard:** indicador **Llamadas perdidas** y filtro **Resultado**.

**En el panel de Netelip** (*API Voice › Notificaciones de estado*): la extensión marcada y los eventos **Ring, Answer, Hangup, Busy, No answer y Not available**.

**Límites:**
- Las llamadas que no llegan a sonar en la extensión (por ejemplo, si cuelgan en el IVR) no generan eventos.
- Registrar no es grabar: solo se graban las que pasan por API Voice.

**Esquema:** aditivo. `netelip_calls.audio_ref` admite NULL, hay dos columnas nuevas en `netelip_calls` (`event_uniqueid` y `resultado`) y una tabla nueva, `netelip_call_events`.

## Variables (`/etc/lyn/backend.env`)

| Variable | Valor en producción |
|---|---|
| `NETELIP_WEBHOOK_TOKEN` | Aleatorio, 48 hex o más (`openssl rand -hex 24`). Nunca el usado en local |
| `NETELIP_TRUSTED_NETWORKS` | Sin definir: usa las redes de Netelip |
| `NETELIP_AVISO_TEXT` / `NETELIP_AVISO_VOICE` | Texto aprobado por Legal (subtarea 869fg5z4k) / `Silvia` |
| `NETELIP_AVISO_FILE` | `/etc/lyn/netelip/aviso.mp3` (locución definitiva, 0640 root:lyn) |
| `NETELIP_AVISO_ANNOUNCE` | `remote\|https://<dominio>/webhook/netelip/<token>/aviso.mp3` |
| `NETELIP_OUTBOUND_CALLERID` | `Grupo LYN;34XXXXXXXXX` (número asignado a la cuenta). El nombre no suele llegar a los móviles, solo el número. En el QA del 22/10/2026, con `34910054498` el móvil mostró +34 910 05 92 15: falta que Netelip confirme qué número presenta (pregunta 16 a soporte) |
| `NETELIP_OUTBOUND_CALLERIDS` | JSON extensión → `nombre;número`, p. ej. `'{"109":"Grupo LYN;34865456130"}'`. Cada extensión presenta su número y, si el cliente devuelve la llamada, vuelve a ella. Las extensiones sin entrada usan `NETELIP_OUTBOUND_CALLERID` |
| `NETELIP_CONTROL_ROUTES` / `NETELIP_CONTROL_DEFAULT_EXTENSION` | Número entrante → extensión, según el inventario del runbook |
| `NETELIP_TRANSCRIPTION_ENGINE` | `none` hasta que se decida P3; después, `gemini` o `local_whisper` (ver «Transcripción») |
| `NETELIP_WHISPER_TIMEOUT_MINUTES` | Solo con `local_whisper`. Minutos que puede tardar Whisper con una llamada antes de cortarlo y reintentar (30 por defecto). En esta instancia, `360` (ver «Duración de Whisper») |
| `NETELIP_VDRIVE_USER` / `NETELIP_VDRIVE_APP_PASSWORD` | **Obligatorias** (el preflight no deja desplegar sin ellas). Usuario de vDrive y contraseña de aplicación de Nextcloud, nunca la del panel. Con ellas se descarga el audio de las llamadas pendientes cuando se active el motor |
| `NETELIP_ALERT_WEBHOOK_URL` | Canal de tecnología (Slack/Teams) para fallos y conciliación |
| `NETELIP_TRANSCRIPT_RETENTION_DAYS` / `NETELIP_AUDIO_RETENTION_DAYS` | Según P5. Sin definir no se borra nada |
| `NETELIP_DEBUG_AUDIO_DIR` | **No definir en producción** (copia los audios; solo para pruebas locales) |

## Transcripción

Se elige con `NETELIP_TRANSCRIPTION_ENGINE` y se cambia reiniciando el backend. Todos los motores obtienen el audio igual (URL del aviso o, si caducó, vDrive) y guardan el mismo formato; las llamadas ya transcritas conservan el motor que las procesó.

| Motor | Qué hace | En el servidor | Datos |
|---|---|---|---|
| `none` | Nada: las llamadas quedan `pending` | — | — |
| `gemini` | Sube el audio a Gemini con la clave de los informes (`GOOGLE_GEMINI_API_KEY`, modelo `GOOGLE_GEMINI_FLASH_MODEL`) y pide el texto separado en agente y cliente | Nada que instalar, sin carga | **El audio sale a Google**: requiere el visto bueno de Legal |
| `local_whisper` | `whisper_transcribe.py` (faster-whisper) en el propio servidor | Python, ffmpeg, modelo de ~1,6 GB; usa toda la CPU y 1,5–2 GB de RAM durante minutos | No sale del servidor |

**Gemini.** Descarta, como Whisper, los segmentos que repiten el aviso (`NETELIP_AVISO_TEXT`) o que solo dicen «Grupo LYN» (NET-03). Si Gemini no responde (clave, cuota o red), la transcripción falla y se reintenta: nunca se guarda la respuesta local de reserva que usan los informes. Precisión: pendiente de medir con las grabaciones del QA.

**Whisper.** `local_whisper` ejecuta `backend/netelip/whisper_transcribe.py` (faster-whisper). Medido el 15/10/2026 con una llamada real a un móvil, leyendo un texto conocido:

| Configuración | Palabras acertadas |
|---|---|
| `medium` con filtro de silencios | 57 % |
| `large-v3-turbo`, saltando el aviso, sin repeticiones | 72–76 % |

- **Sin conversación.** Si después del aviso solo hay silencio o ruido de línea (por debajo de −45 dBFS), el script no llama a Whisper y devuelve texto vacío: el panel muestra «La grabación no contiene conversación». También descarta los segmentos sin voz y los que solo repiten `WHISPER_HOTWORDS`. En el QA del 22/10/2026 Whisper rellenaba el silencio con «Grupo LYN».
- **Inicio de la conversación.** En las salientes se salta el aviso, pero nunca más que lo que dura `NETELIP_AVISO_FILE`: así no se pierde un saludo en voz baja justo después del aviso.
- **GRUPO LYN y CLIENTE.** La grabación es mono. El script parte cada segmento por las pausas y los finales de frase, y reparte los tramos entre las dos voces por su energía grave: la red móvil la recorta y la voz por VoIP la conserva. Si las dos voces no se distinguen (una sola voz, o dos por la misma red), no etiqueta y el panel avisa de que no se pudo separar. Las frases muy cortas al final pueden quedar en el turno equivocado. La separación exacta necesita la grabación estéreo, pendiente de Netelip (pregunta 17).
- **Llamadas grabadas con el motor apagado.** Cada llamada queda en el historial con la transcripción `pending`. La grabación la guarda Netelip en vDrive (`/APIVoice/Record/<día>/`) y la llamada conserva su ruta. Al activar el motor (cambiar `NETELIP_TRANSCRIPTION_ENGINE` y reiniciar el backend fuera del horario de llamadas), se transcriben todas las pendientes, de una en una y de la más antigua a la más reciente. Como el enlace de descarga del aviso caduca, el audio se baja de vDrive. Mientras el motor está apagado no se avisa de las pendientes; si vDrive no responde al arrancar, sí llega la alerta «vDrive de Netelip inaccesible». **Hay que confirmar con Netelip cuánto tiempo conserva vDrive las grabaciones:** es el plazo máximo para activar el motor sin perder audios.
- **Motor pendiente de decidir (P3).** La instancia de producción tiene 3,7 GB de RAM (2,6 GB disponibles el 27/10/2026) y CPU de ráfaga de Lightsail: Whisper cabe justo y, con muchas pendientes, puede agotar los créditos de CPU y ralentizar WhatsApp. Mientras Producto y Legal no aprueben un motor con evidencia de precisión, `NETELIP_TRANSCRIPTION_ENGINE` queda en `none`: las llamadas se guardan y la transcripción queda pendiente.
- **Duración de Whisper.** Se procesa una llamada cada vez y, si no termina en `NETELIP_WHISPER_TIMEOUT_MINUTES`, se corta («Whisper no terminó a tiempo») y se reintenta hasta 3 veces. El 03/11/2026, con el límite fijo de 30 min, fallaron todas las llamadas de 11 a 28 min de la extensión 115: en la instancia de producción (CPU de ráfaga, `nice -n 19`) Whisper tarda varias veces la duración de la llamada. Con un límite de horas las llamadas largas se transcriben, pero ocupan la CPU todo ese tiempo y las demás esperan en cola. Las fallidas se reencolan desde el panel (punto siguiente) o, a mano, con `UPDATE netelip_call_transcriptions SET status='pending', attempts=0, last_error=NULL, progress=NULL, next_attempt_at=NOW() WHERE call_id IN (…)`.
- **Reintentar una transcripción fallida.** Tras 3 intentos fallidos, una transcripción queda «Fallida». Se puede volver a poner en cola, con los intentos a cero, de dos formas:
  - desde el detalle de la llamada, con **Reintentar transcripción**;
  - filtrando por *Transcripciones fallidas* y pulsando **Reintentar las N**, que reencola las de esa página.

  El enlace de descarga de Netelip ya se borró, así que el audio se vuelve a bajar de vDrive. Por eso hace falta `NETELIP_VDRIVE_USER` / `NETELIP_VDRIVE_APP_PASSWORD`, y solo se reintentan llamadas de Netelip, no las de WhatsApp. Si la causa fue el límite de Whisper, primero hay que subirlo: si no, la llamada volverá a fallar.
- **Precisión objetivo de Producto: 95 %.** Depende sobre todo de la calidad del audio: mono, 8 kHz, línea móvil. Ver el estado en la subtarea del spike.

## Calificador interno de llamadas (ticket 869e9y98n)

Cuando termina la transcripción de una llamada de un **comercial configurado** (pestaña *Comerciales evaluados* o tabla `comercial_rol`) que dura **60 s o más**, Gemini la evalúa con la rúbrica vigente de su rol y:

1. guarda la nota, los errores críticos con su cita, 2 aciertos, 2 mejoras con acción, las objeciones y las ideas de marketing (`llamada_evaluacion`, `objecion_marketing`);
2. envía al comercial un feedback de 5 líneas y 600 caracteres como máximo por WhatsApp y, si se escala, el mismo mensaje a la vez al supervisor;
3. lo muestra en el detalle de la llamada, donde el supervisor añade su propio feedback (`llamada_feedback_humano`), que también le llega al comercial.

Lo que decide el código, no el modelo (`backend/netelip/calificador/reglas.ts`):

- Los datos del cliente se enmascaran antes de enviar la transcripción a Gemini (nombre del lead o cliente, teléfono, email, DNI, IBAN y dirección).
- Cada error crítico debe traer una cita que aparezca literalmente en la transcripción. Si no aparece, se descarta y la llamada queda con duda.
- `NO_PREGUNTAR` solo es error si el presupuesto del lead está registrado (Alex, 02/11/2026). `crm_leads` aún no guarda ese dato (P-05), así que hoy nunca lo es.
- **Apto** = nota ≥ 80 y ningún error crítico. **Escalado** = algún error crítico, nota < 80 o duda (P-01, pendiente de confirmar).
- Hasta 3 intentos con el modelo (1, 5 y 15 min). Después queda «no evaluada» con el motivo, sin feedback, y se avisa a tecnología.

Las rúbricas están versionadas en la tabla `rubrica_version` (869fpj8dm): el SDR usa `sdr-v1`, los 7 pasos del «Guion completo SDR», y los roles sin versión propia (closers) siguen con la fija `fase0-v1` (`backend/netelip/calificador/rubrica-v1.md`, del «Contexto unificado del Entrenador» de Jean). Publicar un guion nuevo, reevaluar llamadas y calibrar: [CALIFICADOR_RUBRICAS.md](CALIFICADOR_RUBRICAS.md).

| Variable | Valor |
|---|---|
| `GOOGLE_GEMINI_API_KEY` | La misma que el resto del Superagente. Sin ella no se evalúa nada (aviso al arrancar) |
| `CALIFICADOR_ENABLED` | `false` para apagarlo. Por defecto, encendido si hay clave de Gemini |
| `CALIFICADOR_MODEL` | Opcional. Por defecto, `GOOGLE_GEMINI_FLASH_MODEL` |
| `CALIFICADOR_THINKING_LEVEL` | Opcional. Por defecto, `low` |
| `CALIFICADOR_ENVIO` | `whatsapp` para enviar el feedback (P-02). Sale desde el WhatsApp de la instancia de Evolution (`INSTANCE_NAME`), el mismo que habla con los clientes. Sin definir, solo se ve en el Dashboard |
| `CALIFICADOR_SUPERVISOR_NOMBRE` / `CALIFICADOR_SUPERVISOR_WHATSAPP` | `Ernesto` / su móvil en E.164. Obligatorio con envío activo: sin él, una evaluación escalada no se envía |
| `CALIFICADOR_DASHBOARD_URL` | `https://ceo.grupolyn.com`, para el enlace a la llamada en el mensaje al supervisor |
| `CALIFICADOR_SUPERVISOR_ROLES` | Roles que escriben feedback y dan de alta comerciales. Por defecto, los mismos que ven Historial de llamadas |

**Antes de activarlo con el SDR (lunes 09/11):** el SDR informado por escrito de que sus llamadas se evalúan con IA (ticket, «Laboral y RGPD»); su extensión dada de alta con rol `sdr` y su WhatsApp; y `CALIFICADOR_ENVIO=whatsapp` solo cuando se confirme el canal (P-02).

**Apagarlo:** `CALIFICADOR_ENABLED=false` y reiniciar, o desactivar al comercial en *Comerciales evaluados*. Sus tablas son independientes: `backend/netelip/calificador/schema-down.sql` las borra con su contenido.

## Documento del entrenador de llamadas

Es el «Contexto unificado del Entrenador de llamadas Fase 0» de Jean Parra: el archivo que los comerciales cargan en ChatGPT para simular llamadas. La versión original está en `backend/netelip/entrenador/base-v0.txt`. En **Netelip › Historial de llamadas › Documento del entrenador**, el botón **Actualizar con N llamadas nuevas** hace lo siguiente:

1. Toma las llamadas **evaluadas desde la última actualización**, por fecha de evaluación, con un máximo de 120 (las más recientes). Si la última actualización fue hace tres semanas, solo entran esas tres semanas: ninguna llamada se usa dos veces. Usa lo que guardó el calificador (objeciones con su cita, errores críticos y mejoras), que ya va sin datos de clientes.
2. Gemini propone **añadidos**: objeciones nuevas con su criterio (sección 11), material real para los arquetipos A-G (sección 6) y frases de referencia (sección 18).
3. El código añade cada bloque al final de su sección, con la fecha y el periodo, y actualiza la línea «Actualizado con llamadas reales de Netelip hasta…» de la cabecera. **No borra ni reescribe nada del documento.** Antes de añadir cada entrada, vuelve a enmascarar los datos personales. Si una cita no aparece en las llamadas del periodo, la quita.
4. Guarda la versión (`entrenador_version`) y publica el **.docx** en Google Drive **sustituyendo el mismo archivo**, así el enlace que se reparte no cambia. Cada versión se descarga desde el Dashboard y se puede volver a publicar.

Solo actualizan los roles de `CALIFICADOR_SUPERVISOR_ROLES`. Hay una actualización a la vez, y suele tardar menos de un minuto. Si falla, la versión vigente no cambia y se avisa a tecnología.

| Variable | Valor |
|---|---|
| `ENTRENADOR_DRIVE_CARPETA` | Enlace o ID de la carpeta de Drive donde se publica |
| `ENTRENADOR_DRIVE_CUENTA` | Email de la cuenta de Google conectada en Reuniones que publica (la cuenta tech) |

**Permiso de Drive.** Con `ENTRENADOR_DRIVE_CARPETA` definida, la conexión de Google pide además `drive.file`, que solo da acceso a los archivos que crea la app. El resto de Drive sigue en solo lectura. Pasos:

1. Añade el scope `https://www.googleapis.com/auth/drive.file` en Google Auth Platform › Acceso a datos.
2. Vuelve a conectar la cuenta tech desde **Reuniones › Conectar Google Drive**.
3. Si Google no deja crear el archivo dentro de la carpeta (con `drive.file` a veces no «ve» carpetas que no creó la app), el primer archivo se crea en la raíz de «Mi unidad» y el Dashboard lo avisa. Muévelo **una vez** a la carpeta: las siguientes versiones lo seguirán actualizando allí.

Sin estas dos variables no se publica nada en Drive; el documento se descarga desde el Dashboard. Para revertir: `backend/netelip/entrenador/schema-down.sql` borra las versiones, pero no toca el archivo de Drive.

## Paso a paso hasta producción

### Antes de fusionar el PR

Todo con evidencia en ClickUp o en el PR:

- [x] QA de NET-02 y NET-03 repetido con una llamada real y aprobado (24/10/2026).
- [ ] Motor de transcripción (P3) decidido por Producto y Legal, con su precisión medida.
- [ ] Texto del aviso aprobado por Legal (BLOQ-01). Sin esa aprobación se puede desplegar el código, pero **no se activa ninguna ruta**.
- [ ] Rama al día con `main` y Quality Gate en verde (Backend, Dashboard, Evolution y Extension).
- [ ] Aprobación de Alejandro Yepez.

### Despliegue

`/opt/lyn` **no es un repositorio Git** y contiene ajustes de producción que hay que conservar: nunca `git pull` ahí ni copiar el repositorio encima sin comparar. `deploy.sh` **no hace respaldos**: solo valida (`preflight.sh`), compila, migra, reinicia y publica el dashboard. El respaldo es el paso 3 y es obligatorio.

1. **Fusionar y fijar el SHA.** Fusionar en `main` y anotar el commit publicado. No seguir si el Quality Gate de ese SHA no está en verde:

   ```bash
   SHA=$(gh pr view 1 --json mergeCommit -q .mergeCommit.oid)
   gh run list --workflow "Quality Gate" --commit "$SHA"
   git archive --format=tar.gz -o "lyn-$SHA.tar.gz" "$SHA"
   scp "lyn-$SHA.tar.gz" <servidor>:/var/tmp/
   ```

2. **Copia limpia y comparación con el servidor** (en el servidor, como root):

   ```bash
   SHA=<sha completo>
   REL=/var/tmp/lyn-release-$SHA
   install -d -m 0700 "$REL" && tar -xzf "/var/tmp/lyn-$SHA.tar.gz" -C "$REL"
   rsync -rcn --delete --itemize-changes \
     --exclude node_modules --exclude dist --exclude '.env' --exclude '.env.*' \
     "$REL/" /opt/lyn/ | tee "/var/tmp/lyn-diff-$SHA.txt"
   ```

   Revisar cada línea:
   - `>f…`: el fichero cambia. Si es un fichero que esta versión no toca, la diferencia es un ajuste de producción: conservarlo (añadirlo a `/var/tmp/lyn-keep-$SHA.txt`, una ruta relativa por línea) o llevarlo al repositorio en otro PR.
   - `*deleting`: el fichero solo existe en el servidor. El paso 4 no borra nada, así que se conserva.

   Resultado esperado: solo cambian los ficheros del PR y los de `main` que aún no estaban desplegados.

3. **Snapshot y respaldo** antes de sustituir ningún fichero:
   1. Snapshot manual de la instancia en Lightsail (consola › *Snapshots* › *Create snapshot*), con nombre `pre-netelip-<fecha>`. Esperar a que termine.
   2. Respaldo local:

      ```bash
      STAMP=$(date -u +%Y%m%dT%H%M%SZ)
      B=/var/backups/lyn/pre-netelip-$STAMP
      install -d -m 0700 "$B"
      cp -a /opt/lyn "/opt/lyn.pre-netelip-$STAMP"                # código, node_modules y builds
      cp -a /var/www/lyn/dashboard "$B/dashboard"
      tar -C /etc -czf "$B/config.tar.gz" lyn nginx
      systemctl cat lyn-backend lyn-evolution > "$B/services.txt"
      runuser -u postgres -- pg_dump -Fc superagente > "$B/superagente.dump"
      runuser -u postgres -- pg_dump -Fc evolution_db > "$B/evolution_db.dump"
      pg_restore --list "$B/superagente.dump" >/dev/null && pg_restore --list "$B/evolution_db.dump" >/dev/null
      (cd "$B" && sha256sum config.tar.gz services.txt *.dump > SHA256SUMS && sha256sum -c SHA256SUMS)
      echo "Respaldo: $B · Código anterior: /opt/lyn.pre-netelip-$STAMP"
      ```

      Comprobar antes el espacio libre (`df -h /opt /var/backups`). En multiinstancia, respaldar también las bases de cada instancia de `/etc/lyn/instances`.

4. **Instalar la versión conciliada, sin tocar todavía las rutas de llamadas:**

   ```bash
   rsync -a --exclude node_modules --exclude dist --exclude '.env' --exclude '.env.*' \
     --exclude-from="/var/tmp/lyn-keep-$SHA.txt" "$REL/" /opt/lyn/
   ```

   (Si no hay ajustes que conservar, crear `lyn-keep-$SHA.txt` vacío.) Después:
   - Variables `NETELIP_*` de la tabla anterior en `/etc/lyn/backend.env`, **entre comillas** (`deploy.sh` las carga con `source`). `NETELIP_TRANSCRIPTION_ENGINE=none` hasta que P3 esté decidido.
   - Locución definitiva en `/etc/lyn/netelip/aviso.mp3` (`install -o root -g lyn -m 0640`).
   - Bloque de Nginx para el receptor, que limita el origen a las redes de Netelip:

     ```nginx
     location /webhook/netelip/ {
         allow 185.8.244.0/24;
         allow 192.99.91.144/29;
         deny all;
         client_max_body_size 2m;
         proxy_pass http://127.0.0.1:3003/webhook/netelip/;
         proxy_http_version 1.1;
         proxy_set_header Host $host;
         proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
         proxy_set_header X-Forwarded-Proto $scheme;
         proxy_read_timeout 30s;
     }
     ```

     `nginx -t && systemctl reload nginx`.

   En el panel de Netelip no se cambia nada todavía: sin rutas en API Voice, no llega ninguna llamada ni se graba nada.

5. **Despliegue, fuera del horario de llamadas** (el estado de cada llamada vive en memoria y un reinicio corta las que estén en curso):

   ```bash
   sudo bash /opt/lyn/deploy/scripts/preflight.sh
   sudo bash /opt/lyn/deploy/scripts/deploy.sh
   ```

   Al arrancar, el backend crea las tablas `netelip_*`.

6. **Comprobaciones:**
   - Lo existente sigue funcionando: `curl -fsS http://127.0.0.1:3003/health`, `systemctl is-active lyn-backend lyn-evolution`, login en el dashboard, estado de WhatsApp conectado y un mensaje de prueba recibido.
   - Netelip: `journalctl -u lyn-backend | grep netelip` (no deben aparecer «Sin acceso a vDrive» ni «vDrive de Netelip inaccesible») y, en psql, `\dt netelip_*`.
   - Con el **número de prueba**: en Netelip › API Voice, configurar solo ese número con `…/control` (recepción y realización), `…/callrecording` (eventos) y `…/report`, todas en `https://<dominio>/webhook/netelip/<token>/`. Repetir la matriz del spike, entrante y saliente, y verificar la llamada en Historial de llamadas, con la transcripción en «pendiente», y que su grabación está en vDrive, en `/APIVoice/Record/<día>/`.

7. **Activación gradual**, solo con la aprobación legal del aviso y la prueba anterior correcta (subtarea 869fg5z5b), fuera de horas punta:
   1. pasar **una** ruta al plan de marcado de API Voice;
   2. verificarla con una llamada real (aviso, grabación, conexión con la extensión);
   3. anotarla en el inventario y observarla al menos un día antes de pasar la siguiente.

   Si una ruta falla, devolverla a su plan de marcado anterior (ver «Rollback»).

8. **Primeras 24 h** tras cada ruta: revisar la conciliación (alertas) y las transcripciones fallidas.

### Rollback

1. **Una ruta falla:** en el panel de Netelip, devolver esa ruta o extensión a su plan de marcado anterior. Deja de grabar en el acto. Es lo primero, siempre: mientras una ruta apunte a API Voice, si el backend no responde **esa línea no puede llamar**.
2. **Falla el backend o lo existente (WhatsApp, dashboard):** tras el paso 1 en todas las rutas activas,

   ```bash
   systemctl stop lyn-backend lyn-evolution
   mv /opt/lyn "/opt/lyn.failed-$SHA" && mv "/opt/lyn.pre-netelip-$STAMP" /opt/lyn
   rsync -a --delete "$B/dashboard/" /var/www/lyn/dashboard/
   systemctl start lyn-evolution lyn-backend
   curl -fsS http://127.0.0.1:3003/health
   ```

   Si también hay que volver atrás la configuración, restaurar `/etc/lyn` y Nginx desde `$B/config.tar.gz`. Como último recurso, la instancia completa desde el snapshot del paso 3.
3. **Datos:** las tablas `netelip_*` son independientes y pueden quedarse. `schema-down.sql` las borra **con su contenido**: antes, otro `pg_dump`.

## Riesgos abiertos

- **El controlador guarda en memoria el estado de cada llamada.** Con un solo proceso funciona, pero no hay alta disponibilidad: si el backend se reinicia a mitad de llamada, esa llamada no queda grabada (P2).
- **No hay entorno de pruebas** separado de producción.
- **No consta cifrado en reposo** de la base de datos (D6).
