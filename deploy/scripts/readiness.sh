#!/usr/bin/env bash

wait_for_backend() {
  local env_file="$1"
  local port attempt
  port="$(sed -n 's/^PORT=//p' "$env_file" | tail -n 1 | tr -d '\r')"
  [[ "$port" =~ ^[0-9]+$ ]] && (( port > 0 && port <= 65535 )) || {
    echo "PORT inválido en $env_file" >&2
    return 1
  }
  for ((attempt=0; attempt<60; attempt++)); do
    if curl --fail --silent --show-error --connect-timeout 2 --max-time 3 "http://127.0.0.1:$port/ready" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "Backend no preparado en puerto $port. No se publicará el nuevo dashboard." >&2
  return 1
}
