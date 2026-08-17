#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Uso: sudo $0 <instancia> <dominio> <puerto-backend> <puerto-evolution>"
  echo "Ejemplo: sudo $0 ventas ventas.example.com 3004 8081"
}

if [[ $(id -u) -ne 0 || $# -ne 4 ]]; then
  usage
  exit 1
fi

instance="$1"
domain="$2"
backend_port="$3"
evolution_port="$4"
root=/opt/lyn
instance_dir="/etc/lyn/instances/$instance"

[[ "$instance" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || { echo "Instancia inválida." >&2; exit 1; }
[[ "$domain" =~ ^[A-Za-z0-9.-]+$ && "$domain" == *.* ]] || { echo "Dominio inválido." >&2; exit 1; }
[[ "$backend_port" =~ ^[0-9]+$ && "$backend_port" -ge 1024 && "$backend_port" -le 65535 ]] || { echo "Puerto backend inválido." >&2; exit 1; }
[[ "$evolution_port" =~ ^[0-9]+$ && "$evolution_port" -ge 1024 && "$evolution_port" -le 65535 && "$evolution_port" != "$backend_port" ]] || { echo "Puerto Evolution inválido." >&2; exit 1; }
[[ ! -e "$instance_dir" ]] || { echo "La instancia $instance ya existe." >&2; exit 1; }
[[ ! -e "/etc/nginx/sites-available/lyn-$instance.conf" ]] || { echo "Ya existe una configuración Nginx para $instance." >&2; exit 1; }
if grep -Rqs "127.0.0.1:$backend_port" /etc/nginx/sites-available/lyn-*.conf 2>/dev/null; then
  echo "El puerto backend $backend_port ya está asignado." >&2
  exit 1
fi
if grep -Rqs "^SERVER_PORT=$evolution_port$" /etc/lyn/instances 2>/dev/null; then
  echo "El puerto Evolution $evolution_port ya está asignado." >&2
  exit 1
fi

install -d -o root -g lyn -m 0750 "$instance_dir"
install -o root -g lyn -m 0640 "$root/deploy/env/instance/backend.env.example" "$instance_dir/backend.env"
install -o root -g lyn -m 0640 "$root/deploy/env/instance/evolution.env.example" "$instance_dir/evolution.env"

for env_file in "$instance_dir/backend.env" "$instance_dir/evolution.env"; do
  sed -i "s/__INSTANCE__/$instance/g; s/__DOMAIN__/$domain/g; s/__BACKEND_PORT__/$backend_port/g; s/__EVOLUTION_PORT__/$evolution_port/g" "$env_file"
done

sed "s/__DOMAIN__/$domain/g; s/__BACKEND_PORT__/$backend_port/g" \
  "$root/deploy/nginx/lyn-instance.conf.template" > "/etc/nginx/sites-available/lyn-$instance.conf"
ln -s "/etc/nginx/sites-available/lyn-$instance.conf" "/etc/nginx/sites-enabled/lyn-$instance.conf"

systemctl daemon-reload
nginx -t

echo "Instancia $instance creada. Edita primero:"
echo "  $instance_dir/backend.env"
echo "  $instance_dir/evolution.env"
echo "Luego crea las bases superagente_$instance y evolution_$instance, instala TLS y ejecuta:"
echo "  sudo $root/deploy/scripts/start-instance.sh $instance"