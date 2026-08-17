#!/usr/bin/env bash
set -euo pipefail

ROOT=/opt/lyn

value_of() {
  local file="$1"
  local key="$2"
  sed -n "s/^${key}=//p" "$file" | tail -n 1
}

require_value() {
  local file="$1"
  local key="$2"
  local value
  value="$(value_of "$file" "$key")"
  [[ -n "$value" && "$value" != *REEMPLAZA_* ]] || { echo "Falta $key en $file" >&2; return 1; }
}

check_instance() {
  local backend_env="$1"
  local evolution_env="$2"
  [[ -r "$backend_env" && -r "$evolution_env" ]] || { echo "No se pueden leer los archivos de entorno." >&2; return 1; }
  if grep -q 'REEMPLAZA_' "$backend_env" "$evolution_env"; then
    echo "Hay valores REEMPLAZA_ sin configurar." >&2
    return 1
  fi
  local backend_keys=(NODE_ENV PORT BIND_HOST DATABASE_URL EVOLUTION_API_URL EVOLUTION_API_KEY INSTANCE_NAME WEBHOOK_URL PUBLIC_APP_URL WEBHOOK_SECRET CEO_INITIAL_PASSWORD CEO_SESSION_SECRET CORS_ALLOWED_ORIGINS GOOGLE_GEMINI_API_KEY)
  local evolution_keys=(SERVER_PORT DATABASE_CONNECTION_URI AUTHENTICATION_API_KEY)
  for key in "${backend_keys[@]}"; do require_value "$backend_env" "$key"; done
  for key in "${evolution_keys[@]}"; do require_value "$evolution_env" "$key"; done
  [[ "$(value_of "$backend_env" BIND_HOST)" == '127.0.0.1' ]] || { echo 'BIND_HOST debe ser 127.0.0.1 en producción.' >&2; return 1; }
  [[ "$(value_of "$backend_env" WEBHOOK_URL)" == https://* ]] || { echo 'WEBHOOK_URL debe usar HTTPS.' >&2; return 1; }
  [[ "$(value_of "$backend_env" PUBLIC_APP_URL)" == https://* ]] || { echo 'PUBLIC_APP_URL debe usar HTTPS.' >&2; return 1; }
  [[ "$(value_of "$backend_env" CORS_ALLOWED_ORIGINS)" == https://* ]] || { echo 'CORS_ALLOWED_ORIGINS debe usar HTTPS.' >&2; return 1; }
  [[ "$(value_of "$backend_env" EVOLUTION_API_KEY)" == "$(value_of "$evolution_env" AUTHENTICATION_API_KEY)" ]] || { echo 'EVOLUTION_API_KEY y AUTHENTICATION_API_KEY deben coincidir.' >&2; return 1; }
}

[[ "$(id -u)" -eq 0 ]] || { echo 'Ejecuta este preflight con sudo.' >&2; exit 1; }
[[ -d "$ROOT/backend" && -d "$ROOT/frontend" && -d "$ROOT/evolution-api" ]] || { echo "No se encontró el proyecto en $ROOT." >&2; exit 1; }

if [[ -d /etc/lyn/instances ]] && find /etc/lyn/instances -mindepth 1 -maxdepth 1 -type d -print -quit | grep -q .; then
  while IFS= read -r -d '' instance_dir; do
    check_instance "$instance_dir/backend.env" "$instance_dir/evolution.env"
  done < <(find /etc/lyn/instances -mindepth 1 -maxdepth 1 -type d -print0)
else
  check_instance /etc/lyn/backend.env /etc/lyn/evolution.env
fi

nginx -t
printf 'Preflight de producción aprobado.\n'