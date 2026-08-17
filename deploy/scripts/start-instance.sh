#!/usr/bin/env bash
set -euo pipefail

if [[ $(id -u) -ne 0 || $# -ne 1 ]]; then
  echo "Uso: sudo $0 <instancia>" >&2
  exit 1
fi

instance="$1"
[[ "$instance" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || { echo "Instancia inválida." >&2; exit 1; }
backend_env="/etc/lyn/instances/$instance/backend.env"
evolution_env="/etc/lyn/instances/$instance/evolution.env"

[[ -r "$backend_env" && -r "$evolution_env" ]] || { echo "No existen los archivos de entorno de $instance." >&2; exit 1; }
if grep -q 'REEMPLAZA_' "$backend_env" "$evolution_env"; then
  echo "Hay valores REEMPLAZA_ sin configurar en los archivos de entorno." >&2
  exit 1
fi

systemctl enable --now "lyn-evolution@$instance.service"
systemctl enable --now "lyn-backend@$instance.service"
systemctl --no-pager --full status "lyn-evolution@$instance.service" "lyn-backend@$instance.service"