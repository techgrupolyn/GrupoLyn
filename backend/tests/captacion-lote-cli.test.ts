// Ejecutable del lote: argumentos, informe CSV, resumen y las protecciones de arranque (todo sin base de datos ni red).
import { describe, expect, it } from 'vitest';
import type { InformeLote } from '../netelip/captacion/lote.ts';
import { baseParecePruebas, informeCsv, leerArgumentos, main, resumenTexto } from '../netelip/captacion/lote-cli.ts';

const base = ['--desde', '2026-11-05', '--hasta', '2026-11-13', '--informe', 'C:/fuera/informe.csv'];

describe('captación · lote-cli · argumentos', () => {
  it('lee las fechas (UTC), el informe y los valores por defecto', () => {
    const a = leerArgumentos(base);
    expect(a.desde.toISOString()).toBe('2026-11-05T00:00:00.000Z');
    expect(a.hasta.toISOString()).toBe('2026-11-13T00:00:00.000Z');
    expect(a).toMatchObject({ informe: 'C:/fuera/informe.csv', candidatos: 'vivos', escribir: 0, limite: undefined, confirmoCopia: false });
  });

  it('lee las opciones: tope de escritura, límite, candidatos y confirmación de copia', () => {
    expect(leerArgumentos([...base, '--escribir', '10', '--limite', '25', '--candidatos', 'todos', '--confirmo-copia']))
      .toMatchObject({ escribir: 10, limite: 25, candidatos: 'todos', confirmoCopia: true });
    expect(leerArgumentos([...base, '--escribir', '0']).escribir).toBe(0);
  });

  it.each([
    ['sin --desde', ['--hasta', '2026-11-13', '--informe', 'x.csv'], '--desde debe ser una fecha AAAA-MM-DD'],
    ['sin --hasta', ['--desde', '2026-11-05', '--informe', 'x.csv'], '--hasta debe ser una fecha AAAA-MM-DD'],
    ['sin --informe', ['--desde', '2026-11-05', '--hasta', '2026-11-13'], 'Falta --informe'],
    ['fecha con otro formato', ['--desde', '05/11/2026', '--hasta', '2026-11-13', '--informe', 'x.csv'], '--desde debe ser una fecha AAAA-MM-DD'],
    ['fecha que no existe', ['--desde', '2026-02-30', '--hasta', '2026-11-13', '--informe', 'x.csv'], '--desde no es una fecha válida: 2026-02-30'],
    ['hasta igual a desde', ['--desde', '2026-11-05', '--hasta', '2026-11-05', '--informe', 'x.csv'], '--hasta debe ser posterior a --desde'],
    ['hasta anterior a desde', ['--desde', '2026-11-13', '--hasta', '2026-11-05', '--informe', 'x.csv'], '--hasta debe ser posterior a --desde'],
    ['--escribir negativo', [...base, '--escribir', '-1'], '--escribir debe ser un número entero'],
    ['--escribir con decimales', [...base, '--escribir', '2.5'], '--escribir debe ser un número entero'],
    ['--limite no numérico', [...base, '--limite', 'muchos'], '--limite debe ser un número entero'],
    // Con muchos dígitos Number() llega a Infinity (o redondea): un tope así no limitaría nada.
    ['--escribir con 400 dígitos (Infinity)', [...base, '--escribir', '9'.repeat(400)], '--escribir es demasiado grande'],
    ['--escribir por encima del entero seguro', [...base, '--escribir', '9007199254740992'], '--escribir es demasiado grande'],
    ['--limite con 400 dígitos', [...base, '--limite', '9'.repeat(400)], '--limite es demasiado grande'],
    ['candidatos desconocido', [...base, '--candidatos', 'algunos'], '--candidatos debe ser «vivos» o «todos»'],
    ['opción desconocida', [...base, '--fuerza'], 'Argumento desconocido: --fuerza'],
    ['valor suelto', [...base, 'sobra'], 'Argumento inesperado: sobra'],
    ['opción sin valor', ['--desde'], 'Falta el valor de --desde'],
    ['el valor de una opción es otra opción', ['--desde', '--hasta', '2026-11-13', '--informe', 'x.csv'], 'Falta el valor de --desde'],
  ])('rechaza: %s', (_n, argv, mensaje) => {
    expect(() => leerArgumentos(argv)).toThrow(mensaje);
  });
});

const informe: InformeLote = {
  filas: [
    {
      llamadaId: '12', ocurridaEn: '2026-11-10T09:30:00.000Z', duracionSegundos: 240, lead: { id: 'abc', nombre: 'Ana "la Grande"; López', etapa: 'e3_VIABILIDAD' }, via: 'telefono',
      estado: 'procesada', motivo: null, categoria: 'A+', desglose: 'Pres A · Urg A · 3,60 · cob. 65 %',
      citas: [{ criterio: 'decisor', nivel: 'A', cita: 'Lo decidimos mi marido y yo' }, { criterio: 'urgencia', nivel: 'A', cita: 'en unos dos meses' }],
      descartes: 1, revisionManual: ['punto uno', 'punto dos'], intentos: 2,
    },
    { llamadaId: '13', ocurridaEn: '2026-11-10T10:00:00.000Z', duracionSegundos: 90, lead: null, via: null, estado: 'sin_lead', motivo: 'sin_coincidencia', categoria: null, desglose: null, citas: [], descartes: 0, revisionManual: [], intentos: 1 },
  ],
  escrituras: [
    { clickupTaskId: 'abc', nombre: 'Ana', resultado: 'escrito', campos: 5, detalle: null },
    { clickupTaskId: 'd', nombre: 'D', resultado: 'simulado', campos: 0, detalle: null },
    { clickupTaskId: 'e', nombre: 'E', resultado: 'sin_cupo', campos: 0, detalle: null },
    { clickupTaskId: 'g', nombre: 'G', resultado: 'no_vivo', campos: 0, detalle: null },
    { clickupTaskId: 'f', nombre: 'F', resultado: 'error', campos: 0, detalle: 'x' },
  ],
  resumen: { leadsEnLista: 2066, leadsVivos: 320, alcanceProvisional: 215, presupuestoFormulario: 12, llamadas: 2, porEstado: { procesada: 1, sin_lead: 1 }, leadsCalificados: 1, porCategoria: { 'A+': 1 } },
};

describe('captación · lote-cli · informe', () => {
  it('el CSV es para Excel: BOM, separador «;», cabecera y una fila por llamada, con comillas escapadas', () => {
    const csv = informeCsv(informe);
    expect(csv.startsWith('\uFEFFfecha;llamada;lead;lead_id;etapa;via;estado;motivo;categoria;desglose;frases_citadas;descartes;revision_manual;intentos\r\n')).toBe(true);
    const lineas = csv.split('\r\n');
    expect(lineas).toHaveLength(4);
    expect(lineas[1]).toBe('2026-11-10T09:30:00.000Z;12;"Ana ""la Grande""; López";abc;e3_VIABILIDAD;telefono;procesada;;A+;Pres A · Urg A · 3,60 · cob. 65 %;decisor A: «Lo decidimos mi marido y yo» | urgencia A: «en unos dos meses»;1;punto uno | punto dos;2');
    expect(lineas[2]).toBe('2026-11-10T10:00:00.000Z;13;;;;;sin_lead;sin_coincidencia;;;;0;;1');
    expect(lineas[3]).toBe('');
  });

  it('el resumen de pantalla solo lleva totales: ni nombres ni frases', () => {
    const texto = resumenTexto(informe);
    expect(texto).toBe([
      'Leads en la lista: 2066 (vivos 320) · Alcance provisional nuevo: 215 · Presupuesto del formulario nuevo: 12',
      'Llamadas procesadas: 2 → procesada 1 · sin_lead 1',
      'Leads calificados: 1 → A+ 1',
      'Escritura en ClickUp: 1 leads escritos · 1 en simulacro · 1 sin cupo · 1 no vivos (no se escriben) · 1 con error',
      'Escritos (ids de ClickUp): abc',
      'Con error (ids de ClickUp): f',
    ].join('\n'));
    expect(texto).not.toContain('Ana');
    expect(texto).not.toContain('«');
  });

  it('el resumen da los ids de las tarjetas escritas (para abrirlas) y nada más: sin ids si no se escribió', () => {
    const dos = resumenTexto({ ...informe, escrituras: [
      { clickupTaskId: 'u1', nombre: 'X', resultado: 'escrito', campos: 5, detalle: null },
      { clickupTaskId: 'u2', nombre: 'Y', resultado: 'escrito', campos: 4, detalle: null },
    ] });
    expect(dos.split('\n').filter((l) => l.startsWith('Escritos'))).toEqual(['Escritos (ids de ClickUp): u1, u2']);
    expect(dos).not.toContain('Con error');
    const simulacro = resumenTexto({ ...informe, escrituras: [{ clickupTaskId: 'u3', nombre: 'Z', resultado: 'simulado', campos: 0, detalle: null }] });
    expect(simulacro).not.toContain('ids de ClickUp');
    expect(simulacro).not.toContain('u3');
  });

  it('neutraliza las celdas que Excel leería como fórmula (= + - @, con o sin espacios, o tabulador) con un apóstrofo', () => {
    const celdaLead = (nombre: string): string => informeCsv({ ...informe, filas: [{ ...informe.filas[1]!, lead: { id: 'x', nombre, etapa: null } }] }).split('\r\n')[1]!.split(';')[2]!;
    expect(celdaLead('=1+1')).toBe("'=1+1");
    expect(celdaLead('+34600111222')).toBe("'+34600111222");
    expect(celdaLead('-2+3')).toBe("'-2+3");
    expect(celdaLead('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(celdaLead('  =1+1')).toBe("'  =1+1");
    expect(celdaLead('\t=1+1')).toBe("'\t=1+1");
    // Un tabulador delante ya es sospechoso aunque lo que sigue no sea una fórmula.
    expect(celdaLead('\tcmd')).toBe("'\tcmd");
    // Un nombre normal, o uno que solo lleva esos signos por dentro, queda como está.
    expect(celdaLead('Ana López')).toBe('Ana López');
    expect(celdaLead('a=b')).toBe('a=b');
    expect(celdaLead('Ana-María')).toBe('Ana-María');
  });

  it('una fórmula con comillas y «;» lleva el apóstrofo DENTRO de las comillas del CSV', () => {
    const fila = informeCsv({ ...informe, filas: [{ ...informe.filas[1]!, lead: { id: 'x', nombre: '=HYPERLINK("http://x";"y")', etapa: null } }] }).split('\r\n')[1]!;
    expect(fila).toContain(';"\'=HYPERLINK(""http://x"";""y"")";');
  });

  it('también se neutralizan el motivo de un fallo y la revisión manual', () => {
    const fila = informeCsv({ ...informe, filas: [{ ...informe.filas[1]!, motivo: '=cmd|calc', revisionManual: ['@x'] }] }).split('\r\n')[1]!;
    expect(fila).toBe("2026-11-10T10:00:00.000Z;13;;;;;sin_lead;'=cmd|calc;;;;0;'@x;1");
  });

  it('entrecomilla una celda que solo lleva «;» o un salto de línea, y deja tal cual la que lleva comas', () => {
    const una = { ...informe.filas[1]!, motivo: 'a;b', desglose: 'x, y', revisionManual: ['línea1\nlínea2'] };
    const fila = informeCsv({ ...informe, filas: [una] }).split('\r\n')[1]!;
    expect(fila).toBe('2026-11-10T10:00:00.000Z;13;;;;;sin_lead;"a;b";;x, y;;0;"línea1\nlínea2";1');
  });

  it('un informe vacío da solo la cabecera y un resumen con guiones', () => {
    const vacio: InformeLote = { filas: [], escrituras: [], resumen: { leadsEnLista: 0, leadsVivos: 0, alcanceProvisional: 0, presupuestoFormulario: 0, llamadas: 0, porEstado: {}, leadsCalificados: 0, porCategoria: {} } };
    expect(informeCsv(vacio).split('\r\n')).toHaveLength(2);
    expect(resumenTexto(vacio)).toContain('Llamadas procesadas: 0 → —');
  });
});

describe('captación · lote-cli · qué base parece de pruebas', () => {
  it.each([
    'postgres://u@127.0.0.1:5432/lyn_qa_retest',
    'postgres://u@localhost/copia_superagente',
    'postgres://u@[::1]:5432/Superagente_PRUEBA',
    'postgresql://u:p@127.0.0.1/test',
    'postgres://postgres@127.0.0.1:54329/lyn_qa_retest',
    'postgres://u@127.0.0.1/superagente_local',
    'postgres://u@127.0.0.1/superagente_qa',
  ])('sí: %s', (url) => {
    expect(baseParecePruebas(url)).toBe(true);
  });
  it.each([
    ['un túnel hacia producción (local, nombre real)', 'postgres://u@127.0.0.1:5433/superagente'],
    ['una base remota aunque se llame de pruebas', 'postgres://u@db.ejemplo.com/lyn_qa_retest'],
    ['local sin nombre de base', 'postgres://u@127.0.0.1:5432/'],
    ['una cadena que no es una URL', 'esto no es una url'],
    ['vacía', ''],
  ])('no: %s', (_n, url) => {
    expect(baseParecePruebas(url)).toBe(false);
  });
});

describe('captación · lote-cli · protecciones de arranque', () => {
  const ambiente = { CLICKUP_API_TOKEN: 'pk_x', CAPTACION_CLICKUP_LIST_ID: '123' };

  it('sin DATABASE_URL no arranca', async () => {
    await expect(main(base, ambiente)).rejects.toThrow('Falta DATABASE_URL');
  });

  it('una base que no es local exige confirmar que es una copia', async () => {
    await expect(main(base, { ...ambiente, DATABASE_URL: 'postgres://u:p@db.ejemplo.com:5432/superagente' })).rejects.toThrow('usa una COPIA de la base y repite con --confirmo-copia');
    await expect(main(base, { ...ambiente, DATABASE_URL: 'esto no es una url' })).rejects.toThrow('--confirmo-copia');
  });

  it('un túnel hacia producción (127.0.0.1 con el nombre de la base real) NO pasa la protección aunque parezca local', async () => {
    const tunel = { ...ambiente, DATABASE_URL: 'postgres://u:p@127.0.0.1:5433/superagente' };
    await expect(main(base, tunel)).rejects.toThrow('no parece una base de pruebas');
    await expect(main(base, tunel)).rejects.toThrow('un túnel hacia producción también es local');
  });

  it('con --confirmo-copia una base remota pasa la protección (y sigue con la siguiente comprobación)', async () => {
    const remota = { DATABASE_URL: 'postgres://u:p@db.ejemplo.com:5432/copia' };
    await expect(main([...base, '--confirmo-copia'], remota)).rejects.toThrow('Faltan CLICKUP_API_TOKEN y/o CAPTACION_CLICKUP_LIST_ID');
  });

  it('sin el token o la lista de ClickUp no arranca (con una base local)', async () => {
    await expect(main(base, { DATABASE_URL: 'postgres://postgres@127.0.0.1:5432/copia_local', CLICKUP_API_TOKEN: 'pk_x' })).rejects.toThrow('Faltan CLICKUP_API_TOKEN y/o CAPTACION_CLICKUP_LIST_ID');
  });

  it('con argumentos mal puestos falla antes de mirar el entorno', async () => {
    await expect(main(['--desde', '2026-11-05'], {})).rejects.toThrow('--hasta debe ser una fecha');
  });
});
