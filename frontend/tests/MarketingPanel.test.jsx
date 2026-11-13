import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canAccessMarketing } from '../src/ceo-dashboard/CeoLogin';
import { crearModelo, montarPanel } from '../src/ceo-dashboard/marketing/panelEngine';
import { readDashboardRoute } from '../src/ceo-dashboard/routing';

vi.mock('../src/ceo-dashboard/api', () => ({ default: { marketing: { panel: vi.fn(), load: vi.fn(), saveWeights: vi.fn() } } }));
import api from '../src/ceo-dashboard/api';
import MarketingView from '../src/ceo-dashboard/views/MarketingView';

const LETRAS = ['A++', 'A+', 'A', 'B', 'C', 'D', 'No apto', 'Sin valorar'];
const PERIODOS = ['May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', '19–25', '26–1', '2–8', '9–15'].map((etiqueta, i) => ({
  i, bloque: i < 6 ? 0 : 1, etiqueta, sub: '', largo: etiqueta, desde: '2026-05-01', hasta: '2026-05-31', dias: i < 6 ? 30 : 7, edadMedia: i < 6 ? 180 - i * 30 : 28 - (i - 6) * 7, edadFin: 0,
}));
// Un lead con F2 en octubre (periodo 5) por hoja: así se ve si un total cuenta dos veces.
const d = (visitas = 1) => PERIODOS.map((p) => ({ n: p.i === 5 ? 2 : 0, entry: [0, 0, 1, 0, 0, 0, 0, p.i === 5 ? 1 : 0], after: [0, 0, 0, 1, 0, 0, 0], obs: { lead: p.i === 5 ? 2 : 0, visita: p.i === 5 ? visitas : 0, diseno: 0, seguimiento: 0, ganado: 0 }, spend: p.i === 5 ? 200 : 0 }));
const camp = (canal, zona, id, nombre, hijos) => ({ id: `${canal}|c:${id}`, name: nombre, ...(hijos ? { children: hijos } : {}) });
const TREE = { id: 'root', name: 'Todos los canales', children: [
  { id: 'google', name: 'Google', children: [
    { id: 'google|z:Alicante', name: 'Alicante', children: [camp('google', 'Alicante', 'g1', 'Búsqueda · integrales')] },
    { id: 'google|z:Murcia', name: 'Murcia', children: [camp('google', 'Murcia', 'g2', 'Búsqueda · integrales')] }] },
  { id: 'meta', name: 'Meta', children: [
    { id: 'meta|z:Alicante', name: 'Alicante', children: [camp('meta', 'Alicante', 'm1', 'Integral · Captación', [
      { id: 'meta|c:m1|f:Antes y después', name: 'Antes y después', children: [
        { id: 'meta|a:120214455501', name: 'Cocina blanca', adId: '120214455501' },
        { id: 'meta|a:120214455987', name: 'Cocina blanca', adId: '120214455987' }] }])] },
    { id: 'meta|z:Murcia', name: 'Murcia', children: [camp('meta', 'Murcia', 'm2', 'Integral · Captación', [
      { id: 'meta|c:m2|f:Antes y después', name: 'Antes y después', children: [{ id: 'meta|a:120214459031', name: 'Cocina blanca', adId: '120214459031' }] }])] }] }] };
const DATA = {
  corte: '2026-11-17', periodos: PERIODOS, letras: LETRAS, edadesCurva: [7, 14, 30, 60, 90, 120, 180],
  valoresLetra: { 'A++': 1, 'A+': 1, A: 1, B: 0.75, C: 0.45, D: 0.15, 'No apto': 0 },
  curvas: { calidad: [0.45, 0.65, 0.85, 0.95, 1, 1, 1], visita: [0.3, 0.55, 0.8, 0.95, 1, 1, 1], diseno: [0.05, 0.2, 0.45, 0.75, 0.9, 0.97, 1], seguimiento: [0.02, 0.1, 0.3, 0.6, 0.8, 0.92, 1], ganado: [0, 0.02, 0.1, 0.35, 0.6, 0.8, 0.95] },
  tree: TREE,
  leaves: ['google|c:g1', 'google|c:g2', 'meta|a:120214455501', 'meta|a:120214455987', 'meta|a:120214459031'].map((id) => ({ id, d: d() })),
  defaultChecked: ['google', 'meta|z:Alicante', 'meta|z:Murcia'],
  avisos: { leads_sin_atribucion: 3, leads_por_nombre_ambiguo: 0 }, valoracion: null, nota: null,
  cargas: [{ fuente: 'clickup', estado: 'ok', fin: '2026-11-12T06:00:00Z', filas: 10 }, { fuente: 'windsor', estado: 'ok', fin: '2026-11-12T06:00:00Z', filas: 10 }],
  permisos: { editar: true, nota: false },
};

describe('Panel de marketing · árbol de filtros', () => {
  it('prueba de Alex: Zonas → desmarcar Meta Murcia → Campañas', () => {
    const m = crearModelo(DATA);
    m.shortcut(1);
    expect([...m.state.checked].sort()).toEqual(['google|z:Alicante', 'google|z:Murcia', 'meta|z:Alicante', 'meta|z:Murcia']);
    m.toggleNode(m.NODE['meta|z:Murcia']);
    expect(m.state.excluded.has('meta|z:Murcia')).toBe(true);
    m.shortcut(2);
    expect([...m.state.checked].sort()).toEqual(['google|c:g1', 'google|c:g2', 'meta|c:m1']);
  });

  it('estado parcial al excluir un creativo, y la rama sigue incluida', () => {
    const m = crearModelo(DATA);
    m.toggleNode(m.NODE['meta|a:120214455987']); // incluido por «Meta Alicante»: lo excluye
    expect(m.nodeState(m.NODE['meta|a:120214455987'])).toBe('excl');
    expect(m.nodeState(m.NODE['meta|c:m1|f:Antes y después'])).toBe('mixed');
    expect(m.nodeState(m.NODE['meta|z:Alicante'])).toBe('mixed');
    expect(m.getSeries().union.map((l) => l.id)).not.toContain('meta|a:120214455987');
  });

  it('zona y una campaña suya marcadas a la vez: el total cuenta cada lead una vez', () => {
    const m = crearModelo(DATA);
    m.state.checked = new Set(['meta|z:Alicante', 'meta|c:m1']);
    const { series, total } = m.getSeries();
    expect(series).toHaveLength(2);
    const suma = series.reduce((a, s) => a + m.sumL(s.leaves, 5).obs.visita, 0);
    expect(suma).toBe(4);
    expect(m.sumL(total.leaves, 5).obs.visita).toBe(2);
  });

  it('anuncios con el mismo nombre y distinto ID son creativos distintos; «Familia» suma campañas y zonas', () => {
    const m = crearModelo(DATA);
    m.state.checked = new Set(['meta']);
    const creativos = m.getSeries('creativo').series.map((s) => s.label);
    expect(creativos).toEqual(['Cocina blanca · 120214455501', 'Cocina blanca · 120214455987', 'Cocina blanca · 120214459031']);
    const familias = m.getSeries('familia').series;
    expect(familias).toHaveLength(1);
    expect(familias[0].leaves).toHaveLength(3);
  });

  it('«Seleccionar todo» refleja lo incluido por herencia y por exclusiones', () => {
    const m = crearModelo(DATA);
    const google = m.NODE.google, meta = m.NODE.meta;
    expect(m.allState(google)).toBe('on'); // Google marcado: sus zonas están incluidas por herencia
    expect(m.allState(meta)).toBe('on'); // las dos zonas de Meta, marcadas una a una
    m.toggleNode(m.NODE['meta|z:Murcia']);
    expect(m.allState(meta)).toBe('mixed');
    m.toggleAll(google); // desmarcar todas las zonas de Google: quedan excluidas aunque Google siga marcado
    expect(m.allState(google)).toBe('off');
    expect(m.getSeries().union.some((l) => l.channel.id === 'google')).toBe(false);
    m.toggleAll(google);
    expect(m.allState(google)).toBe('on');
  });

  it('selección por defecto: Google y las zonas de Meta que existen', () => {
    expect([...crearModelo(DATA).state.checked]).toEqual(['google', 'meta|z:Alicante', 'meta|z:Murcia']);
  });
});

describe('Panel de marketing · criterio del épico (869fny1et)', () => {
  it('coste ajustado por letra: 300 € y 10 leads D en un mes = 200 € por lead equivalente A', () => {
    const vacio = () => ({ n: 0, entry: LETRAS.map(() => 0), after: LETRAS.slice(0, -1).map(() => 0), obs: { lead: 0, visita: 0, diseno: 0, seguimiento: 0, ganado: 0 }, spend: 0 });
    const d10 = PERIODOS.map((p) => (p.i === 5 ? { ...vacio(), n: 10, entry: [0, 0, 0, 0, 0, 10, 0, 0], obs: { ...vacio().obs, lead: 10 }, spend: 300 } : vacio()));
    const data = { ...DATA, tree: { id: 'root', name: 'Todos', children: [{ id: 'meta', name: 'Meta' }] }, leaves: [{ id: 'meta', d: d10 }], defaultChecked: ['meta'] };
    const root = document.createElement('div');
    const panel = montarPanel(root, data, {});
    panel.state.tab = 'c2'; panel.state.c2.sel = 5; panel.render();
    const fila = [...root.querySelectorAll('.detail table.dt tbody tr')].find((tr) => tr.textContent.includes('€/espera'));
    expect(fila.textContent).toContain('1,5 eq. A');
    expect(fila.lastChild.textContent).toBe('200 €');
    panel.destroy();
  });
});

describe('Panel de marketing · igual que el mockup de Producto (10/11)', () => {
  const vacio = () => ({ n: 0, entry: LETRAS.map(() => 0), after: LETRAS.slice(0, -1).map(() => 0), obs: { lead: 0, visita: 0, diseno: 0, seguimiento: 0, ganado: 0 }, spend: 0 });
  const conMes = (mes) => ({ ...DATA, tree: { id: 'root', name: 'Todos', children: [{ id: 'meta', name: 'Meta' }] }, defaultChecked: ['meta'],
    leaves: [{ id: 'meta', d: PERIODOS.map((p) => (p.i === 5 ? { ...vacio(), ...mes } : vacio())) }] });

  it('€/espera: los «Sin valorar» cuentan con el valor medio de los valorados (propuesta del mockup)', () => {
    const root = document.createElement('div');
    const panel = montarPanel(root, conMes({ n: 10, entry: [0, 0, 0, 8, 0, 0, 0, 2], obs: { ...vacio().obs, lead: 10 }, spend: 300 }), {});
    panel.state.tab = 'c2'; panel.state.c2.sel = 5; panel.render();
    const fila = [...root.querySelectorAll('.detail table.dt tbody tr')].find((tr) => tr.textContent.includes('€/espera'));
    expect(fila.textContent).toContain('7,5 eq. A'); // 8 B × 0,75 + 2 × 0,75 (media de los valorados)
    expect(fila.lastChild.textContent).toBe('40 €');
    panel.destroy();
  });

  it('letras del mockup (A++ … D y «Sin valorar»): «No apto» se suma a D', () => {
    const m = crearModelo(conMes({ n: 3, entry: [0, 0, 0, 0, 0, 1, 2, 0] }));
    expect(m.LK).toEqual(['A++', 'A+', 'A', 'B', 'C', 'D', 'Sin valorar']);
    expect(m.sumL(m.LEAVES, 5).entry).toEqual([0, 0, 0, 0, 0, 3, 0]);
  });

  it('botón «Ejecutar la prueba de Alex» sobre el árbol real', () => {
    const root = document.createElement('div');
    const panel = montarPanel(root, DATA, {});
    [...root.querySelectorAll('button')].find((b) => b.textContent === 'Ejecutar la prueba de Alex').click();
    const res = [...root.querySelectorAll('.res li')].map((li) => li.className);
    expect(res).toHaveLength(5);
    expect(res.every((c) => c === 'ok')).toBe(true);
    expect(panel.state.mode).toBe('pond');
    panel.destroy();
  });

  it('sin leads de ClickUp usa los leads de Meta: volumen como «Sin valorar», €/espera = coste por lead y abre en el gráfico 1', () => {
    const datos = { ...conMes({ spend: 300, leadsMeta: 6 }), cargas: [{ fuente: 'windsor', estado: 'ok', fin: '2026-11-12T06:00:00Z', filas: 1 }, { fuente: 'clickup', estado: 'error', fin: '2026-11-12T06:00:00Z', detalle: 'ACCESS_065' }] };
    const root = document.createElement('div');
    const panel = montarPanel(root, datos, {});
    expect(panel.state.tab).toBe('c1');
    expect(root.querySelector('.mk .top .sub').textContent).toContain('Leads según Meta');
    expect(panel.model.sumL(panel.model.LEAVES, 5)).toMatchObject({ n: 6, obs: { lead: 6 } });
    panel.state.tab = 'c2'; panel.state.c2.sel = 5; panel.render();
    const fila = [...root.querySelectorAll('.detail table.dt tbody tr')].find((tr) => tr.textContent.includes('€/espera'));
    expect(fila.lastChild.textContent).toBe('50 €'); // 300 € ÷ 6 leads
    panel.destroy();
  });

  it('botón «Tema» alterna claro y oscuro', () => {
    const root = document.createElement('div');
    const panel = montarPanel(root, DATA, {});
    const mk = root.querySelector('.mk');
    [...root.querySelectorAll('button')].find((b) => b.textContent === 'Tema').click();
    expect(mk.dataset.theme).toBe('light');
    [...root.querySelectorAll('button')].find((b) => b.textContent === 'Tema').click();
    expect(mk.dataset.theme).toBe('dark');
    panel.destroy();
  });
});

describe('Panel de marketing · criterio de M-1 (869fpj8gn)', () => {
  it('cohorte inmadura: 4 visitas reales con la curva de F2 a 0,5 → 8 visitas estimadas, marcadas como estimado', () => {
    const vacio = () => ({ n: 0, entry: LETRAS.map(() => 0), after: LETRAS.slice(0, -1).map(() => 0), obs: { lead: 0, visita: 0, diseno: 0, seguimiento: 0, ganado: 0 }, spend: 0 });
    const d4 = PERIODOS.map((p) => (p.i === 9 ? { ...vacio(), n: 10, obs: { ...vacio().obs, lead: 10, visita: 4 } } : vacio()));
    const periodos = PERIODOS.map((p) => (p.i === 9 ? { ...p, edadMedia: 30 } : p));
    const data = { ...DATA, periodos, curvas: { ...DATA.curvas, visita: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] },
      tree: { id: 'root', name: 'Todos', children: [{ id: 'meta', name: 'Meta' }] }, leaves: [{ id: 'meta', d: d4 }], defaultChecked: ['meta'] };
    const root = document.createElement('div');
    const panel = montarPanel(root, data, {});
    const celda = () => root.querySelectorAll('table.dt tbody tr')[0].querySelectorAll('td')[11].querySelector('span');
    expect(celda().textContent).toBe('4');
    panel.state.mode = 'pond'; panel.render();
    expect(celda().textContent).toBe('≈8');
    expect(celda().className).toBe('est');
    panel.destroy();
  });
});

describe('Panel de marketing · vista', () => {
  beforeEach(() => { vi.mocked(api.marketing.panel).mockReset(); });

  it('monta las pestañas; sin permiso de nota no aparece el gráfico 5', () => {
    const root = document.createElement('div');
    const panel = montarPanel(root, DATA, {});
    const tabs = [...root.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabs).toEqual(['Filtros · Reuniones F2', '1 · Calidad de los leads', '2 · Coste por fase', '3 · Conversión entre fases', '4 · Cambio de valoración', 'Notas para la reunión']);
    expect(root.textContent).toContain('Reuniones F2');
    panel.state.tab = 'c4'; panel.render();
    expect(root.textContent).toContain('histórico de letras');
    panel.state.tab = 'notas'; panel.render();
    expect(root.textContent).toContain('3 leads de Meta o Google sin campaña');
    panel.destroy();
    expect(root.innerHTML).toBe('');
  });

  it('carga los datos de la API y muestra el error si falla', async () => {
    vi.mocked(api.marketing.panel).mockResolvedValueOnce(DATA);
    const { unmount } = render(<MarketingView />);
    await waitFor(() => expect(screen.getByText('Panel de marketing')).toBeInTheDocument());
    unmount();
    vi.mocked(api.marketing.panel).mockRejectedValueOnce(Object.assign(new Error('HTTP 403'), { body: 'No tienes acceso al panel de marketing.' }));
    render(<MarketingView />);
    expect(await screen.findByRole('alert')).toHaveTextContent('No tienes acceso al panel de marketing.');
  });
});

describe('Panel de marketing · acceso y rutas', () => {
  it('solo Dirección ve el panel', () => {
    expect(canAccessMarketing({ rol: 'superadmin' })).toBe(true);
    expect(canAccessMarketing({ rol: 'employee:Director General' })).toBe(true);
    expect(canAccessMarketing({ rol: 'employee:superadmin' })).toBe(true); // superadmin del directorio (QA CAL-09)
    expect(canAccessMarketing({ rol: 'employee:comercial' })).toBe(false);
  });

  it('?view=marketing es una vista válida', () => {
    expect(readDashboardRoute('?view=marketing')).toMatchObject({ view: 'marketing' });
  });
});
