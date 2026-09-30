import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const sidepanel = await readFile(new URL('../src/sidepanel/sidepanel.js', import.meta.url), 'utf8');
const worker = await readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

test('el informe global usa solo rutas permitidas para la extensión activada', () => {
  assert.match(worker, /global-summary/);
  assert.match(worker, /global-summaries/);
  assert.match(sidepanel, /directBackendRequest\('\/chat\/global-summary'/);
  assert.match(sidepanel, /global-summaries\/latest/);
});

test('el modo local sin activación está limitado a hosts loopback', () => {
  assert.match(worker, /isLocalDevelopmentBackend/);
  assert.match(worker, /host === '127\.0\.0\.1' \|\| host === 'localhost' \|\| host === '::1'/);
  assert.match(sidepanel, /isLocalDevelopmentBackend/);
});

test('una respuesta aceptada en segundo plano no se presenta como informe terminado', () => {
  assert.match(sidepanel, /data\?\.en_progreso \? 'Informe en proceso; todavía no está terminado\.'/);
});

test('el panel prioriza el informe global y muestra el contador de mensajes pendientes', async () => {
  const html = await readFile(new URL('../src/sidepanel/sidepanel.html', import.meta.url), 'utf8');
  assert.match(html, /Informe global/);
  assert.match(html, /btn-generate-global-report/);
  assert.ok(html.indexOf('id="tab-global-report"') < html.indexOf('id="tab-pending-chats"'));
  assert.match(html, /tab-pending-count/);
  assert.match(html, /id="global-report-progress" aria-live="polite"/);
  assert.match(sidepanel, /function renderPendingUnreadCounter/);
  assert.match(sidepanel, /if \(success\) await loadChats\(\);/);
  assert.equal(manifest.version, '1.1.8');
});

function reportHarness() {
  const button={disabled:false};
  const elements={'btn-generate-global-report':button,'specialist-select':{value:'general'},'global-report-meta':{textContent:''},'global-report-progress':{innerHTML:''}};
  const timers=[];
  const renders=[];
  const responses=[];
  let refreshes=0;
  const context=vm.createContext({
    state:{globalReport:null,globalReportLoading:false},
    $:(id)=>elements[id],
    clearTimeout:()=>{},
    setTimeout:(callback)=>{timers.push(callback);return timers.length;},
    renderGlobalReport:(data)=>renders.push(data),
    directBackendRequest:async()=>{const response=responses.shift();if(response instanceof Error)throw response;return response;},
    loadChats:async()=>{refreshes++;},
  });
  const code=sidepanel.slice(sidepanel.indexOf('let globalReportPoll ='),sidepanel.indexOf('async function generateGlobalReport()'));
  vm.runInContext(code+'\nglobalThis.accept=acceptGlobalReport;globalThis.load=loadLatestGlobalReport;',context);
  return {context,button,timers,renders,responses,refreshes:()=>refreshes};
}

test('el informe pendiente se actualiza automáticamente al terminar y refresca contadores', async () => {
  const harness=reportHarness();
  harness.context.accept({jobId:'qa',en_progreso:true,status:'running'},0);
  assert.equal(harness.button.disabled,true);
  harness.responses.push({jobId:'qa',en_progreso:false,status:'completed',resumen:'Resultado'});
  await harness.timers.shift()();
  assert.equal(harness.renders.at(-1).resumen,'Resultado');
  assert.equal(harness.button.disabled,false);
  assert.equal(harness.refreshes(),1);
});

test('un fallo del trabajo termina la espera y permite reintentar', async () => {
  const harness=reportHarness();
  harness.context.accept({jobId:'qa',en_progreso:true},0);
  harness.responses.push({jobId:'qa',en_progreso:false,status:'failed',error:'IA no disponible'});
  await harness.timers.shift()();
  assert.equal(harness.renders.at(-1).status,'failed');
  assert.equal(harness.button.disabled,false);
  assert.equal(harness.timers.length,0);
});

test('la pérdida temporal de conexión reintenta sin lanzar otro análisis', async () => {
  const harness=reportHarness();
  harness.context.accept({jobId:'qa',en_progreso:true},0);
  harness.responses.push(new Error('Sin conexión'));
  await harness.timers.shift()();
  assert.equal(harness.button.disabled,true);
  assert.equal(harness.timers.length,1);
  assert.equal(harness.refreshes(),0);
});

test('reabrir recupera el avance confirmado del servidor y retoma la consulta', async () => {
  const harness = reportHarness();
  const progress = { stage: 'verifying', completedMessages: 7500, totalMessages: 20000 };
  harness.responses.push({ jobId: 'qa', status: 'running', en_progreso: true, progress });
  await harness.context.load();
  assert.equal(harness.renders.at(-1).progress, progress);
  assert.equal(harness.button.disabled, true);
  harness.responses.push(new Error('Sin conexión'));
  await harness.timers.shift()();
  assert.equal(harness.renders.at(-1).progress, progress);
  assert.equal(harness.timers.length, 1);
});

test('inicia el trabajo sin esperar una sincronización masiva del service worker', async () => {
  const code = sidepanel.slice(sidepanel.indexOf('async function generateGlobalReport()'), sidepanel.indexOf('async function getPendingChats('));
  const elements = { 'specialist-select': { value: 'general' }, 'global-report-output': {}, 'btn-generate-global-report': {} };
  const calls = [];
  const context = vm.createContext({
    state: { globalReport: null, globalReportLoading: false }, globalReportRequest: 0,
    $: (id) => elements[id],
    backendMessage: () => { throw new Error('No debe esperar SYNC_NOW'); },
    directBackendRequest: async (path) => { calls.push(path); return { jobId: 'qa', en_progreso: true }; },
    acceptGlobalReport: (data) => { context.state.globalReport = data; },
    loadChats: async () => { throw new Error('Refresco interrumpido'); },
    escapeHtml: (text) => text,
  });
  vm.runInContext(code + '\nglobalThis.start = generateGlobalReport;', context);
  await context.start();
  assert.deepEqual(calls, ['/chat/global-summary']);
  assert.equal(context.state.globalReport.jobId, 'qa');
  assert.equal(elements['btn-generate-global-report'].disabled, true);
  assert.doesNotMatch(elements['global-report-output'].innerHTML, /No se pudo generar/);
});

test('muestra progreso por lotes sin decir que el informe parcial está terminado', () => {
  const code = sidepanel.slice(sidepanel.indexOf('function globalReportDescription('), sidepanel.indexOf('function renderGlobalReport('));
  const context = vm.createContext({});
  vm.runInContext(code + '\nglobalThis.describe = globalReportDescription;', context);
  const text = context.describe({ en_progreso: true, progress: { stage: 'consolidating', completedBatches: 40, totalBatches: 40 } });
  assert.match(text, /Consolidando.*40\/40 lotes de texto/);
  assert.match(text, /trabajo continúa en el servidor/);
  const verification = context.describe({ en_progreso: true, progress: { stage: 'verifying', completedBatches: 3, totalBatches: 40 } });
  assert.match(verification, /Verificando evidencias.*3\/40/);
});

function progressMarkup(data) {
  const code = sidepanel.slice(sidepanel.indexOf('function globalReportProgressMarkup('), sidepanel.indexOf('function globalReportDescription('));
  const context = vm.createContext({});
  vm.runInContext(code + '\nglobalThis.markup = globalReportProgressMarkup;', context);
  return context.markup(data);
}

test('la barra usa mensajes verificados y muestra el porcentaje restante real', () => {
  const data = { en_progreso: true, status: 'running', progress: { stage: 'verifying', completedMessages: 7500, totalMessages: 20000, completedBatches: 2, totalBatches: 40 } };
  const markup = progressMarkup(data);
  assert.match(markup, /value="37.5"/);
  assert.match(markup, /37,5 % analizado/);
  assert.match(markup, /62,5 % restante/);
  assert.match(markup, /Verificando evidencias/);
  assert.match(markup, /no tiempo restante/);
  assert.equal(progressMarkup(data), markup);
  data.progress.totalBatches = 50;
  assert.equal(progressMarkup(data), markup);
});

test('preparación y progreso desconocido no inventan un porcentaje', () => {
  for (const progress of [undefined, { completedMessages: 0, totalMessages: 0 }, { completedMessages: NaN, totalMessages: 20 }, { completedMessages: 21, totalMessages: 20 }]) {
    const markup = progressMarkup({ en_progreso: true, status: 'queued', progress });
    assert.match(markup, /<progress max="100" aria-label=/);
    assert.doesNotMatch(markup, /value="|% analizado/);
    assert.match(markup, /Calculando el total/);
  }
  assert.equal(progressMarkup(null), '');
});

test('no redondea al 100 prematuramente ni confunde analizar con guardar', () => {
  const data = { en_progreso: true, progress: { stage: 'analyzing', completedMessages: 19999, totalMessages: 20000 } };
  assert.match(progressMarkup(data), /value="99.9"/);
  data.progress.completedMessages = 20000;
  data.progress.stage = 'consolidating';
  const saving = progressMarkup(data);
  assert.match(saving, /value="100"/);
  assert.match(saving, /0 % restante del análisis/);
  assert.match(saving, /Preparando y guardando/);
  assert.doesNotMatch(saving, /Informe guardado/);
  assert.match(progressMarkup({ status: 'completed', mensajes_analizados: 20000 }), /Informe guardado/);
  assert.match(progressMarkup({ mensajes_contexto: 20000 }), /value="100"/);
});

test('fallar conserva el último avance y soporta servidores anteriores por lotes', () => {
  const data = { status: 'failed', progress: { completedBatches: 3, totalBatches: 10 } };
  const markup = progressMarkup(data);
  assert.match(markup, /value="30"/);
  assert.match(markup, /3 de 10 lotes verificados/);
  assert.match(markup, /Análisis detenido/);
  assert.match(markup, /mensajes siguen pendientes/);
});

test('el render actualiza la barra con los datos recibidos y la limpia al no haber informe', () => {
  const elements = { 'global-report-progress': {}, 'global-report-output': {}, 'global-report-meta': {} };
  const code = sidepanel.slice(sidepanel.indexOf('function globalReportProgressMarkup('), sidepanel.indexOf('let globalReportPoll ='));
  const context = vm.createContext({ $: (id) => elements[id], escapeHtml: (value) => value });
  vm.runInContext(code + '\nglobalThis.render = renderGlobalReport;', context);
  context.render({ en_progreso: true, progress: { completedMessages: 50, totalMessages: 100 } });
  assert.match(elements['global-report-progress'].innerHTML, /value="50"/);
  context.render({ status: 'completed', mensajes_analizados: 100, resumen: 'Informe final' });
  assert.match(elements['global-report-progress'].innerHTML, /value="100"/);
  assert.match(elements['global-report-output'].innerHTML, /Informe final/);
  context.render(null);
  assert.equal(elements['global-report-progress'].innerHTML, '');
});

test('144 de 3035 no se presenta como cobertura de todos los pendientes', () => {
  const markup = progressMarkup({ status: 'completed', mensajes_analizados: 144, mensajes_pendientes: 3035 });
  assert.match(markup, /cobertura no verificada/);
  assert.match(markup, /144 de 144 textos seleccionados/);
  assert.match(markup, /no a todos los pendientes/);
  assert.match(markup, /100 % analizado de la selección/);
});

test('los textos vacíos excluidos no convierten el informe en parcial', () => {
  const markup = progressMarkup({ status: 'completed', mensajes_analizados: 3396,
    coverage: { pending: 4558, texts: 3396, excludedMedia: 916, unavailable: 0, empty: 246, emptyExcluded: true } });
  assert.match(markup, /Informe guardado/);
  assert.match(markup, /246 textos vacíos excluidos/);
  assert.doesNotMatch(markup, /Informe parcial guardado/);
});

test('el alcance disponible no muestra ausentes ni adjuntos como pendientes', () => {
  const markup = progressMarkup({ status: 'completed', mensajes_analizados: 144, mensajes_pendientes: 144,
    coverage: { scope: 'available_texts', pending: 144, texts: 144 } });
  assert.match(markup, /Informe guardado/);
  assert.match(markup, /textos disponibles al iniciar/);
  assert.match(markup, /no cuentan como pendientes de análisis/);
  assert.doesNotMatch(markup, /Informe parcial guardado|0 pendientes sin contenido disponible/);
});

test('un informe parcial diferencia historial faltante, adjuntos y textos vacíos', () => {
  const markup = progressMarkup({ status: 'completed', mensajes_analizados: 144,
    coverage: { pending: 3035, texts: 144, excludedMedia: 570, unavailable: 2320, empty: 1 } });
  assert.match(markup, /Informe parcial guardado/);
  assert.match(markup, /570 adjuntos excluidos/);
  assert.match(markup, /2320 pendientes sin contenido disponible/);
  assert.match(markup, /1 textos vacíos/);
});

test('recuperar historial no inventa progreso de IA', () => {
  const markup = progressMarkup({ en_progreso: true, progress: { stage: 'syncing', completedMessages: 0, totalMessages: 0 } });
  assert.match(markup, /Recuperando historial pendiente/);
  assert.doesNotMatch(markup, /value="|% analizado/);
});
