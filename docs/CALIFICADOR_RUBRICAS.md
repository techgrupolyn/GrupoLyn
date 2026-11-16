# Rúbricas del calificador: publicar un guion nuevo y reevaluar (869fpj8dm)

El calificador interno de llamadas puntúa con la **rúbrica vigente del rol**, guardada en la tabla `rubrica_version`, no en el código. Cambiar el guion es publicar una versión nueva: **no hace falta desplegar**.

- **SDR:** `sdr-v1`, los 7 pasos del «Guion completo SDR» con sus pesos (5 · 25 · 15 · 20 · 10 · 10 · 15) y 3 errores críticos (REGLA CERO, LÍMITE PROFESIONAL y EXCEPCIÓN SIN AUTORIZACIÓN). Se carga sola la primera vez desde `backend/netelip/calificador/rubricas/sdr-v1.json`.
- **Closers (F2, F3 y F4):** no se evalúan hasta que tengan versión propia activa (CAL-06). Sus llamadas quedan «No evaluada» con el motivo «sin rúbrica para el rol closer_f2» (o el que corresponda). Si la rúbrica se activa en los 2 días siguientes a la transcripción, la llamada se evalúa con ella. La rúbrica fija `fase0-v1` (`rubrica-v1.md`) solo se usa para el SDR si no tuviera versión activa.
- **Nota:** el modelo puntúa cada paso (0 hasta su peso, o «no aplica» según el tipo de llamada) y **el código** calcula la nota sobre 100 con los pasos que aplican. Apto: nota ≥ `nota_apto` (80) y sin errores críticos.
- **Versión guardada:** cada evaluación guarda su versión (`version_rubrica`, `rubrica_version_id`) y la nota por paso (`puntuacion_pasos`), que se ven en el detalle de la llamada.
- **Consentimiento:** si en la transcripción el cliente no autoriza la grabación («prefiero que no se grabe», o «sin problema, tomo las notas yo» tras preguntar), la llamada **no se envía al modelo**, queda «sin consentimiento» y no se guardan objeciones. Una reevaluación nunca la incluye.

Todas las órdenes se lanzan desde `backend/`, con el `.env` del entorno:

```bash
npx tsx --env-file=.env scripts/calificador-rubrica.ts <orden>
```

## Publicar una versión nueva del guion

1. Copia `backend/netelip/calificador/rubricas/sdr-v1.json` a un archivo nuevo y cambia:
   - `codigo` («sdr-v2») y `version` (2);
   - `fuente`: el documento y la fecha del guion;
   - los `criterios` (pasos, pesos que sumen 100 y descripción), `errores_criticos` y `reglas`.
2. Publícala y actívala:
   `publicar sdr-v2.json --activar`
   Sin `--activar` queda guardada pero inactiva; se activa después con `activar sdr-v2`.
3. Comprueba la versión vigente (●) con `listar`.

Desde ese momento **las llamadas nuevas** del rol se evalúan con la v2. Las evaluaciones anteriores conservan su versión y no se reevalúan solas. Para volver atrás: `activar sdr-v1`.

## Reevaluar llamadas antiguas bajo demanda

```bash
reevaluar --version sdr-v2 --desde 2026-11-01 --hasta 2026-11-15 --simular   # cuántas serían, sin crear nada
reevaluar --version sdr-v2 --desde 2026-11-01 --hasta 2026-11-15             # las evalúa la cola del backend
reevaluar --version sdr-v2 --desde 2026-11-01 --hasta 2026-11-15 --ahora     # o aquí mismo, sin esperar a la cola
```

- **Qué llamadas entran:** las del rol de esa versión ya evaluadas en el rango, por fecha de la llamada en hora de Madrid.
- **Qué hace:** crea una evaluación **nueva** por llamada, marcada como reevaluación. Nunca modifica la anterior.
- **Qué no hace:** no se envía al comercial por WhatsApp y no cuenta para el documento del entrenador.
- **Exclusiones:** las llamadas «sin consentimiento» se saltan. Una llamada que ya tiene evaluación con esa versión no se repite.
- **Dónde se ve:** el detalle de la llamada enseña la evaluación principal y, debajo, «Otras evaluaciones».
- **Coste:** una llamada al modelo por llamada reevaluada.

## Calibración con Alex y Ernesto

1. **Plantilla de 10 llamadas al azar:**
   `calibracion-plantilla --desde 2026-11-09 --hasta 2026-11-20 --n 10 > calibracion.csv`
   La plantilla no trae la nota de la IA.
2. **Puntuación a ciegas:** Alex o Ernesto escuchan cada llamada sin abrir su evaluación en el Dashboard y rellenan en el CSV `evaluador`, `nota_humana` (0-100) y `errores_humanos`. En `errores_humanos` van los códigos separados por comas, p. ej. `REGLA_CERO`, o nada.
3. **Informe:**
   `calibracion-informe calibracion.csv > informe-calibracion.md`
   - Hay acuerdo en una llamada si coinciden los errores críticos y la nota difiere 10 puntos o menos.
   - La calibración se supera con acuerdo en 8 de 10 llamadas.
   - Si no se supera: ajusta la rúbrica, publica una versión nueva, reevalúa esas llamadas y repite.

## Reversión

`backend/netelip/calificador/schema-down.sql` tiene, comentado, el bloque que quita solo las rúbricas versionadas. Ese bloque conserva las evaluaciones automáticas y vuelve a una evaluación por llamada.
