import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ceo-dashboard/api', () => ({
  default: {
    netelip: { decision: vi.fn(), saveDecision: vi.fn() },
    decisiones: { bandeja: vi.fn(), caso: vi.fn(), confirmar: vi.fn(), corregir: vi.fn(), acierto: vi.fn() },
  },
}));

import api from '../src/ceo-dashboard/api';
import { antiguedad, callIdDe, motivoLabel, tarjetaUrl } from '../src/ceo-dashboard/decisionPase';
import DecisionBandejaView from '../src/ceo-dashboard/views/DecisionBandejaView';
import DecisionPasePanel from '../src/ceo-dashboard/views/DecisionPasePanel';

const MOTIVOS = {
  pasar_a_reunion: [{ codigo: 'cumple_criterios', etiqueta: 'Cumple los criterios' }],
  derivar_partners: [{ codigo: 'presupuesto_partners', etiqueta: 'Presupuesto de Partners' }],
  seguimiento: [{ codigo: 'falta_plano', etiqueta: 'Falta el plano' }, { codigo: 'pide_tiempo', etiqueta: 'Pide tiempo' }],
  descartar: [{ codigo: 'no_interesado', etiqueta: 'El cliente decide no seguir' }],
};
const PASO = { orden: 1, accion: 'Llamar para pedir el plano', cuando: { tipo: 'fecha_cliente', valor: 'a partir del día 20' }, canal: 'llamada', quePedir: 'el plano', requiereErnesto: false, cita: 'vuelvo el 20' };
const sdr = { actor: 'sdr', decision: 'seguimiento', motivo_codigo: 'falta_plano', motivo_texto: null, dato_cita: 'Dijo que manda el plano', usuario_nombre: 'Sara', proximos_pasos: [], motivos: [], excepciones: [], dudas: [], pendiente_ernesto: null };
const ia = { actor: 'ia', decision: 'seguimiento', motivo_codigo: 'falta_plano', motivo_texto: null, dato_cita: 'te mando el plano cuando vuelva', motivos: [{ codigo: 'falta_plano', texto: null }], excepciones: ['descuento'], dudas: [], pendiente_ernesto: null, proximos_pasos: [PASO] };

afterEach(() => vi.clearAllMocks());

describe('decisión de pase · utilidades', () => {
  it('el motivo se muestra con la etiqueta de la lista, o con el texto libre si es «otro»', () => {
    expect(motivoLabel(MOTIVOS, 'seguimiento', 'falta_plano')).toBe('Falta el plano');
    expect(motivoLabel(MOTIVOS, 'seguimiento', 'otro', 'Quiere esperar')).toBe('Otro: Quiere esperar');
    expect(motivoLabel(MOTIVOS, 'seguimiento', 'otro')).toBe('Otro');
    expect(motivoLabel(MOTIVOS, 'seguimiento', 'motivo_que_ya_no_esta')).toBe('motivo_que_ya_no_esta');
    expect(motivoLabel(MOTIVOS, 'seguimiento', null)).toBe('—');
  });
  it('saca el id numérico de la llamada, la antigüedad y el enlace a la tarjeta', () => {
    expect(callIdDe('netelip:123')).toBe('123');
    const ahora = new Date('2026-11-18T12:00:00Z').getTime();
    expect(antiguedad('2026-11-18T11:30:00Z', ahora)).toBe('30 min');
    expect(antiguedad('2026-11-18T09:00:00Z', ahora)).toBe('3 h');
    expect(antiguedad('2026-11-16T12:00:00Z', ahora)).toBe('2 d');
    expect(antiguedad('no es una fecha', ahora)).toBe('');
    expect(tarjetaUrl('86abc')).toBe('https://app.clickup.com/t/86abc');
  });
});

describe('DecisionPasePanel · formulario del SDR', () => {
  const sinPropuesta = { lead_conocido: true, motivos: MOTIVOS, estado: null, sdr: null, ia: null };
  beforeEach(() => { vi.mocked(api.netelip.decision).mockResolvedValue(sinPropuesta); });

  it('Escenario «Propuesta del SDR en el Dashboard General»: puede registrar decisión, motivo y dato; hasta que lo rellena no puede enviar', async () => {
    vi.mocked(api.netelip.saveDecision).mockResolvedValue({ ...sinPropuesta, sdr, ia, estado: 'pendiente_ernesto' });
    render(<DecisionPasePanel callId={7} />);
    const enviar = await screen.findByRole('button', { name: 'Registrar mi decisión' });
    expect(enviar).toBeDisabled();
    // Sin decisión no hay motivos que elegir.
    expect(screen.getByLabelText('Motivo')).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Seguimiento'));
    const motivo = screen.getByLabelText('Motivo');
    expect(motivo).toBeEnabled();
    expect(within(motivo).getAllByRole('option').map((o) => o.textContent)).toEqual(['Elige un motivo', 'Falta el plano', 'Pide tiempo', 'Otro']);
    fireEvent.change(motivo, { target: { value: 'falta_plano' } });
    expect(enviar).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Dato o cita de la llamada que lo justifica'), { target: { value: '  Dijo que manda el plano ' } });
    expect(enviar).toBeEnabled();
    fireEvent.click(enviar);
    await waitFor(() => expect(api.netelip.saveDecision).toHaveBeenCalledWith(7, { decision: 'seguimiento', motivo_codigo: 'falta_plano', dato_cita: 'Dijo que manda el plano' }));
  });

  it('Escenario «El SDR no ve a la IA antes de decidir»: antes de registrar no hay nada de la IA en pantalla; después aparece su decisión y sus próximos pasos', async () => {
    vi.mocked(api.netelip.saveDecision).mockResolvedValue({ ...sinPropuesta, sdr, ia, estado: 'pendiente_ernesto' });
    const { container } = render(<DecisionPasePanel callId={7} />);
    await screen.findByRole('button', { name: 'Registrar mi decisión' });
    expect(container.textContent).not.toContain('Decisión de la IA');
    expect(container.textContent).not.toContain('Llamar para pedir el plano');
    fireEvent.click(screen.getByLabelText('Seguimiento'));
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'falta_plano' } });
    fireEvent.change(screen.getByLabelText('Dato o cita de la llamada que lo justifica'), { target: { value: 'dato' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar mi decisión' }));
    await screen.findByText('Decisión de la IA');
    expect(screen.getByText('Tu propuesta', { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/Llamar para pedir el plano/)).toBeInTheDocument();
  });

  it('con «otro» pide escribir cuál, y manda el texto', async () => {
    vi.mocked(api.netelip.saveDecision).mockResolvedValue({ ...sinPropuesta, sdr, ia: null, estado: null });
    render(<DecisionPasePanel callId={7} />);
    await screen.findByRole('button', { name: 'Registrar mi decisión' });
    fireEvent.click(screen.getByLabelText('Descartar'));
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'otro' } });
    fireEvent.change(screen.getByLabelText('Dato o cita de la llamada que lo justifica'), { target: { value: 'dato' } });
    expect(screen.getByRole('button', { name: 'Registrar mi decisión' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('¿Cuál es el motivo?'), { target: { value: 'Quiere esperar a la herencia' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar mi decisión' }));
    await waitFor(() => expect(api.netelip.saveDecision).toHaveBeenCalledWith(7, { decision: 'descartar', motivo_codigo: 'otro', dato_cita: 'dato', motivo_texto: 'Quiere esperar a la herencia' }));
    await screen.findByText('La IA todavía no ha analizado esta llamada.', { exact: false });
  });

  it('cambiar de decisión borra el motivo elegido (no se mezclan listas)', async () => {
    render(<DecisionPasePanel callId={7} />);
    await screen.findByRole('button', { name: 'Registrar mi decisión' });
    fireEvent.click(screen.getByLabelText('Seguimiento'));
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'falta_plano' } });
    fireEvent.click(screen.getByLabelText('Descartar'));
    expect(screen.getByLabelText('Motivo')).toHaveValue('');
  });

  it('un error del servidor al guardar se muestra y deja el formulario para reintentar', async () => {
    vi.mocked(api.netelip.saveDecision).mockRejectedValue(Object.assign(new Error('HTTP 409'), { body: 'La propuesta de esta llamada ya está registrada.' }));
    render(<DecisionPasePanel callId={7} />);
    await screen.findByRole('button', { name: 'Registrar mi decisión' });
    fireEvent.click(screen.getByLabelText('Seguimiento'));
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'falta_plano' } });
    fireEvent.change(screen.getByLabelText('Dato o cita de la llamada que lo justifica'), { target: { value: 'dato' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar mi decisión' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('La propuesta de esta llamada ya está registrada.');
    expect(screen.getByRole('button', { name: 'Registrar mi decisión' })).toBeEnabled();
  });

  it('una llamada sin lead identificado no ofrece el formulario; con propuesta ya registrada la muestra sin formulario', async () => {
    vi.mocked(api.netelip.decision).mockResolvedValueOnce({ lead_conocido: false, motivos: MOTIVOS, estado: null, sdr: null, ia: null });
    const { unmount } = render(<DecisionPasePanel callId={7} />);
    await screen.findByText('todavía no está vinculada a un lead', { exact: false });
    expect(screen.queryByRole('button', { name: 'Registrar mi decisión' })).not.toBeInTheDocument();
    unmount();
    vi.mocked(api.netelip.decision).mockResolvedValueOnce({ ...sinPropuesta, sdr, ia, estado: 'pendiente_ernesto' });
    render(<DecisionPasePanel callId={8} />);
    await screen.findByText('Decisión de la IA');
    expect(screen.queryByRole('button', { name: 'Registrar mi decisión' })).not.toBeInTheDocument();
    expect(screen.getByText(/Pendiente de Ernesto/)).toBeInTheDocument();
  });

  it('al cambiar de llamada no queda en pantalla lo de la anterior mientras llega la nueva, ni si la nueva falla', async () => {
    vi.mocked(api.netelip.decision).mockResolvedValueOnce({ ...sinPropuesta, sdr, ia, estado: 'pendiente_ernesto' });
    const { rerender } = render(<DecisionPasePanel callId={1} />);
    await screen.findByText('Decisión de la IA');
    let resolver;
    vi.mocked(api.netelip.decision).mockReturnValueOnce(new Promise((resolve) => { resolver = resolve; }));
    rerender(<DecisionPasePanel callId={2} />);
    expect(screen.queryByText('Decisión de la IA')).not.toBeInTheDocument();
    expect(screen.queryByText(/Llamar para pedir el plano/)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Cargando');
    resolver(sinPropuesta);
    await screen.findByRole('button', { name: 'Registrar mi decisión' });
    // Si la nueva petición falla, tampoco asoma lo de la llamada anterior.
    vi.mocked(api.netelip.decision).mockRejectedValueOnce(Object.assign(new Error('HTTP 500'), { body: 'Falló' }));
    rerender(<DecisionPasePanel callId={3} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Falló');
    expect(screen.queryByText('Decisión de la IA')).not.toBeInTheDocument();
  });

  it('un formulario a medias de una llamada no pasa a la siguiente', async () => {
    const { rerender } = render(<DecisionPasePanel callId={1} />);
    await screen.findByRole('button', { name: 'Registrar mi decisión' });
    fireEvent.click(screen.getByLabelText('Seguimiento'));
    fireEvent.change(screen.getByLabelText('Dato o cita de la llamada que lo justifica'), { target: { value: 'dato de la llamada 1' } });
    rerender(<DecisionPasePanel callId={2} />);
    await screen.findByRole('button', { name: 'Registrar mi decisión' });
    expect(screen.getByLabelText('Dato o cita de la llamada que lo justifica')).toHaveValue('');
    expect(screen.getByLabelText('Seguimiento')).not.toBeChecked();
  });

  it('si no se puede cargar, lo dice', async () => {
    vi.mocked(api.netelip.decision).mockRejectedValue(Object.assign(new Error('HTTP 500'), { body: 'No se pudo completar la operación.' }));
    render(<DecisionPasePanel callId={7} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo completar la operación.');
  });
});

describe('DecisionBandejaView · bandeja de Ernesto', () => {
  const fila = (n, o = {}) => ({
    llamadaId: `netelip:${n}`, leadId: `lead${n}`, fechaLlamada: '2026-11-17T10:00:00.000Z', sdr: { decision: 'seguimiento', motivoCodigo: 'falta_plano' }, ia: { decision: 'seguimiento', motivoCodigo: 'falta_plano' },
    coincide: true, motivoEscalado: 'piloto', estado: 'pendiente_ernesto', creadoEn: new Date(Date.now() - 3 * 3600_000).toISOString(), revisadoEn: null, ...o,
  });
  const caso = (o = {}) => ({
    llamada_id: 'netelip:1', lead_id: 'lead1', estado: 'pendiente_ernesto', motivo_escalado: 'piloto', coincide: true, revisado_por: null, revisado_en: null, sdr, ia, ernesto: null,
    resumen: { que_quiere: 'Reforma integral', donde_quedo: 'Cita en oficina', que_lo_frena: 'Nada', para_que_llamarlo: 'Confirmar la cita', fecha_prevista: null },
    calificacion: { categoria: 'B', presupuesto: 70000, ponderado: 52500 }, motivos: MOTIVOS, ...o,
  });
  const acierto = [
    { actor: 'coincidentes', revisados: 10, aciertos: 9, porcentaje: 90 }, { actor: 'sdr', revisados: 10, aciertos: 8, porcentaje: 80 }, { actor: 'ia', revisados: 0, aciertos: 0, porcentaje: null },
  ];
  beforeEach(() => {
    vi.mocked(api.decisiones.bandeja).mockResolvedValue({ items: [fila(1), fila(2, { coincide: false, sdr: { decision: 'descartar', motivoCodigo: 'no_interesado' }, motivoEscalado: 'discrepancia' })] });
    vi.mocked(api.decisiones.acierto).mockResolvedValue({ items: acierto });
    vi.mocked(api.decisiones.caso).mockResolvedValue(caso());
  });

  it('una fila por caso con lead, propuestas, motivo, estado y antigüedad; solo la discrepancia va resaltada; y la tabla de acierto', async () => {
    render(<DecisionBandejaView />);
    const fila1 = (await screen.findByText('lead1')).closest('tr');
    expect(within(fila1).getAllByText('Seguimiento')).toHaveLength(2);
    expect(within(fila1).getByText('Piloto')).toBeInTheDocument();
    expect(within(fila1).getByText('Pendiente de Ernesto')).toBeInTheDocument();
    expect(within(fila1).getByText('3 h')).toBeInTheDocument();
    const fila2 = screen.getByText('lead2').closest('tr');
    expect(within(fila2).getByText('Descartar').className).toContain('text-amber-200');
    expect(within(fila2).getByText('Discrepancia')).toBeInTheDocument();
    const tabla = screen.getByLabelText('Acierto del piloto');
    expect(within(tabla).getByText('SDR e IA coinciden').closest('tr')).toHaveTextContent('10');
    expect(within(tabla).getByText('SDR e IA coinciden').closest('tr')).toHaveTextContent('90 %');
    expect(within(tabla).getByText('IA').closest('tr')).toHaveTextContent('—');
  });

  it('las pestañas piden pendientes, revisados o todos', async () => {
    render(<DecisionBandejaView />);
    await screen.findByText('lead1');
    fireEvent.click(screen.getByRole('tab', { name: 'Revisados' }));
    await waitFor(() => expect(api.decisiones.bandeja).toHaveBeenLastCalledWith('revisados'));
    fireEvent.click(screen.getByRole('tab', { name: 'Todos' }));
    await waitFor(() => expect(api.decisiones.bandeja).toHaveBeenLastCalledWith('todos'));
    expect(screen.getByRole('tab', { name: 'Todos' })).toHaveAttribute('aria-selected', 'true');
  });

  it('sin casos lo dice; un error se muestra', async () => {
    vi.mocked(api.decisiones.bandeja).mockResolvedValueOnce({ items: [] });
    const { unmount } = render(<DecisionBandejaView />);
    await screen.findByText('No hay casos pendientes.');
    unmount();
    vi.mocked(api.decisiones.bandeja).mockRejectedValueOnce(Object.assign(new Error('HTTP 403'), { body: 'No tienes permiso para validar decisiones de pase.' }));
    render(<DecisionBandejaView />);
    expect(await screen.findByRole('alert')).toHaveTextContent('No tienes permiso para validar decisiones de pase.');
  });

  it('al abrir un caso: resumen del lead, las dos propuestas con sus citas y los próximos pasos', async () => {
    render(<DecisionBandejaView />);
    fireEvent.click((await screen.findByText('lead1')).closest('tr'));
    const drawer = await screen.findByRole('dialog', { name: 'Detalle del caso' });
    await within(drawer).findByText('Propuesta del SDR', { exact: false });
    expect(api.decisiones.caso).toHaveBeenCalledWith('1');
    expect(within(drawer).getByText('Reforma integral')).toBeInTheDocument();
    expect(within(drawer).getByText(/Categoría B · presupuesto 70\.000 €/)).toBeInTheDocument();
    expect(within(drawer).getByText(/Decisión de la IA/)).toBeInTheDocument();
    expect(within(drawer).getByText(/Llamar para pedir el plano/)).toBeInTheDocument();
    expect(within(drawer).getByText(/Excepciones: Descuento/)).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: /Abrir la tarjeta del lead/ })).toHaveAttribute('href', 'https://app.clickup.com/t/lead1');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('Confirmar con acuerdo total no pide nada más y recarga la bandeja', async () => {
    vi.mocked(api.decisiones.confirmar).mockResolvedValue(caso({ estado: 'validada' }));
    render(<DecisionBandejaView />);
    fireEvent.click((await screen.findByText('lead1')).closest('tr'));
    const drawer = await screen.findByRole('dialog');
    const confirmar = await within(drawer).findByRole('button', { name: 'Confirmar' });
    expect(confirmar).toBeEnabled();
    fireEvent.click(confirmar);
    await waitFor(() => expect(api.decisiones.confirmar).toHaveBeenCalledWith('1', {}));
    await waitFor(() => expect(vi.mocked(api.decisiones.bandeja).mock.calls.length).toBeGreaterThan(1));
  });

  it('Escenario «Discrepancia»: confirmar exige elegir con quién se está de acuerdo, y manda esa elección', async () => {
    const dis = caso({ coincide: false, motivo_escalado: 'discrepancia', sdr: { ...sdr, decision: 'descartar', motivo_codigo: 'no_interesado' } });
    vi.mocked(api.decisiones.caso).mockResolvedValue(dis);
    vi.mocked(api.decisiones.confirmar).mockResolvedValue({ ...dis, estado: 'validada' });
    render(<DecisionBandejaView />);
    fireEvent.click((await screen.findByText('lead2')).closest('tr'));
    const drawer = await screen.findByRole('dialog');
    const confirmar = await within(drawer).findByRole('button', { name: 'Confirmar' });
    expect(confirmar).toBeDisabled();
    // La discrepancia se resalta en las dos propuestas.
    expect(drawer.querySelectorAll('[data-resaltado="true"]')).toHaveLength(2);
    fireEvent.click(within(drawer).getByLabelText('Con la IA'));
    expect(confirmar).toBeEnabled();
    fireEvent.click(confirmar);
    await waitFor(() => expect(api.decisiones.confirmar).toHaveBeenCalledWith('2', { a_favor: 'ia' }));
  });

  it('Escenario «Corrección de Ernesto»: Corregir exige decisión, motivo y el dato que cambia su criterio', async () => {
    vi.mocked(api.decisiones.corregir).mockResolvedValue(caso({ estado: 'corregida' }));
    render(<DecisionBandejaView />);
    fireEvent.click((await screen.findByText('lead1')).closest('tr'));
    const drawer = await screen.findByRole('dialog');
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Corregir' }));
    const guardar = within(drawer).getByRole('button', { name: 'Guardar corrección' });
    expect(guardar).toBeDisabled();
    fireEvent.change(within(drawer).getByLabelText('Decisión'), { target: { value: 'descartar' } });
    fireEvent.change(within(drawer).getByLabelText('Motivo'), { target: { value: 'no_interesado' } });
    expect(guardar).toBeDisabled();
    fireEvent.change(within(drawer).getByLabelText('Dato que cambia tu criterio'), { target: { value: '  Contrató a otra empresa ' } });
    expect(guardar).toBeEnabled();
    fireEvent.click(guardar);
    await waitFor(() => expect(api.decisiones.corregir).toHaveBeenCalledWith('1', { decision: 'descartar', motivo_codigo: 'no_interesado', dato_cita: 'Contrató a otra empresa' }));
  });

  it('un caso ya revisado enseña la decisión final y no ofrece acciones', async () => {
    vi.mocked(api.decisiones.caso).mockResolvedValue(caso({ estado: 'validada', revisado_en: '2026-11-18T09:00:00Z', ernesto: { ...sdr, actor: 'ernesto', usuario_nombre: 'Ernesto', proximos_pasos: [PASO] } }));
    render(<DecisionBandejaView />);
    fireEvent.click((await screen.findByText('lead1')).closest('tr'));
    const drawer = await screen.findByRole('dialog');
    await within(drawer).findByText(/Decisión final/);
    expect(within(drawer).queryByRole('button', { name: 'Confirmar' })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: 'Corregir' })).not.toBeInTheDocument();
    expect(within(drawer).getByText(/Revisado el 18\/11\/2026/)).toBeInTheDocument();
  });

  it('un error al confirmar se muestra dentro del caso', async () => {
    vi.mocked(api.decisiones.confirmar).mockRejectedValue(Object.assign(new Error('HTTP 409'), { body: 'Ese caso ya está revisado.' }));
    render(<DecisionBandejaView />);
    fireEvent.click((await screen.findByText('lead1')).closest('tr'));
    const drawer = await screen.findByRole('dialog');
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Confirmar' }));
    expect(await within(drawer).findByRole('alert')).toHaveTextContent('Ese caso ya está revisado.');
  });
});
