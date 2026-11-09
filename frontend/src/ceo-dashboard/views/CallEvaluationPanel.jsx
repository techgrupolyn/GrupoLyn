import { useEffect, useState } from 'react';
import api from '../api';
import { formatMadridDateTime } from '../netelipFormat';

// Calificador interno de llamadas (ticket 869e9y98n): evaluación del comercial en el detalle de la llamada.
const RULE_LABEL = {
  REGLA_CERO: 'REGLA CERO', LIMITE_PROFESIONAL: 'LÍMITE PROFESIONAL', NO_PREGUNTAR: 'NO PREGUNTAR',
  PRECIO_CERRADO_PRIMERA_REUNION: 'Precio cerrado tras la primera reunión', PRECIO_M2_TARIFA: 'Precio por m² como tarifa', ALTERAR_PROCESO: 'Alterar el proceso',
};
const OBJECTION_LABEL = { precio: 'Precio', plazo: 'Plazo', confianza: 'Confianza', decisor: 'Decisor', otra: 'Otra' };
const ROLE_LABEL = { sdr: 'SDR', closer_f2: 'Closer Fase 2', closer_f3: 'Closer Fase 3' };
const box = 'rounded border border-[#2E2E2E] bg-[#141414] p-3';
const label = 'font-mono text-[10px] uppercase tracking-[.12em] text-[#737373]';

/** Nota compacta para la tabla de llamadas. */
export function EvaluationBadge({ evaluation }) {
  if (!evaluation) return <span className="text-xs text-[#4A4A4A]">—</span>;
  if (evaluation.status === 'pendiente' || evaluation.status === 'procesando') return <span className="text-xs text-amber-200">Evaluando…</span>;
  if (evaluation.status === 'no_evaluada') return <span className="text-xs text-[#737373]">No evaluada</span>;
  const tone = evaluation.pass ? 'border-emerald-300/40 text-emerald-100' : 'border-red-400/40 text-red-200';
  return <span className="inline-flex items-center gap-1.5"><span className={`rounded-full border px-2 py-0.5 font-mono text-[11px] ${tone}`}>{evaluation.score}/100</span>{evaluation.escalated && <span title="Escalada al supervisor" className="text-[11px] text-amber-200">⚠️</span>}</span>;
}

function HumanFeedback({ evaluation, callId, canSupervise, onSaved }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event) => {
    event.preventDefault();
    if (!text.trim()) return;
    setSaving(true); setError('');
    try {
      await api.netelip.addEvaluationFeedback(callId, text.trim());
      setText('');
      onSaved();
    } catch (requestError) { setError(requestError.body || requestError.message || 'No se pudo guardar el comentario.'); }
    finally { setSaving(false); }
  };
  return <div className="mt-3">
    <p className={label}>Feedback del supervisor</p>
    {evaluation.feedback_humano?.length ? <ul className="mt-2 space-y-2">{evaluation.feedback_humano.map((item) => <li key={item.id} className={box}><p className="text-[10px] text-[#737373]">{item.autor_nombre || 'Supervisor'} · {formatMadridDateTime(item.creado_en)}{item.enviado_en ? ' · enviado al comercial' : item.envio_error ? ' · no se pudo enviar' : ''}</p><p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-[#D4D4D4]">{item.texto}</p></li>)}</ul> : <p className="mt-2 text-xs text-[#737373]">Todavía no hay comentarios del supervisor.</p>}
    {canSupervise && <form onSubmit={submit} className="mt-3">
      <label htmlFor="evaluation-feedback" className="sr-only">Añadir feedback para el comercial</label>
      <textarea id="evaluation-feedback" value={text} onChange={(event) => setText(event.target.value)} maxLength={2000} rows={3} placeholder="Añade tu feedback: le llegará al comercial junto al de la IA." className="w-full rounded border border-[#2E2E2E] bg-[#0D0D0D] p-2 text-xs text-[#F2F2F2] outline-none focus:border-amber-300/60" />
      {error && <p role="alert" className="mt-1 text-xs text-red-200">{error}</p>}
      <div className="mt-2 flex justify-end"><button type="submit" disabled={saving || !text.trim()} className="rounded border border-amber-300/50 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-300/10 disabled:opacity-40">{saving ? 'Guardando…' : 'Guardar y enviar'}</button></div>
    </form>}
  </div>;
}

export default function CallEvaluationPanel({ callId, transcriptionStatus }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    const load = () => api.netelip.evaluation(callId).then((result) => { if (active) { setData(result); setError(''); } }).catch((requestError) => { if (active) setError(requestError.body || requestError.message); });
    void load();
    // Mientras se transcribe o se evalúa, se actualiza solo.
    const timer = window.setInterval(() => { void load(); }, 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [callId, reload]);

  if (error) return <p role="alert" className="rounded border border-red-900/70 bg-red-950/30 p-3 text-xs text-red-200">{error}</p>;
  if (!data) return <p className="text-xs text-[#737373]" role="status">Cargando evaluación…</p>;
  const evaluation = data.evaluation;
  if (!evaluation) return <p className={`${box} text-xs text-[#737373]`}>{transcriptionStatus === 'completed' ? 'Esta llamada no se evalúa: la extensión no tiene un comercial configurado o la llamada dura menos de 60 segundos.' : 'La evaluación empezará cuando la transcripción esté lista (solo para comerciales configurados).'}</p>;
  if (evaluation.estado === 'pendiente' || evaluation.estado === 'procesando') return <p role="status" className="rounded border border-amber-300/30 bg-amber-300/[.06] p-3 text-xs text-amber-100">Evaluando la llamada con la rúbrica de Fase 0. El resultado aparecerá aquí en unos minutos.</p>;
  if (evaluation.estado === 'no_evaluada') return <p className={`${box} text-xs text-[#BFBFBF]`}>No evaluada: {evaluation.motivo_no_evaluada || 'sin motivo registrado'}.</p>;

  const quotes = data.quotes_access === 'granted';
  return <div className="space-y-3">
    <div className={`${box} flex flex-wrap items-center gap-3`}>
      <p className="font-mono text-2xl font-semibold text-[#F2F2F2]">{evaluation.nota}<span className="text-sm text-[#737373]">/100</span></p>
      <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${evaluation.apto ? 'border-emerald-300/40 text-emerald-100' : 'border-red-400/40 text-red-200'}`}>{evaluation.apto ? 'Apto' : 'No apto'}</span>
      {evaluation.escalado && <span className="rounded-full border border-amber-300/50 px-2 py-0.5 text-[11px] text-amber-100">⚠️ Escalada al supervisor</span>}
      <p className="ml-auto text-[10px] text-[#737373]">{evaluation.comercial || 'Comercial'} · {ROLE_LABEL[evaluation.rol] || evaluation.rol}</p>
      {evaluation.escalado && <p className="w-full text-xs text-amber-100">Motivo: {evaluation.motivo_escalado}</p>}
    </div>

    <div>
      <p className={label}>Errores críticos</p>
      {evaluation.errores_criticos?.length ? <ul className="mt-2 space-y-2">{evaluation.errores_criticos.map((item, index) => <li key={index} className="rounded border border-red-900/70 bg-red-950/30 p-3 text-xs text-red-100"><p className="font-semibold">{RULE_LABEL[item.regla] || item.regla}{item.marca_tiempo && <span className="ml-2 font-mono font-normal text-red-200/70">{item.marca_tiempo}</span>}</p>{quotes && item.cita && <p className="mt-1 leading-5 text-red-100/90">«{item.cita}»</p>}</li>)}</ul> : <p className="mt-2 text-xs text-emerald-200">No se detectan errores críticos.</p>}
      {evaluation.duda && <p className="mt-2 text-xs text-amber-200">Duda del agente: {evaluation.motivo_duda}</p>}
    </div>

    <div className="grid gap-3 sm:grid-cols-2">
      <div><p className={label}>Bien hecho</p><ul className="mt-2 space-y-1.5">{(evaluation.bien || []).map((item, index) => <li key={index} className="text-xs leading-5 text-[#D4D4D4]">✅ {item}</li>)}</ul></div>
      <div><p className={label}>A mejorar</p><ul className="mt-2 space-y-1.5">{(evaluation.mejorar || []).map((item, index) => <li key={index} className="text-xs leading-5 text-[#D4D4D4]"><span className="text-[#F2F2F2]">{item.que}</span><br /><span className="text-[#BFBFBF]">→ {item.accion}</span></li>)}</ul></div>
    </div>

    {evaluation.objeciones?.length > 0 && <div><p className={label}>Objeciones del cliente</p><ul className="mt-2 space-y-2">{evaluation.objeciones.map((item) => <li key={item.id} className={box}><p className="text-[10px] text-[#737373]">{OBJECTION_LABEL[item.tipo] || item.tipo}</p>{quotes && item.cita && <p className="mt-1 text-xs leading-5 text-[#D4D4D4]">«{item.cita}»</p>}{quotes && item.idea_contenido && <p className="mt-1 text-xs text-amber-100">💡 {item.idea_contenido}</p>}</li>)}</ul></div>}

    <details className={box}><summary className="cursor-pointer text-xs text-[#BFBFBF]">Mensaje enviado al comercial{evaluation.enviado_en ? ` · ${formatMadridDateTime(evaluation.enviado_en)}` : evaluation.envio_error ? ' · no se pudo enviar' : ' · visible solo aquí'}</summary><p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-[#D4D4D4]">{evaluation.feedback_texto}</p>{evaluation.envio_error && <p className="mt-2 text-[10px] text-red-200">{evaluation.envio_error}</p>}<p className="mt-2 text-[10px] text-[#737373]">Rúbrica {evaluation.version_rubrica} · {evaluation.modelo}. Evaluación orientativa: no se usa para sanciones ni retribución sin revisión humana.</p></details>

    <HumanFeedback evaluation={evaluation} callId={callId} canSupervise={data.can_supervise} onSaved={() => setReload((value) => value + 1)} />
  </div>;
}
