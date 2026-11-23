import { useEffect, useState } from 'react';
import api from '../api';
import { DECISIONES, DECISION_LABEL, ESTADO_LABEL, OTRO } from '../decisionPase';
import { DecisionBloque, labelClass } from './DecisionBloques';

// Decisión de pase del SDR (N-1.4): formulario de un minuto en el detalle de la llamada. El SDR propone una decisión, el motivo (lista
// cerrada con «otro») y el dato de la llamada que la justifica. La decisión de la IA solo aparece DESPUÉS de registrar la suya: el
// servidor no la manda antes, así que la pantalla no puede enseñarla aunque quisiera.
const box = 'rounded border border-[#2E2E2E] bg-[#141414] p-3';
const field = 'w-full rounded border border-[#2E2E2E] bg-[#0D0D0D] p-2 text-xs text-[#F2F2F2] outline-none focus:border-amber-300/60';
const VACIO = { decision: '', motivo: '', texto: '', dato: '' };

export default function DecisionPasePanel({ callId, readOnly = false }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState(VACIO);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    let active = true;
    // Al cambiar de llamada no puede quedar en pantalla lo de la anterior (ni su propuesta, ni la decisión de la IA, ni lo escrito en el formulario).
    setData(null); setError(''); setForm(VACIO); setSaveError('');
    api.netelip.decision(callId)
      .then((result) => { if (active) { setData(result); setError(''); } })
      .catch((requestError) => { if (active) setError(requestError.body || requestError.message); });
    return () => { active = false; };
  }, [callId]);

  if (error) return <p role="alert" className="rounded border border-red-900/70 bg-red-950/30 p-3 text-xs text-red-200">{error}</p>;
  if (!data) return <p role="status" className="text-xs text-[#737373]">Cargando la decisión de pase…</p>;
  if (!data.lead_conocido) return <p className={`${box} text-xs leading-5 text-[#737373]`}>Esta llamada todavía no está vinculada a un lead de «Contacto de Reforma», así que aún no se puede registrar la decisión de pase.</p>;

  if (data.sdr) {
    return <div className="space-y-3">
      <DecisionBloque titulo={readOnly ? "Propuesta del SDR" : "Tu propuesta"} decision={data.sdr} motivos={data.motivos} />
      {data.ia
        ? <DecisionBloque titulo="Decisión de la IA" decision={data.ia} motivos={data.motivos} resaltar={data.ia.decision !== data.sdr.decision} />
        : <p className={`${box} text-xs text-[#737373]`}>La IA todavía no ha analizado esta llamada. Cuando lo haga, verás aquí su decisión y los próximos pasos que recomienda.</p>}
      <p className="text-[11px] text-[#737373]">Estado del caso: {data.estado ? ESTADO_LABEL[data.estado] : 'esperando la decisión de la IA'}. Ernesto valida todos los casos durante el piloto.</p>
    </div>;
  }

  // Solo lectura: no registra la propuesta del SDR (ni, por tanto, ve la de la IA antes que el SDR).
  if (readOnly) return <p className={`${box} text-xs leading-5 text-[#737373]`}>El SDR todavía no ha registrado su decisión de pase para esta llamada.</p>;

  const motivosDeLaDecision = form.decision ? data.motivos?.[form.decision] || [] : [];
  const otro = form.motivo === OTRO;
  const valido = form.decision && form.motivo && form.dato.trim() && (!otro || form.texto.trim());
  const cambiar = (cambios) => setForm((actual) => ({ ...actual, ...cambios }));

  const enviar = async (event) => {
    event.preventDefault();
    if (!valido) return;
    setSaving(true); setSaveError('');
    try {
      const body = { decision: form.decision, motivo_codigo: form.motivo, dato_cita: form.dato.trim(), ...(otro ? { motivo_texto: form.texto.trim() } : {}) };
      setData(await api.netelip.saveDecision(callId, body));
      setForm(VACIO);
    } catch (requestError) { setSaveError(requestError.body || requestError.message || 'No se pudo guardar la decisión.'); }
    finally { setSaving(false); }
  };

  return <form onSubmit={enviar} className={`${box} space-y-3`} aria-label="Decisión de pase del SDR">
    <p className="text-xs leading-5 text-[#BFBFBF]">¿Qué hacemos con este lead? Se registra una sola vez. Después verás qué decidió la IA por su cuenta y qué pasos recomienda.</p>
    <fieldset>
      <legend className={labelClass}>Decisión</legend>
      <div className="mt-2 grid grid-cols-2 gap-2">{DECISIONES.map((decision) => <label key={decision} className={`flex cursor-pointer items-center gap-2 rounded border px-2.5 py-2 text-xs ${form.decision === decision ? 'border-amber-300/60 bg-amber-300/[.08] text-amber-100' : 'border-[#2E2E2E] text-[#D4D4D4] hover:border-[#737373]'}`}>
        <input type="radio" name="decision" value={decision} checked={form.decision === decision} onChange={() => cambiar({ decision, motivo: '', texto: '' })} className="accent-amber-300" />
        {DECISION_LABEL[decision]}
      </label>)}</div>
    </fieldset>
    <div>
      <label htmlFor="decision-motivo" className={labelClass}>Motivo</label>
      <select id="decision-motivo" value={form.motivo} onChange={(event) => cambiar({ motivo: event.target.value, texto: '' })} disabled={!form.decision} className={`mt-2 h-9 ${field}`}>
        <option value="">{form.decision ? 'Elige un motivo' : 'Primero elige la decisión'}</option>
        {motivosDeLaDecision.map((motivo) => <option key={motivo.codigo} value={motivo.codigo}>{motivo.etiqueta}</option>)}
        {form.decision && <option value={OTRO}>Otro</option>}
      </select>
      {otro && <>
        <label htmlFor="decision-texto" className="sr-only">¿Cuál es el motivo?</label>
        <input id="decision-texto" value={form.texto} onChange={(event) => cambiar({ texto: event.target.value })} maxLength={300} placeholder="¿Cuál es el motivo?" className={`mt-2 h-9 ${field}`} />
      </>}
    </div>
    <div>
      <label htmlFor="decision-dato" className={labelClass}>Dato o cita de la llamada que lo justifica</label>
      <textarea id="decision-dato" value={form.dato} onChange={(event) => cambiar({ dato: event.target.value })} maxLength={1000} rows={3} placeholder="Qué dijo el cliente o qué dato de la llamada te hace decidir esto." className={`mt-2 ${field}`} />
    </div>
    {saveError && <p role="alert" className="text-xs text-red-200">{saveError}</p>}
    <div className="flex justify-end"><button type="submit" disabled={!valido || saving} className="rounded border border-amber-300/50 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-300/10 disabled:opacity-40">{saving ? 'Guardando…' : 'Registrar mi decisión'}</button></div>
  </form>;
}
