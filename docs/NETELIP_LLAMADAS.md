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

## Variables (`/etc/lyn/backend.env`)

| Variable | Valor en producción |
|---|---|
| `NETELIP_WEBHOOK_TOKEN` | Aleatorio, 48 hex o más (`openssl rand -hex 24`). Nunca el usado en local |
| `NETELIP_TRUSTED_NETWORKS` | Sin definir: usa las redes de Netelip |
| `NETELIP_AVISO_TEXT` / `NETELIP_AVISO_VOICE` | Texto aprobado por Legal (subtarea 869fg5z4k) / `Silvia` |
| `NETELIP_AVISO_FILE` | `/etc/lyn/netelip/aviso.mp3` (locución definitiva, 0640 root:lyn) |
| `NETELIP_AVISO_ANNOUNCE` | `remote\|https://<dominio>/webhook/netelip/<token>/aviso.mp3` |
| `NETELIP_OUTBOUND_CALLERID` | `Grupo LYN;34XXXXXXXXX` (número asignado a la cuenta). El nombre no suele llegar a los móviles, solo el número. En el QA del 22/10/2026, con `34910054498` el móvil mostró +34 910 05 92 15: falta que Netelip confirme qué número presenta (pregunta 16 a soporte) |
| `NETELIP_CONTROL_ROUTES` / `NETELIP_CONTROL_DEFAULT_EXTENSION` | Número entrante → extensión, según el inventario del runbook |
| `NETELIP_TRANSCRIPTION_ENGINE` | `none` hasta que se decida P3; después, el motor aprobado (ver «Transcripción») |
| `NETELIP_VDRIVE_USER` / `NETELIP_VDRIVE_APP_PASSWORD` | **Obligatorias** (el preflight no deja desplegar sin ellas). Usuario de vDrive y contraseña de aplicación de Nextcloud, nunca la del panel. Con ellas se descarga el audio de las llamadas pendientes cuando se active el motor |
| `NETELIP_ALERT_WEBHOOK_URL` | Canal de tecnología (Slack/Teams) para fallos y conciliación |
| `NETELIP_TRANSCRIPT_RETENTION_DAYS` / `NETELIP_AUDIO_RETENTION_DAYS` | Según P5. Sin definir no se borra nada |
| `NETELIP_DEBUG_AUDIO_DIR` | **No definir en producción** (copia los audios; solo para pruebas locales) |

## Transcripción

`local_whisper` ejecuta `backend/netelip/whisper_transcribe.py` (faster-whisper). Medido el 15/10/2026 con una llamada real a un móvil, leyendo un texto conocido:

| Configuración | Palabras acertadas |
|---|---|
| `medium` con filtro de silencios | 57 % |
| `large-v3-turbo`, saltando el aviso, sin repeticiones | 72–76 % |

- **Sin conversación.** Si después del aviso solo hay silencio o ruido de línea (por debajo de −45 dBFS), el script no llama a Whisper y devuelve texto vacío: el panel muestra «La grabación no contiene conversación». También descarta los segmentos sin voz y los que solo repiten `WHISPER_HOTWORDS`. En el QA del 22/10/2026 Whisper rellenaba el silencio con «Grupo LYN».
- **Inicio de la conversación.** En las salientes se salta el aviso, pero nunca más que lo que dura `NETELIP_AVISO_FILE`: así no se pierde un saludo en voz baja justo después del aviso.
- **GRUPO LYN y CLIENTE.** La grabación es mono. El script parte cada segmento por las pausas y los finales de frase, y reparte los tramos entre las dos voces por su energía grave: la red móvil la recorta y la voz por VoIP la conserva. Si las dos voces no se distinguen (una sola voz, o dos por la misma red), no etiqueta y el panel avisa de que no se pudo separar. Las frases muy cortas al final pueden quedar en el turno equivocado. La separación exacta necesita la grabación estéreo, pendiente de Netelip (pregunta 17).
- **Llamadas grabadas con el motor apagado.** Cada llamada queda en el historial con la transcripción `pending`. La grabación la guarda Netelip en vDrive (`/APIVoice/Record/<día>/`) y la llamada conserva su ruta. Al activar el motor (cambiar `NETELIP_TRANSCRIPTION_ENGINE` y reiniciar el backend fuera del horario de llamadas), se transcriben todas las pendientes, de una en una y de la más antigua a la más reciente. Como el enlace de descarga del aviso caduca, el audio se baja de vDrive. Mientras el motor está apagado no se avisa de las pendientes; si vDrive no responde al arrancar, sí llega la alerta «vDrive de Netelip inaccesible». **Hay que confirmar con Netelip cuánto tiempo conserva vDrive las grabaciones:** es el plazo máximo para activar el motor sin perder audios.
- **Motor pendiente de decidir (P3).** Que el servidor tenga 4 GB de RAM no demuestra que Whisper funcione con la calidad requerida (lo medido es 72–76 % frente al 95 % objetivo) ni sin quitar memoria al backend y a Evolution. Mientras Producto y Legal no aprueben un motor con evidencia de precisión, `NETELIP_TRANSCRIPTION_ENGINE` queda en `none`: las llamadas se guardan y la transcripción queda pendiente.
- **Precisión objetivo de Producto: 95 %.** Depende sobre todo de la calidad del audio: mono, 8 kHz, línea móvil. Ver el estado en la subtarea del spike.

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
