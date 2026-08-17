# Despliegue de producción en AWS Lightsail

Esta guía publica un solo dominio HTTPS para dashboard, CEO, extensión y API. Los puertos internos nunca se exponen. La IA usa la Interactions API de Gemini con `gemini-3.6-flash` por defecto.

## 1. Infraestructura

1. Crea una instancia Linux con IP estática y un dominio, por ejemplo `app.example.com`.
2. En el firewall de Lightsail permite solo `22` (restringido a tu IP), `80` y `443`.
3. Apunta el registro A del dominio a la IP estática.
4. Instala PostgreSQL local o, preferiblemente, usa una base administrada separada. Crea `superagente` y `evolution_db` con usuarios de privilegios mínimos.

AWS recomienda respaldos con snapshots; configura snapshots automáticos y prueba una restauración periódicamente. Consulta la [documentación de snapshots de Lightsail](https://docs.aws.amazon.com/lightsail/latest/userguide/understanding-snapshots-in-amazon-lightsail.html) y de [snapshots automáticos](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-configuring-automatic-snapshots.html).

## 2. Paquetes y usuario de servicio

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx postgresql-client rsync certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo useradd --system --create-home --home-dir /opt/lyn --shell /usr/sbin/nologin lyn
sudo mkdir -p /opt/lyn /etc/lyn /var/backups/lyn
sudo chown -R lyn:lyn /opt/lyn /var/backups/lyn
sudo chmod 700 /etc/lyn
```

Instala el proyecto en `/opt/lyn` con el usuario `lyn`. No copies `node_modules`, `.env`, ni bases de datos desde desarrollo.

## 3. Variables de entorno

```bash
sudo install -o root -g lyn -m 640 deploy/env/backend.production.env.example /etc/lyn/backend.env
sudo install -o root -g lyn -m 640 deploy/env/evolution.production.env.example /etc/lyn/evolution.env
sudoedit /etc/lyn/backend.env
sudoedit /etc/lyn/evolution.env
```

Reemplaza todos los valores `REEMPLAZA_*`. Usa secretos aleatorios largos para `CEO_SESSION_SECRET`, `WEBHOOK_SECRET` y `EVOLUTION_API_KEY`. El backend mantiene `tsx` como dependencia de ejecución porque sirve TypeScript directamente. Define:

- `WEBHOOK_URL=https://app.example.com/webhook/evolution`
- `CORS_ALLOWED_ORIGINS=https://app.example.com`
- `BIND_HOST=127.0.0.1`
- una `GOOGLE_GEMINI_API_KEY` con facturación/saldo disponible.

No reutilices las claves de desarrollo. Mantén los archivos solo en `/etc/lyn` y nunca en Git.

## 4. Servicios, base y frontend

```bash
sudo cp deploy/systemd/lyn-backend.service /etc/systemd/system/
sudo cp deploy/systemd/lyn-evolution.service /etc/systemd/system/
sudo cp deploy/nginx/lyn.conf /etc/nginx/sites-available/lyn
sudo ln -s /etc/nginx/sites-available/lyn /etc/nginx/sites-enabled/lyn
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl daemon-reload
sudo chmod 750 /opt/lyn/deploy/scripts/preflight.sh
sudo /opt/lyn/deploy/scripts/preflight.sh
sudo /opt/lyn/deploy/scripts/deploy.sh
```

El script instala dependencias reproducibles, compila el backend y dashboard, aplica migraciones, elimina dependencias de desarrollo de los servicios y los reinicia. Ejecuta una vez manualmente antes de automatizarlo. Confirma el estado:

```bash
sudo systemctl status lyn-backend lyn-evolution nginx
curl -fsS http://127.0.0.1:3003/health
curl -fsS https://app.example.com/health
```

## 5. HTTPS

Para TLS directo en la instancia, una vez que DNS esté propagado:

```bash
sudo certbot --nginx -d app.example.com --redirect
```

Para TLS terminado en un balanceador de Lightsail, crea y asocia el certificado en Lightsail y deja que el balanceador redirija HTTP a HTTPS. Sigue la guía oficial de [certificados TLS](https://docs.aws.amazon.com/lightsail/latest/userguide/understanding-tls-ssl-certificates-in-lightsail-https.html) y [redirección HTTPS](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-configure-load-balancer-https-redirection.html). Elige una sola terminación TLS para evitar dobles redirecciones.

## 6. Respaldos y operación

Programa el respaldo diario:

```bash
sudo install -o root -g root -m 750 deploy/scripts/backup-postgres.sh /usr/local/sbin/lyn-backup-postgres
echo '15 2 * * * root /usr/local/sbin/lyn-backup-postgres' | sudo tee /etc/cron.d/lyn-backup
```

Revisa cada día `systemctl status`, espacio en disco y el resultado del respaldo. Conserva snapshots fuera de la instancia. Antes de una actualización: realiza respaldo, ejecuta el despliegue y verifica `/health`, login CEO, webhook y un envío de prueba.

## Extensión y clientes

Distribuye la extensión empaquetada por el canal interno de Chrome/Edge/Brave y configura su backend como `https://app.example.com`. La extensión no debe apuntar a una IP privada ni a `http` remoto. El navegador y el dashboard se conectan únicamente al dominio público HTTPS.
