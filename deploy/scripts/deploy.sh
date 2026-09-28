#!/usr/bin/env bash
set -euo pipefail

ROOT=/opt/lyn
source "$ROOT/deploy/scripts/readiness.sh"

ensure_env_access() {
  install -d -o root -g lyn -m 0750 /etc/lyn
  for env_file in /etc/lyn/backend.env /etc/lyn/evolution.env; do
    [[ -f "$env_file" ]] || continue
    chown root:lyn "$env_file"
    chmod 0640 "$env_file"
  done
}

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Ejecuta este script con sudo."
  exit 1
fi

ensure_env_access

bash "$ROOT/deploy/scripts/preflight.sh"

run_as_lyn() {
  runuser -u lyn -- "$@"
}

run_as_lyn_with_env() {
  local env_file="$1"
  shift
  runuser -u lyn -- bash -c 'set -a; source "$1"; shift; set +a; exec "$@"' _ "$env_file" "$@"
}

chown -R lyn:lyn "$ROOT/backend" "$ROOT/evolution-api" "$ROOT/frontend"

cd "$ROOT/backend"
run_as_lyn npm ci
run_as_lyn npm run build

cd "$ROOT/evolution-api"
run_as_lyn npm ci
run_as_lyn_with_env /etc/lyn/evolution.env npm --prefix "$ROOT/evolution-api" run db:generate
run_as_lyn env NODE_OPTIONS=--max-old-space-size=1536 npm run build

cd "$ROOT/frontend"
run_as_lyn npm ci
run_as_lyn npm run build

cd "$ROOT/backend"
run_as_lyn npm prune --omit=dev
cd "$ROOT/evolution-api"
run_as_lyn npm prune --omit=dev

systemctl daemon-reload

if [[ -d /etc/lyn/instances ]] && find /etc/lyn/instances -mindepth 1 -maxdepth 1 -type d -print -quit | grep -q .; then
  while IFS= read -r -d '' instance_dir; do
    instance="$(basename "$instance_dir")"
    run_as_lyn_with_env "$instance_dir/backend.env" npm --prefix "$ROOT/backend" run migrate
    run_as_lyn_with_env "$instance_dir/evolution.env" npm --prefix "$ROOT/evolution-api" run db:deploy
    systemctl restart "lyn-evolution@$instance.service"
    systemctl restart "lyn-backend@$instance.service"
    wait_for_backend "$instance_dir/backend.env"
    systemctl is-active --quiet "lyn-evolution@$instance.service"
  done < <(find /etc/lyn/instances -mindepth 1 -maxdepth 1 -type d -print0)
else
  run_as_lyn_with_env /etc/lyn/backend.env npm --prefix "$ROOT/backend" run migrate
  run_as_lyn_with_env /etc/lyn/evolution.env npm --prefix "$ROOT/evolution-api" run db:deploy
  systemctl restart lyn-evolution lyn-backend
  wait_for_backend /etc/lyn/backend.env
  systemctl is-active --quiet lyn-evolution
fi

nginx -t
install -d -o lyn -g lyn -m 0755 /var/www/lyn/dashboard/assets
rsync -a --chown=lyn:lyn "$ROOT/frontend/dist/assets/" /var/www/lyn/dashboard/assets/
rsync -a --delete --exclude='assets/' --exclude='index.html' --exclude='.index.html.next' --chown=lyn:lyn "$ROOT/frontend/dist/" /var/www/lyn/dashboard/
install -o lyn -g lyn -m 0644 "$ROOT/frontend/dist/index.html" /var/www/lyn/dashboard/.index.html.next
if [[ -f /var/www/lyn/dashboard/index.html ]]; then
  cp -p /var/www/lyn/dashboard/index.html /var/www/lyn/dashboard/.index.html.previous
fi
mv -f /var/www/lyn/dashboard/.index.html.next /var/www/lyn/dashboard/index.html
if ! systemctl reload nginx; then
  if [[ -f /var/www/lyn/dashboard/.index.html.previous ]]; then
    cp -p /var/www/lyn/dashboard/.index.html.previous /var/www/lyn/dashboard/.index.html.next
    mv -f /var/www/lyn/dashboard/.index.html.next /var/www/lyn/dashboard/index.html
  fi
  echo 'Falló la recarga de nginx; se restauró el HTML anterior cuando estaba disponible.' >&2
  exit 1
fi
printf 'Servicios preparados y dashboard publicado. Validar los flujos reales antes de cerrar QA.\n'
