#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT=/opt/lyn
expected=2490ccac84936e1d86e99f639e90edb596a11079
backup=/var/backups/lyn/pre-global-summary-20260929T204026Z
trap 'echo "REANUDACION DETENIDA. Conserva el registro. No repitas ni restaures bases automáticamente. Respaldo: $backup" >&2' ERR
[[ $(id -u) -eq 0 ]]
exec 9>/run/lock/lyn-global-summary.lock
flock -n 9 || { echo 'Hay otro despliegue en ejecución.' >&2; exit 1; }
gitlyn() { runuser -u lyn -- git -C "$ROOT" "$@"; }
[[ $(gitlyn rev-parse HEAD) == "$expected" ]]
gitlyn diff --quiet HEAD -- backend evolution-api deploy
test ! -e "$backup/evolution-dist-before"
test -s "$backup/SHA256SUMS"
[[ $(cat "$backup/previous-commit.txt") == 96c742034d091be641e1c19be88624752d1ebfff ]]
cd "$backup"
sha256sum -c SHA256SUMS
test -s "$ROOT/evolution-api/dist/main.js"
test -f "$ROOT/evolution-api/node_modules/tsup/dist/cli-default.js"
bash "$ROOT/deploy/scripts/preflight.sh"
grep -qx 'DATABASE_SAVE_DATA_HISTORIC=true' /etc/lyn/evolution.env
grep -qx 'DATABASE_SAVE_DATA_NEW_MESSAGE=true' /etc/lyn/evolution.env
port=$(sed -n 's/^SERVER_PORT=//p' /etc/lyn/evolution.env | tail -n 1 | tr -d '\r')
[[ "$port" =~ ^[0-9]+$ ]] && (( port > 0 && port <= 65535 ))
available=$(df -B1 --output=avail "$ROOT/evolution-api" | tail -n 1 | tr -d ' ')
[[ "$available" =~ ^[0-9]+$ ]] && (( available > 268435456 ))

stage=$(mktemp -d "$ROOT/evolution-api/.history-resume-XXXXXXXX")
chown lyn:lyn "$stage"
cd "$ROOT/evolution-api"
echo "Compilando en staging. TypeScript ya validado fuera del servidor para $expected."
runuser -u lyn -- env LYN_EVOLUTION_BUILD_DIR="$stage" node --max-old-space-size=256 node_modules/tsup/dist/cli-default.js
test -s "$stage/main.js"
test -d "$stage/translations"
grep -q 'requestHistory' "$stage/main.js"
runuser -u lyn -- node --check "$stage/main.js"
echo 'BUNDLE VERIFICADO. Reiniciando Evolution sin eliminar sesiones.'
systemctl stop lyn-evolution
mv "$ROOT/evolution-api/dist" "$backup/evolution-dist-before"
mv "$stage" "$ROOT/evolution-api/dist"
systemctl start lyn-evolution
ready=false
for ((attempt=0; attempt<60; attempt++)); do
  if curl --fail --silent --connect-timeout 2 --max-time 3 "http://127.0.0.1:$port/" >/dev/null; then
    ready=true
    break
  fi
  sleep 2
done
[[ "$ready" == true ]]
source "$ROOT/deploy/scripts/readiness.sh"
systemctl restart lyn-backend
wait_for_backend /etc/lyn/backend.env
systemctl is-active lyn-backend lyn-evolution nginx
test "$(runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d superagente -tAc "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='summary_jobs' AND column_name='next_attempt_at'")" = 1
curl --fail --silent --show-error --max-time 20 https://ceo.grupolyn.com/health
echo
echo "RECUPERACION DESPLEGADA: $expected"
