import { describe, expect, it } from 'vitest';
import { citaVerificable, normalizarCita, SalidaInvalida, validarSalidaModelo, verificarSalida } from '../netelip/captacion/salida-modelo.ts';

const TRANSCRIPCION = [
  '[00:00:04] GRUPO LYN: Hola [NOMBRE], soy Laura de Grupo LYN, te llamo por la solicitud de reforma que nos dejaste. ¿Te pillo bien?',
  '[00:00:20] CLIENTE: Sí, dime. Queremos reformar el piso entero, unos noventa metros.',
  '[00:01:10] CLIENTE: Nos gustaría empezar en unos cuatro meses, cuando entreguemos el piso de alquiler.',
  '[00:01:40] CLIENTE: Decidimos mi pareja y yo, estamos totalmente de acuerdo.',
  '[00:02:05] CLIENTE: Tenemos entre cuarenta y setenta mil euros para la reforma.',
  '[00:02:30] GRUPO LYN: Perfecto, os propongo venir a la oficina de Alicante el jueves.',
].join('\n');

const NE = { nivel: 'NE', cita: null, marca_tiempo: null };
// La salida cruda del modelo es JSON sin tipo: los tests la tocan campo a campo.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const base = (): any => ({
  interaccion_id: 'call-77',
  presupuesto: {
    detectado: true, tipo: 'rango', min: 40000, max: 70000, moneda: 'EUR', emisor: 'cliente',
    cita: 'Tenemos entre cuarenta y setenta mil euros para la reforma', marca_tiempo: '00:02:05',
  },
  presupuesto_insuficiente_sin_solucion: { valor: false, cita: null, marca_tiempo: null },
  criterios: {
    presupuesto: { nivel: 'A', cita: 'Tenemos entre cuarenta y setenta mil euros para la reforma', marca_tiempo: '00:02:05' },
    urgencia: { plazo_meses: 4, cita: 'Nos gustaría empezar en unos cuatro meses', marca_tiempo: '00:01:10' },
    decisor: { nivel: 'A', cita: 'Decidimos mi pareja y yo, estamos totalmente de acuerdo', marca_tiempo: '00:01:40' },
    alcance: { nivel: 'A', cita: 'Queremos reformar el piso entero', marca_tiempo: '00:00:20' },
    actitud: NE,
    encaje_lyn: NE,
    predisposicion_f2f3: NE,
  },
  resumen: { que_quiere: 'Reforma integral', donde_quedo: 'Cita en oficina', que_lo_frena: '', para_que_llamarlo: 'Confirmar fecha', fecha_prevista: null },
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const con = (cambio: (o: any) => void): string => {
  const o = base();
  cambio(o);
  return JSON.stringify(o);
};

describe('validarSalidaModelo · contrato', () => {
  it('acepta una salida válida y asigna el nivel de Urgencia desde el plazo (4 meses → B)', () => {
    const s = validarSalidaModelo(JSON.stringify(base()), 'call-77');
    expect(s.interaccionId).toBe('call-77');
    expect(s.criterios.urgencia).toMatchObject({ nivel: 'B', plazoMeses: 4 });
    expect(s.criterios.presupuesto.nivel).toBe('A');
    expect(s.criterios.actitud).toEqual({ nivel: 'NE', plazoMeses: null, cita: null, marcaTiempo: null });
    expect(s.presupuesto).toMatchObject({ tipo: 'rango', min: 40000, max: 70000, emisor: 'cliente' });
    expect(s.noApto).toEqual({ valor: false, cita: null, marcaTiempo: null });
    expect(s.resumen.queQuiere).toBe('Reforma integral');
  });

  it('rechaza lo que no es un objeto JSON', () => {
    expect(() => validarSalidaModelo('hola')).toThrow(SalidaInvalida);
    expect(() => validarSalidaModelo('[]')).toThrow(/no es un objeto/);
    expect(() => validarSalidaModelo('null')).toThrow(/no es un objeto/);
  });

  it('exige interaccion_id y que coincida con la llamada evaluada', () => {
    expect(() => validarSalidaModelo(con((o) => { delete o.interaccion_id; }))).toThrow(/interaccion_id/);
    expect(() => validarSalidaModelo(JSON.stringify(base()), 'otra-llamada')).toThrow(/no coincide/);
  });

  it('exige los 7 criterios', () => {
    expect(() => validarSalidaModelo(con((o) => { delete o.criterios.decisor; }))).toThrow(/criterios\.decisor/);
    expect(() => validarSalidaModelo(con((o) => { delete o.criterios; }))).toThrow(/falta criterios/);
  });

  it('un nivel distinto de NE exige cita y marca de tiempo', () => {
    expect(() => validarSalidaModelo(con((o) => { o.criterios.decisor.cita = null; }))).toThrow(/exige cita/);
    expect(() => validarSalidaModelo(con((o) => { o.criterios.decisor.marca_tiempo = ''; }))).toThrow(/exige cita/);
  });

  it('NE exige cita null', () => {
    expect(() => validarSalidaModelo(con((o) => { o.criterios.actitud = { nivel: 'NE', cita: 'Se le oye muy motivado', marca_tiempo: '00:00:10' }; }))).toThrow(/NE exige cita null/);
  });

  it('rechaza niveles que no existen', () => {
    expect(() => validarSalidaModelo(con((o) => { o.criterios.decisor.nivel = 'E'; }))).toThrow(/nivel desconocido/);
    expect(() => validarSalidaModelo(con((o) => { o.criterios.decisor.nivel = 'a'; }))).toThrow(/nivel desconocido/);
  });

  it('Urgencia: sin plazo es NE y no admite cita; un plazo exige cita y no puede ser negativo', () => {
    const sin = validarSalidaModelo(con((o) => { o.criterios.urgencia = { plazo_meses: null, cita: null, marca_tiempo: null }; }));
    expect(sin.criterios.urgencia.nivel).toBe('NE');
    expect(() => validarSalidaModelo(con((o) => { o.criterios.urgencia = { plazo_meses: null, cita: 'Cuando se pueda', marca_tiempo: '00:00:01' }; }))).toThrow(/sin plazo/);
    expect(() => validarSalidaModelo(con((o) => { o.criterios.urgencia.cita = null; }))).toThrow(/exige cita/);
    expect(() => validarSalidaModelo(con((o) => { o.criterios.urgencia.plazo_meses = -2; }))).toThrow(/plazo_meses/);
    expect(() => validarSalidaModelo(con((o) => { o.criterios.urgencia.plazo_meses = '4'; }))).toThrow(/plazo_meses/);
  });

  it('presupuesto: detectado falso da null; el resto de campos se ignora', () => {
    expect(validarSalidaModelo(con((o) => { o.presupuesto = { detectado: false }; })).presupuesto).toBeNull();
    expect(() => validarSalidaModelo(con((o) => { o.presupuesto = { detectado: 'sí' }; }))).toThrow(/detectado/);
  });

  it('presupuesto: min no puede superar a max, moneda EUR, emisor cliente o lyn y exige cita', () => {
    expect(() => validarSalidaModelo(con((o) => { o.presupuesto.min = 80000; }))).toThrow(/min no puede superar/);
    expect(() => validarSalidaModelo(con((o) => { o.presupuesto.moneda = 'USD'; }))).toThrow(/EUR/);
    expect(() => validarSalidaModelo(con((o) => { o.presupuesto.emisor = 'comercial'; }))).toThrow(/emisor/);
    expect(() => validarSalidaModelo(con((o) => { o.presupuesto.cita = ''; }))).toThrow(/cita/);
    expect(() => validarSalidaModelo(con((o) => { o.presupuesto.tipo = 'aprox'; }))).toThrow(/tipo desconocido/);
  });

  it('presupuesto: solo euros enteros (lo validado es lo que se guarda) y un exacto lleva min igual a max', () => {
    expect(() => validarSalidaModelo(con((o) => { o.presupuesto.min = 40000.5; }))).toThrow(/euros enteros/);
    expect(() => validarSalidaModelo(con((o) => { o.presupuesto.max = 70000.25; }))).toThrow(/euros enteros/);
    expect(() => validarSalidaModelo(con((o) => { o.presupuesto.min = '40000'; }))).toThrow(/euros enteros/);
    expect(() => validarSalidaModelo(con((o) => { o.presupuesto.tipo = 'exacto'; o.presupuesto.min = 40000; o.presupuesto.max = 41000; }))).toThrow(/min igual a max/);
    const exactoSinMax = validarSalidaModelo(con((o) => { o.presupuesto.tipo = 'exacto'; o.presupuesto.min = 40000; o.presupuesto.max = null; }));
    expect(exactoSinMax.presupuesto).toMatchObject({ tipo: 'exacto', min: 40000, max: null });
  });

  it('presupuesto: cada tipo trae los importes que necesita', () => {
    expect(() => validarSalidaModelo(con((o) => { o.presupuesto.tipo = 'exacto'; o.presupuesto.min = null; o.presupuesto.max = 5000; }))).toThrow(/importes/);
    expect(() => validarSalidaModelo(con((o) => { o.presupuesto.tipo = 'rango'; o.presupuesto.max = null; }))).toThrow(/importes/);
    const sup = validarSalidaModelo(con((o) => { o.presupuesto.tipo = 'abierto_superior'; o.presupuesto.max = null; }));
    expect(sup.presupuesto).toMatchObject({ tipo: 'abierto_superior', min: 40000, max: null });
    const inf = validarSalidaModelo(con((o) => { o.presupuesto.tipo = 'abierto_inferior'; o.presupuesto.min = null; }));
    expect(inf.presupuesto).toMatchObject({ tipo: 'abierto_inferior', min: null, max: 70000 });
    const exacto = validarSalidaModelo(con((o) => { o.presupuesto.tipo = 'exacto'; o.presupuesto.min = 55000; o.presupuesto.max = 55000; }));
    expect(exacto.presupuesto?.min).toBe(55000);
  });

  it('presupuesto insuficiente sin solución: sin cita no invalida la salida (lo resuelve la verificación)', () => {
    const sinCita = validarSalidaModelo(con((o) => { o.presupuesto_insuficiente_sin_solucion = { valor: true, cita: null, marca_tiempo: null }; }));
    expect(sinCita.noApto).toEqual({ valor: true, cita: null, marcaTiempo: null });
    expect(() => validarSalidaModelo(con((o) => { o.presupuesto_insuficiente_sin_solucion = { valor: 'sí' }; }))).toThrow(/verdadero o falso/);
    const ok = validarSalidaModelo(con((o) => {
      o.presupuesto_insuficiente_sin_solucion = { valor: true, cita: 'No llegamos a más de veinte mil euros', marca_tiempo: '00:03:00' };
    }));
    expect(ok.noApto.valor).toBe(true);
  });

  it('el resumen es opcional para N-1.2: si falta, queda vacío', () => {
    const s = validarSalidaModelo(con((o) => { delete o.resumen; }));
    expect(s.resumen).toEqual({ queQuiere: '', dondeQuedo: '', queLoFrena: '', paraQueLlamarlo: '', fechaPrevista: null });
  });
});

describe('citas verificables', () => {
  it('normaliza mayúsculas, tildes, puntuación, marcadores y espacios', () => {
    expect(normalizarCita('  ¡Nos GUSTARÍA   empezar, [NOMBRE]! ')).toBe('nos gustaria empezar');
  });
  it('acepta una cita copiada con otras mayúsculas, sin tildes y sin puntuación', () => {
    expect(citaVerificable('NOS GUSTARIA EMPEZAR EN UNOS CUATRO MESES', TRANSCRIPCION)).toBe(true);
  });
  it('rechaza una cita inventada o parafraseada', () => {
    expect(citaVerificable('Queremos empezar dentro de cuatro meses', TRANSCRIPCION)).toBe(false);
  });
  it('rechaza una cita de menos de 4 palabras', () => {
    expect(citaVerificable('cuatro meses', TRANSCRIPCION)).toBe(false);
    expect(citaVerificable('en unos cuatro meses', TRANSCRIPCION)).toBe(true);
  });
  it('una cita puede cruzar dos turnos seguidos del mismo hablante', () => {
    const dos = '[00:00:01] CLIENTE: Queremos empezar en septiembre\n[00:00:09] CLIENTE: si la obra lo permite.';
    expect(citaVerificable('Queremos empezar en septiembre si la obra lo permite', dos)).toBe(true);
  });
  it('null no es una cita', () => {
    expect(citaVerificable(null, TRANSCRIPCION)).toBe(false);
  });
});

describe('verificarSalida · el código decide qué vale', () => {
  const salida = (cambio: (o: ReturnType<typeof base>) => void = () => undefined) => {
    const o = base();
    cambio(o);
    return validarSalidaModelo(JSON.stringify(o));
  };

  it('con todas las citas reales conserva todo', () => {
    const v = verificarSalida(salida(), TRANSCRIPCION);
    expect(v.descartes).toEqual([]);
    expect(v.criterios.decisor.nivel).toBe('A');
    expect(v.criterios.urgencia).toMatchObject({ nivel: 'B', plazoMeses: 4 });
    expect(v.presupuesto?.tipo).toBe('rango');
    expect(v.revisionManual).toEqual([]);
  });

  it('un nivel sin cita verificable pasa a NE y queda anotado', () => {
    const v = verificarSalida(salida((o) => { o.criterios.decisor.cita = 'Mi mujer manda más que yo en esto'; }), TRANSCRIPCION);
    expect(v.criterios.decisor).toEqual({ nivel: 'NE', plazoMeses: null, cita: null, marcaTiempo: null });
    expect(v.descartes).toEqual([{ campo: 'criterios.decisor', motivo: 'cita no encontrada en la transcripción', cita: 'Mi mujer manda más que yo en esto' }]);
  });

  it('una Urgencia con cita inventada vuelve a NE y sin plazo', () => {
    const v = verificarSalida(salida((o) => { o.criterios.urgencia.cita = 'Tenemos prisa por empezar ya mismo'; }), TRANSCRIPCION);
    expect(v.criterios.urgencia).toEqual({ nivel: 'NE', plazoMeses: null, cita: null, marcaTiempo: null });
  });

  it('un presupuesto con cita inventada no se registra', () => {
    const v = verificarSalida(salida((o) => { o.presupuesto.cita = 'Podemos gastar hasta cien mil euros'; }), TRANSCRIPCION);
    expect(v.presupuesto).toBeNull();
    expect(v.descartes.map((d) => d.campo)).toContain('presupuesto');
  });

  it('el importe fuera de 1.000 a 5.000.000 € no se registra solo y va a revisión manual', () => {
    const alto = verificarSalida(salida((o) => { o.presupuesto.min = 40000; o.presupuesto.max = 6_000_000; }), TRANSCRIPCION);
    expect(alto.presupuesto).toBeNull();
    expect(alto.presupuestoParaRevision?.max).toBe(6_000_000);
    expect(alto.revisionManual).toHaveLength(1);
    const bajo = verificarSalida(salida((o) => { o.presupuesto.min = 500; o.presupuesto.max = 700; }), TRANSCRIPCION);
    expect(bajo.presupuesto).toBeNull();
    expect(bajo.revisionManual).toHaveLength(1);
  });

  it('los límites exactos 1.000 € y 5.000.000 € sí se aceptan', () => {
    const v = verificarSalida(salida((o) => { o.presupuesto.min = 1000; o.presupuesto.max = 5_000_000; }), TRANSCRIPCION);
    expect(v.presupuesto).not.toBeNull();
    expect(v.revisionManual).toEqual([]);
  });

  it('un rango abierto con el importe fuera de rango también va a revisión', () => {
    const v = verificarSalida(salida((o) => { o.presupuesto.tipo = 'abierto_superior'; o.presupuesto.min = 8_000_000; o.presupuesto.max = null; }), TRANSCRIPCION);
    expect(v.presupuesto).toBeNull();
    expect(v.revisionManual).toHaveLength(1);
  });

  it('Escenario: No apto sin cita verificable no se aplica y queda en revisión manual', () => {
    const inventada = verificarSalida(salida((o) => {
      o.presupuesto_insuficiente_sin_solucion = { valor: true, cita: 'No tenemos ni un euro para esta obra', marca_tiempo: '00:03:00' };
    }), TRANSCRIPCION);
    expect(inventada.noApto).toEqual({ valor: false, cita: null, marcaTiempo: null });
    expect(inventada.descartes.map((d) => d.campo)).toContain('presupuesto_insuficiente_sin_solucion');
    expect(inventada.revisionManual).toEqual(['presupuesto insuficiente sin solución señalado sin una cita verificable']);

    const sinCita = verificarSalida(salida((o) => {
      o.presupuesto_insuficiente_sin_solucion = { valor: true, cita: null, marca_tiempo: null };
    }), TRANSCRIPCION);
    expect(sinCita.noApto.valor).toBe(false);
    expect(sinCita.revisionManual).toHaveLength(1);
  });

  it('levantar un No apto con una cita inventada tampoco vale, y no necesita revisión', () => {
    const v = verificarSalida(salida((o) => {
      o.presupuesto_insuficiente_sin_solucion = { valor: false, cita: 'Al final sí que nos llega el dinero', marca_tiempo: '00:03:00' };
    }), TRANSCRIPCION);
    expect(v.noApto).toEqual({ valor: false, cita: null, marcaTiempo: null });
    expect(v.descartes).toHaveLength(1);
    expect(v.revisionManual).toEqual([]);
  });

  it('sin mención de No apto no hay descarte ni revisión', () => {
    const v = verificarSalida(salida(), TRANSCRIPCION);
    expect(v.noApto).toEqual({ valor: false, cita: null, marcaTiempo: null });
    expect(v.revisionManual).toEqual([]);
  });

  it('un No apto con cita real se conserva', () => {
    const v = verificarSalida(salida((o) => {
      o.presupuesto_insuficiente_sin_solucion = { valor: true, cita: 'Tenemos entre cuarenta y setenta mil euros', marca_tiempo: '00:02:05' };
    }), TRANSCRIPCION);
    expect(v.noApto.valor).toBe(true);
  });

  it('no modifica la salida original', () => {
    const s = salida((o) => { o.criterios.decisor.cita = 'Mi mujer manda más que yo en esto'; });
    verificarSalida(s, TRANSCRIPCION);
    expect(s.criterios.decisor.nivel).toBe('A');
  });
});
