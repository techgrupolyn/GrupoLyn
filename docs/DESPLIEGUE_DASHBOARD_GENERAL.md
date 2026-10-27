# Desplegar el Dashboard General

Esta guía es para actualizar la instalación existente de Grupo LYN en AWS Lightsail. El Dashboard General y la vista CEO son la misma aplicación. No configura una instancia desde cero; para eso consulta [Producción en Lightsail](PRODUCCION_LIGHTSAIL.md).

## Antes de empezar

- Acceso autorizado a GitHub y SSH a la instancia; permisos `sudo` para ejecutar los scripts y consultar servicios.
- PR integrado en `main`, con una aprobación ajena al autor, rama actualizada y los cuatro checks de **Quality Gate** en verde para el SHA que se desplegará: `Backend`, `Dashboard`, `Evolution compatibility and security` y `Extension`. No desplegar un PR abierto ni una rama local.
- Ventana de despliegue comunicada al equipo y posibilidad de volver al commit anterior. Coordinar los cambios de esquema o servicios con quien mantenga esas integraciones.
- Node 22.16+ o 24, `npm`, `rsync`, Nginx, PostgreSQL y servicios `systemd` operativos. Comprobar espacio libre y memoria antes de compilar.
- Credenciales de producción **ya configuradas** en `/etc/lyn/backend.env` y `/etc/lyn/evolution.env` (o `/etc/lyn/instances/<instancia>/`). Nunca copiarlas al repositorio ni imprimirlas en un chat o log público. Las claves requeridas figuran en `deploy/env/*.production.env.example`; `preflight.sh` valida las obligatorias sin revelar su valor. Las integraciones opcionales solo se habilitan si la funcionalidad está aprobada y configurada.

## 1. Identificar la versión y respaldar

Conéctate a la instancia y ejecuta lo siguiente allí, no en tu ordenador. La instalación existente está en `/opt/lyn`; confirma la ruta antes de continuar.

```bash
cd /opt/lyn
git remote -v
git status --short
git rev-parse HEAD
df -h /opt/lyn /var/backups/lyn
free -h
sudo systemctl is-active lyn-backend lyn-evolution nginx
```

Anota el SHA anterior. **Detente si `git status --short` muestra cambios**: no uses `reset --hard`, `clean`, `stash` o un `pull` que pueda mezclar trabajo local. Pide que se identifiquen y preserven esos cambios antes de seguir. En instalaciones con varias instancias, comprueba también los servicios `lyn-backend@<instancia>` y `lyn-evolution@<instancia>`.

Antes de migraciones, confirma un respaldo recuperable de ambas bases, configuración y archivos servidos. El script siguiente presupone PostgreSQL **local** con bases `superagente` y `evolution_db`; si la instalación usa otros nombres o un servidor externo, usa el procedimiento de esa instalación. Verifica el resultado y conserva una copia fuera de la instancia:

```bash
sudo bash /opt/lyn/deploy/scripts/backup-postgres.sh
sudo find /var/backups/lyn -maxdepth 1 -type f -name '*.dump' -printf '%f %s bytes\n'
```

El script valida el formato con `pg_restore --list`, pero eso **no prueba una restauración**. Comprueba también que existe un snapshot reciente de Lightsail o respaldo equivalente de `/opt/lyn`, `/etc/lyn` y `/var/www/lyn/dashboard`. No continúes si el respaldo necesario no está disponible.

## 2. Actualizar solo desde `main`

Consulta el SHA del merge aprobado en GitHub. En el servidor:

```bash
sudo -u lyn git -C /opt/lyn fetch origin main
sudo -u lyn git -C /opt/lyn status --short
sudo -u lyn git -C /opt/lyn pull --ff-only origin main
sudo -u lyn git -C /opt/lyn rev-parse HEAD
```

El último SHA debe coincidir con el merge aprobado y con sus checks. Si hay cambios locales, falla `--ff-only` o el SHA no coincide, **detente**; no fuerces la actualización. No copies `.env`, `node_modules` ni respaldos desde desarrollo.

## 3. Desplegar

```bash
sudo bash /opt/lyn/deploy/scripts/preflight.sh
sudo bash /opt/lyn/deploy/scripts/deploy.sh
```

Espera a que cada comando termine con código 0. `deploy.sh` instala dependencias, compila backend/Evolution/frontend, aplica migraciones, reinicia los servicios, espera `/ready` y después publica el dashboard. No ejecutes compilaciones paralelas en la instancia. Una migración de base de datos **no se revierte** solo cambiando el código.

## 4. Comprobar y cerrar

```bash
sudo systemctl is-active lyn-backend lyn-evolution nginx
curl -fsS http://127.0.0.1:3003/ready
curl -fsS https://ceo.grupolyn.com/health
curl -fsSI https://ceo.grupolyn.com/
sudo journalctl -u lyn-backend -u lyn-evolution -n 80 --no-pager
sudo nginx -t
```

Si el puerto o los nombres de servicio difieren, usa los de la instancia configurada. Abre el Dashboard General y la vista CEO (`https://ceo.grupolyn.com/?view=ceo`): comprueba login, rol, navegación y el flujo afectado por el PR. En WhatsApp, comprueba el estado de la cuenta sin enviar mensajes de prueba a clientes. Registra SHA, hora, checks, respaldo y resultado de las comprobaciones en el ticket de despliegue. Un `200` en `/health` no sustituye la prueba funcional.

## 5. Si falla: volver atrás

1. Detén la publicación; conserva el SHA fallido y los logs. No borres datos ni secretos. Si falla antes de publicar el HTML, revisa si el script dejó el dashboard anterior intacto.
2. Si el problema es solo del frontend, `deploy.sh` guarda `/var/www/lyn/dashboard/.index.html.previous`. Con supervisión, restaura ese HTML **solo si** el backend anterior sigue siendo compatible; los assets antiguos permanecen en la carpeta. Verifica inmediatamente el sitio.
3. Para revertir código, prepara un **PR de revert** del merge, exige los mismos checks y aprobación, intégralo en `main` y repite los pasos 2–4. No hagas `git reset --hard` ni push directo a `main`. Si el servidor tiene cambios locales, resuélvelos primero sin descartarlos.
4. Si una migración incompatibiliza la versión anterior, no ejecutes un deploy antiguo contra la base nueva. Coordina una corrección hacia delante o una restauración completa desde el respaldo verificado. Restaurar bases requiere detener escrituras, guardar el estado fallido y aceptar expresamente la posible pérdida de datos posteriores al respaldo.

## Control de PR

La protección de `main` debe exigir PR, al menos **una aprobación**, rama actualizada antes del merge (checks estrictos), los cuatro jobs de **Quality Gate** y prohibir bypass/push directo. Si GitHub marca el PR como desactualizado, actualiza su rama con `main`, resuelve conflictos y espera los checks nuevos antes de integrar. No uses una aprobación antigua si hubo cambios relevantes después de la revisión.

Antes de activar la regla, avisa al equipo y revisa los PR abiertos para que sus autores puedan terminar o actualizar sus ramas. En GitHub, un administrador del repositorio debe ir a **Settings → Branches → Add branch protection rule** (o **Settings → Rules → Rulesets**), apuntar solo a `main` y configurar:

1. **Require a pull request before merging** y **Require approvals: 1**. Activa **Dismiss stale pull request approvals when new commits are pushed** para que los cambios posteriores requieran nueva revisión.
2. **Require status checks to pass before merging** con **Require branches to be up to date before merging**. Selecciona los cuatro checks que emite `.github/workflows/quality.yml`: `Backend`, `Dashboard`, `Evolution compatibility and security` y `Extension`. Si los nombres aparecen con prefijo de workflow, usa el nombre exacto mostrado por GitHub; no selecciones checks de otra fuente.
3. Aplica la regla a administradores, sin excepciones ni bypass no documentado. No permitas force push ni borrado de `main`. No actives una merge queue sin añadir primero el evento `merge_group` a la CI.
4. Guarda y **verifica** con una rama de prueba que un PR desactualizado queda bloqueado, que exige aprobación y checks, y que un push directo a `main` es rechazado. No uses datos ni cambios productivos para esa prueba; elimina la rama de prueba cuando termine.

Si GitHub no ofrece estas opciones para el plan del repositorio privado o no tienes permisos de administración, no declares la protección activa: solicita al propietario del repositorio que habilite el plan/permisos necesarios y repita la verificación.
