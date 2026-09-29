#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT=/opt/lyn
expected=${1:?Indica el commit aprobado completo}
mode=${2:-backend}
[[ "$mode" == backend || "$mode" == phone-history ]] || { echo 'Modo de despliegue inválido.' >&2; exit 1; }
backup='pendiente de crear'
trap 'echo "DESPLIEGUE DETENIDO. Respaldo: $backup. Revisa el registro antes de repetir." >&2' ERR
[[ $(id -u) -eq 0 ]] || { echo 'Ejecuta con sudo.' >&2; exit 1; }
[[ "$expected" =~ ^[0-9a-f]{40}$ ]] || { echo 'Commit inválido.' >&2; exit 1; }
exec 9>/run/lock/lyn-global-summary.lock
flock -n 9 || { echo 'Ya hay una actualización de informes en ejecución.' >&2; exit 1; }
gitlyn() { runuser -u lyn -- git -C "$ROOT" "$@"; }
gitroot() { git -c safe.directory="$ROOT" -C "$ROOT" "$@"; }
[[ $(gitlyn branch --show-current) == main ]]
gitlyn fetch origin
[[ $(gitlyn rev-parse origin/main) == "$expected" ]]
before=$(gitlyn rev-parse HEAD)
gitlyn merge-base --is-ancestor "$before" "$expected"
if [[ "$mode" == phone-history ]]; then
  gitlyn diff --quiet "$before" "$expected" -- backend/package.json backend/package-lock.json evolution-api/package.json evolution-api/package-lock.json evolution-api/prisma frontend
  test -f "$ROOT/evolution-api/node_modules/typescript/bin/tsc"
  test -f "$ROOT/evolution-api/node_modules/tsup/dist/cli-default.js"
  grep -qx 'DATABASE_SAVE_DATA_HISTORIC=true' /etc/lyn/evolution.env
  grep -qx 'DATABASE_SAVE_DATA_NEW_MESSAGE=true' /etc/lyn/evolution.env
else
  gitlyn diff --quiet "$before" "$expected" -- backend/package.json backend/package-lock.json evolution-api frontend
fi
if gitlyn diff HEAD --name-only | grep -Ev '^(backend|evolution-api)/package-lock.json$'; then
  echo 'Hay cambios locales inesperados. No se sobrescribirán.' >&2
  exit 1
fi
if gitlyn ls-files --others --exclude-standard | grep -Ev '^(\.npm/|\.cache/|\.lesshst$)'; then
  echo 'Hay archivos locales sin seguimiento. Revísalos antes de continuar.' >&2
  exit 1
fi
test -f "$ROOT/backend/node_modules/tsx/dist/cli.mjs"
if [[ -d /etc/lyn/instances ]] && find /etc/lyn/instances -mindepth 1 -maxdepth 1 -type d -print -quit | grep -q .; then
  echo 'Este despliegue está preparado para lyn-backend, no para múltiples instancias.' >&2
  exit 1
fi
bash "$ROOT/deploy/scripts/preflight.sh"
database_bytes=$(runuser -u postgres -- psql -X -d postgres -tAc "SELECT pg_database_size('superagente') + pg_database_size('evolution_db')")
available_bytes=$(df -B1 --output=avail /var/backups | tail -n 1 | tr -d ' ')
[[ "$database_bytes" =~ ^[0-9]+$ && "$available_bytes" =~ ^[0-9]+$ ]]
(( available_bytes > database_bytes + 1073741824 )) || { echo 'Espacio insuficiente para respaldar con margen. No se actualizó el código.' >&2; exit 1; }
backup="/var/backups/lyn/pre-global-summary-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -o root -g root -m 0700 "$backup"
printf '%s\n' "$before" > "$backup/previous-commit.txt"
gitroot bundle create "$backup/repository.bundle" --all
gitroot bundle verify "$backup/repository.bundle"
gitlyn diff --binary HEAD > "$backup/local-changes.patch"
tar -C /etc -czf "$backup/config.tar.gz" lyn
systemctl cat lyn-backend > "$backup/backend-unit.txt"
if [[ "$mode" == phone-history ]]; then
  systemctl cat lyn-evolution > "$backup/evolution-unit.txt"
  tar -C "$ROOT/evolution-api" -czf "$backup/evolution-dist.tar.gz" dist
fi
runuser -u postgres -- pg_dump -Fc superagente > "$backup/superagente.dump"
pg_restore --list "$backup/superagente.dump" >/dev/null
runuser -u postgres -- pg_dump -Fc evolution_db > "$backup/evolution_db.dump"
pg_restore --list "$backup/evolution_db.dump" >/dev/null
cd "$backup"
sha256sum previous-commit.txt repository.bundle local-changes.patch config.tar.gz backend-unit.txt superagente.dump evolution_db.dump > SHA256SUMS
if [[ "$mode" == phone-history ]]; then sha256sum evolution-unit.txt evolution-dist.tar.gz >> SHA256SUMS; fi
sha256sum -c SHA256SUMS
echo "RESPALDO VERIFICADO: $backup"
gitlyn stash push -m "Respaldo locks antes de informes globales $expected" -- backend/package-lock.json evolution-api/package-lock.json
gitlyn merge --ff-only "$expected"
source "$ROOT/deploy/scripts/readiness.sh"
if [[ "$mode" == phone-history ]]; then
  stage=$(mktemp -d "$ROOT/evolution-api/.history-build-XXXXXXXX")
  chown lyn:lyn "$stage"
  cd "$ROOT/evolution-api"
  runuser -u lyn -- node node_modules/typescript/bin/tsc --noEmit
  runuser -u lyn -- env LYN_EVOLUTION_BUILD_DIR="$stage" node node_modules/tsup/dist/cli-default.js
  test -s "$stage/main.js"
  grep -q 'requestHistory' "$stage/main.js"
  runuser -u lyn -- node --check "$stage/main.js"
  systemctl stop lyn-backend lyn-evolution
  mv "$ROOT/evolution-api/dist" "$backup/evolution-dist-before"
  mv "$stage" "$ROOT/evolution-api/dist"
  systemctl start lyn-evolution
fi
systemctl restart lyn-backend
wait_for_backend /etc/lyn/backend.env
systemctl is-active lyn-backend lyn-evolution nginx
test "$(runuser -u postgres -- psql -X -d superagente -tAc "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='resumenes_globales_chat' AND column_name IN ('evidence','coverage')")" = 2
if [[ "$mode" == phone-history ]]; then
  test "$(runuser -u postgres -- psql -X -d superagente -tAc "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='summary_jobs' AND column_name='next_attempt_at'")" = 1
fi
curl --fail --silent --show-error --max-time 20 https://ceo.grupolyn.com/health
echo
echo "BACKEND ACTUALIZADO: $expected"
echo 'Esta corrección backend no requiere otra versión si ya usas la extensión 1.1.6. Verifica la cobertura real del historial antes de dar por resuelta la incidencia.'
