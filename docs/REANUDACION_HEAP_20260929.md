# Reanudación tras agotar heap en TypeScript

La unidad `lyn-recuperacion-2490cca` falló con código 134 durante `tsc --noEmit`, con heap de aproximadamente 463 MB. El proceso no llegó al empaquetado ni al intercambio de dist/reinicio. El checkout avanzó a `2490cca`, pero eso no acredita la actualización de los procesos activos.

`deploy/scripts/resume-phone-history-2490cca.sh` solo admite el commit completo `2490ccac84936e1d86e99f639e90edb596a11079` y el respaldo verificado `/var/backups/lyn/pre-global-summary-20260929T204026Z`, cuyo commit anterior es `96c7420`. Rechaza cambios locales en backend, Evolution o deploy y un intercambio ya iniciado. No hace pull, no reinstala dependencias, no modifica credenciales y no restaura bases de datos.

La revisión TypeScript de ese código ya se ejecutó localmente; esta reanudación omite únicamente repetir `tsc` en el servidor de poca RAM. Compila con tsup en un directorio nuevo y un heap máximo de 256 MiB para ese proceso, sin cambiar límites de memoria de los servicios. Verifica sintaxis, traducciones y presencia de la ruta. Solo entonces intercambia el bundle, conservando el anterior en el respaldo, y reinicia Evolution. Espera su respuesta HTTP local antes de reiniciar y comprobar el backend.

Extraer el script de su commit publicado y lanzarlo con una unidad systemd nueva. Si falla, conservar logs y no volver a ejecutar automáticamente. El marcador de éxito es `RECUPERACION DESPLEGADA: 2490ccac84936e1d86e99f639e90edb596a11079`. El éxito de despliegue no confirma que WhatsApp haya entregado el historial real.
