import { CRITERIOS_IDS, MATRIZ_V1, type CriterioConfig } from './matriz.ts';
import { TIPOS_PRESUPUESTO } from './tipos.ts';

// N-1.2 · Prompt de producción del agente que evalúa al LEAD con la matriz de 7 criterios.
// La tabla de la matriz se arma desde la configuración (los mismos descriptores que usa el código),
// así el prompt y el motor no se pueden desalinear. Temperatura 0 y salida JSON con esquema estricto.
// Cambiar el texto de las reglas o los ejemplos = subir VERSION_PROMPT.

export const VERSION_PROMPT = 'captacion-v3';

// ---------------------------------------------------------------------------------------------
// Esquema de la salida (formato de respuesta del modelo)
// ---------------------------------------------------------------------------------------------

const textoONull = { type: ['string', 'null'] };
const criterioConNivel = {
  type: 'object',
  properties: { nivel: { type: 'string', enum: ['A', 'B', 'C', 'D', 'NE'] }, cita: textoONull, marca_tiempo: textoONull },
  required: ['nivel', 'cita', 'marca_tiempo'],
};

export const ESQUEMA_SALIDA = {
  type: 'object',
  properties: {
    interaccion_id: { type: 'string' },
    presupuesto: {
      type: 'object',
      properties: {
        detectado: { type: 'boolean' },
        tipo: { type: ['string', 'null'], enum: [...TIPOS_PRESUPUESTO, null] },
        min: { type: ['integer', 'null'] },
        max: { type: ['integer', 'null'] },
        moneda: { type: ['string', 'null'], enum: ['EUR', null] },
        emisor: { type: ['string', 'null'], enum: ['cliente', 'lyn', null] },
        cita: textoONull,
        marca_tiempo: textoONull,
      },
      required: ['detectado', 'tipo', 'min', 'max', 'moneda', 'emisor', 'cita', 'marca_tiempo'],
    },
    presupuesto_insuficiente_sin_solucion: {
      type: 'object',
      properties: { valor: { type: 'boolean' }, cita: textoONull, marca_tiempo: textoONull },
      required: ['valor', 'cita', 'marca_tiempo'],
    },
    criterios: {
      type: 'object',
      properties: Object.fromEntries(
        CRITERIOS_IDS.map((id) => [
          id,
          id === 'urgencia'
            ? {
                type: 'object',
                properties: { plazo_meses: { type: ['number', 'null'] }, cita: textoONull, marca_tiempo: textoONull },
                required: ['plazo_meses', 'cita', 'marca_tiempo'],
              }
            : criterioConNivel,
        ]),
      ),
      required: [...CRITERIOS_IDS],
    },
    resumen: {
      type: 'object',
      properties: {
        que_quiere: { type: 'string' },
        donde_quedo: { type: 'string' },
        que_lo_frena: { type: 'string' },
        para_que_llamarlo: { type: 'string' },
        fecha_prevista: textoONull,
      },
      required: ['que_quiere', 'donde_quedo', 'que_lo_frena', 'para_que_llamarlo', 'fecha_prevista'],
    },
  },
  required: ['interaccion_id', 'presupuesto', 'presupuesto_insuficiente_sin_solucion', 'criterios', 'resumen'],
} as const;

// ---------------------------------------------------------------------------------------------
// Ejemplos (few-shot). No son llamadas reales. Las pruebas comprueban que cada salida cumple el
// contrato y que todas sus citas están literalmente en su transcripción.
// ---------------------------------------------------------------------------------------------

const NE = { nivel: 'NE', cita: null, marca_tiempo: null } as const;
const SIN_PLAZO = { plazo_meses: null, cita: null, marca_tiempo: null } as const;
const SIN_PRESUPUESTO = { detectado: false, tipo: null, min: null, max: null, moneda: null, emisor: null, cita: null, marca_tiempo: null } as const;
const SIN_NO_APTO = { valor: false, cita: null, marca_tiempo: null } as const;

export interface Ejemplo {
  titulo: string;
  contexto: string;
  transcripcion: string[];
  salida: Record<string, unknown>;
}

export const EJEMPLOS: readonly Ejemplo[] = [
  {
    titulo: 'Lead claro, con el rango que dice el cliente',
    contexto: 'interaccion_id ej-1 · llamada saliente del 2026-11-10 · 4 min',
    transcripcion: [
      '[00:00:05] GRUPO LYN: Hola [NOMBRE], soy Laura de Grupo LYN, te llamo por la reforma que nos consultaste.',
      '[00:00:30] CLIENTE: Sí, queremos reformar el piso entero, son unos cien metros.',
      '[00:01:10] CLIENTE: La idea es empezar en unos dos meses, en cuanto firmemos la compra.',
      '[00:01:40] CLIENTE: Lo decidimos mi marido y yo, y los dos lo tenemos clarísimo.',
      '[00:02:10] CLIENTE: Tenemos pensado entre 90 y 110 mil euros para toda la obra.',
      '[00:02:40] GRUPO LYN: Con ese rango vais holgados para lo que me cuentas.',
      '[00:03:05] CLIENTE: Nos gusta mucho que llevéis vosotros el diseño y toda la obra.',
      '[00:03:30] CLIENTE: Perfecto, nos vemos el jueves a las cinco en vuestra oficina.',
    ],
    salida: {
      interaccion_id: 'ej-1',
      presupuesto: { detectado: true, tipo: 'rango', min: 90000, max: 110000, moneda: 'EUR', emisor: 'cliente', cita: 'Tenemos pensado entre 90 y 110 mil euros para toda la obra', marca_tiempo: '00:02:10' },
      presupuesto_insuficiente_sin_solucion: SIN_NO_APTO,
      criterios: {
        presupuesto: { nivel: 'A', cita: 'Con ese rango vais holgados para lo que me cuentas', marca_tiempo: '00:02:40' },
        urgencia: { plazo_meses: 2, cita: 'La idea es empezar en unos dos meses', marca_tiempo: '00:01:10' },
        decisor: { nivel: 'A', cita: 'Lo decidimos mi marido y yo, y los dos lo tenemos clarísimo', marca_tiempo: '00:01:40' },
        alcance: { nivel: 'A', cita: 'queremos reformar el piso entero', marca_tiempo: '00:00:30' },
        actitud: NE,
        encaje_lyn: { nivel: 'A', cita: 'Nos gusta mucho que llevéis vosotros el diseño y toda la obra', marca_tiempo: '00:03:05' },
        predisposicion_f2f3: { nivel: 'A', cita: 'nos vemos el jueves a las cinco en vuestra oficina', marca_tiempo: '00:03:30' },
      },
      resumen: { que_quiere: 'Reforma integral de un piso de unos 100 m²', donde_quedo: 'Reunión en oficina el jueves a las cinco', que_lo_frena: 'Nada: falta firmar la compra', para_que_llamarlo: 'Confirmar la reunión del jueves', fecha_prevista: null },
    },
  },
  {
    titulo: 'Dudas de pareja, compara precio, «tengo que comentarlo en casa» y sin presupuesto',
    contexto: 'interaccion_id ej-2 · llamada saliente del 2026-11-10 · 3 min',
    transcripcion: [
      '[00:00:04] GRUPO LYN: Hola [NOMBRE], te llamo de Grupo LYN por tu solicitud.',
      '[00:00:25] CLIENTE: Queremos cambiar la cocina y los dos baños, el resto de la casa está bien.',
      '[00:01:00] CLIENTE: Prisa no tenemos, sería para dentro de un año o así.',
      '[00:01:30] CLIENTE: A mí me convence, pero mi mujer no lo ve claro y sin ella no decido.',
      '[00:02:00] CLIENTE: Estamos comparando precios con otras cuatro empresas antes de decidir nada.',
      '[00:02:30] GRUPO LYN: ¿Os vendría bien venir a la oficina la semana que viene?',
      '[00:02:40] CLIENTE: Tengo que comentarlo en casa, ya os digo algo.',
    ],
    salida: {
      interaccion_id: 'ej-2',
      presupuesto: SIN_PRESUPUESTO,
      presupuesto_insuficiente_sin_solucion: SIN_NO_APTO,
      criterios: {
        presupuesto: NE,
        urgencia: { plazo_meses: 12, cita: 'sería para dentro de un año o así', marca_tiempo: '00:01:00' },
        decisor: { nivel: 'C', cita: 'mi mujer no lo ve claro y sin ella no decido', marca_tiempo: '00:01:30' },
        alcance: { nivel: 'D', cita: 'Queremos cambiar la cocina y los dos baños, el resto de la casa está bien', marca_tiempo: '00:00:25' },
        actitud: NE,
        encaje_lyn: { nivel: 'C', cita: 'Estamos comparando precios con otras cuatro empresas antes de decidir nada', marca_tiempo: '00:02:00' },
        predisposicion_f2f3: { nivel: 'C', cita: 'Tengo que comentarlo en casa, ya os digo algo', marca_tiempo: '00:02:40' },
      },
      resumen: { que_quiere: 'Cambiar cocina y dos baños', donde_quedo: 'Quedó en comentarlo en casa', que_lo_frena: 'Su pareja no lo ve claro y compara precios', para_que_llamarlo: 'Proponer una llamada con los dos', fecha_prevista: null },
    },
  },
  {
    titulo: 'Presupuesto insuficiente y sin solución',
    contexto: 'interaccion_id ej-3 · llamada saliente del 2026-11-10 · 2 min',
    transcripcion: [
      '[00:00:05] GRUPO LYN: Hola [NOMBRE], soy Laura de Grupo LYN.',
      '[00:00:40] CLIENTE: Es una reforma integral de un piso de ochenta metros.',
      '[00:01:20] GRUPO LYN: Una reforma así se mueve entre 60.000 y 90.000 euros, como orientación.',
      '[00:01:45] CLIENTE: Uf, nosotros tenemos 25.000 euros y no podemos pedir financiación ni esperar.',
      '[00:02:10] GRUPO LYN: Entiendo. Con ese importe no podemos plantear una integral.',
    ],
    salida: {
      interaccion_id: 'ej-3',
      presupuesto: { detectado: true, tipo: 'exacto', min: 25000, max: 25000, moneda: 'EUR', emisor: 'cliente', cita: 'nosotros tenemos 25.000 euros y no podemos pedir financiación ni esperar', marca_tiempo: '00:01:45' },
      presupuesto_insuficiente_sin_solucion: { valor: true, cita: 'tenemos 25.000 euros y no podemos pedir financiación ni esperar', marca_tiempo: '00:01:45' },
      criterios: {
        presupuesto: { nivel: 'D', cita: 'Con ese importe no podemos plantear una integral', marca_tiempo: '00:02:10' },
        urgencia: SIN_PLAZO,
        decisor: NE,
        alcance: { nivel: 'A', cita: 'Es una reforma integral de un piso de ochenta metros', marca_tiempo: '00:00:40' },
        actitud: NE,
        encaje_lyn: NE,
        predisposicion_f2f3: NE,
      },
      resumen: { que_quiere: 'Reforma integral de un piso de 80 m²', donde_quedo: 'Sin siguiente paso', que_lo_frena: 'Tiene 25.000 € y no puede financiar ni esperar', para_que_llamarlo: 'No procede por ahora', fecha_prevista: null },
    },
  },
  {
    titulo: 'Rango que da LYN para este proyecto',
    contexto: 'interaccion_id ej-4 · llamada saliente del 2026-11-10 · 3 min',
    transcripcion: [
      '[00:00:06] GRUPO LYN: Hola [NOMBRE], te llamo de Grupo LYN para seguir con tu proyecto.',
      '[00:00:50] CLIENTE: Todavía no me he hecho una idea de cuánto puede costar.',
      '[00:01:20] GRUPO LYN: Por lo que me cuentas, tu proyecto estaría entre 60.000 y 80.000 euros.',
      '[00:01:50] CLIENTE: Vale, habrá que ajustar alguna cosa pero me encaja.',
      '[00:02:20] CLIENTE: Puedo ir a la oficina, aunque todavía no sé qué día.',
    ],
    salida: {
      interaccion_id: 'ej-4',
      presupuesto: { detectado: true, tipo: 'rango', min: 60000, max: 80000, moneda: 'EUR', emisor: 'lyn', cita: 'tu proyecto estaría entre 60.000 y 80.000 euros', marca_tiempo: '00:01:20' },
      presupuesto_insuficiente_sin_solucion: SIN_NO_APTO,
      criterios: {
        presupuesto: { nivel: 'B', cita: 'habrá que ajustar alguna cosa pero me encaja', marca_tiempo: '00:01:50' },
        urgencia: SIN_PLAZO,
        decisor: NE,
        alcance: NE,
        actitud: NE,
        encaje_lyn: NE,
        predisposicion_f2f3: { nivel: 'B', cita: 'Puedo ir a la oficina, aunque todavía no sé qué día', marca_tiempo: '00:02:20' },
      },
      resumen: { que_quiere: 'Seguir con su proyecto de reforma', donde_quedo: 'Acepta ir a la oficina, sin fecha', que_lo_frena: 'Tendrá que ajustar algo del alcance', para_que_llamarlo: 'Cerrar día y hora de la reunión', fecha_prevista: null },
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Texto del prompt
// ---------------------------------------------------------------------------------------------

const tablaMatriz = (matriz: readonly CriterioConfig[]): string =>
  [...matriz]
    .sort((a, b) => a.orden - b.orden)
    .map((c) => `${c.criterioId} (${c.nombre}) · A: ${c.descriptores.A} · B: ${c.descriptores.B} · C: ${c.descriptores.C} · D: ${c.descriptores.D}`)
    .join('\n');

const ejemplo = (e: Ejemplo, n: number): string =>
  `### Ejemplo ${n}: ${e.titulo}\nContexto: ${e.contexto}\n${e.transcripcion.join('\n')}\n\nSalida:\n${JSON.stringify(e.salida)}`;

export function promptSistema(matriz: readonly CriterioConfig[] = MATRIZ_V1): string {
  return `# Calificación de leads · Grupo LYN · matriz de 7 criterios · ${VERSION_PROMPT}

## Tu tarea
Lees la transcripción de una llamada REAL entre un comercial de Grupo LYN (reformas de vivienda) y un lead, y devuelves SOLO el JSON del esquema. Evalúas AL LEAD, no al comercial. No calculas ninguna categoría global ni puntuación: eso lo hace el código con lo que tú devuelves.

## Cómo leer la transcripción
- Viene por turnos: \`[hh:mm:ss] GRUPO LYN:\` es el comercial y \`[hh:mm:ss] CLIENTE:\` el lead. En las grabaciones reales estas etiquetas fallan a menudo: decide quién habla por el CONTENIDO y usa la etiqueta solo como pista.
- Los datos personales vienen sustituidos por marcadores como [NOMBRE], [TELÉFONO], [EMAIL], [DIRECCIÓN] o [DNI]: no intentes reconstruirlos.
- La transcripción es automática y puede tener palabras mal reconocidas. No saques conclusiones de un error evidente de transcripción.

## Regla principal: sin evidencia, NE
- A cada criterio le pones A, B, C o D SOLO si una frase de ESTA llamada lo demuestra. Si no se habló del tema, o solo puedes suponerlo, el nivel es "NE" con cita null y marca_tiempo null. NE no perjudica al lead; un nivel inventado sí.
- Todo nivel distinto de NE lleva una \`cita\` COPIADA LITERALMENTE de la transcripción: un fragmento continuo de 4 a 30 palabras, sin cambiar ni corregir nada y sin las marcas de turno. El código comprueba que la cita aparece tal cual; si no aparece, descarta el nivel.
- \`marca_tiempo\` es el minuto del turno de la cita, en formato hh:mm:ss.
- Evalúa lo que se dijo, nunca lo que «quizá quiso decir».

## Matriz
<matriz>
${tablaMatriz(matriz)}
</matriz>

## Criterios con regla propia
- urgencia: NO eliges nivel. Devuelves \`plazo_meses\`: en cuántos meses quiere el lead EMPEZAR la obra, como número («en tres meses» = 3; «para dentro de un año» = 12). Si da una fecha, calcula los meses desde la fecha de la llamada, que viene en el contexto. Si no menciona ningún plazo o es vago («cuando se pueda», «sin prisa»), plazo_meses es null, con cita null.
- presupuesto (criterio): cómo encaja el dinero del lead con lo que cuesta su proyecto, según lo que se dice en la llamada. Si no se habla de dinero, NE.
- predisposicion_f2f3: disposición a venir a la reunión presencial en la oficina de Alicante y seguir el proceso.

## Presupuesto mencionado (objeto \`presupuesto\`)
- \`detectado\` es true si alguien dice un importe o un rango para TODA esta reforma. Lo normal es lo que dice el lead (emisor "cliente"): «tenemos 90.000 euros para la obra». También cuenta la horquilla o el importe que da el comercial para el proyecto completo de este lead (emisor "lyn"), por ejemplo «¿estaríais en un rango de 40.000 a 60.000?», aunque el cliente solo conteste «sí» o «me parece bien» sin repetir la cifra: se registra con emisor "lyn". Los dos canales cuentan.
- NO cuenta, y entonces \`detectado\` es false: una referencia genérica del comercial («una vivienda de 90 m² se mueve entre 60.000 y 90.000»); el precio de un producto, una partida, una ampliación o un extra suelto («una ampliación te costaría 500 más», «la cocina sale por 12.000», «son 100 euros más»); ni un importe que sea solo una PARTE de la obra. El presupuesto inicial se mueve en rangos amplios (de decenas de miles de euros); una cifra de unos pocos cientos o miles de euros es casi siempre una ampliación o un extra.
- \`tipo\`: "exacto" (un importe: min = max), "rango" (min y max), "abierto_superior" («más de 80.000»: min = 80000, max = null) o "abierto_inferior" («como mucho 50.000»: min = null, max = 50000).
- \`min\` y \`max\` van en euros, como números enteros: «40k», «cuarenta mil» y «40.000 €» son 40000.
- Lleva su \`cita\` literal y su \`marca_tiempo\`. Si en la llamada hay más de un importe válido, devuelve el más reciente que siga en pie al final.
- Si no hay ninguno: detectado false y el resto de campos en null.

## Presupuesto insuficiente y sin solución
- \`valor\` es true SOLO si en la llamada queda claro que el dinero del lead no alcanza para lo que necesita Y no queda ninguna salida abierta (ni financiación, ni reducir el alcance, ni esperar). Lleva la cita literal que lo demuestra.
- Si en esta llamada el lead dice que ese problema ya está resuelto (consiguió financiación, amplió el presupuesto), \`valor\` es false CON la cita que lo demuestra.
- En cualquier otro caso: valor false, cita null y marca_tiempo null.

## Resumen
Cuatro frases cortas (20 palabras como máximo cada una), sin datos personales ni marcadores: \`que_quiere\`, \`donde_quedo\`, \`que_lo_frena\` y \`para_que_llamarlo\`. \`fecha_prevista\` es la fecha (AAAA-MM-DD) de la siguiente acción acordada, o null.

## Qué devuelves
Solo el JSON. \`interaccion_id\` es el que viene en el contexto, sin cambios.

## Ejemplos
${EJEMPLOS.map((e, i) => ejemplo(e, i + 1)).join('\n\n')}`;
}

export function promptUsuario(args: {
  interaccionId: string;
  direccion: string;
  /** Fecha de la llamada, AAAA-MM-DD (hora de Madrid). */
  fecha: string;
  duracionSegundos: number;
  transcripcion: string;
}): string {
  const min = Math.max(1, Math.round(args.duracionSegundos / 60));
  const sentido = args.direccion === 'outbound' ? 'saliente' : 'entrante';
  return `Contexto: interaccion_id ${args.interaccionId} · llamada ${sentido} del ${args.fecha} · ${min} min\n\nTranscripción:\n${args.transcripcion}`;
}
