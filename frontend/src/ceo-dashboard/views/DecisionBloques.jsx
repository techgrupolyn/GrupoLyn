import { CANAL_LABEL, DECISION_LABEL, DUDA_LABEL, EXCEPCION_LABEL, motivoLabel } from '../decisionPase';

// Bloques de presentación de una decisión de pase (SDR, IA o Ernesto), compartidos por el detalle de la llamada y la bandeja.
const box = 'rounded border border-[#2E2E2E] bg-[#141414] p-3';
export const labelClass = 'font-mono text-[10px] uppercase tracking-[.12em] text-[#737373]';

/** Próximos pasos de la IA: acción, cuándo, canal, qué pedir, «requiere Ernesto» y la cita que los justifica. Es solo una recomendación. */
export function ProximosPasos({ pasos }) {
  if (!pasos?.length) return <p className="mt-1 text-xs text-[#737373]">Sin próximos pasos.</p>;
  return <ol className="mt-2 space-y-2">{pasos.map((paso) => <li key={paso.orden} className="rounded border border-[#2E2E2E] bg-[#0D0D0D] p-2.5 text-xs leading-5">
    <p className="text-[#F2F2F2]"><span className="font-mono text-[#737373]">{paso.orden}.</span> {paso.accion}{paso.requiereErnesto || paso.requiere_ernesto ? <span className="ml-2 rounded-full border border-amber-300/50 px-1.5 py-0.5 text-[10px] text-amber-200">Requiere Ernesto</span> : null}</p>
    <p className="text-[#BFBFBF]">{paso.cuando?.tipo === 'fecha_cliente' ? 'Fecha que dio el cliente' : 'Plazo según el guion'}: {paso.cuando?.valor} · {CANAL_LABEL[paso.canal] || paso.canal}{(paso.quePedir || paso.que_pedir) ? ` · Pedir o llevar: ${paso.quePedir || paso.que_pedir}` : ''}</p>
    {paso.cita && <p className="text-[#737373]">«{paso.cita}»</p>}
  </li>)}</ol>;
}

/** Una propuesta (de la IA, del SDR o de Ernesto) con su motivo, su dato o cita y, si es de la IA, excepciones, dudas y próximos pasos. */
export function DecisionBloque({ titulo, decision, motivos, resaltar = false }) {
  if (!decision) return <div className={box}><p className={labelClass}>{titulo}</p><p className="mt-2 text-xs text-[#737373]">Sin propuesta.</p></div>;
  const lista = Array.isArray(decision.motivos) && decision.motivos.length ? decision.motivos : null;
  return <div className={`rounded border p-3 ${resaltar ? 'border-amber-300/60 bg-amber-300/[.06]' : 'border-[#2E2E2E] bg-[#141414]'}`} data-resaltado={resaltar ? 'true' : undefined}>
    <p className={labelClass}>{titulo}{decision.usuario_nombre ? ` · ${decision.usuario_nombre}` : ''}</p>
    <p className="mt-1 text-sm font-semibold text-[#F2F2F2]">{DECISION_LABEL[decision.decision] || decision.decision}</p>
    <p className="mt-1 text-xs text-[#D4D4D4]">Motivo: {motivoLabel(motivos, decision.decision, decision.motivo_codigo, decision.motivo_texto)}</p>
    {lista && lista.length > 1 && <ul className="mt-1 space-y-0.5 text-xs text-[#BFBFBF]">{lista.slice(1).map((m) => <li key={m.codigo + (m.texto || '')}>También: {motivoLabel(motivos, decision.decision, m.codigo, m.texto)}</li>)}</ul>}
    {decision.dato_cita && <p className="mt-1 text-xs leading-5 text-[#BFBFBF]">{decision.actor === 'ia' ? 'Cita' : 'Dato'}: «{decision.dato_cita}»</p>}
    {decision.a_favor && <p className="mt-1 text-xs text-[#BFBFBF]">De acuerdo con: {decision.a_favor === 'sdr' ? 'el SDR' : 'la IA'}</p>}
    {decision.excepciones?.length > 0 && <p className="mt-2 text-xs text-amber-100">Excepciones: {decision.excepciones.map((e) => EXCEPCION_LABEL[e] || e).join(' · ')}</p>}
    {decision.dudas?.length > 0 && <p className="mt-1 text-xs text-amber-100">Dudas: {decision.dudas.map((d) => DUDA_LABEL[d] || d).join(' · ')}</p>}
    {decision.pendiente_ernesto && <p role="note" className="mt-2 rounded border border-amber-300/40 bg-amber-300/[.06] p-2 text-xs text-amber-100">Pendiente de Ernesto: {decision.pendiente_ernesto.queDebeDecidir}</p>}
    {decision.actor === 'ia' || decision.actor === 'ernesto' ? <div className="mt-2"><p className={labelClass}>Próximos pasos</p><ProximosPasos pasos={decision.proximos_pasos} /></div> : null}
  </div>;
}
