# PMC de Club LYN y correcciones HTTP

La versión incorpora el relleno seguro de PMC de proyectos y la mejora de calidad de informes pendiente de publicación. No modifica la extensión ni requiere reconstruir el dashboard.

Se actualizan exclusivamente `compression` 1.8.1 → 1.8.2 y `proxy-addr` 2.0.7 → 2.0.8 en backend y Evolution. Los manifiestos exigen `compression ^1.8.2`; ambos locks fijan las versiones corregidas. Avisos: https://github.com/advisories/GHSA-vc2v-76pw-4v95 y https://github.com/advisories/GHSA-jqcg-44mw-7w3h.

## Despliegue

Después de validar CI, ejecutar `deploy/scripts/deploy-pmc-security.sh COMMIT_COMPLETO` como root mediante una unidad transitoria de systemd. El script requiere main limpio, commit remoto aprobado, ausencia de análisis activos y espacio para respaldar ambas bases, configuración y repositorio. Comprueba los hashes del respaldo.

Prepara los dos paquetes desde las URLs HTTPS del lock y verifica SHA-512 antes de tocar los servicios. Rechaza cualquier otro cambio en el árbol de dependencias y conserva las dependencias anidadas existentes. Evolution debe seguir cargando compression externamente; no se compila TypeScript en la máquina de producción de 1 GB.

Tras una última comprobación de trabajos activos, detiene brevemente ambos servicios, actualiza el código y reemplaza solo esos dos directorios por componente. Conserva los anteriores en el respaldo. Comprueba readiness y salud pública. Ante fallo durante la sustitución intenta recuperar los paquetes y commit anteriores (HEAD separado); requiere revisar los servicios antes de otro intento. Nunca restaura automáticamente bases ni elimina sesiones de WhatsApp.

La sincronización del directorio completa PMC faltantes automáticamente. La cantidad depende de las asignaciones reales de Club LYN: no se inventan PMC para proyectos sin responsable o con varios candidatos. Comprobar los conteos y los vínculos tras desplegar; los informes históricos no se regeneran por este despliegue.

La comprobación posterior detectó un parámetro SQL sin tipo en la actualización de responsables de tareas, que revertía la transacción completa de etiquetado. Se tipa explícitamente el identificador nullable y se añade una regresión con una reunión vinculada y una tarea sin responsable identificable. La tarea conserva su responsable sin resolver y ya no bloquea la asignación del PMC de la reunión.
