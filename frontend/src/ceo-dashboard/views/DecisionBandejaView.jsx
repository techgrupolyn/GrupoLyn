import { useCallback, useEffect, useState } from 'react';
import api from '../api';
import { antiguedad, callIdDe, DECISIONES, DECISION_LABEL, ESCALADO_LABEL, ESTADO_LABEL, OTRO, tarjetaUrl } from '../decisionPase';
import { formatMadridDateTime } from '../netelipFormat';
import { DecisionBloque, labelClass } from './DecisionBloques';

// Bandeja de Ernesto (N-1.4): una fila por caso con las propuestas del SDR y de la IA, drawer con el resumen del lead, las citas y los
// próximos pasos, y «Confirmar» o «Corregir». Solo la discrepancia va resaltada. Es el único sitio donde se validan las decisiones: ninguna
// mueve la tarjeta de fase ni escribe al cliente.
const box = 'rounded border border-[#2E2E2E] bg-[#141414] p-3';
const field = 'w-full rounded border border-[#2E2E2E] bg-[#0D0D0D] p-2 text-xs text-[#F2F2F2] outline-none focus:border-amber-300/60';
const TABS = [['pendientes', 'Pendientes'], ['revisados', 'Revisados'], ['todos', 'Todos']];
const ACTOR_LABEL = { coincidentes: 'SDR e IA coinciden', sdr: 'SDR', ia: 'IA' };

function TablaAcierto({ items }) {
  if (!items) return null;
  return <section aria-label="Acierto del piloto" className={box}>
    <p className={labelClass}>Acierto del piloto</p>
    <table className="mt-2 w-full text-xs"><thead><tr className="text-left text-[#737373]"><th className="py-1 font-normal">Quién</th><th className="py-1 font-normal">Casos revisados</th><th className="py-1 font-normal">Aciertos</th><th className="py-1 font-normal">%</th></tr></thead>
      <tbody>{items.map((fila) => <tr key={fila.actor} className="border-t border-[#2E2E2E] text-[#D4D4D4]"><td className="py-1.5">{ACTOR_LABEL[fila.actor] || fila.actor}</td><td>{fila.revisados}</td><td>{fila.aciertos}</td><td>{fila.porcentaje === null ? '—' : `${fila.porcentaje} %`}</td></tr>)}</tbody>
    </table>
    <p className="mt-2 text-[10px] leading-4 text-[#737373]">Solo casos nuevos ya revisados. «SDR e IA coinciden»: en cuántos Ernesto confirmó decisión y motivo. SDR e IA: en cuántos su decisión y su motivo son los finales de Ernesto. Los próximos pasos no cuentan.</p>
  </section>;
}

function FormularioCorregir({ caso, onCancel, onSaved }) {
  const [form, setForm] = useState({ decision: '', motivo: '', texto: '', dato: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const motivos = form.decision ? caso.motivos?.[form.decision] || [] : [];
  const otro = form.motivo === OTRO;
  const valido = form.decision && form.motivo && form.dato.trim() && (!otro || form.texto.trim());
  const cambiar = (cambios) => setForm((actual) => ({ ...actual, ...cambios }));
  const enviar = async (event) => {
    event.preventDefault();
    if (!valido) return;
    setSaving(true); setError('');
    try {
      await api.decisiones.corregir(callIdDe(caso.llamada_id), { decision: form.decision, motivo_codigo: form.motivo, dato_cita: form.dato.trim(), ...(otro ? { motivo_texto: form.texto.trim() } : {}) });
      onSaved();
    } catch (requestError) { setError(requestError.body || requestError.message || 'No se pudo guardar la corrección.'); }
    finally { setSaving(false); }
  };
  return <form onSubmit={enviar} aria-label="Corregir la decisión" className={`${box} space-y-3`}>
    <p className="text-xs leading-5 text-[#BFBFBF]">Corregir exige la decisión, el motivo y el dato de la llamada que cambia tu criterio. Los próximos pasos quedan como los propuso la IA.</p>
    <div>
      <label htmlFor="corregir-decision" className={labelClass}>Decisión</label>
      <select id="corregir-decision" value={form.decision} onChange={(event) => cambiar({ decision: event.target.value, motivo: '', texto: '' })} className={`mt-2 h-9 ${field}`}>
        <option value="">Elige la decisión</option>
        {DECISIONES.map((d) => <option key={d} value={d}>{DECISION_LABEL[d]}</option>)}
      </select>
    </div>
    <div>
      <label htmlFor="corregir-motivo" className={labelClass}>Motivo</label>
      <select id="corregir-motivo" value={form.motivo} onChange={(event) => cambiar({ motivo: event.target.value, texto: '' })} disabled={!form.decision} className={`mt-2 h-9 ${field}`}>
        <option value="">{form.decision ? 'Elige un motivo' : 'Primero elige la decisión'}</option>
        {motivos.map((m) => <option key={m.codigo} value={m.codigo}>{m.etiqueta}</option>)}
        {form.decision && <option value={OTRO}>Otro</option>}
      </select>
      {otro && <><label htmlFor="corregir-texto" className="sr-only">¿Cuál es el motivo?</label><input id="corregir-texto" value={form.texto} onChange={(event) => cambiar({ texto: event.target.value })} maxLength={300} placeholder="¿Cuál es el motivo?" className={`mt-2 h-9 ${field}`} /></>}
    </div>
    <div>
      <label htmlFor="corregir-dato" className={labelClass}>Dato que cambia tu criterio</label>
      <textarea id="corregir-dato" value={form.dato} onChange={(event) => cambiar({ dato: event.target.value })} maxLength={1000} rows={3} className={`mt-2 ${field}`} />
    </div>
    {error && <p role="alert" className="text-xs text-red-200">{error}</p>}
    <div className="flex justify-end gap-2">
      <button type="button" onClick={onCancel} className="rounded border border-[#2E2E2E] px-3 py-1.5 text-xs text-[#BFBFBF] hover:border-[#737373]">Cancelar</button>
      <button type="submit" disabled={!valido || saving} className="rounded border border-amber-300/50 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-300/10 disabled:opacity-40">{saving ? 'Guardando…' : 'Guardar corrección'}</button>
    </div>
  </form>;
}

function Drawer({ llamadaId, onClose, onChanged }) {
  const [caso, setCaso] = useState(null);
  const [error, setError] = useState('');
  const [modo, setModo] = useState('ver');
  const [aFavor, setAFavor] = useState('');
  const [saving, setSaving] = useState(false);

  const cargar = useCallback(() => api.decisiones.caso(callIdDe(llamadaId)).then((r) => { setCaso(r); setError(''); }).catch((e) => setError(e.body || e.message)), [llamadaId]);
  useEffect(() => { void cargar(); }, [cargar]);
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pendiente = caso?.estado === 'pendiente_ernesto';
  // SDR e IA coinciden en decisión Y motivo (si no, es una discrepancia y hay que decir con quién se está de acuerdo).
  const acuerdoTotal = Boolean(caso?.coincide);
  const confirmar = async () => {
    setSaving(true); setError('');
    try { await api.decisiones.confirmar(callIdDe(llamadaId), acuerdoTotal ? {} : { a_favor: aFavor }); await cargar(); onChanged(); }
    catch (requestError) { setError(requestError.body || requestError.message || 'No se pudo confirmar.'); }
    finally { setSaving(false); }
  };

  return <aside role="dialog" aria-modal="true" aria-label="Detalle del caso" className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[720px] flex-col border-l border-[#2E2E2E] bg-[#0D0D0D] shadow-2xl">
    <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[#2E2E2E] bg-[#111111] px-5 py-4">
      <div className="min-w-0"><p className={labelClass}>Decisión de pase</p><h2 className="mt-1 text-lg font-semibold text-[#F2F2F2]">{caso ? `${ESCALADO_LABEL[caso.motivo_escalado]} · ${ESTADO_LABEL[caso.estado]}` : 'Cargando…'}</h2>{caso && <a href={tarjetaUrl(caso.lead_id)} target="_blank" rel="noreferrer" className="text-[11px] text-amber-300 hover:text-amber-200">Abrir la tarjeta del lead en ClickUp</a>}</div>
      <button type="button" onClick={onClose} className="shrink-0 rounded border border-[#2E2E2E] px-2.5 py-1.5 text-xs text-[#BFBFBF] hover:border-[#737373]">Cerrar</button>
    </header>
    <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
      {error && <p role="alert" className="rounded border border-red-900/70 bg-red-950/30 p-3 text-xs text-red-200">{error}</p>}
      {caso && <>
        <section aria-label="Resumen del lead" className={box}>
          <p className={labelClass}>Resumen del lead</p>
          {caso.resumen
            ? <dl className="mt-2 space-y-1 text-xs leading-5">{[['Qué quiere', caso.resumen.que_quiere], ['Dónde quedó', caso.resumen.donde_quedo], ['Qué lo frena', caso.resumen.que_lo_frena], ['Para qué llamarlo', caso.resumen.para_que_llamarlo]].map(([k, v]) => <div key={k}><dt className="inline text-[#737373]">{k}: </dt><dd className="inline text-[#D4D4D4]">{v}</dd></div>)}</dl>
            : <p className="mt-2 text-xs text-[#737373]">Este lead todavía no tiene resumen ejecutivo.</p>}
          {caso.calificacion && <p className="mt-2 text-[11px] text-[#737373]">Categoría {caso.calificacion.categoria}{caso.calificacion.presupuesto !== null ? ` · presupuesto ${Number(caso.calificacion.presupuesto).toLocaleString('es-ES')} €` : ''}</p>}
        </section>
        <div className="grid gap-3 md:grid-cols-2">
          <DecisionBloque titulo="Propuesta del SDR" decision={caso.sdr} motivos={caso.motivos} resaltar={!caso.coincide} />
          <DecisionBloque titulo="Decisión de la IA" decision={caso.ia} motivos={caso.motivos} resaltar={!caso.coincide} />
        </div>
        {caso.ernesto && <DecisionBloque titulo="Decisión final" decision={caso.ernesto} motivos={caso.motivos} />}
        {pendiente && modo === 'ver' && <section aria-label="Acciones" className={`${box} space-y-3`}>
          {!acuerdoTotal && <fieldset>
            <legend className="text-xs text-[#BFBFBF]">SDR e IA no coinciden en decisión y motivo. Para confirmar, di con quién estás de acuerdo:</legend>
            <div className="mt-2 flex gap-4 text-xs text-[#D4D4D4]">{[['sdr', 'Con el SDR'], ['ia', 'Con la IA']].map(([valor, texto]) => <label key={valor} className="flex items-center gap-1.5"><input type="radio" name="a-favor" value={valor} checked={aFavor === valor} onChange={() => setAFavor(valor)} className="accent-amber-300" />{texto}</label>)}</div>
          </fieldset>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setModo('corregir')} className="rounded border border-[#2E2E2E] px-3 py-1.5 text-xs text-[#D4D4D4] hover:border-amber-300/50">Corregir</button>
            <button type="button" onClick={confirmar} disabled={saving || (!acuerdoTotal && !aFavor)} className="rounded border border-amber-300/50 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-300/10 disabled:opacity-40">{saving ? 'Guardando…' : 'Confirmar'}</button>
          </div>
        </section>}
        {pendiente && modo === 'corregir' && <FormularioCorregir caso={caso} onCancel={() => setModo('ver')} onSaved={async () => { setModo('ver'); await cargar(); onChanged(); }} />}
        {caso.revisado_en && <p className="text-[11px] text-[#737373]">Revisado el {formatMadridDateTime(caso.revisado_en)}.</p>}
      </>}
    </div>
  </aside>;
}

export default function DecisionBandejaView() {
  const [estado, setEstado] = useState('pendientes');
  const [items, setItems] = useState(null);
  const [acierto, setAcierto] = useState(null);
  const [error, setError] = useState('');
  const [abierto, setAbierto] = useState(null);

  const cargar = useCallback(async () => {
    try {
      const [bandeja, tabla] = await Promise.all([api.decisiones.bandeja(estado), api.decisiones.acierto()]);
      setItems(bandeja.items); setAcierto(tabla.items); setError('');
    } catch (requestError) { setError(requestError.body || requestError.message); }
  }, [estado]);
  useEffect(() => { void cargar(); }, [cargar]);

  return <section className="ceo-page p-4 sm:p-6 xl:p-8">
    <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div><h1 className="text-xl font-semibold tracking-tight text-[#F2F2F2]">Decisiones de pase</h1><p className="mt-1 max-w-2xl text-xs leading-5 text-[#737373]">Durante el piloto validas todos los casos: la propuesta del SDR, lo que decidió la IA por su cuenta y los próximos pasos que recomienda. Ninguna decisión mueve la tarjeta de fase ni escribe al cliente.</p></div>
      <div role="tablist" aria-label="Estado de los casos" className="flex gap-1">{TABS.map(([valor, texto]) => <button key={valor} role="tab" aria-selected={estado === valor} type="button" onClick={() => setEstado(valor)} className={`rounded border px-3 py-1.5 text-xs ${estado === valor ? 'border-amber-300/60 bg-amber-300/[.08] text-amber-100' : 'border-[#2E2E2E] text-[#BFBFBF] hover:border-[#737373]'}`}>{texto}</button>)}</div>
    </header>
    {error && <p role="alert" className="mb-4 rounded border border-red-900/70 bg-red-950/30 p-3 text-xs text-red-200">{error}</p>}
    <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
      <div className="overflow-x-auto rounded border border-[#2E2E2E]">
        <table className="w-full min-w-[680px] text-left text-xs">
          <thead className="bg-[#141414] text-[#737373]"><tr>{['Lead', 'Llamada', 'SDR', 'IA', 'Motivo', 'Estado', 'Antigüedad'].map((c) => <th key={c} className="px-3 py-2 font-normal">{c}</th>)}</tr></thead>
          <tbody>
            {items === null && <tr><td colSpan={7} className="px-3 py-6 text-center text-[#737373]">Cargando…</td></tr>}
            {items?.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-[#737373]">No hay casos {estado === 'pendientes' ? 'pendientes' : estado === 'revisados' ? 'revisados' : ''}.</td></tr>}
            {items?.map((fila) => <tr key={fila.llamadaId} tabIndex={0} onClick={() => setAbierto(fila.llamadaId)} onKeyDown={(event) => { if (event.key === 'Enter') setAbierto(fila.llamadaId); }} className="cursor-pointer border-t border-[#2E2E2E] text-[#D4D4D4] hover:bg-[#141414] focus:bg-[#141414] focus:outline-none">
              <td className="px-3 py-2 font-mono text-[11px]">{fila.leadId}</td>
              <td className="px-3 py-2">{fila.fechaLlamada ? formatMadridDateTime(fila.fechaLlamada) : '—'}</td>
              <td className={`px-3 py-2 ${fila.coincide ? '' : 'font-semibold text-amber-200'}`}>{DECISION_LABEL[fila.sdr.decision]}</td>
              <td className={`px-3 py-2 ${fila.coincide ? '' : 'font-semibold text-amber-200'}`}>{DECISION_LABEL[fila.ia.decision]}</td>
              <td className="px-3 py-2">{ESCALADO_LABEL[fila.motivoEscalado]}</td>
              <td className="px-3 py-2">{ESTADO_LABEL[fila.estado]}</td>
              <td className="px-3 py-2">{antiguedad(fila.estado === 'pendiente_ernesto' ? fila.creadoEn : fila.revisadoEn)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
      <TablaAcierto items={acierto} />
    </div>
    {abierto && <Drawer key={abierto} llamadaId={abierto} onClose={() => setAbierto(null)} onChanged={cargar} />}
  </section>;
}
