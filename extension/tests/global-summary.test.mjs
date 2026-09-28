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
  assert.match(sidepanel, /function renderPendingUnreadCounter/);
  assert.match(sidepanel, /if \(success\) await loadChats\(\);/);
  assert.equal(manifest.version, '1.1.4');
});

function reportHarness() {
  const button={disabled:false};
  const elements={'btn-generate-global-report':button,'specialist-select':{value:'general'},'global-report-meta':{textContent:''}};
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
