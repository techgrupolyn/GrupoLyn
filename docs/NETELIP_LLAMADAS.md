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
| `NETELIP_OUTBOUND_CALLERID` | `Grupo LYN;34XXXXXXXXX` (número asignado a la cuenta) |
| `NETELIP_CONTROL_ROUTES` / `NETELIP_CONTROL_DEFAULT_EXTENSION` | Número entrante → extensión, según el inventario del runbook |
| `NETELIP_TRANSCRIPTION_ENGINE` | Motor aprobado en P3 (ver «Transcripción») |
| `NETELIP_ALERT_WEBHOOK_URL` | Canal de tecnología (Slack/Teams) para fallos y conciliación |
| `NETELIP_TRANSCRIPT_RETENTION_DAYS` / `NETELIP_AUDIO_RETENTION_DAYS` | Según P5. Sin definir no se borra nada |
| `NETELIP_DEBUG_AUDIO_DIR` | **No definir en producción** (copia los audios; solo para pruebas locales) |

## Transcripción

`local_whisper` ejecuta `backend/netelip/whisper_transcribe.py` (faster-whisper). Medido el 15/10/2026 con una llamada real a un móvil, leyendo un texto conocido:

| Configuración | Palabras acertadas |
|---|---|
| `medium` con filtro de silencios | 57 % |
| `large-v3-turbo`, saltando el aviso, sin repeticiones | 72–76 % |

- **Whisper no cabe en el servidor actual** (≈1 GB de RAM). En producción hace falta un servidor de transcripción aparte o un motor gestionado. Es la decisión P3, que pasa por Legal.
- **Precisión objetivo de Producto: 95 %.** Depende sobre todo de la calidad del audio: mono, 8 kHz, línea móvil. Ver el estado en la subtarea del spike.

## Paso a paso hasta producción

Requisitos previos, todos con evidencia en ClickUp:
- texto del aviso aprobado por Legal;
- P2 y P3 decididos;
- motor de transcripción con la precisión exigida;
- matriz de pruebas del spike ejecutada con el número de prueba.

1. **PR.** Rama `feat/netelip-llamadas` → `main`, con el Quality Gate en verde (Backend y Dashboard) y la aprobación de Alejandro Yepez.
2. **Copia de seguridad.** El script de despliegue guarda el bundle de git, `/etc/lyn` y los volcados de las dos bases antes de tocar nada.
3. **Variables.** Añadir las de la tabla anterior a `/etc/lyn/backend.env` y copiar la locución definitiva a `/etc/lyn/netelip/aviso.mp3`.
4. **Nginx.** Añadir una ubicación propia para el receptor, que limite el origen a las redes de Netelip:

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

   Después: `nginx -t && systemctl reload nginx`.
5. **Despliegue.** Con el script de producción y el SHA aprobado. Al arrancar, el backend crea las tablas `netelip_*`. Comprobar:
   - `/health`;
   - el log `journalctl -u lyn-backend | grep netelip`;
   - en psql, `\dt netelip_*`.
6. **Panel de Netelip › API Voice.** Recepción y realización de llamadas en `…/control`, eventos en `…/callrecording` y reporte en `…/report`, todas con `https://<dominio>/webhook/netelip/<token>/`.
7. **Prueba con el número de prueba.** Repetir la matriz del spike en producción, entrante y saliente, y verificar la llamada y su transcripción en Historial de llamadas.
8. **Activación por rutas** (subtarea 869fg5z5b), fuera de horas punta y en este orden:
   1. activar el aviso;
   2. verificarlo con una llamada;
   3. solo entonces pasar la ruta al plan de marcado de API Voice;
   4. anotarlo en el inventario.
9. **Primeras 24 h.** Revisar la conciliación (alertas) y las transcripciones fallidas.

### Rollback (menos de 15 minutos)

1. **En el panel de Netelip:** devolver la ruta o la extensión a su plan de marcado anterior. Deja de grabar en el acto.
2. **Si falla el backend:** mientras haya rutas en API Voice, **esas líneas no pueden llamar**. Por eso hay que hacer antes el paso 1 y, después, desplegar el commit anterior.
3. **Datos:** las tablas son independientes. `schema-down.sql` las borra **con su contenido**, así que antes hay que hacer copia.

## Riesgos abiertos

- **El controlador guarda en memoria el estado de cada llamada.** Con un solo proceso funciona, pero no hay alta disponibilidad: si el backend se reinicia a mitad de llamada, esa llamada no queda grabada (P2).
- **No hay entorno de pruebas** separado de producción.
- **No consta cifrado en reposo** de la base de datos (D6).
