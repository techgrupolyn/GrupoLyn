# Panel de marketing (épico 869fny1et)

Dashboard › Marketing › **Panel de marketing** (`?view=marketing`). Implementa la base común (M-1) y los gráficos del mockup de Producto del 10/11/2026 (`Panel_marketing_mockups_LYN.html`, adjunto en ClickUp) con datos reales:

| Pestaña | Qué muestra | Estado |
|---|---|---|
| Filtros · Reuniones F2 | Tabla de F2 celebradas por selección, con el total sin duplicados | Con datos |
| 1 · Calidad de los leads | Barras apiladas por letra, «Al entrar» / «Tras la gestión», % / número | Con datos. «Al entrar» es provisional (ver abajo) |
| 2 · Coste por fase | €/espera (ajustado por letra), €/visita, €/diseño, €/seguimiento, €/ganado con objetivos | Con datos |
| 3 · Conversión entre fases | Nº que llega o % desde la fase anterior | Con datos |
| 4 · Cambio de valoración | Variación de la nota media a igual antigüedad | **Sin datos**: necesita el histórico de letras de N-1.2 |
| 5 · Nota comercial | Nota media del calificador interno por fase, con media y objetivo | Con datos de F0. Solo roles de `MARKETING_NOTA_ROLES` |
| Datos y avisos | Última carga, leads sin atribución, preguntas abiertas | — |

Reglas comunes, como en el mockup: árbol permanente con atajos, «Seleccionar todo» con su alcance, exclusiones y estado parcial; «Desglosar por» aparte; los 6 últimos meses completos y las 4 últimas semanas completas (lunes a domingo) a la vez, por **fecha de alta del lead en hora de Madrid**; selector Real / Ponderado; selección por defecto Google + Meta Alicante, Murcia y Sureste.

## Diseño

La interfaz sigue el mockup de Producto del 10/11/2026: las mismas pestañas, controles, textos y notas «Especificación de Alex y dudas», el botón «Ejecutar la prueba de Alex», «Notas para la reunión» y el selector de tema. Diferencias con el mockup, todas por usar datos reales:
- **Gráfico 4:** no tiene datos hasta que exista el histórico de letras (N-1.2).
- **«No apto»:** se suma a D (pregunta abierta del mockup).
- **Datos de la instalación:** el estado de las cargas y el botón «Cargar datos ahora» están en «Notas para la reunión › Datos de esta instalación».
- **Colores de la calidad:** las letras son ordinales y van en un solo tono (azul) con la luminosidad ordenada, más «Sin valorar» en gris. La rampa está validada con el validador de paletas contra el fondo de cada tema.

**Leads de respaldo.** Mientras la carga de ClickUp no haya funcionado nunca, el panel usa los leads que cuenta Meta en sus formularios (`actions_lead` de Windsor, columna `mk_gasto_diario.leads_plataforma`):
- Entran como «Sin valorar», porque Meta no da letra ni fase.
- Así se ven el volumen (gráfico 1), el coste por lead (€/espera, gráfico 2) y la fase «Lead» (gráfico 3).
- El panel abre en el gráfico 1 y lo indica en la cabecera.
- Visitas, diseños, seguimiento, obras y letras solo existen en ClickUp.
- En cuanto haya una carga de ClickUp correcta, el panel deja de usar los leads de Meta.

## Datos

Todo es agregado o seudónimo: **ningún nombre, teléfono ni email de un lead** sale de ClickUp ni se guarda.

| Tabla | Origen | Contenido |
|---|---|---|
| `mk_gasto_diario` | Windsor.ai (solo lectura) | Gasto, clics e impresiones por día y anuncio (Meta) o campaña (Google) |
| `mk_lead` | ClickUp, lista «Contacto de Reforma» (`MARKETING_CLICKUP_LIST`), solo tareas padre | Hash del lead, fecha de alta, canal, UTM, letra de entrada y vigente, importe, etapa y si llegó a visita / diseño / seguimiento / ganado |
| `mk_valor_letra`, `mk_curva_maduracion` | Tabla central de ponderaciones (editable en el panel) | A++, A+ y A = 1 · B 0,75 · C 0,45 · D 0,15 · No apto 0; curvas iniciales del mockup |
| `mk_zona_regla`, `mk_familia_creativa` | Reglas editables (`PUT /api/marketing/reglas`) | Zona por nombre de campaña (gana la que aparece antes) y familia por nombre de anuncio |
| `mk_carga` | Registro | Cada carga, con su resultado |
| `llamada_evaluacion` | Calificador interno (869e9y98n) | Nota comercial: `sdr` → F0, `closer_f2` → F2, `closer_f3` → F3 |

Reglas que decide el código (`backend/marketing/atribucion.ts`, `clickup.ts`, `panel.ts`):

- **Canal**: manda `utm_source`; si no hay, el campo `canal` de ClickUp: 1 Tally · 2 Google · 3, 3.1 y 3.2 Meta (P-06) · el resto, «Otros canales».
- **«Llegó a la fase k»**: sello `T_ek` o el de una fase posterior (`T_e4` visita, `T_e5` diseño, `T_e11` seguimiento, `T_e14` ganado).
- **Atribución a campaña y anuncio**: por `utm_campaign` (nombre de campaña) y `utm_id`/`ad_id` si llega; si no, por `utm_content` (nombre del anuncio). Con dos anuncios del mismo nombre gana el del conjunto de `utm_term` y luego el de más gasto. Un lead nunca se reparte. Los leads sin campaña van a «Sin zona › Sin campaña».
- **Letra «Al entrar»**: hasta que N-1.2 guarde el histórico de letras, es la letra que tenía el lead la primera vez que lo cargó el panel (`COALESCE` en `mk_lead.letra_entrada`). Los leads anteriores a la primera carga entran con su letra vigente.
- **Ponderado** = observado ÷ F(hito, antigüedad media del periodo); por debajo de 0,05 no se estima. Gasto, leads, €/espera y calidad «Al entrar» son siempre reales.
- **Campañas excluidas:** una regla de zona con valor `Excluida` saca la campaña del panel (gasto y leads). Viene cargada para «Ofertas de trabajo», que es contratación. El gasto excluido se indica en «Datos y avisos».
- **Gráfico 5:** solo cuenta la evaluación automática de cada llamada. Las reevaluaciones del calificador (869fpj8dm) no cuentan.

## Carga

Diaria e idempotente (`backend/marketing/carga.ts`): cada 15 minutos comprueba si ya pasó `MARKETING_CARGA_HORA` (6:00 Madrid) y si falta la carga correcta del día de cada fuente.

- **Windsor**: sustituye en una transacción el gasto desde el día 1 de hace 7 meses hasta ayer.
- **ClickUp**: sustituye los leads; los que ya no están en la lista se borran. Una lectura vacía es un error y conserva los datos anteriores.
- Carga manual: botón «Cargar datos ahora» del panel o `POST /api/marketing/cargar` (roles de edición).
- **Sin clave de Windsor en el backend:** `npx tsx --env-file=.env scripts/marketing-importar-windsor.ts exportacion.json` importa una exportación JSON de Windsor (los mismos campos que la API) y lo deja registrado en `mk_carga`.
- **Sin permiso en ClickUp:** la API devuelve la lista de tareas vacía, no un error. La carga comprueba entonces la lista y deja el motivo real en `mk_carga` (p. ej. `ACCESS_065`). El panel muestra un aviso: «Todavía no hay leads».

## Variables

| Variable | Uso |
|---|---|
| `WINDSOR_API_KEY` | Clave de Windsor. Sin ella no hay gasto |
| `MARKETING_WINDSOR_META_ACCOUNTS` | Opcional: limita las cuentas (`select_accounts`, número de cuenta sin prefijo) |
| `MARKETING_WINDSOR_GOOGLE` | `true` cuando Google Ads esté conectado en Windsor |
| `CLICKUP_API_TOKEN` | Token con lectura de «Contacto de Reforma». Sin acceso al espacio, la carga queda en error con `ACCESS_065` |
| `MARKETING_CLICKUP_LIST` | Id de la lista «Contacto de Reforma» en ClickUp. Obligatorio para cargar leads |
| `MARKETING_HASH_SALT` | Sal del hash de los leads. No cambiarla: los leads se recrean y se pierde la letra de entrada |
| `MARKETING_CARGA_HORA` / `MARKETING_CARGA_ENABLED` | Hora de la carga diaria / `false` para apagarla |
| `MARKETING_ACCESS_ROLES` | Quién ve el panel. Por defecto superadmin, admin, ceo, director y director general. Debe coincidir con `MARKETING_ACCESS_ROLES` de `frontend/src/ceo-dashboard/CeoLogin.jsx` |
| `MARKETING_NOTA_ROLES` | Quién ve la nota comercial (Dirección y Ernesto). Ernesto necesita además un rol que pase `requireCeoAuth` |
| `MARKETING_EDIT_ROLES` | Quién guarda ponderaciones y reglas, y lanza cargas. Por defecto superadmin, admin, ceo |

## API

`GET /api/marketing/panel` · `PUT /api/marketing/ponderaciones` · `GET`/`PUT /api/marketing/reglas` · `POST /api/marketing/cargar`. Todas con sesión de administración del Dashboard.

## Pendiente

- **Datos**: acceso de solo lectura del token a «Contacto de Reforma»; atribución en Tally y en los anuncios (869fnzbwu); histórico de letras (N-1.2) para el gráfico 4; Google Ads en Windsor.
- **Windsor, comprobado en real (12/11/2026):** la carga por API trae el gasto y los leads de Meta por anuncio con los campos que espera el código. Falta comprobar contra la lista real los campos de ClickUp (`canal`, `ETAPA_CRM`, `T_e*`, `Categoría`/`valoracion_interna`, `presupuesto_estimado`, `utm_*`).
- **Producto y Dirección**: P-01, P-03, P-04, P-06, P-08 del épico; qué es A++ y si «No apto» va en el gráfico 1.

Depende del PR #33 (rúbricas del calificador): el gráfico 5 usa la columna `llamada_evaluacion.reevaluacion`.

Reversión: `backend/marketing/schema-down.sql`.
