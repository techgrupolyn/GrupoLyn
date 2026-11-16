// Motor del panel de marketing (épico 869fny1et). Es la lógica del mockup de Producto del 10/11/2026
// (árbol con atajos, exclusiones y estado parcial; total sin duplicados; Real / Ponderado; 5 gráficos en SVG)
// alimentada con los datos de /api/marketing/panel en vez de datos simulados. Se monta sobre un nodo del DOM:
// React solo carga los datos y lo monta (MarketingView.jsx).
import './panel.css';

const SVGNS = 'http://www.w3.org/2000/svg';
function setA(e, a) { if (!a) return; for (const k in a) { const v = a[k]; if (v == null || v === false) continue; if (k === 'text') e.textContent = v; else if (k === 'html') e.innerHTML = v; else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v); } }
function h(t, a, p) { const e = document.createElement(t); setA(e, a); if (p) p.appendChild(e); return e; }
function sv(t, a, p) { const e = document.createElementNS(SVGNS, t); setA(e, a); if (p) p.appendChild(e); return e; }
function grp(n) { return Math.round(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
export function fN(v, d = 0) { if (v == null || !isFinite(v)) return '—'; const neg = v < 0; if (d === 0) return (neg && Math.round(Math.abs(v)) > 0 ? '-' : '') + grp(v); const s = Math.abs(v).toFixed(d).split('.'); return (neg && +(s.join('.')) > 0 ? '-' : '') + grp(+s[0]) + ',' + s[1]; }
const fE = (v) => (v == null ? '—' : fN(v) + ' €');
const fP = (v, d = 1) => (v == null ? '—' : fN(v, d) + ' %');
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function nice(lo, hi, n) { n = n || 5; if (!(hi > lo)) hi = lo + 1; const raw = (hi - lo) / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), r = raw / mag; const st = (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * mag; return { min: Math.floor(lo / st + 1e-9) * st, max: Math.ceil(hi / st - 1e-9) * st, step: st }; }
const clone = (o) => JSON.parse(JSON.stringify(o));

// Calidad de los leads: las letras son ordinales (A++ es la mejor), así que van en un solo tono con la
// luminosidad ordenada y «Sin valorar» en gris neutro. Rampa azul validada con el validador de la guía de
// visualización (--ordinal) contra el fondo de cada tema: en oscuro la mejor letra es la más clara; en claro, la
// más oscura. Sin rojos ni verdes: esos colores son de estado (bien/mal), no de orden.
const LCOL_TEMA = {
  dark: { 'A++': '#cde2fb', 'A+': '#9ec5f4', A: '#6da7ec', B: '#3987e5', C: '#256abf', D: '#184f95', 'No apto': '#184f95', 'Sin valorar': '#6b6a66' },
  light: { 'A++': '#0d366b', 'A+': '#184f95', A: '#256abf', B: '#3987e5', C: '#6da7ec', D: '#86b6ef', 'No apto': '#86b6ef', 'Sin valorar': '#8a8984' },
};
let LCOL = LCOL_TEMA.dark;
const CURVE_LABELS = { calidad: 'Calidad confirmada', visita: 'F2 celebrada (visita)', diseno: 'Diseños iniciales', seguimiento: 'Seguimiento', ganado: 'Obra firmada (ganado)' };
const LEVEL_NAMES = ['canal', 'zona', 'campaña', 'familia creativa', 'creativo'];
const PAL = ['#3b82f6', '#14b8a6', '#a855f7', '#f43f5e', '#84cc16', '#06b6d4', '#f97316', '#ec4899', '#94a3b8', '#0ea5e9', '#d946ef', '#22c55e'];
const FIXED = { google: '#eab308', meta: '#3b82f6' };
const CHECK_SVG = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.3l2.3 2.3 4.7-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const MIX_SVG = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 6h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

/** Modelo del árbol y de la selección, sin DOM: lo usan el panel y los tests. */
export function crearModelo(data) {
  // Letras del mockup: A++ … D y «Sin valorar». Si el backend trae «No apto», se suma a D (pregunta abierta del mockup).
  const iNA = data.letras.indexOf('No apto'), iD = data.letras.indexOf('D');
  const plegar = (arr) => { if (iNA < 0 || !arr) return arr; const c = arr.slice(); c[iD] += c[iNA] || 0; c.splice(iNA, 1); return c; };
  const LK = iNA < 0 ? data.letras : data.letras.filter((k) => k !== 'No apto');
  const LETTERS = LK.slice(0, -1);
  const PERIODS = data.periodos.map((p) => ({ i: p.i, label: p.etiqueta, sub: p.sub, long: p.largo, block: p.bloque, days: p.dias, ageMid: p.edadMedia, ageEnd: p.edadFin }));
  const TREE = clone(data.tree);
  const NODE = {}, ALL = [], LEAVES = [];
  // Mientras no haya leads de ClickUp (sin carga correcta), se usan los leads que cuenta Meta en sus formularios:
  // entran como «Sin valorar» (Meta no da letra ni fase), así el volumen, el coste por lead y la fase «Lead» tienen datos.
  const leadsDeMeta = !(data.cargas || []).some((c) => c.fuente === 'clickup' && c.estado === 'ok');
  const iSV = LK.length - 1;
  const conMeta = (x) => {
    const y = { ...x, entry: plegar(x.entry), after: plegar(x.after) };
    if (!leadsDeMeta || !x.leadsMeta || x.n) return y;
    const entry = y.entry.slice(); entry[iSV] += x.leadsMeta;
    return { ...y, n: x.leadsMeta, entry, obs: { ...y.obs, lead: x.leadsMeta } };
  };
  const dataById = new Map(data.leaves.map((l) => [l.id, l.d.map(conMeta)]));
  const empty = () => PERIODS.map(() => ({ n: 0, entry: LK.map(() => 0), after: LETTERS.map(() => 0), obs: { lead: 0, visita: 0, diseno: 0, seguimiento: 0, ganado: 0 }, spend: 0 }));
  (function walk(n, p, lv) { n.parent = p; n.level = lv; NODE[n.id] = n; if (lv >= 0) ALL.push(n); if (!n.children || !n.children.length) { n.leaf = true; LEAVES.push(n); } else n.children.forEach((c) => walk(c, n, lv + 1)); })(TREE, null, -1);
  ALL.concat([TREE]).forEach((n) => { n.desc = []; (function d(x) { (x.children || []).forEach((c) => { n.desc.push(c); d(c); }); })(n); });
  LEAVES.forEach((L) => { const ch = []; let p = L; while (p && p.level >= 0) { ch.unshift(p); p = p.parent; } L.channel = ch[0]; L.zone = ch[1] || null; L.campaign = ch[2] || null; L.family = ch[3] || null; L.d = dataById.get(L.id) || empty(); });

  const state = { checked: new Set((data.defaultChecked || []).filter((id) => NODE[id])), excluded: new Set(), expanded: new Set((TREE.children || []).map((c) => c.id)), desglose: 'marcadas' };
  const isExclPath = (n) => { let p = n; while (p && p.level >= 0) { if (state.excluded.has(p.id)) return true; p = p.parent; } return false; };
  const anc = (n) => { let p = n.parent; while (p && p.level >= 0) { if (state.excluded.has(p.id)) return null; if (state.checked.has(p.id)) return p; p = p.parent; } return null; };
  function nodeState(n) { if (state.excluded.has(n.id)) return 'excl'; const exB = n.desc.some((d) => state.excluded.has(d.id)); if (state.checked.has(n.id)) return exB ? 'mixed' : 'on'; if (anc(n)) return exB ? 'mixed' : 'inh'; if (n.desc.some((d) => state.checked.has(d.id) && !isExclPath(d))) return 'mixed'; return 'off'; }
  function toggleNode(n) { const st = nodeState(n); if (st === 'excl') { state.excluded.delete(n.id); if (!anc(n)) state.checked.add(n.id); return; } if (state.checked.has(n.id)) { state.checked.delete(n.id); state.excluded.add(n.id); return; } if (anc(n)) { state.excluded.add(n.id); return; } state.checked.add(n.id); n.desc.forEach((d) => state.excluded.delete(d.id)); }
  // «Seleccionar todo» refleja lo que de verdad está incluido (marcado, heredado o parcial), no solo las marcas directas.
  function allState(B) { const st = B.children.map(nodeState); if (st.every((x) => x === 'on' || x === 'inh')) return 'on'; return st.every((x) => x === 'off' || x === 'excl') ? 'off' : 'mixed'; }
  function toggleAll(B) {
    if (allState(B) === 'on') B.children.forEach((x) => { state.checked.delete(x.id); if (anc(x)) state.excluded.add(x.id); });
    else B.children.forEach((x) => { state.excluded.delete(x.id); x.desc.forEach((d) => state.excluded.delete(d.id)); if (!anc(x)) state.checked.add(x.id); });
  }
  function shortcut(L) { state.checked = new Set(ALL.filter((n) => n.level === L && !isExclPath(n)).map((n) => n.id)); state.checked.forEach((id) => { let p = NODE[id].parent; while (p && p.level >= 0) { state.expanded.add(p.id); p = p.parent; } }); }
  function inc(n) { if (state.excluded.has(n.id)) return []; if (n.leaf) return [n]; return n.children.flatMap(inc); }
  function pathLabel(n) { const a = []; let p = n; while (p && p.level >= 0) { a.unshift(p.name + (p.adId && /^\d+$/.test(p.adId) ? ' (ID ' + p.adId + ')' : '')); p = p.parent; } return a.join(' › '); }
  function shortLabel(n) {
    const up = (k) => { let p = n; for (let i = 0; i < k; i++) p = p.parent; return p; };
    if (n.level <= 0) return n.name;
    if (n.level === 1) return n.parent.name + ' · ' + n.name;
    if (n.level === 2) return up(2).name + ' · ' + up(1).name + ' · ' + n.name;
    if (n.level === 3) return n.name + ' · ' + n.parent.name + ' (' + up(2).name + ')';
    return n.name + (n.adId && /^\d+$/.test(n.adId) ? ' · ' + n.adId : '');
  }
  function colorize(ss) { const used = new Set(ss.map((s) => FIXED[s.key]).filter(Boolean)); let k = 0; ss.forEach((s) => { if (FIXED[s.key]) { s.color = FIXED[s.key]; return; } while (used.has(PAL[k % PAL.length]) && k < PAL.length * 2) k++; s.color = PAL[k % PAL.length]; used.add(s.color); k++; }); }
  function groupKey(l, d) {
    switch (d) {
      case 'canal': return [l.channel.id, l.channel.name];
      case 'zona': return l.zone ? ['z:' + l.zone.name, l.zone.name] : ['z:none:' + l.channel.id, l.channel.name];
      case 'campana': return l.campaign ? [l.campaign.id, shortLabel(l.campaign)] : [l.channel.id, l.channel.name];
      case 'familia': return l.family ? ['f:' + l.family.name, l.family.name] : ['f:none:' + l.channel.id, l.channel.name + ' (sin familias)'];
      default: return [l.id, l.adId && /^\d+$/.test(l.adId) ? l.name + ' · ' + l.adId : shortLabel(l)];
    }
  }
  function getSeries(des) {
    des = des || state.desglose;
    const nodes = ALL.filter((n) => state.checked.has(n.id));
    const U = new Map(); nodes.forEach((n) => inc(n).forEach((l) => U.set(l.id, l))); const union = [...U.values()];
    let series;
    if (des === 'marcadas') series = nodes.map((n) => ({ key: n.id, label: shortLabel(n), title: pathLabel(n), leaves: inc(n) })).filter((s) => s.leaves.length);
    else { const g = new Map(); union.forEach((l) => { const [k, lab] = groupKey(l, des); if (!g.has(k)) g.set(k, { key: k, label: lab, title: lab, leaves: [] }); g.get(k).leaves.push(l); }); series = [...g.values()]; }
    colorize(series);
    return { series, union, total: { key: '__t', label: 'Total sin duplicados', title: 'Cada lead cuenta una sola vez', leaves: union, color: '#8b93a1' } };
  }
  function sumL(leaves, pi) {
    const o = { n: 0, entry: LK.map(() => 0), after: LETTERS.map(() => 0), obs: { lead: 0, visita: 0, diseno: 0, seguimiento: 0, ganado: 0 }, spend: 0, leadsMeta: 0 };
    leaves.forEach((l) => { const d = l.d[pi]; o.n += d.n; d.entry.forEach((v, i) => (o.entry[i] += v)); d.after.forEach((v, i) => (o.after[i] += v)); for (const k in o.obs) o.obs[k] += d.obs[k]; o.spend += d.spend; o.leadsMeta += d.leadsMeta || 0; });
    return o;
  }
  return { LK, LETTERS, PERIODS, TREE, NODE, ALL, LEAVES, leadsDeMeta, state, isExclPath, nodeState, toggleNode, allState, toggleAll, shortcut, inc, pathLabel, shortLabel, getSeries, sumL };
}

/** Monta el panel en `root`. Devuelve `destroy()` para desmontarlo. */
export function montarPanel(root, data, { onGuardarPonderaciones, onRecargar } = {}) {
  const M = crearModelo(data);
  const { LK, LETTERS, PERIODS, TREE, NODE, ALL, leadsDeMeta, state, isExclPath, nodeState, toggleNode, allState, toggleAll, shortcut, pathLabel, shortLabel, getSeries, sumL } = M;
  const AGES = data.edadesCurva;
  const CURVE_DEF = Object.fromEntries(Object.entries(data.curvas).map(([k, v]) => [k, { label: CURVE_LABELS[k] || k, v }]));
  let CURVES = clone(CURVE_DEF);
  const LVAL_DEF = Object.fromEntries(LETTERS.map((k) => [k, data.valoresLetra[k] ?? 0]));
  let LVAL = clone(LVAL_DEF);
  const months = PERIODS.filter((p) => p.block === 0), weeks = PERIODS.filter((p) => p.block === 1);
  // Cabecera de tabla: «May», «19–25 oct», «26 oct–1 nov».
  const colLabel = (p) => (p.sub && p.sub.includes('–') ? p.long.replace(/\s\d{4}$/, '') : p.label + (p.sub ? ' ' + p.sub : ''));
  const fd = (dia) => new Date(dia + 'T12:00:00Z').toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const P0 = data.periodos.filter((p) => p.bloque === 0), P1 = data.periodos.filter((p) => p.bloque === 1);
  const BLOCKS = [{ t: '6 últimos meses completos', s: P0.length ? months[0].long + ' – ' + months[months.length - 1].long : '' }, { t: '4 últimas semanas completas', s: P1.length ? fd(P1[0].desde) + ' – ' + fd(P1[P1.length - 1].hasta) : '' }];
  function cv(c, age) { const v = c.v; if (age <= AGES[0]) return v[0] * Math.max(0, age) / AGES[0]; for (let i = 1; i < AGES.length; i++) { if (age <= AGES[i]) { const t = (age - AGES[i - 1]) / (AGES[i] - AGES[i - 1]); return v[i - 1] + t * (v[i] - v[i - 1]); } } return v[v.length - 1]; }

  Object.assign(state, {
    tab: 'filtros', mode: 'real', showTotal: false, test: null,
    c1: { view: 'entry', unit: 'pct', sel: null },
    c2: { metrics: { espera: true, visita: true, diseno: false, seguimiento: false, ganado: false }, obj: { espera: null, visita: 300, diseno: 500, seguimiento: 600, ganado: 800 }, sel: null },
    c3: { axis: 'pct', phases: { lead: false, visita: true, diseno: false, seguimiento: false, ganado: false } },
    c5: { vend: {}, ph: { F0: true, F2: true, F3: true, F4: true }, media: false, obj: true, per: PERIODS.length - 1 },
  });

  root.innerHTML = '';
  const wrap = h('div', { class: 'mk' }, root);
  const top = h('div', { class: 'top' }, wrap);
  const tl = h('div', null, top);
  const demo = (data.cargas || []).some((c) => c.detalle === 'demo');
  const h2 = h('h2', { text: 'Panel de marketing' }, tl);
  if (demo) h('span', { class: 'badge', text: 'Datos de demostración', title: 'Cargados con backend/scripts/marketing-demo.ts: cifras inventadas' }, h2);
  const corteTxt = new Date(data.corte + 'T12:00:00Z').toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  h('p', { class: 'sub', text: `Grupo LYN · Corte al ${corteTxt} · Periodos por fecha de alta del lead, hora de Madrid` + (leadsDeMeta ? ' · Leads según Meta: falta el acceso a ClickUp, sin letra ni fase' : '') }, tl);
  const tc = h('div', { class: 'tc' }, top);
  const modeSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Real o ponderado' }, tc);
  [['real', 'Real'], ['pond', 'Ponderado']].forEach(([m, t]) => h('button', { type: 'button', 'data-mode': m, 'aria-pressed': String(state.mode === m), text: t, onclick: (e) => { if (e.currentTarget.disabled) return; state.mode = m; renderMain(); } }, modeSeg));
  h('button', { type: 'button', class: 'ghost', text: 'Tabla de ponderaciones', onclick: openPond }, tc);
  // Tema claro u oscuro, como el mockup; se recuerda en el navegador.
  const leerTema = () => { try { return localStorage.getItem('lyn-mk-theme'); } catch { return null; } };
  const tema = leerTema(); if (tema) wrap.dataset.theme = tema;
  LCOL = LCOL_TEMA[wrap.dataset.theme === 'light' ? 'light' : 'dark'];
  h('button', { type: 'button', class: 'ghost', text: 'Tema', title: 'Cambiar entre tema claro y oscuro', onclick: () => { wrap.dataset.theme = wrap.dataset.theme === 'light' ? 'dark' : 'light'; LCOL = LCOL_TEMA[wrap.dataset.theme]; try { localStorage.setItem('lyn-mk-theme', wrap.dataset.theme); } catch { /* sin almacenamiento */ } renderMain(); } }, tc);
  const tabs = h('nav', { class: 'tabs', role: 'tablist' }, wrap);
  const layout = h('div', { class: 'layout' }, wrap);
  const side = h('aside', { class: 'side', 'aria-label': 'Filtros' }, layout);
  const main = h('div', { class: 'main' }, layout);
  const tip = h('div', { class: 'tip', hidden: true }, wrap);
  const dlg = h('dialog', null, wrap);

  function showTip(html, ev) { tip.innerHTML = html; tip.hidden = false; const r = tip.getBoundingClientRect(); let x = ev.clientX + 14, y = ev.clientY + 14; if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 14; if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - 14; tip.style.left = Math.max(8, x) + 'px'; tip.style.top = Math.max(8, y) + 'px'; }
  function hideTip() { tip.hidden = true; }
  function phaseVal(a, k, pi, mode) { mode = mode || state.mode; const raw = a.obs[k]; if (k === 'lead' || mode === 'real') return { v: raw, est: false }; const c = cv(CURVES[k], PERIODS[pi].ageMid); if (c < 0.05) return { v: null, est: true, na: true }; return { v: raw / c, est: c < 0.999 }; }

  /* ---------- gráfico de líneas ---------- */
  function regionsFor(W, m, gap) { const plotW = W - m.l - m.r; const w0 = (plotW - gap) * 0.58, w1 = plotW - gap - w0; return [{ x0: m.l, x1: m.l + w0, idx: months.map((p) => p.i) }, { x0: m.l + w0 + gap, x1: m.l + w0 + gap + w1, idx: weeks.map((p) => p.i) }]; }
  function xOf(rg, i) { const r = rg[PERIODS[i].block], k = r.idx.indexOf(i), st = (r.x1 - r.x0) / r.idx.length; return r.x0 + st * (k + 0.5); }
  function stepOf(rg, i) { const r = rg[PERIODS[i].block]; return (r.x1 - r.x0) / r.idx.length; }
  function drawLines(host, o) {
    host.innerHTML = ''; host.style.overflowX = 'auto'; const W = Math.max(640, host.clientWidth || 800), H = o.height || 330; const split = o.layout === 'split';
    const m = { t: 46, r: o.refs && o.refs.length ? 92 : 14, b: o.subLabels ? 58 : 44, l: 58 }; const rg = regionsFor(W, m, split ? 46 : 30);
    const svg = sv('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img', 'aria-label': o.aria || '' }, host);
    const vals = []; o.series.forEach((s) => s.values.forEach((v) => { if (v != null && isFinite(v)) vals.push(v); })); (o.refs || []).forEach((r) => vals.push(r.y));
    let lo = o.yMin != null ? o.yMin : Math.min(0, ...vals), hi = o.yMax != null ? o.yMax : Math.max(...vals, o.minHi || 1);
    const sc = nice(lo, hi, o.ticks || 5); if (o.yMin != null) sc.min = o.yMin; if (o.yMax != null) sc.max = o.yMax;
    const Y = (v) => m.t + (H - m.t - m.b) * (1 - (v - sc.min) / (sc.max - sc.min));
    rg.forEach((r, b) => { const x = split ? r.x0 : (r.x0 + r.x1) / 2; sv('text', { x, y: 14, class: 'blk', 'text-anchor': split ? 'start' : 'middle', text: BLOCKS[b].t }, svg); sv('text', { x, y: 28, class: 'blks', 'text-anchor': split ? 'start' : 'middle', text: BLOCKS[b].s }, svg); });
    for (let v = sc.min, g = 0; v <= sc.max + sc.step * 1e-6 && g < 40; v += sc.step, g++) { const vv = Math.round(v / sc.step) * sc.step; rg.forEach((r) => sv('line', { x1: r.x0, x2: r.x1, y1: Y(vv), y2: Y(vv), class: Math.abs(vv) < 1e-9 && sc.min < 0 ? 'zero' : 'grid' }, svg)); sv('text', { x: m.l - 8, y: Y(vv) + 4, class: 'ylab', 'text-anchor': 'end', text: (o.fmtAxis || fN)(vv) }, svg); if (split) sv('text', { x: rg[1].x0 - 6, y: Y(vv) + 4, class: 'ylab', 'text-anchor': 'end', text: (o.fmtAxis || fN)(vv) }, svg); }
    if (!split) { const xs = (rg[0].x1 + rg[1].x0) / 2; sv('line', { x1: xs, x2: xs, y1: m.t - 8, y2: H - m.b, class: 'sep' }, svg); }
    const cy = (m.t + H - m.b) / 2; sv('text', { x: 13, y: cy, class: 'ylab', 'text-anchor': 'middle', transform: 'rotate(-90 13 ' + cy + ')', text: o.yLabel || '' }, svg);
    PERIODS.forEach((p) => { const x = xOf(rg, p.i); sv('text', { x, y: H - m.b + 15, class: 'xlab', 'text-anchor': 'middle', text: p.label }, svg); if (p.sub) sv('text', { x, y: H - m.b + 27, class: 'xsub', 'text-anchor': 'middle', text: p.sub }, svg); if (o.subLabels) sv('text', { x, y: H - m.b + (p.sub ? 40 : 28), class: 'xsub2', 'text-anchor': 'middle', text: o.subLabels[p.i] }, svg); });
    const rl = (o.refs || []).map((r) => ({ r, y: Y(r.y), ly: Y(r.y) + 3.5 })).sort((a, b) => a.y - b.y); for (let i = 1; i < rl.length; i++) if (rl[i].ly - rl[i - 1].ly < 11) rl[i].ly = rl[i - 1].ly + 11;
    rl.forEach(({ r, y, ly }) => { rg.forEach((g) => sv('line', { x1: g.x0, x2: g.x1, y1: y, y2: y, stroke: r.color || 'var(--faint)', 'stroke-width': 1.2, 'stroke-dasharray': r.dash || '5 4', opacity: r.opacity || 0.9 }, svg)); sv('text', { x: rg[1].x1 + 6, y: ly, class: 'refl', text: r.label, fill: r.color || 'var(--muted)' }, svg); });
    const hl = sv('line', { class: 'hl', y1: m.t - 4, y2: H - m.b, x1: 0, x2: 0, visibility: 'hidden' }, svg);
    o.series.forEach((s) => {
      rg.forEach((r) => { let d = '', pen = false; r.idx.forEach((i) => { const v = s.values[i]; if (v == null || !isFinite(v)) { pen = false; return; } const x = xOf(rg, i), y = Y(v); d += (pen ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1); pen = true; }); if (d) sv('path', { d, fill: 'none', stroke: s.color, 'stroke-width': s.width || 2, 'stroke-dasharray': s.dash || null, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: s.opacity || 1 }, svg); });
      s.values.forEach((v, i) => { if (v == null || !isFinite(v)) return; const x = xOf(rg, i), y = Y(v), est = s.est && s.est[i]; sv('circle', { cx: x, cy: y, r: s.r || 3.4, fill: est ? 'var(--panel)' : s.color, stroke: s.color, 'stroke-width': est ? 1.6 : 0 }, svg); if (o.pointLabels && !s.noLabel) sv('text', { x, y: v < 0 ? y + 15 : y - 8, class: 'plab', 'text-anchor': 'middle', text: o.fmtPoint ? o.fmtPoint(v) : fN(v) }, svg); });
    });
    if (!vals.length && !o.allowEmpty) sv('text', { x: W / 2, y: H / 2, class: 'empty', 'text-anchor': 'middle', text: o.emptyText || 'Sin datos para la selección' }, svg);
    PERIODS.forEach((p) => { const x = xOf(rg, p.i), st = stepOf(rg, p.i); const band = sv('rect', { x: x - st / 2, y: m.t - 6, width: st, height: H - m.t - m.b + 6, class: 'band' }, svg); band.addEventListener('mousemove', (ev) => { hl.setAttribute('x1', x); hl.setAttribute('x2', x); hl.setAttribute('visibility', 'visible'); if (o.tooltip) showTip(o.tooltip(p.i), ev); }); band.addEventListener('mouseleave', () => { hl.setAttribute('visibility', 'hidden'); hideTip(); }); if (o.onClick) band.addEventListener('click', () => { hideTip(); o.onClick(p.i); }); });
    return svg;
  }
  function legendLines(host, items) { const lg = h('div', { class: 'legend' }, host); items.forEach((it) => { const sp = h('span', { class: 'it' }, lg); const s = sv('svg', { width: 26, height: 10 }, sp); sv('line', { x1: 1, x2: 25, y1: 5, y2: 5, stroke: it.color || 'var(--muted)', 'stroke-width': 2, 'stroke-dasharray': it.dash || null }, s); h('span', { html: it.html || esc(it.label) }, sp); }); return lg; }
  function tipTable(title, rows) { return '<div class="h">' + esc(title) + '</div><table>' + rows.map((r) => '<tr><td>' + (r.color ? '<span class="swl" style="background:' + r.color + '"></span>' : '') + esc(r.label) + '</td><td class="n">' + r.value + '</td></tr>').join('') + '</table>'; }

  /* ---------- barras apiladas ---------- */
  function drawStacked(host, o) {
    host.innerHTML = ''; host.style.overflowX = 'auto'; const W = Math.max(640, host.clientWidth || 800), H = o.height || 360; const m = { t: 50, r: 12, b: 46, l: 66 }; const rg = regionsFor(W, m, 26);
    const svg = sv('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img', 'aria-label': o.aria || '' }, host);
    const pct = o.unit === 'pct'; let mx = 1; o.series.forEach((s) => s.bars.forEach((b) => { if (b && !b.na) mx = Math.max(mx, b.total); })); const sc = pct ? { min: 0, max: 100, step: 25 } : nice(0, mx, 5);
    const Y = (v) => m.t + (H - m.t - m.b) * (1 - (v - sc.min) / (sc.max - sc.min));
    rg.forEach((r, b) => { sv('text', { x: r.x0, y: 14, class: 'blk', text: BLOCKS[b].t }, svg); sv('text', { x: r.x0, y: 28, class: 'blks', text: BLOCKS[b].s }, svg); });
    for (let v = sc.min; v <= sc.max + 1e-6; v += sc.step) { rg.forEach((r) => sv('line', { x1: r.x0, x2: r.x1, y1: Y(v), y2: Y(v), class: 'grid' }, svg)); sv('text', { x: m.l - 8, y: Y(v) + 4, class: 'ylab', 'text-anchor': 'end', text: pct ? fN(v) + ' %' : (o.fmtAxis || fN)(v) }, svg); }
    const cy = (m.t + H - m.b) / 2; sv('text', { x: 13, y: cy, class: 'ylab', 'text-anchor': 'middle', transform: 'rotate(-90 13 ' + cy + ')', text: pct ? '% de las altas del periodo' : o.yLabel || 'Leads' }, svg);
    const k = Math.max(1, o.series.length);
    PERIODS.forEach((p) => {
      const cx = xOf(rg, p.i), st = stepOf(rg, p.i), gw = st * 0.84, bw = Math.min(36, gw / k - 3), x0 = cx - (bw * k + 3 * (k - 1)) / 2;
      sv('text', { x: cx, y: H - m.b + 15, class: 'xlab', 'text-anchor': 'middle', text: p.label }, svg); if (p.sub) sv('text', { x: cx, y: H - m.b + 27, class: 'xsub', 'text-anchor': 'middle', text: p.sub }, svg);
      o.series.forEach((s, si) => {
        const b = s.bars[p.i]; const x = x0 + si * (bw + 3); const g = sv('g', { class: 'bar' }, svg);
        if (!b || b.na) { sv('rect', { x, y: m.t, width: bw, height: H - m.t - m.b, fill: 'none', stroke: 'var(--line)', 'stroke-dasharray': '3 3' }, g); }
        else { let acc = 0; b.segs.forEach((sg) => { const val = pct ? (b.total ? sg.v / b.total * 100 : 0) : sg.v; if (val <= 0) return; const y1 = Y(acc + val), y0 = Y(acc); sv('rect', { x, y: y1, width: bw, height: Math.max(0, y0 - y1), fill: sg.color || LCOL[sg.k], stroke: 'var(--panel)', 'stroke-width': 1, opacity: b.est ? 0.82 : 1 }, g); acc += val; }); if (bw >= 22) sv('text', { x: x + bw / 2, y: Y(acc) - 5, class: 'tot', 'text-anchor': 'middle', text: (o.fmtTotal || fN)(b.total) }, g); }
        if (k > 1) sv('rect', { x, y: H - m.b + 1, width: bw, height: 3, fill: s.color, rx: 1 }, g);
        g.addEventListener('mousemove', (ev) => showTip(o.tooltip(p.i, si), ev)); g.addEventListener('mouseleave', hideTip); g.addEventListener('click', () => { hideTip(); if (o.onClick) o.onClick(p.i, si); });
      });
    });
    return svg;
  }

  /* ---------- barra lateral ---------- */
  function cbEl(st, label, onclick, title) { const b = h('button', { type: 'button', class: 'cb ' + st, role: 'checkbox', 'aria-checked': st === 'on' || st === 'inh' ? 'true' : st === 'mixed' ? 'mixed' : 'false', 'aria-label': label, title: title || null, onclick }, null); b.innerHTML = st === 'on' || st === 'inh' ? CHECK_SVG : st === 'mixed' ? MIX_SVG : ''; return b; }
  function scopeLabel(n) { if (n.level === -1) return 'Todos los canales'; if (n.level === 0) return 'Todas las zonas de ' + n.name; if (n.level === 1) return 'Todas las campañas de ' + n.name; if (n.level === 2) return 'Todas las familias de esta campaña'; return 'Todos los creativos de esta familia'; }
  function stTitle(st, n) { if (st === 'inh') { let p = n.parent; while (p && !state.checked.has(p.id)) p = p.parent; return 'Incluido porque «' + (p ? p.name : '') + '» está marcado. Pulsa para excluirlo.'; } if (st === 'excl') return 'Excluido a mano. Los atajos lo respetan. Pulsa para volver a incluirlo.'; if (st === 'mixed') return 'Marcado parcialmente'; return null; }
  function renderTreeNode(n, depth, box) {
    const open = state.expanded.has(n.id); const row = h('div', { class: 'tn', role: 'treeitem', 'aria-level': depth + 1, 'aria-expanded': n.leaf ? null : String(open), style: 'padding-left:' + (4 + depth * 14) + 'px' }, box);
    if (!n.leaf) h('button', { type: 'button', class: 'chev', 'aria-label': (open ? 'Cerrar ' : 'Abrir ') + n.name, text: open ? '▾' : '▸', onclick: () => { if (open) state.expanded.delete(n.id); else state.expanded.add(n.id); renderSide(); } }, row); else h('span', { class: 'chev-sp' }, row);
    const st = nodeState(n); row.appendChild(cbEl(st, n.name, () => { toggleNode(n); render(); }, stTitle(st, n)));
    h('span', { class: 'tl' + (st === 'excl' ? ' excl' : '') + (n.level === 0 ? ' lvl0' : ''), text: n.name, title: pathLabel(n) + ' · ' + LEVEL_NAMES[n.level], onclick: () => { toggleNode(n); render(); } }, row);
    if (n.adId && /^\d+$/.test(n.adId)) h('span', { class: 'adid', text: 'ID …' + n.adId.slice(-4), title: 'ID de anuncio ' + n.adId }, row);
    if (!n.leaf && open) { const ar = h('div', { class: 'tn all', style: 'padding-left:' + (4 + (depth + 1) * 14) + 'px' }, box); h('span', { class: 'chev-sp' }, ar); ar.appendChild(cbEl(allState(n), scopeLabel(n), () => { toggleAll(n); render(); })); h('span', { class: 'tl', text: scopeLabel(n), onclick: () => { toggleAll(n); render(); } }, ar); n.children.forEach((c) => renderTreeNode(c, depth + 1, box)); }
  }
  function renderSide() {
    side.innerHTML = '';
    if (state.tab === 'c5') { renderSide5(side); return; }
    h('div', { class: 'sideh', text: 'Marcar automáticamente' }, side); const sc = h('div', { class: 'shortcuts' }, side);
    [['Canales', 0], ['Zonas', 1], ['Campañas', 2], ['Familias creativas', 3], ['Creativos', 4]].forEach(([t, l]) => h('button', { type: 'button', class: 'chip', text: t, title: 'Marca solo las casillas de nivel ' + LEVEL_NAMES[l] + ' y respeta lo excluido', onclick: () => { shortcut(l); render(); } }, sc));
    h('p', { class: 'hint', text: 'Cada atajo sustituye las marcas por las de ese nivel y respeta lo que hayas excluido. Después puedes marcar o desmarcar a mano.' }, side);
    h('div', { class: 'sideh', text: 'Árbol de selección' }, side); const tr = h('div', { class: 'tree', role: 'tree' }, side);
    const rr = h('div', { class: 'tn all' }, tr); h('span', { class: 'chev-sp' }, rr); rr.appendChild(cbEl(allState(TREE), 'Todos los canales', () => { toggleAll(TREE); render(); })); h('span', { class: 'tl', text: 'Todos los canales', onclick: () => { toggleAll(TREE); render(); } }, rr);
    (TREE.children || []).forEach((c) => renderTreeNode(c, 0, tr));
    if (state.excluded.size) { h('div', { class: 'sideh', text: 'Excluido a mano' }, side); const ex = h('div', { class: 'exl' }, side); [...state.excluded].forEach((id) => h('span', { text: shortLabel(NODE[id]) }, ex)); h('button', { type: 'button', class: 'linkbtn', style: 'margin:6px 4px 0', text: 'Quitar exclusiones', onclick: () => { state.excluded.clear(); render(); } }, side); }
    h('div', { class: 'sideh', text: 'Desglosar por' }, side); const sel = h('select', { 'aria-label': 'Desglosar por', style: 'width:100%', onchange: (e) => { state.desglose = e.target.value; renderMain(); } }, side);
    [['marcadas', 'Cada casilla marcada'], ['canal', 'Canal'], ['zona', 'Zona (suma canales)'], ['campana', 'Campaña'], ['familia', 'Familia creativa (suma campañas y zonas)'], ['creativo', 'Creativo individual']].forEach(([v, t]) => h('option', { value: v, text: t, selected: state.desglose === v }, sel));
    h('p', { class: 'hint', text: 'Va aparte de la selección: marca todo Meta y elige «Familia creativa» para comparar familias sumando todas sus campañas.' }, side);
    const tl2 = h('label', { class: 'chk', style: 'margin:10px 4px 0' }, side); h('input', { type: 'checkbox', checked: state.showTotal, onchange: (e) => { state.showTotal = e.target.checked; renderMain(); } }, tl2); h('span', { text: 'Mostrar el total sin duplicados' }, tl2);
    h('button', { type: 'button', class: 'linkbtn', style: 'margin:12px 4px 0;display:block', text: 'Volver a la selección por defecto', onclick: () => { state.checked = new Set((data.defaultChecked || []).filter((id) => NODE[id])); state.excluded.clear(); state.expanded = new Set((TREE.children || []).map((c) => c.id)); render(); } }, side);
    h('p', { class: 'hint', text: 'Por defecto: Google, Meta Alicante, Meta Murcia y Meta Sureste.' }, side);
  }

  /* ---------- nota comercial: datos del calificador interno ---------- */
  const NOTA = data.nota;
  const VEND = (NOTA?.vendedores || []).map((v) => ({ id: v.id, name: v.name, ph: v.fases, d: v.d }));
  VEND.forEach((v) => { state.c5.vend[v.id] = true; });
  const PH5 = [{ k: 'F0', label: 'F0 · Contacto inicial', color: '#3b82f6' }, { k: 'F2', label: 'F2 · Visita', color: '#eab308' }, { k: 'F3', label: 'F3 · Presentación', color: '#ec4899' }, { k: 'F4', label: 'F4 · nombre por definir', color: '#ef4444' }];
  const HIST = 12;
  function renderSide5(box) {
    h('div', { class: 'sideh', text: 'Vendedor' }, box);
    if (!VEND.length) h('p', { class: 'hint', text: 'Aún no hay comerciales con llamadas evaluadas.' }, box);
    VEND.forEach((v) => { const l = h('label', { class: 'chk', style: 'display:flex;margin:4px' }, box); h('input', { type: 'checkbox', checked: state.c5.vend[v.id], onchange: (e) => { state.c5.vend[v.id] = e.target.checked; renderMain(); } }, l); h('span', { text: v.name + ' (' + v.ph.join(', ') + ')' }, l); });
    h('div', { class: 'sideh', text: 'Fases' }, box); PH5.forEach((p) => { const l = h('label', { class: 'chk', style: 'display:flex;margin:4px' }, box); h('input', { type: 'checkbox', checked: state.c5.ph[p.k], onchange: (e) => { state.c5.ph[p.k] = e.target.checked; renderMain(); } }, l); h('span', { html: '<span class="swl" style="background:' + p.color + '"></span>' + esc(p.label) }, l); });
    h('div', { class: 'sideh', text: 'Referencias por fase' }, box); [['media', 'Media de los últimos 12 meses', '6 4'], ['obj', 'Objetivo: media de los 3 mejores meses', '2 4']].forEach(([k, t, d]) => { const l = h('label', { class: 'chk', style: 'display:flex;margin:4px' }, box); h('input', { type: 'checkbox', checked: state.c5[k], onchange: (e) => { state.c5[k] = e.target.checked; renderMain(); } }, l); const s = sv('svg', { width: 22, height: 8 }, l); sv('line', { x1: 1, x2: 21, y1: 4, y2: 4, stroke: 'var(--muted)', 'stroke-width': 1.5, 'stroke-dasharray': d }, s); h('span', { text: t }, l); });
    h('p', { class: 'hint', text: 'Datos de desempeño de empleados: solo los ven Dirección y Ernesto.' }, box);
  }
  function g5(pk, slot) { let n = 0, cel = 0, sm = 0, it = 0; VEND.forEach((v) => { if (!state.c5.vend[v.id] || !v.d[pk]) return; const x = v.d[pk][slot]; if (!x) return; n += x.n; cel += x.cel; sm += (x.mean || 0) * x.n; it += x.int; }); return { n, cel, mean: n ? sm / n : null, int: it }; }
  const slotOf = (pi) => (PERIODS[pi].block === 0 ? HIST - months.length + months.findIndex((p) => p.i === pi) : HIST + weeks.findIndex((p) => p.i === pi));
  function refs5(pk) { const ms = []; for (let s = 0; s < HIST; s++) { const x = g5(pk, s); if (x.mean != null) ms.push(x.mean); } if (!ms.length) return null; const top = ms.slice().sort((a, b) => b - a).slice(0, 3); return { media: ms.reduce((a, b) => a + b, 0) / ms.length, obj: top.reduce((a, b) => a + b, 0) / top.length }; }

  /* ---------- pestañas ---------- */
  const TABS = [{ id: 'filtros', label: 'Filtros · Reuniones F2' }, { id: 'c1', label: '1 · Calidad de los leads' }, { id: 'c2', label: '2 · Coste por fase' }, { id: 'c3', label: '3 · Conversión entre fases' }, { id: 'c4', label: '4 · Cambio de valoración' }, ...(NOTA ? [{ id: 'c5', label: '5 · Nota comercial' }] : []), { id: 'notas', label: 'Notas para la reunión' }];
  const NOPOND = { c4: 'Compara los mismos leads a igual antigüedad: no necesita ponderar.', c5: 'Las notas son reales: las reuniones ya están evaluadas.', notas: '' };
  function renderTabs() { tabs.innerHTML = ''; TABS.forEach((x) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(state.tab === x.id), text: x.label, onclick: () => { state.tab = x.id; render(); } }, tabs)); }
  function renderMode() { modeSeg.querySelectorAll('button').forEach((b) => { b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)); const dis = state.tab in NOPOND; b.disabled = dis; b.title = dis ? NOPOND[state.tab] : ''; }); }
  const modeTxt = () => (state.mode === 'real' ? 'Real' : 'Ponderado por antigüedad');
  function notesBox(c, title, items) { const d = h('details', { class: 'notes' }, c); h('summary', { text: title }, d); const ul = h('ul', null, d); items.forEach((i) => h('li', { html: i, class: i.indexOf('¿') >= 0 ? 'q' : null }, ul)); return d; }
  const card = (title, sub) => { const c = h('section', { class: 'card' }, main); h('h3', { class: 't', text: title }, c); h('p', { class: 'cs', text: sub }, c); return c; };
  function figTable(box, lines, fmt) { const w = h('div', { style: 'overflow-x:auto;margin-top:6px' }, box); const t = h('table', { class: 'dt' }, w); const hr = h('tr', null, h('thead', null, t)); h('th', { text: 'Serie' }, hr); PERIODS.forEach((p) => { if (p.i === weeks[0]?.i) h('th', { class: 'gap' }, hr); h('th', { text: colLabel(p) }, hr); }); const tb = h('tbody', null, t); lines.forEach((l) => { const tr = h('tr', null, tb); h('td', { html: '<span class="swl" style="background:' + l.color + '"></span>' + esc(l.label) }, tr); l.values.forEach((v, i) => { if (i === weeks[0]?.i) h('td', { class: 'gap' }, tr); h('td', { class: l.est && l.est[i] ? 'est' : null, text: v == null ? '—' : (l.est && l.est[i] ? '≈' : '') + fmt(v) }, tr); }); }); }

  /* ---------- Filtros · F2 ---------- */
  const f2val = (leaves, pi) => phaseVal(sumL(leaves, pi), 'visita', pi);
  function renderFiltros() {
    const c = card('Reuniones F2', 'Prototipo del árbol de filtros · F2 celebradas por fecha de alta del lead · ' + modeTxt());
    const tb = h('div', { class: 'testbar' }, c); h('button', { type: 'button', class: 'primary', text: 'Ejecutar la prueba de Alex', onclick: () => { runAlexTest(); render(); } }, tb); h('span', { class: 'muted', text: 'Zonas → desmarcar Meta · Murcia → Campañas → Ponderado' }, tb);
    if (state.test) { const ul = h('ul', { class: 'res' }, c); state.test.forEach((r) => h('li', { class: r.ok ? 'ok' : 'bad', text: (r.ok ? '✓ ' : '✗ ') + r.t }, ul)); }
    const { series, total } = getSeries();
    if (!series.length) { h('p', { class: 'note', text: 'Ningún elemento seleccionado.' }, c); notesF(c); return; }
    const rows = series.map((s) => ({ s, vals: PERIODS.map((p) => f2val(s.leaves, p.i)) })); const trow = { s: total, vals: PERIODS.map((p) => f2val(total.leaves, p.i)) };
    const mx = [0, 1].map((b) => Math.max(1, ...rows.concat([trow]).flatMap((r) => r.vals.filter((v, i) => PERIODS[i].block === b && v.v != null).map((v) => v.v))));
    const w = h('div', { style: 'overflow-x:auto' }, c); const t = h('table', { class: 'dt' }, w); const th = h('tr', null, h('thead', null, t)); h('th', { text: 'Selección' }, th);
    PERIODS.forEach((p) => { if (p.i === weeks[0]?.i) h('th', { class: 'gap' }, th); h('th', { html: esc(p.label) + (p.sub ? ' <span class="muted">' + esc(p.sub) + '</span>' : '') }, th); });
    const tbd = h('tbody', null, t);
    const addRow = (r, cls) => { const tr = h('tr', { class: cls || null }, tbd); const td = h('td', null, tr); const rl = h('div', { class: 'rowlab', title: r.s.title }, td); h('span', { html: '<span class="swl" style="background:' + r.s.color + '"></span>' + esc(r.s.label) }, rl); if (r.s.key !== '__t' && state.desglose === 'marcadas' && NODE[r.s.key]) h('small', { text: LEVEL_NAMES[NODE[r.s.key].level] + (nodeState(NODE[r.s.key]) === 'mixed' ? ' · con exclusiones' : '') }, rl);
      r.vals.forEach((v, i) => { if (i === weeks[0]?.i) h('td', { class: 'gap' }, tr); const cc = h('td', null, tr); h('span', { class: v.est ? 'est' : null, text: v.v == null ? '—' : (v.est ? '≈' : '') + fN(v.v) }, cc); const mb = h('div', { class: 'mb' }, cc); h('i', { style: 'width:' + (v.v == null ? 0 : Math.min(100, v.v / mx[PERIODS[i].block] * 100)) + '%;background:' + r.s.color }, mb); }); };
    rows.forEach((r) => addRow(r)); addRow(trow, 'tot');
    const last = months[months.length - 1]?.i; const sumRows = rows.reduce((a, r) => a + (r.vals[last].v || 0), 0);
    if (series.length > 1 && sumRows > (trow.vals[last].v || 0) + 0.5) h('p', { class: 'note', text: 'Hay selecciones que se solapan: en ' + PERIODS[last].long + ' la suma de filas da ' + fN(sumRows) + ' y el total cuenta cada reunión una vez: ' + fN(trow.vals[last].v) + '.' }, c);
    if (state.mode === 'pond') h('p', { class: 'note', text: '≈ = estimado con la curva de maduración de F2 de la tabla de ponderaciones. Los periodos antiguos ya están maduros y no cambian.' }, c);
    notesF(c);
  }
  function notesF(c) { notesBox(c, 'Qué valida esta pestaña y dudas', ['Fuente: carpeta «Filtros» (documento y grabación del prototipo de Alex).', 'Los atajos marcan solo ese nivel y abren las ramas necesarias. Abrir o cerrar una rama no cambia la selección.', 'Una casilla marcada incluye toda su rama aunque los hijos no estén marcados. Desmarcar un hijo deja la rama «parcial» y lo excluye.', '«Seleccionar todo» aparece en cada rama con su alcance: «Todas las campañas de Alicante», «Todos los creativos de esta familia».', 'Si se marcan una zona y una campaña suya, salen las dos filas y el total cuenta cada reunión una vez.', 'Los anuncios con el mismo nombre y distinto ID aparecen como creativos distintos, y una familia puede estar en varias campañas y zonas.', '¿Al pulsar «Familias creativas», Google queda fuera porque no tiene familias? Propuesta: sí.', '¿Desmarcar a mano una casilla que marcó un atajo cuenta como exclusión para los atajos siguientes? Propuesta: sí; es lo que pide la prueba de Alex.']); }
  // La prueba de Alex del mockup, sobre el árbol real: Zonas → desmarcar Meta · Murcia → Campañas → Ponderado.
  function runAlexTest() {
    const res = []; state.checked = new Set(); state.excluded = new Set(); state.mode = 'real'; state.desglose = 'marcadas';
    shortcut(1); const zonas = ALL.filter((n) => n.level === 1).map((n) => n.id).sort();
    res.push({ ok: [...state.checked].sort().join() === zonas.join(), t: '«Zonas» marca solo las ' + zonas.length + ' zonas' });
    const murcia = (TREE.children || []).find((c) => c.id === 'meta')?.children?.find((z) => z.name === 'Murcia');
    if (murcia) { toggleNode(murcia); res.push({ ok: !state.checked.has(murcia.id) && state.excluded.has(murcia.id), t: 'Meta · Murcia queda desmarcada y excluida' }); }
    shortcut(2); const exp = ALL.filter((n) => n.level === 2 && !isExclPath(n)).map((n) => n.id).sort(); const got = [...state.checked].sort();
    res.push({ ok: got.join() === exp.join() && (!murcia || !murcia.desc.some((d) => state.checked.has(d.id))), t: '«Campañas» marca las campañas de todas las zonas salvo las de Meta Murcia' });
    const ultima = PERIODS.length - 1; const antes = getSeries().series.map((x) => f2val(x.leaves, ultima).v).join('|'); state.mode = 'pond';
    const despues = getSeries().series.map((x) => f2val(x.leaves, ultima).v).join('|');
    res.push({ ok: [...state.checked].sort().join() === exp.join(), t: 'Al cambiar a «Ponderado» se conservan las mismas campañas' });
    res.push({ ok: antes !== despues || getSeries().union.every((l) => !sumL([l], ultima).obs.visita), t: 'Los dos periodos se recalculan con la curva de F2' + (antes === despues ? ' (sin visitas que estimar en la última semana)' : '') });
    state.test = res; return res;
  }

  /* ---------- Gráfico 1 · Calidad ---------- */
  const NL = LETTERS.length;
  function c1Bar(a, pi) {
    if (state.c1.view === 'entry') return { segs: a.entry.map((v, i) => ({ k: LK[i], v })), total: a.n, est: false };
    if (state.mode === 'real') { const val = a.after.reduce((x, y) => x + y, 0); return { segs: [...a.after.map((v, i) => ({ k: LETTERS[i], v })), { k: 'Sin valorar', v: a.n - val }], total: a.n, est: false }; }
    const c = cv(CURVES.calidad, PERIODS[pi].ageMid); if (c < 0.05) return { na: true, total: a.n };
    let est = a.after.map((v) => v / c); const s = est.reduce((x, y) => x + y, 0), cap = a.n * 0.97; if (s > cap) est = est.map((v) => v * cap / s); const t = est.reduce((x, y) => x + y, 0);
    return { segs: [...est.map((v, i) => ({ k: LETTERS[i], v })), { k: 'Sin valorar', v: Math.max(0, a.n - t) }], total: a.n, est: c < 0.999 };
  }
  function renderC1() {
    const c = card('Calidad de los leads', 'Barras apiladas por letra, de A++ a D más «Sin valorar»');
    const ct = h('div', { class: 'ctrls' }, c);
    const s1 = h('div', { class: 'seg', role: 'group', 'aria-label': 'Momento de la valoración' }, ct); [['entry', 'Al entrar'], ['after', 'Tras la gestión']].forEach(([v, t]) => h('button', { type: 'button', 'aria-pressed': String(state.c1.view === v), text: t, onclick: () => { state.c1.view = v; state.c1.sel = null; renderMain(); } }, s1));
    const s2 = h('div', { class: 'seg', role: 'group', 'aria-label': 'Unidad' }, ct); [['pct', 'Porcentaje'], ['num', 'Número']].forEach(([v, t]) => h('button', { type: 'button', 'aria-pressed': String(state.c1.unit === v), text: t, onclick: () => { state.c1.unit = v; renderMain(); } }, s2));
    if (state.c1.view === 'entry') h('p', { class: 'note', text: '«Al entrar» siempre usa datos observados, también con «Ponderado» activado.' }, c);
    else if (state.mode === 'pond') h('p', { class: 'note', text: 'Tras la gestión · Ponderado: reparte las valoraciones que faltan según la curva «Calidad confirmada» de la tabla central. Las barras atenuadas son estimadas; el total de leads es siempre real.' }, c);
    else h('p', { class: 'note', text: 'Tras la gestión · Real: los periodos recientes aún tienen muchos leads «Sin valorar».' }, c);
    const lg = h('div', { class: 'legend' }, c); LK.forEach((k) => { const it = h('span', { class: 'it' }, lg); h('span', { class: 'lg-sw', style: 'background:' + LCOL[k] }, it); h('span', { text: k }, it); });
    const { series, total } = getSeries(); const ss = state.showTotal && series.length > 1 ? series.concat([total]) : series;
    if (ss.length > 1) { const l2 = h('div', { class: 'legend' }, c); h('span', { text: 'Barras de izquierda a derecha:' }, l2); ss.forEach((s) => { const it = h('span', { class: 'it' }, l2); h('span', { class: 'lg-sw', style: 'background:' + s.color + ';height:4px' }, it); h('b', { text: s.label }, it); }); }
    const host = h('div', null, c);
    const bars = ss.map((s) => ({ label: s.label, color: s.color, bars: PERIODS.map((p) => c1Bar(sumL(s.leaves, p.i), p.i)) }));
    const draw = () => drawStacked(host, { series: bars, unit: state.c1.unit, aria: 'Calidad de los leads por periodo', tooltip: (pi, si) => { const b = bars[si].bars[pi]; if (!b || b.na) return tipTable(bars[si].label + ' · ' + PERIODS[pi].long, [{ label: 'Ponderación no disponible', value: '' }]); return tipTable(bars[si].label + ' · ' + PERIODS[pi].long + (b.est ? ' (estimado)' : ''), b.segs.slice().reverse().map((sg) => ({ label: sg.k, color: LCOL[sg.k], value: fN(sg.v) + ' · ' + fP(b.total ? sg.v / b.total * 100 : 0, 0) })).concat([{ label: 'Total de leads', value: fN(b.total) }])); }, onClick: (pi, si) => { state.c1.sel = { pi, si }; renderMain(); } });
    draw(); host._draw = draw;
    h('p', { class: 'note', text: 'La cifra encima de cada barra es el total de leads del periodo. Cada barra suma el 100 % de las altas, incluidas las que siguen sin valorar. Pulsa una barra para ver el detalle.' }, c);
    if (state.c1.sel && bars[state.c1.sel.si]) { const { pi, si } = state.c1.sel; const b = bars[si].bars[pi]; const d = h('div', { class: 'detail' }, c); h('h4', { text: bars[si].label + ' · ' + PERIODS[pi].long + (b.est ? ' · estimado' : '') }, d); if (b.na) h('p', { class: 'note', text: 'Ponderación no disponible.' }, d); else { const t = h('table', { class: 'dt' }, d); const hr = h('tr', null, h('thead', null, t)); ['Categoría', 'Nº', '%'].forEach((x) => h('th', { text: x }, hr)); const tb = h('tbody', null, t); b.segs.slice().reverse().forEach((sg) => { const tr = h('tr', null, tb); h('td', { html: '<span class="swl" style="background:' + LCOL[sg.k] + '"></span>' + esc(sg.k) }, tr); h('td', { text: fN(sg.v) }, tr); h('td', { text: fP(b.total ? sg.v / b.total * 100 : 0) }, tr); }); const tr = h('tr', { class: 'tot' }, tb); h('td', { text: 'Total' }, tr); h('td', { text: fN(b.total) }, tr); h('td', { text: '100 %' }, tr); } }
    notesBox(c, 'Especificación de Alex y dudas', ['Fuente: carpeta «1 barras apiladas» (prompt y vídeo). Sustituye a la descripción que faltaba del gráfico 1.', 'Diez barras en un solo gráfico: 6 meses y 4 semanas, con un pequeño espacio entre bloques. Por defecto «Al entrar» en porcentaje.', 'Al comparar varias selecciones, sus barras van juntas dentro de cada periodo con los mismos colores de letra; la tira de color bajo cada barra indica la selección.', '«Tras la gestión» con «Ponderado» usa la tabla central. Sin tabla: «Ponderación no disponible».', '¿Qué es A++? La matriz actual del calificador de leads va de A+ a D más «No apto». ¿Dónde va «No apto» en este gráfico? (Hoy se suma a D.)']);
  }

  /* ---------- Gráfico 2 · Coste por fase ---------- */
  const METRICS = [{ k: 'espera', label: '€/espera', ph: 'lead', dash: '2 4', name: 'espera' }, { k: 'visita', label: '€/visita', ph: 'visita', dash: '', name: 'visita' }, { k: 'diseno', label: '€/diseño', ph: 'diseno', dash: '7 4', name: 'diseño' }, { k: 'seguimiento', label: '€/seguimiento', ph: 'seguimiento', dash: '9 4 2 4', name: 'seguimiento' }, { k: 'ganado', label: '€/ganado', ph: 'ganado', dash: '14 5', name: 'ganado' }];
  // Leads equivalentes a A (mockup): cada lead vale lo de su letra de entrada; los «Sin valorar», la media de los valorados.
  function eqA(a) { let s = 0, c = 0; for (let i = 0; i < NL; i++) { s += a.entry[i] * LVAL[LETTERS[i]]; c += a.entry[i]; } const avg = c ? s / c : leadsDeMeta ? 1 : 0; return s + a.entry[NL] * avg; }
  function c2Val(a, mt, pi) { if (mt.k === 'espera') { const e = eqA(a); return { v: e ? a.spend / e : null, est: false, res: e }; } const pv = phaseVal(a, mt.ph, pi); if (pv.v == null || pv.v <= 0) return { v: null, est: pv.est, res: pv.v }; return { v: a.spend / pv.v, est: pv.est, res: pv.v }; }
  function renderC2() {
    const c = card('Coste por fase', '€ por resultado · ' + modeTxt() + ' · el documento lo titula «Valor esperado»');
    const ct = h('div', { class: 'ctrls' }, c); const mbox = h('div', { class: 'legend', style: 'margin:0' }, ct);
    METRICS.forEach((mt) => { const l = h('label', { class: 'chk' }, mbox); h('input', { type: 'checkbox', checked: state.c2.metrics[mt.k], onchange: (e) => { state.c2.metrics[mt.k] = e.target.checked; renderMain(); } }, l); const s = sv('svg', { width: 24, height: 8 }, l); sv('line', { x1: 1, x2: 23, y1: 4, y2: 4, stroke: 'var(--text)', 'stroke-width': 1.8, 'stroke-dasharray': mt.dash || null }, s); h('span', { text: mt.label }, l); });
    h('button', { type: 'button', class: 'linkbtn', text: 'Marcar las cinco', onclick: () => { METRICS.forEach((mm) => { state.c2.metrics[mm.k] = true; }); renderMain(); } }, ct);
    const ob = h('div', { class: 'ctrls' }, c); METRICS.forEach((mt) => { const f = h('label', { class: 'field' }, ob); h('span', { text: 'Objetivo máx. · ' + mt.label }, f); h('input', { type: 'number', min: 0, step: 10, placeholder: 'Sin fijar', value: state.c2.obj[mt.k] == null ? '' : state.c2.obj[mt.k], onchange: (e) => { state.c2.obj[mt.k] = e.target.value === '' ? null : +e.target.value; renderMain(); } }, f); });
    h('p', { class: 'note', html: '€/espera = gasto ÷ leads de entrada equivalentes a A según el valor por letra (A+ y A = 1 · B = 0,75 · C = 0,45 · D = 0,15). Siempre real. El resto = gasto ÷ leads que llegan a la fase' + (state.mode === 'pond' ? ', ponderado por antigüedad' : '') + '.' }, c);
    const { series, total } = getSeries(); const ss = state.showTotal && series.length > 1 ? series.concat([total]) : series; const act = METRICS.filter((mm) => state.c2.metrics[mm.k]);
    legendLines(c, ss.map((s) => ({ color: s.color, label: s.label })));
    const lines = []; ss.forEach((s) => act.forEach((mt) => { const vs = PERIODS.map((p) => c2Val(sumL(s.leaves, p.i), mt, p.i)); lines.push({ color: s.color, dash: mt.dash, values: vs.map((v) => v.v), est: vs.map((v) => v.est), label: s.label + ' · ' + mt.label }); }));
    const refs = act.filter((mt) => state.c2.obj[mt.k] != null).map((mt) => ({ y: state.c2.obj[mt.k], label: 'Obj. ' + mt.name + ' · ' + fE(state.c2.obj[mt.k]), dash: mt.dash || '6 3', color: 'var(--faint)' }));
    const host = h('div', null, c);
    const draw = () => drawLines(host, { series: lines, refs, yLabel: '€ por resultado', fmtAxis: (v) => fN(v), aria: 'Coste por fase', emptyText: act.length ? 'Sin datos para la selección' : 'Marca al menos una métrica', tooltip: (pi) => tipTable(PERIODS[pi].long, lines.map((l) => ({ label: l.label, color: l.color, value: l.values[pi] == null ? 'n/d' : (l.est[pi] ? '≈' : '') + fE(l.values[pi]) }))), onClick: (pi) => { state.c2.sel = pi; renderMain(); } }); draw(); host._draw = draw;
    if (state.c2.sel != null) { const pi = state.c2.sel; const d = h('div', { class: 'detail' }, c); h('h4', { text: 'Detalle del punto · ' + PERIODS[pi].long }, d); const t = h('table', { class: 'dt' }, d); const hr = h('tr', null, h('thead', null, t)); ['Selección', 'Métrica', 'Gasto', 'Resultados', '€ por resultado'].forEach((x) => h('th', { text: x }, hr)); const tb = h('tbody', null, t); ss.forEach((s) => { const a = sumL(s.leaves, pi); act.forEach((mt) => { const v = c2Val(a, mt, pi); const tr = h('tr', null, tb); h('td', { html: '<span class="swl" style="background:' + s.color + '"></span>' + esc(s.label) }, tr); h('td', { text: mt.label }, tr); h('td', { text: fE(a.spend) }, tr); h('td', { text: v.res == null ? 'n/d' : (v.est ? '≈' : '') + fN(v.res, mt.k === 'espera' ? 1 : 0) + (mt.k === 'espera' ? ' eq. A' : '') }, tr); h('td', { text: v.v == null ? 'n/d' : (v.est ? '≈' : '') + fE(v.v) }, tr); }); }); }
    else h('p', { class: 'note', text: 'Pulsa un periodo para ver el detalle del punto.' + (state.mode === 'real' ? ' En Real, las semanas recientes salen caras porque aún no han llegado sus visitas; «Ponderado» lo corrige.' : '') }, c);
    const fig = h('details', { class: 'fig' }, c); h('summary', { text: 'Ver cifras por periodo' }, fig); figTable(fig, lines, (v) => fE(v));
    notesBox(c, 'Especificación de Alex y dudas', ['Fuente: carpeta «2» (documento y vídeo con audio). El vídeo lo muestra como «Coste por fase»; el documento lo titula «Valor esperado».', 'Audio: «inicialmente solo vamos a tener marcados por defecto estos dos» → €/espera y €/visita. Selección por defecto: Google, Meta Alicante, Meta Murcia y Meta Sureste.', 'Color = selección (canal, zona…); tipo de línea = métrica. Objetivos del 04/11: visita 300 €, diseño 500 €, seguimiento 600 €, ganado 800 €; espera sin fijar.', 'Resuelve la P-01 de M-3: «€/visita» es coste por visita, no valor esperado por visita.', '¿Cómo cuentan los «Sin valorar» en €/espera? Propuesta del mockup: con el valor medio de los valorados del periodo.', '¿El gráfico se sigue llamando «Valor esperado» o pasa a «Coste por fase»?']);
  }

  /* ---------- Gráfico 3 · Conversión ---------- */
  const PHASES = [{ k: 'lead', label: 'Lead (en espera)', dash: '' }, { k: 'visita', label: 'Visita', dash: '7 4' }, { k: 'diseno', label: 'Diseños iniciales', dash: '2 4' }, { k: 'seguimiento', label: 'Seguimiento', dash: '9 4 2 4' }, { k: 'ganado', label: 'Obra firmada', dash: '14 5' }];
  function renderC3() {
    const c = card('Conversión entre fases', 'Periodos según la fecha de alta del lead · Corte del ' + corteTxt + ' · ' + modeTxt());
    const ct = h('div', { class: 'ctrls' }, c); const f = h('label', { class: 'field' }, ct); h('span', { text: 'Eje vertical' }, f); const sel = h('select', { onchange: (e) => { state.c3.axis = e.target.value; renderMain(); } }, f); [['num', 'Nº que llega'], ['pct', '% desde la fase anterior']].forEach(([v, t]) => h('option', { value: v, text: t, selected: state.c3.axis === v }, sel));
    const pb = h('div', { class: 'legend', style: 'margin:0' }, ct); PHASES.forEach((ph) => { const dis = ph.k === 'lead' && state.c3.axis === 'pct'; const l = h('label', { class: 'chk', title: dis ? 'No hay fase anterior al lead' : null, style: dis ? 'opacity:.45' : null }, pb); h('input', { type: 'checkbox', checked: state.c3.phases[ph.k] && !dis, disabled: dis, onchange: (e) => { state.c3.phases[ph.k] = e.target.checked; renderMain(); } }, l); const s = sv('svg', { width: 24, height: 8 }, l); sv('line', { x1: 1, x2: 23, y1: 4, y2: 4, stroke: 'var(--text)', 'stroke-width': 1.8, 'stroke-dasharray': ph.dash || null }, s); h('span', { text: ph.label }, l); });
    const pct = state.c3.axis === 'pct'; const { series, total } = getSeries(); const ss = state.showTotal && series.length > 1 ? series.concat([total]) : series;
    const act = PHASES.filter((ph) => state.c3.phases[ph.k] && !(pct && ph.k === 'lead'));
    legendLines(c, ss.map((s) => ({ color: s.color, label: s.label })));
    const lines = []; ss.forEach((s) => act.forEach((ph) => { const idx = PHASES.indexOf(ph); const vs = PERIODS.map((p) => { const a = sumL(s.leaves, p.i); const cur = phaseVal(a, ph.k, p.i); if (!pct) return cur; const prev = phaseVal(a, PHASES[idx - 1].k, p.i); if (cur.v == null || prev.v == null || !prev.v) return { v: null, est: cur.est }; return { v: cur.v / prev.v * 100, est: cur.est || prev.est }; }); lines.push({ color: s.color, dash: ph.dash, values: vs.map((v) => v.v), est: vs.map((v) => v.est), label: s.label + ' · ' + (pct ? PHASES[idx - 1].label.split(' ')[0] + ' → ' : '') + ph.label }); }));
    const host = h('div', null, c); const fmt = pct ? (v) => fP(v, 1) : (v) => fN(v);
    const draw = () => drawLines(host, { series: lines, yLabel: pct ? 'Paso desde la fase anterior (%)' : 'Leads que llegan (n)', fmtAxis: pct ? (v) => fN(v) + ' %' : (v) => fN(v), aria: 'Conversión entre fases', emptyText: act.length ? 'Sin datos para la selección' : 'Marca al menos una fase', tooltip: (pi) => tipTable(PERIODS[pi].long, lines.map((l) => ({ label: l.label, color: l.color, value: l.values[pi] == null ? 'n/d' : (l.est[pi] ? '≈' : '') + fmt(l.values[pi]) }))) }); draw(); host._draw = draw;
    h('p', { class: 'note', text: 'Periodos de alta: ' + BLOCKS[0].s.toLowerCase() + ' y semanas del ' + BLOCKS[1].s + '. En Real, las semanas recientes aún no han madurado; en Ponderado, ≈ = estimado. Sin estimación posible: «—».' }, c);
    const fig = h('details', { class: 'fig' }, c); h('summary', { text: 'Ver cifras por periodo' }, fig); figTable(fig, lines, fmt);
    notesBox(c, 'Especificación de Alex y dudas', ['Fuente: carpeta «3» (documento y vídeo). Por defecto: Google, Meta Alicante, Meta Murcia y Meta Sureste, y de lead a visita.', 'Color = selección; tipo de línea = fase. Se pueden comparar varias, por ejemplo Meta frente a Google.', 'El documento dice «Escuchar audio y explicación», pero el vídeo de la carpeta no tiene audio transcribible. ¿Falta otra explicación?', '¿En «% desde la fase anterior», el paso a «Obra firmada» se mide desde seguimiento o desde diseños iniciales?']);
  }

  /* ---------- Gráfico 4 · Cambio de valoración ---------- */
  function renderC4() {
    const c = card('Cambio de valoración del lead', 'Variación de la nota media respecto a la entrada, a igual antigüedad');
    h('div', { class: 'warnbox', text: 'Este gráfico necesita el histórico de letras de cada lead, que guardará el calificador de leads (N-1.2, 869fny1eg). Hasta entonces no hay datos que mostrar.' }, c);
    notesBox(c, 'Especificación de Alex y dudas', ['Fuente: carpeta «4» (documento y vídeo con audio).', 'Audio: antigüedad de 7 y 30 días, y de 2, 3, 4, 5, 6, 9 y 12 meses. Y dos modos: «seleccionamos todos, un filtro normal» o «un comparativo, Meta y Google por separado, por líneas diferentes».', 'Por defecto: Google, Meta Alicante, Meta Murcia y Meta Sureste. Pesos editables (A = 100, B = 75…).', 'Con A++, A+ y A a 100, los cambios entre esas letras no mueven la media. ¿Les damos pesos distintos?', 'Si la nota de entrada es la del día 7, la opción «Día 7» siempre da 0 %. ¿Se quita o la entrada es otra?']);
  }

  /* ---------- Gráfico 5 · Nota comercial ---------- */
  function renderC5() {
    const c = card('Evolución de la nota comercial', 'Grupo LYN · Corte al ' + corteTxt + ' · Nota media del calificador interno por fecha de la reunión o llamada');
    const act = PH5.filter((p) => state.c5.ph[p.k]); const lg = h('div', { class: 'legend' }, c); act.forEach((p) => { const it = h('span', { class: 'it' }, lg); const s = sv('svg', { width: 26, height: 10 }, it); sv('line', { x1: 1, x2: 25, y1: 5, y2: 5, stroke: p.color, 'stroke-width': 2 }, s); sv('circle', { cx: 13, cy: 5, r: 3, fill: p.color }, s); h('b', { text: p.label }, it); });
    const lines = [], refs = []; act.forEach((p) => { const vs = PERIODS.map((pp) => g5(p.k, slotOf(pp.i))); lines.push({ color: p.color, values: vs.map((v) => v.mean), label: p.label, vs }); const r = refs5(p.k); if (r) { if (state.c5.media) refs.push({ y: r.media, label: p.k + ' media ' + fN(r.media, 1), color: p.color, dash: '6 4', opacity: 0.6 }); if (state.c5.obj) refs.push({ y: r.obj, label: p.k + ' obj. ' + fN(r.obj, 1), color: p.color, dash: '2 4', opacity: 0.75 }); } });
    const host = h('div', null, c);
    const draw = () => drawLines(host, { series: lines, refs, layout: 'split', height: 340, yMin: 60, yMax: 100, ticks: 4, fmtAxis: (v) => fN(v), yLabel: 'Nota / 100', aria: 'Evolución de la nota comercial', allowEmpty: !act.length, emptyText: 'Sin llamadas evaluadas en estos periodos', tooltip: (pi) => tipTable(PERIODS[pi].long, lines.map((l) => ({ label: l.label, color: l.color, value: l.vs[pi].mean == null ? 'sin evaluaciones' : fN(l.vs[pi].mean, 1) + ' · ' + fN(l.vs[pi].n) + ' evaluadas' }))), onClick: (pi) => { state.c5.per = pi; renderMain(); } }); draw(); host._draw = draw;
    const dt = h('div', { class: 'detail' }, c); const hd = h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap' }, dt); h('h4', { text: 'Detalle del periodo', style: 'margin:0' }, hd); const ps = h('select', { 'aria-label': 'Periodo del detalle', onchange: (e) => { state.c5.per = +e.target.value; renderMain(); } }, hd); PERIODS.slice().reverse().forEach((p) => h('option', { value: p.i, text: p.long, selected: state.c5.per === p.i }, ps));
    const t = h('table', { class: 'dt', style: 'margin-top:8px' }, dt); const hr = h('tr', null, h('thead', null, t)); ['Fase', 'Media / 100', 'Evaluadas / celebradas'].forEach((x) => h('th', { text: x }, hr)); const tb = h('tbody', null, t); const slot = slotOf(state.c5.per);
    act.forEach((p) => { const x = g5(p.k, slot); const tr = h('tr', null, tb); h('td', { html: '<span class="swl" style="background:' + p.color + '"></span>' + esc(p.k) }, tr); h('td', { text: x.mean == null ? '—' : fN(x.mean, 1) }, tr); h('td', { text: x.cel ? fN(x.n) + ' / ' + fN(x.cel) : 'sin evaluaciones' }, tr); });
    const f0 = g5('F0', slot); h('p', { class: 'note', style: 'margin-top:8px', text: f0.int ? 'Contacto F0 · ' + fN(f0.cel) + ' de ' + fN(f0.int) + ' intentos con conversación (' + fP(f0.cel / f0.int * 100, 0) + ')' : 'Contacto F0 · sin datos para los vendedores elegidos' }, dt);
    notesBox(c, 'Especificación de Alex y dudas', ['Fuente: carpeta «Ventas 5» (documento y la imagen anotada) y WhatsApp del 08/11.', 'Marcas de Alex en la imagen: F4 en la leyenda, como una línea más en los dos gráficos y como fila de la tabla (en su ejemplo, 90 de media y 6/7). Las líneas rojas que dibujó son la serie F4, no referencias.', 'Media y objetivo vienen del documento («opción de marcar la media de esa fase y sus 3 mejores») y del WhatsApp («la media de los 3 mejores meses de los últimos 12»). Se pueden activar o desactivar.', 'Hoy solo F0 tiene datos reales (rúbrica del SDR). F2, F3 y F4 llegarán con sus rúbricas; hasta entonces aparecerán como «sin evaluaciones».', '¿Qué es F4 y qué fase de ETAPA_CRM son F3 y F4?', '¿«Sus 3 mejores» son los 3 mejores meses (como dice el WhatsApp) o los 3 mejores comerciales?']);
  }

  /* ---------- Notas para la reunión ---------- */
  function renderNotas() {
    const c = h('section', { class: 'card notas' }, main); h('h3', { class: 't', text: 'Notas para la reunión con Alex' }, c); h('p', { class: 'cs', text: 'Qué se tomó de cada fuente, qué cambia respecto a los tickets y qué falta decidir.' }, c);
    const sec = (t, items) => { h('h4', { text: t }, c); const ul = h('ul', null, c); items.forEach((i) => h('li', { html: i }, ul)); };
    sec('Fuentes (Drive › Laboratorio › Ventas › Estadísticas)', ['<b>Filtros</b>: documento del prototipo del árbol y su grabación (sin audio).', '<b>1 barras apiladas</b>: prompt detallado y vídeo. Es la descripción que faltaba del gráfico 1.', '<b>2</b>: documento y vídeo con audio (24 s).', '<b>3</b>: documento y vídeo sin audio transcribible.', '<b>4</b>: documento y vídeo con audio (35 s).', '<b>Ventas 5</b>: documento e imagen anotada de la nota comercial.', 'Documento de reglas generales en la raíz de la carpeta.']);
    sec('Comunes a todos los gráficos', ['Árbol de filtros permanente con atajos; «Desglosar por» aparte; total sin duplicados.', 'Dos ventanas a la vez: 6 meses completos y 4 semanas completas de lunes a domingo, por fecha de alta del lead.', 'Selector Real / Ponderado siempre visible. Gasto, leads, CPL y calidad de entrada son siempre reales; los hitos del embudo se ponderan con una curva por hito de la tabla central.', 'Color = selección (canal, zona, campaña…). Tipo de línea o grosor = métrica o fase.', 'Por defecto: Google, Meta Alicante, Meta Murcia y Meta Sureste.']);
    sec('Cambios respecto a los tickets', ['<b>Gráfico 1</b> ya tiene descripción propia (P-09 del épico): «Calidad de los leads», barras apiladas con A++.', '<b>Gráfico 2</b> es «Coste por fase» (€ por resultado), no valor esperado. Resuelve la P-01 de M-3. Por defecto €/espera y €/visita.', '<b>Gráfico 4</b>: selector de antigüedad con 9 opciones y modo «sumar» o «comparar».', '<b>Gráfico 5</b>: F4 es una serie más (línea y fila de la tabla). La media y el objetivo son referencias aparte, activables.']);
    sec('Preguntas abiertas para Alex', ['¿Qué es A++? La matriz actual va de A+ a D más «No apto». ¿Dónde va «No apto» en el gráfico 1?', 'Gráfico 2: ¿cómo cuentan los «Sin valorar» en €/espera? ¿Se llama «Valor esperado» o «Coste por fase»?', 'Gráfico 3: el documento remite a un audio con explicación que no está en la carpeta.', 'Gráfico 4: con A++, A+ y A al mismo peso, sus cambios no mueven la media. ¿«Día 7» se mantiene si la entrada es el día 7?', 'Gráfico 5: ¿qué es F4? ¿«Sus 3 mejores» son meses o comerciales?', 'Filtros: ¿al pulsar «Familias creativas» Google queda fuera? ¿Desmarcar a mano tras un atajo cuenta como exclusión?']);
    // Datos reales de esta instalación (no estaba en el mockup, que usaba datos simulados).
    const carga = (f, nombre) => { const x = (data.cargas || []).find((y) => y.fuente === f); if (!x) return `<b>${nombre}</b>: sin cargas todavía.`; return x.estado === 'ok' ? `<b>${nombre}</b>: <span class="ok">correcta</span> el ${esc(new Date(x.fin).toLocaleString('es-ES'))} (${fN(x.filas)} filas).` : `<b>${nombre}</b>: <span class="bad">error</span> el ${esc(new Date(x.fin).toLocaleString('es-ES'))}: ${esc(x.detalle || '')}`; };
    const av = data.avisos || {};
    sec('Datos de esta instalación', [carga('windsor', 'Gasto de Meta y Google (Windsor)'), carga('clickup', 'Leads de «Contacto de Reforma» (ClickUp)'),
      `<b>${fN(av.leads_sin_atribucion || 0)}</b> leads de Meta o Google sin campaña: van a «Sin zona › Sin campaña» hasta que se activen los campos ocultos de Tally (869fnzbwu).`,
      ...(av.gasto_excluido ? [`<b>${fE(av.gasto_excluido)}</b> de gasto excluido: campañas que no son de captación (zona «Excluida», p. ej. «Ofertas de trabajo»).`] : [])]);
    if (onRecargar && data.permisos?.editar) h('button', { type: 'button', class: 'ghost', text: 'Cargar datos ahora', onclick: (e) => { e.currentTarget.disabled = true; e.currentTarget.textContent = 'Cargando…'; onRecargar(); } }, c);
  }

  /* ---------- tabla de ponderaciones ---------- */
  function openPond() {
    dlg.innerHTML = ''; h('h4', { text: 'Tabla central de ponderaciones' }, dlg); h('p', { class: 'note', text: 'La usan «Ponderado», el coste ajustado por letra (€/espera) y el gráfico 1. Los cambios se ven al momento' + (data.permisos?.editar ? '; con «Guardar» quedan para todos.' : '. No tienes permiso para guardarlos.') }, dlg);
    h('div', { class: 'sideh', text: 'Valor por letra' }, dlg); const t1 = h('table', { class: 'dt' }, dlg); const r1 = h('tr', null, h('thead', null, t1)); LETTERS.forEach((k) => h('th', { text: k }, r1)); const b1 = h('tr', null, h('tbody', null, t1)); LETTERS.forEach((k) => { const td = h('td', null, b1); h('input', { type: 'number', step: 0.05, min: 0, max: 1, value: LVAL[k], 'aria-label': 'Valor de ' + k, style: 'width:64px', onchange: (e) => { LVAL[k] = Math.min(1, Math.max(0, +e.target.value || 0)); renderMain(); } }, td); });
    h('div', { class: 'sideh', text: 'Curvas de maduración: parte del hito ya ocurrida según la antigüedad del lead' }, dlg); const w = h('div', { style: 'overflow-x:auto' }, dlg); const t2 = h('table', { class: 'dt' }, w); const r2 = h('tr', null, h('thead', null, t2)); h('th', { text: 'Hito' }, r2); AGES.forEach((a) => h('th', { text: a + ' d' }, r2)); const b2 = h('tbody', null, t2);
    Object.keys(CURVES).forEach((k) => { const tr = h('tr', null, b2); h('td', { text: CURVES[k].label }, tr); CURVES[k].v.forEach((v, i) => { const td = h('td', null, tr); h('input', { type: 'number', step: 0.05, min: 0, max: 1, value: v, 'aria-label': CURVES[k].label + ' a ' + AGES[i] + ' días', style: 'width:60px', onchange: (e) => { CURVES[k].v[i] = Math.min(1, Math.max(0, +e.target.value || 0)); renderMain(); } }, td); }); });
    const ft = h('div', { class: 'dlgf' }, dlg); const msg = h('span', { class: 'note', style: 'margin:0 auto 0 0' }, ft);
    h('button', { type: 'button', class: 'ghost', text: 'Restablecer', onclick: () => { CURVES = clone(CURVE_DEF); LVAL = clone(LVAL_DEF); renderMain(); openPond(); } }, ft);
    if (data.permisos?.editar && onGuardarPonderaciones) h('button', { type: 'button', class: 'primary', text: 'Guardar', onclick: async (e) => { const b = e.currentTarget; b.disabled = true; msg.textContent = 'Guardando…'; try { await onGuardarPonderaciones({ valoresLetra: LVAL, curvas: Object.fromEntries(Object.entries(CURVES).map(([k, c]) => [k, c.v])) }); msg.textContent = 'Guardado.'; } catch (err) { msg.textContent = err.body || err.message; } finally { b.disabled = false; } } }, ft);
    const cerrar = h('button', { type: 'button', class: 'ghost', text: 'Cerrar', onclick: () => dlg.close() }, ft);
    if (!dlg.open) dlg.showModal?.();
    cerrar.focus();
  }

  /* ---------- render ---------- */
  const RENDER = { filtros: renderFiltros, c1: renderC1, c2: renderC2, c3: renderC3, c4: renderC4, c5: renderC5, notas: renderNotas };
  function renderMain() { main.innerHTML = ''; hideTip(); renderMode(); layout.classList.toggle('noside', state.tab === 'notas'); RENDER[state.tab](); }
  function render() { renderTabs(); renderSide(); renderMain(); }
  let rt; const onResize = () => { clearTimeout(rt); rt = setTimeout(() => main.querySelectorAll('div').forEach((d) => { if (d._draw) d._draw(); }), 120); };
  addEventListener('resize', onResize);
  // Con leads de Meta no hay visitas (F2 a cero): se abre en el gráfico 1, que ya muestra el volumen de leads.
  if (leadsDeMeta) state.tab = 'c1';
  render();
  return { model: M, state, render, destroy() { removeEventListener('resize', onResize); clearTimeout(rt); root.innerHTML = ''; } };
}
