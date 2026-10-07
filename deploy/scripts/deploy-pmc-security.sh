#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT=/opt/lyn
expected=${1:?Indica el commit completo aprobado}
[[ $(id -u) -eq 0 && "$expected" =~ ^[0-9a-f]{40}$ ]]
exec 9>/run/lock/lyn-global-summary.lock
flock -n 9
gitlyn() { runuser -u lyn -- git -C "$ROOT" "$@"; }
idle() {
  [[ $(runuser -u postgres -- psql -XAt -v ON_ERROR_STOP=1 -d superagente -c "SELECT (SELECT COUNT(*) FROM summary_jobs WHERE status IN ('running','queued')) + (SELECT COUNT(*) FROM meeting_reviews WHERE analysis_status='processing')") == 0 ]]
}
[[ $(gitlyn branch --show-current) == main ]]
gitlyn fetch origin
[[ $(gitlyn rev-parse origin/main) == "$expected" ]]
before=$(gitlyn rev-parse HEAD)
gitlyn merge-base --is-ancestor "$before" "$expected"
gitlyn diff --quiet HEAD
gitlyn diff --quiet "$before" "$expected" -- frontend evolution-api/src evolution-api/prisma evolution-api/tsup.config.ts
idle
bash "$ROOT/deploy/scripts/preflight.sh"
backup="/var/backups/lyn/pre-pmc-security-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0700 "$backup"
stage=$(mktemp -d /var/tmp/lyn-pmc-security-XXXXXXXX)
swapping=false
rollback() {
  trap - ERR
  set +e
  echo "DESPLIEGUE FALLIDO. Respaldo: $backup"
  if [[ "$swapping" == true ]]; then
    systemctl stop lyn-backend lyn-evolution
    for component in backend evolution-api; do
      for package in compression proxy-addr; do
        if [[ -d "$backup/$component/$package" ]]; then
          if [[ -d "$ROOT/$component/node_modules/$package" ]]; then
            mv "$ROOT/$component/node_modules/$package" "$stage/$component/$package-failed"
          fi
          mv "$backup/$component/$package" "$ROOT/$component/node_modules/$package"
        fi
      done
    done
    gitlyn switch --detach "$before"
    systemctl start lyn-evolution lyn-backend
    echo 'Código y paquetes anteriores restaurados; verificar servicios. No se restauraron bases de datos.'
  fi
  exit 1
}
trap rollback ERR
database_bytes=$(runuser -u postgres -- psql -XAt -v ON_ERROR_STOP=1 -d postgres -c "SELECT pg_database_size('superagente') + pg_database_size('evolution_db')")
available_bytes=$(df -B1 --output=avail /var/backups | tail -n 1 | tr -d ' ')
(( available_bytes > database_bytes + 1073741824 ))
printf '%s\n' "$before" > "$backup/previous-commit.txt"
git -c safe.directory="$ROOT" -C "$ROOT" bundle create "$backup/repository.bundle" --all
git -c safe.directory="$ROOT" -C "$ROOT" bundle verify "$backup/repository.bundle"
tar -C /etc -czf "$backup/config.tar.gz" lyn
systemctl cat lyn-backend lyn-evolution > "$backup/services.txt"
runuser -u postgres -- pg_dump -Fc superagente > "$backup/superagente.dump"
runuser -u postgres -- pg_dump -Fc evolution_db > "$backup/evolution_db.dump"
pg_restore --list "$backup/superagente.dump" >/dev/null
pg_restore --list "$backup/evolution_db.dump" >/dev/null
(cd "$backup"; sha256sum previous-commit.txt repository.bundle config.tar.gz services.txt superagente.dump evolution_db.dump > SHA256SUMS; sha256sum -c SHA256SUMS)
echo "RESPALDO VERIFICADO: $backup"
for component in backend evolution-api; do
  mkdir -p "$stage/$component" "$backup/$component"
  gitlyn show "$expected:$component/package-lock.json" > "$stage/$component/next-lock.json"
  node - "$ROOT/$component" "$stage/$component/next-lock.json" <<'NODE'
const fs = require('node:fs');
const root = process.argv[2];
const previous = JSON.parse(fs.readFileSync(root + '/package-lock.json'));
const next = JSON.parse(fs.readFileSync(process.argv[3]));
const allowed = new Set(['', 'node_modules/compression', 'node_modules/proxy-addr']);
for (const key of new Set([...Object.keys(previous.packages), ...Object.keys(next.packages)])) {
  if (!allowed.has(key) && JSON.stringify(previous.packages[key]) !== JSON.stringify(next.packages[key])) throw new Error('Cambio de dependencia no previsto: ' + key);
}
const beforeManifest = structuredClone(previous.packages['']);
beforeManifest.dependencies.compression = next.packages[''].dependencies.compression;
if (JSON.stringify(beforeManifest) !== JSON.stringify(next.packages[''])) throw new Error('Manifiesto fuera del alcance');
for (const [name, version] of [['compression', '1.8.2'], ['proxy-addr', '2.0.8']]) {
  const locked = next.packages['node_modules/' + name];
  if (locked.version !== version || locked.resolved !== `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`) throw new Error('Paquete inesperado');
  const installed = JSON.parse(fs.readFileSync(root + '/node_modules/' + name + '/package.json'));
  if (installed.version !== previous.packages['node_modules/' + name].version) throw new Error('La instalación no coincide con el lock anterior');
}
NODE
  for package in compression proxy-addr; do
    archive="$stage/$component/$package.tgz"
    url=$(node -p "require('$stage/$component/next-lock.json').packages['node_modules/$package'].resolved")
    curl --fail --silent --show-error --location --proto '=https' --max-time 120 "$url" -o "$archive"
    node - "$stage/$component/next-lock.json" "$package" "$archive" <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const locked = JSON.parse(fs.readFileSync(process.argv[2])).packages['node_modules/' + process.argv[3]];
const actual = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(process.argv[4])).digest('base64');
if (actual !== locked.integrity) throw new Error('Integridad del paquete inválida');
NODE
    mkdir "$stage/$component/$package"
    tar -xzf "$archive" --strip-components=1 -C "$stage/$component/$package"
    if [[ -d "$ROOT/$component/node_modules/$package/node_modules" ]]; then
      cp -a "$ROOT/$component/node_modules/$package/node_modules" "$stage/$component/$package/node_modules"
    fi
    chmod 0755 "$stage/$component/$package"
    NODE_PATH="$ROOT/$component/node_modules" node -e "if(typeof require('$stage/$component/$package') !== 'function') throw Error('Carga inválida')"
  done
done
grep -q 'require("compression")' "$ROOT/evolution-api/dist/main.js"
idle
gitlyn diff --quiet HEAD
swapping=true
systemctl stop lyn-backend lyn-evolution
idle
gitlyn merge --ff-only "$expected"
for component in backend evolution-api; do
  for package in compression proxy-addr; do
    mv "$ROOT/$component/node_modules/$package" "$backup/$component/$package"
    mv "$stage/$component/$package" "$ROOT/$component/node_modules/$package"
  done
done
systemctl start lyn-evolution
port=$(sed -n 's/^SERVER_PORT=//p' /etc/lyn/evolution.env | tail -n 1 | tr -d '\r')
[[ "$port" =~ ^[0-9]+$ ]]
ready=false
for ((attempt=0; attempt<60; attempt++)); do
  if curl --fail --silent --connect-timeout 2 --max-time 3 "http://127.0.0.1:$port/" >/dev/null; then ready=true; break; fi
  sleep 2
done
[[ "$ready" == true ]]
systemctl start lyn-backend
source "$ROOT/deploy/scripts/readiness.sh"
wait_for_backend /etc/lyn/backend.env
systemctl is-active lyn-backend lyn-evolution nginx
curl --fail --silent --show-error --max-time 20 https://ceo.grupolyn.com/health
swapping=false
echo
echo "PMC Y SEGURIDAD DESPLEGADOS: $expected. Respaldo: $backup"
