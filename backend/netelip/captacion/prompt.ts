import { CRITERIOS_IDS, MATRIZ_V1, type CriterioConfig } from './matriz.ts';
import { CANALES, DECISIONES, DUDAS, EXCEPCIONES, TIPOS_CUANDO, type Decision, type MotivosPorDecision } from './decision.ts';
import { renderResumen, type ResumenLead } from './resumen.ts';
import { GUION_V1_PENDIENTE, MANUAL_V1_PROVISIONAL, MOTIVOS_V1 } from './schema-decision.ts';
import { TIPOS_PRESUPUESTO } from './tipos.ts';

// N-1.2 · Prompt de producción del agente que evalúa al LEAD con la matriz de 7 criterios.
// La tabla de la matriz se arma desde la configuración (los mismos descriptores que usa el código),
// así el prompt y el motor no se pueden desalinear. Temperatura 0 y salida JSON con esquema estricto.
// Cambiar el texto de las reglas o los ejemplos = subir VERSION_PROMPT.

export const VERSION_PROMPT = 'captacion-v5';

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
        fecha_prevista_cita: textoONull,
      },
      required: ['que_quiere', 'donde_quedo', 'que_lo_frena', 'para_que_llamarlo', 'fecha_prevista', 'fecha_prevista_cita'],
    },
    // N-1.4 · decisión de pase del SDR: la decide la IA por su cuenta (null si el lead ya está en F2 o más allá).
    decision_ia: {
      type: ['object', 'null'],
      properties: {
        decision: { type: 'string', enum: [...DECISIONES] },
        motivos: {
          type: 'array',
          items: {
            type: 'object',
            properties: { codigo: { type: 'string' }, cita: { type: 'string' }, texto: textoONull },
            required: ['codigo', 'cita', 'texto'],
          },
        },
        excepciones: { type: 'array', items: { type: 'string', enum: [...EXCEPCIONES] } },
        dudas: { type: 'array', items: { type: 'string', enum: [...DUDAS] } },
        pendiente_ernesto: {
          type: ['object', 'null'],
          properties: { que_debe_decidir: { type: 'string' } },
          required: ['que_debe_decidir'],
        },
        proximos_pasos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              orden: { type: 'integer' },
              accion: { type: 'string' },
              cuando: {
                type: 'object',
                properties: { tipo: { type: 'string', enum: [...TIPOS_CUANDO] }, valor: { type: 'string' } },
                required: ['tipo', 'valor'],
              },
              canal: { type: 'string', enum: [...CANALES] },
              que_pedir: textoONull,
              requiere_ernesto: { type: 'boolean' },
              cita: { type: 'string' },
            },
            required: ['orden', 'accion', 'cuando', 'canal', 'que_pedir', 'requiere_ernesto', 'cita'],
          },
        },
      },
      required: ['decision', 'motivos', 'excepciones', 'dudas', 'pendiente_ernesto', 'proximos_pasos'],
    },
  },
  required: ['interaccion_id', 'presupuesto', 'presupuesto_insuficiente_sin_solucion', 'criterios', 'resumen', 'decision_ia'],
} as const;

// ---------------------------------------------------------------------------------------------
// Contexto de la decisión de pase (N-1.4): guion, manual y lista de motivos. En producción salen de la base (versionados, sin
// desplegar); sin base, estos valores provisionales.
// ---------------------------------------------------------------------------------------------

export interface ContextoDecision {
  guion: { version: number; texto: string };
  manual: { version: number; texto: string };
  motivos: MotivosPorDecision;
}

/** Agrupa filas (decisión, código, etiqueta) como la lista de motivos de cada decisión. */
export function agruparMotivos(filas: ReadonlyArray<readonly [Decision, string, string]>): MotivosPorDecision {
  const lista: Record<Decision, Array<{ codigo: string; etiqueta: string }>> = { pasar_a_reunion: [], derivar_partners: [], seguimiento: [], descartar: [] };
  for (const [decision, codigo, etiqueta] of filas) lista[decision].push({ codigo, etiqueta });
  return lista;
}

export const CONTEXTO_POR_DEFECTO: ContextoDecision = {
  guion: { version: 1, texto: GUION_V1_PENDIENTE },
  manual: { version: 1, texto: MANUAL_V1_PROVISIONAL },
  motivos: agruparMotivos(MOTIVOS_V1),
};
// ---------------------------------------------------------------------------------------------
// Ejemplos (few-shot). No son llamadas reales. Las pruebas comprueban que cada salida cumple el
// contrato y que todas sus citas están literalmente en su transcripción.
// ---------------------------------------------------------------------------------------------

const NE = { nivel: 'NE', cita: null, marca_tiempo: null } as const;
const SIN_PLAZO = { plazo_meses: null, cita: null, marca_tiempo: null } as const;
const SIN_PRESUPUESTO = { detectado: false, tipo: null, min: null, max: null, moneda: null, emisor: null, cita: null, marca_tiempo: null } as const;
const SIN_NO_APTO = { valor: false, cita: null, marca_tiempo: null } as const;

const paso = (orden: number, accion: string, tipo: 'fecha_cliente' | 'plazo_guion', valor: string, canal: 'llamada' | 'whatsapp' | 'email', cita: string, quePedir: string | null = null, requiereErnesto = false) =>
  ({ orden, accion, cuando: { tipo, valor }, canal, que_pedir: quePedir, requiere_ernesto: requiereErnesto, cita });
const motivo = (codigo: string, cita: string, texto: string | null = null) => ({ codigo, cita, texto });
const SIN_EXCEPCIONES = { excepciones: [], dudas: [], pendiente_ernesto: null } as const;

const DECISION_EJ1 = {
  decision: 'pasar_a_reunion', motivos: [motivo('decisores_disponibles', 'nos vemos el jueves a las cinco en vuestra oficina')], ...SIN_EXCEPCIONES,
  proximos_pasos: [paso(1, 'Confirmar la reunión del jueves a las cinco en la oficina', 'fecha_cliente', 'jueves 12 de noviembre a las cinco', 'llamada', 'nos vemos el jueves a las cinco en vuestra oficina', 'que vengan los dos decisores')],
};
const DECISION_EJ2 = {
  decision: 'seguimiento', motivos: [motivo('falta_otro_decisor', 'mi mujer no lo ve claro y sin ella no decido')], ...SIN_EXCEPCIONES,
  proximos_pasos: [paso(1, 'Proponer una llamada con los dos para resolver sus dudas', 'plazo_guion', 'en tres o cuatro días', 'llamada', 'Tengo que comentarlo en casa, ya os digo algo', 'preguntar qué presupuesto manejan')],
};
const DECISION_EJ3 = {
  decision: 'descartar', motivos: [motivo('presupuesto_insuficiente', 'nosotros tenemos 25.000 euros y no podemos pedir financiación ni esperar')], ...SIN_EXCEPCIONES,
  proximos_pasos: [],
};
const DECISION_EJ4 = {
  decision: 'seguimiento', motivos: [motivo('quiere_pensarlo', 'aunque todavía no sé qué día')], ...SIN_EXCEPCIONES,
  proximos_pasos: [paso(1, 'Llamar para cerrar día y hora de la reunión', 'plazo_guion', 'en dos o tres días', 'llamada', 'Puedo ir a la oficina')],
};
const DECISION_EJ5 = {
  decision: 'pasar_a_reunion', motivos: [motivo('decisores_disponibles', 'Podemos ir el viernes 20 a las seis de la tarde, los dos')], ...SIN_EXCEPCIONES,
  proximos_pasos: [paso(1, 'Confirmar la visita del viernes 20 a las seis', 'fecha_cliente', 'viernes 20 a las seis de la tarde', 'whatsapp', 'Podemos ir el viernes 20 a las seis de la tarde, los dos', 'confirmar que vienen los dos')],
};
// Falta un dato que aporta el cliente (el plano): es seguimiento y no escala por eso. Pedir que alguien vaya a medir sí es una excepción.
const DECISION_EJ6 = {
  decision: 'seguimiento', motivos: [motivo('falta_dato_cliente', 'te mando el plano cuando vuelva de vacaciones')], excepciones: ['topografo'], dudas: [], pendiente_ernesto: null,
  proximos_pasos: [
    paso(1, 'Volver a llamar a partir del 20 de noviembre para pedir el plano', 'fecha_cliente', 'a partir del 20 de noviembre', 'llamada', 'Vuelvo el 20 de noviembre', 'el plano'),
    paso(2, 'Valorar con Ernesto enviar a alguien a medir el terreno', 'plazo_guion', 'antes de la reunión', 'llamada', 'Hace falta que alguien venga a medir el terreno', null, true),
  ],
};

export interface Ejemplo {
  titulo: string;
  contexto: string;
  /** Resumen que el lead ya tenía antes de esta llamada (el modelo lo actualiza); sin él es la primera llamada procesada. */
  resumenAnterior?: ResumenLead;
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
      resumen: { que_quiere: 'Reforma integral de un piso de unos 100 m²', donde_quedo: 'Reunión en oficina el jueves a las cinco', que_lo_frena: 'Nada: falta firmar la compra', para_que_llamarlo: 'Confirmar la reunión del jueves', fecha_prevista: '2026-11-12', fecha_prevista_cita: 'nos vemos el jueves a las cinco en vuestra oficina' },
      decision_ia: DECISION_EJ1,
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
      resumen: { que_quiere: 'Cambiar cocina y dos baños', donde_quedo: 'Quedó en comentarlo en casa', que_lo_frena: 'Su pareja no lo ve claro y compara precios', para_que_llamarlo: 'Proponer una llamada con los dos', fecha_prevista: null, fecha_prevista_cita: null },
      decision_ia: DECISION_EJ2,
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
      resumen: { que_quiere: 'Reforma integral de un piso de 80 m²', donde_quedo: 'Sin siguiente paso', que_lo_frena: 'Su dinero no alcanza y no puede financiar ni esperar', para_que_llamarlo: 'No procede por ahora', fecha_prevista: null, fecha_prevista_cita: null },
      decision_ia: DECISION_EJ3,
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
      resumen: { que_quiere: 'Seguir con su proyecto de reforma', donde_quedo: 'Acepta ir a la oficina, sin fecha', que_lo_frena: 'Tendrá que ajustar algo del alcance', para_que_llamarlo: 'Cerrar día y hora de la reunión', fecha_prevista: null, fecha_prevista_cita: null },
      decision_ia: DECISION_EJ4,
    },
  },
  {
    titulo: 'Seguimiento con acuerdos: actualiza el resumen anterior',
    contexto: 'interaccion_id ej-5 · llamada saliente del 2026-11-17 · 3 min',
    // Es la llamada de seguimiento del lead del ejemplo 2: el resumen anterior es el que ese ejemplo dejó (ya con sus indicaciones).
    resumenAnterior: {
      queQuiere: 'Cambiar cocina y dos baños',
      dondeQuedo: 'Quedó en comentarlo en casa',
      queLoFrena: 'Su pareja no lo ve claro y compara precios',
      paraQueLlamarlo: 'Proponer una llamada con los dos; Preguntar presupuesto; sin fecha acordada',
      fechaPrevista: null,
    },
    transcripcion: [
      '[00:00:05] GRUPO LYN: Hola [NOMBRE], te llamo para saber qué os pareció lo que hablamos.',
      '[00:00:30] CLIENTE: Lo hemos hablado en casa y mi mujer ya lo ve bien, queremos seguir adelante.',
      '[00:01:00] CLIENTE: Ya no comparamos con más empresas, nos habéis convencido vosotros.',
      '[00:01:30] GRUPO LYN: Genial, ¿os viene bien pasar por la oficina?',
      '[00:01:50] CLIENTE: Podemos ir el viernes 20 a las seis de la tarde, los dos.',
    ],
    salida: {
      interaccion_id: 'ej-5',
      presupuesto: SIN_PRESUPUESTO,
      presupuesto_insuficiente_sin_solucion: SIN_NO_APTO,
      criterios: {
        presupuesto: NE,
        urgencia: SIN_PLAZO,
        decisor: { nivel: 'A', cita: 'mi mujer ya lo ve bien, queremos seguir adelante', marca_tiempo: '00:00:30' },
        alcance: NE,
        actitud: NE,
        encaje_lyn: { nivel: 'B', cita: 'Ya no comparamos con más empresas, nos habéis convencido vosotros', marca_tiempo: '00:01:00' },
        predisposicion_f2f3: { nivel: 'A', cita: 'Podemos ir el viernes 20 a las seis de la tarde, los dos', marca_tiempo: '00:01:50' },
      },
      resumen: { que_quiere: 'Cambiar cocina y dos baños; ya quieren seguir adelante', donde_quedo: 'Vendrán a la oficina el viernes 20 a las seis, los dos', que_lo_frena: 'Nada pendiente: ya no compara y la pareja está de acuerdo', para_que_llamarlo: 'Confirmar la visita del viernes 20', fecha_prevista: '2026-11-20', fecha_prevista_cita: 'Podemos ir el viernes 20 a las seis de la tarde, los dos' },
      decision_ia: DECISION_EJ5,
    },
  },
  {
    titulo: 'Falta el plano (seguimiento, sin escalar) y pide que alguien vaya a medir (excepción: requiere Ernesto)',
    contexto: 'interaccion_id ej-6 · llamada saliente del 2026-11-10 · 3 min',
    transcripcion: [
      '[00:00:05] GRUPO LYN: Hola [NOMBRE], te llamo por la reforma de tu casa.',
      '[00:00:30] CLIENTE: Queremos reformar la casa entera, de arriba abajo.',
      '[00:00:50] CLIENTE: No tengo el plano ahora, te mando el plano cuando vuelva de vacaciones.',
      '[00:01:10] CLIENTE: Vuelvo el 20 de noviembre.',
      '[00:01:40] CLIENTE: Hace falta que alguien venga a medir el terreno, porque no tenemos nada de eso.',
    ],
    salida: {
      interaccion_id: 'ej-6',
      presupuesto: SIN_PRESUPUESTO,
      presupuesto_insuficiente_sin_solucion: SIN_NO_APTO,
      criterios: {
        presupuesto: NE,
        urgencia: SIN_PLAZO,
        decisor: NE,
        alcance: { nivel: 'A', cita: 'Queremos reformar la casa entera, de arriba abajo', marca_tiempo: '00:00:30' },
        actitud: NE,
        encaje_lyn: NE,
        predisposicion_f2f3: NE,
      },
      resumen: { que_quiere: 'Reforma integral de su casa', donde_quedo: 'Mandará el plano al volver de vacaciones', que_lo_frena: 'No tiene plano ni medidas del terreno', para_que_llamarlo: 'Pedir el plano a partir del día 20', fecha_prevista: '2026-11-20', fecha_prevista_cita: 'Vuelvo el 20 de noviembre' },
      decision_ia: DECISION_EJ6,
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

/** «Resumen anterior» del contexto: el que el lead tenía antes de esta llamada, o la indicación de que es la primera. */
export const bloqueResumenAnterior = (r: ResumenLead | null | undefined): string =>
  r ? `Resumen anterior del lead (actualízalo con esta llamada):\n${renderResumen(r)}` : 'Resumen anterior del lead: ninguno (es la primera llamada procesada).';

const ejemplo = (e: Ejemplo, n: number): string =>
  `### Ejemplo ${n}: ${e.titulo}\nContexto: ${e.contexto}\n${bloqueResumenAnterior(e.resumenAnterior)}\n\nTranscripción:\n${e.transcripcion.join('\n')}\n\nSalida:\n${JSON.stringify(e.salida)}`;

const tablaMotivos = (m: MotivosPorDecision): string =>
  DECISIONES.map((d) => `${d}: ${m[d].map((x) => `${x.codigo} (${x.etiqueta})`).join(' · ') || '(sin motivos configurados)'}`).join('\n');

/** Sección de la decisión de pase: reglas de salida, lista de motivos y el guion y el manual vigentes con su versión. */
function seccionDecision(c: ContextoDecision): string {
  return `## Decisión de pase del SDR (objeto \`decision_ia\`)
Decides POR TU CUENTA, sin conocer la propuesta del SDR, qué pasa con este lead tras la llamada: \`pasar_a_reunion\`, \`derivar_partners\`, \`seguimiento\` o \`descartar\`. Solo es la decisión de PASE (si el lead pasa o no a la sesión de conceptos). Si el contexto dice que el lead ya está en F2 o más allá, \`decision_ia\` es null.
- \`motivos\`: de 1 a 3. Cada uno lleva su \`codigo\` (de la lista de la decisión que elegiste, abajo) y una \`cita\` literal de la llamada, con las mismas reglas que el resto de citas. Si ninguno de la lista encaja, el código es «otro» y escribes el motivo en \`texto\` (en los demás, \`texto\` es null).
- \`excepciones\`: las que haya en la llamada, de entre ${EXCEPCIONES.join(', ')}. Obligan a que decida Ernesto aunque SDR e IA coincidan. \`dudas\`: las que cambien la decisión, de entre ${DUDAS.join(', ')}. Sin ninguna, listas vacías.
- \`pendiente_ernesto\`: null, o \`{ "que_debe_decidir": "…" }\` cuando ante la mínima duda no puedes dar la decisión por clara (sobre todo un descarte: solo lo validas si está claro por qué el proyecto queda fuera de Grupo LYN y de LYN Partners).
- \`proximos_pasos\`: de 1 a 3 pasos ordenados (con «descartar» puede ir vacío si no hay vía de recuperación). Cada paso: \`accion\` concreta; \`cuando\` con \`tipo\` «fecha_cliente» (el cliente dio la fecha; \`valor\` es esa fecha o plazo dicho por él) o «plazo_guion» (el plazo relativo que marca el guion); \`canal\` (${CANALES.join(', ')}); \`que_pedir\` (qué pedir o qué llevar, o null); \`requiere_ernesto\` (true si el paso necesita una excepción: no se presenta como compromiso); y su \`cita\` literal de la llamada. Una fecha solo si el cliente la dio.
- Si solo falta un dato que puede aportar el cliente (plano, fecha de compra, disponibilidad de la pareja), es «seguimiento» y no se escala por eso.
- Es una recomendación: no crea avisos, tareas ni mensajes ni mueve al lead de fase.

### Motivos permitidos por decisión
${tablaMotivos(c.motivos)}

### Guion del SDR (versión ${c.guion.version})
${c.guion.texto}

### Manual de reglas (versión ${c.manual.version})
${c.manual.texto}`;
}

export function promptSistema(matriz: readonly CriterioConfig[] = MATRIZ_V1, contexto: ContextoDecision = CONTEXTO_POR_DEFECTO): string {
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

## Resumen ejecutivo (objeto \`resumen\`)
Lo lee quien va a llamar al lead: en 10 segundos debe saber qué quiere, dónde quedó la conversación, qué lo frena y para qué llamarlo. Es una ACTUALIZACIÓN: parte del «Resumen anterior» del contexto (si lo hay) y lo pone al día con ESTA llamada. \`donde_quedo\` refleja siempre la última conversación; lo que el resumen anterior dice y esta llamada no cambia se conserva.
- Cuatro bloques, cada uno en UNA línea y sin etiqueta dentro del texto: \`que_quiere\` (detalles del proyecto y situación actual, hasta 140 caracteres), \`donde_quedo\` (la última conversación y los acuerdos), \`que_lo_frena\` (objeciones, dudas o bloqueos pendientes) y \`para_que_llamarlo\` (el siguiente paso concreto). Los tres últimos, hasta 110 caracteres cada uno.
- NUNCA pongas importes ni cifras de dinero (ni «90.000», ni «40k», ni «cien mil», ni «500 euros»): el presupuesto tiene sus propios campos. Puedes decir «presupuesto ajustado» o «aún no da cifra», sin números.
- NUNCA pongas teléfonos, emails, direcciones, nombres de personas ni marcadores como [NOMBRE].
- Un bloque sobre el que no hay información, ni en la llamada ni en el resumen anterior, es exactamente «Sin información». No inventes nada.
- \`fecha_prevista\` (AAAA-MM-DD) es la fecha de la siguiente acción SOLO si el lead la acordó en la llamada: si es relativa («el jueves», «dentro de dos semanas»), calcúlala desde la fecha de la llamada; nunca anterior a ella. Va con \`fecha_prevista_cita\`: la frase literal de la llamada que la demuestra (copiada tal cual, como las demás citas). Sin fecha acordada, los dos son null. La fecha nunca se inventa.
- No escribas «Preguntar presupuesto» ni «sin fecha acordada»: el sistema los añade a \`para_que_llamarlo\` cuando corresponde.

${seccionDecision(contexto)}

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
  /** Resumen del lead anterior a esta llamada (N-1.3); null o sin él, es la primera llamada procesada. */
  resumenAnterior?: ResumenLead | null;
  /** El lead ya está en F2 o más allá: no se genera decisión de pase (N-1.4). */
  sinDecision?: boolean;
}): string {
  const min = Math.max(1, Math.round(args.duracionSegundos / 60));
  const sentido = args.direccion === 'outbound' ? 'saliente' : 'entrante';
  const fase = args.sinDecision ? '\nDecisión de pase: no aplica, el lead ya está en F2 o más allá. Devuelve decision_ia null.' : '';
  return `Contexto: interaccion_id ${args.interaccionId} · llamada ${sentido} del ${args.fecha} · ${min} min${fase}\n${bloqueResumenAnterior(args.resumenAnterior)}\n\nTranscripción:\n${args.transcripcion}`;
}
