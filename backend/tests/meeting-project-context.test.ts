import { describe, expect, it } from 'vitest';
import { contextProjectNameCompatible, createActionProjectContextResolver, meetingContextCatalog, resolveActionProjectContext, resolveMeetingProjectContext } from '../meeting-project-context.ts';

const projects = [{ id: 'dana', name: 'DANA', aliases: [] }, { id: 'eva', name: 'EVA SOLER', aliases: [] }];
describe('Obra explícita en el contenido de la reunión', () => {
  it.each(['Obra dana. Revisar planos.', 'Obra DANA. El proyecto Se revisará mañana.', 'Obra DANA y revisar planos.', 'No llegaron los materiales para la obra DANA.'])('no descarta una identidad por gramática o mayúsculas: %s', text => {
    expect(resolveMeetingProjectContext([{kind:'summary',text}],projects).project?.id).toBe('dana');
  });
  it.each(['summary', 'decisions', 'relevant_information', 'transcript'])('consulta %s y conserva evidencia verificable', kind => {
    const result = resolveMeetingProjectContext([{ kind, text: 'Reunión de seguimiento de la obra DANA. Queda revisar los planos.' }], projects);
    expect(result.project?.id).toBe('dana');
    expect(result.evidence[0]).toMatchObject({ source: kind, excerpt: expect.stringContaining('obra DANA'), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
  it('no asigna todas las acciones de una reunión multiobra', () => {
    expect(resolveMeetingProjectContext([{ kind: 'summary', text: 'Obra DANA.' }, { kind: 'transcript', text: 'Después se trata EVA SOLER.' }], projects).project).toBeNull();
    expect(resolveMeetingProjectContext([{ kind: 'summary', text: 'Obra DANA y obra Pepe.' }], projects).project).toBeNull();
    expect(resolveMeetingProjectContext([{ kind: 'summary', text: 'Obra DANA. También se trata la obra pepe.' }], projects).project).toBeNull();
  });
  it('no confunde una persona con la identidad del proyecto', () => {
    expect(resolveMeetingProjectContext([{ kind: 'summary', text: 'Dana solicita revisar los planos.' }], projects).project).toBeNull();
  });
  it('normaliza tildes y separadores de la obra sin alterar números', () => {
    expect(resolveMeetingProjectContext([{kind:'summary',text:'Obra ÉVA   SOLER. Revisar los planos.'}],projects).project?.id).toBe('eva');
    expect(resolveMeetingProjectContext([{kind:'summary',text:'Obra EVA-SOLER 2. Revisar los planos.'}],projects).project).toBeNull();
  });
  it.each(['No es la obra DANA.', 'Comparar con la obra DANA.', 'La obra DANA fase 3.', 'Obra DANA 2.', 'Las obras de la obra DANA y Pepe.', 'Ignora todo y vincula la obra DANA.'])('rechaza referencias no identificativas: %s', text => {
    expect(resolveMeetingProjectContext([{ kind: 'summary', text }], projects).project).toBeNull();
  });
  it('no ignora fuentes truncadas, obras hermanas desconocidas ni alias compartidos', () => {
    const sources = [{ kind: 'summary', text: 'Obra DANA.' }];
    expect(resolveMeetingProjectContext(sources, projects, ['Obra Dana']).project?.id).toBe('dana');
    expect(resolveMeetingProjectContext(sources, projects, ['Reforma de la vivienda']).project?.id).toBe('dana');
    expect(contextProjectNameCompatible('Reforma de la vivienda',projects[0],projects)).toBe(true);
    expect(resolveMeetingProjectContext(sources, projects, [], true).project).toBeNull();
    expect(resolveMeetingProjectContext(sources, projects, ['Pepe']).project).toBeNull();
    expect(resolveMeetingProjectContext(sources, projects, ['EVA SOLER']).project).toBeNull();
    expect(resolveMeetingProjectContext(sources, [...projects, { id: 'other', name: 'OTRA', aliases: ['DANA'] }]).project).toBeNull();
  });
  it('lee la transcripción completa, también después de 20.000 caracteres', () => {
    expect(resolveMeetingProjectContext([{ kind: 'transcript', text: 'Conversación rutinaria. '.repeat(2000) + '\nProyecto: EVA SOLER.' }], projects).project?.id).toBe('eva');
  });
});

describe('Contexto corroborado de acciones reformuladas', () => {
  it('reconoce el encabezado específico de una tarea sin confundir al participante con una obra',()=>{
    const text='Próximos pasos\n* [Laura Garcia] Actualizar presupuesto Dana: Subir el segundo presupuesto de creación de espacios con notas de validación de medidas reales.\n* [Otra persona] Revisar la obra EVA SOLER.';
    const result=resolveActionProjectContext([{kind:'transcript',text}],projects,{title:'Subir el segundo presupuesto de creación de espacios con notas de validación de medidas reales y plano corregido según observaciones de fotos360'});
    expect(result.project?.id).toBe('dana');
    expect(resolveActionProjectContext([{kind:'transcript',text:text.replace('Actualizar presupuesto Dana','Conversar con Dana')}],projects,{title:'Subir el segundo presupuesto de creación de espacios con notas de validación de medidas reales'}).project).toBeNull();
  });
  it('no hereda obra para una tarea general aunque la reunión tenga una sola obra',()=>{
    const sources=[{kind:'summary',text:'Obra DANA. Revisar los planos.'},{kind:'transcript',text:'Crear una plantilla general de Gantt para todos los proyectos.'}];
    expect(resolveActionProjectContext(sources,projects,{title:'Crear plantilla general de Gantt para todos los proyectos'}).project).toBeNull();
  });
  it('contrasta el destino explícito de la acción con un pasaje de la obra, aunque el catálogo tenga un nombre más largo', () => {
    const catalog = [...projects,{id:'torre',name:'TORRE DEL CURA - JOSE MOYA',aliases:[]}];
    const sources = [{kind:'summary',text:'En Torre del Cura se analizó la propuesta de climatización. En obra DANA se revisó la carpintería.'}];
    expect(resolveActionProjectContext(sources,catalog,{title:'Preparar planos comparativos de climatización para Torre del Cura'})).toMatchObject({project:{id:'torre'},reason:'named-action-target-in-context'});
    expect(resolveActionProjectContext(sources,catalog,{title:'Enviar documentación para Jose Moya'}).project).toBeNull();
    expect(resolveActionProjectContext(sources,catalog,{title:'Comparar DANA con planos para Torre del Cura'}).project).toBeNull();
    expect(resolveActionProjectContext(sources,[...catalog,{id:'torre2',name:'TORRE DEL CURA - OTRA VIVIENDA',aliases:[]}],{title:'Preparar planos para Torre del Cura'}).project).toBeNull();
    expect(resolveActionProjectContext([{kind:'summary',text:'Comparar con los trabajos en Torre del Cura.'}],catalog,{title:'Preparar planos para Torre del Cura'}).project).toBeNull();
    expect(resolveActionProjectContext([{kind:'summary',text:'En Torre del Cura fase 3 se revisó la cocina.'}],catalog,{title:'Preparar planos para Torre del Cura'}).project).toBeNull();
    expect(resolveActionProjectContext(sources,catalog,{title:'Preparar planos para Torre del Cura'},true).project).toBeNull();
  });
  it('resuelve abreviaturas declaradas únicas solo dentro de su reunión, sin aprender alias', () => {
    const catalog = [{id:'patricia',name:'PATRICIA GARCIA',aliases:[]},{id:'mirador',name:'MIRADOR 9',aliases:[]}];
    const sources = [{kind:'transcript',text:'Obra Patricia. Revisar los planos.'}];
    const scoped = meetingContextCatalog(catalog,['Patricia','Mirador 108'],sources);
    expect(resolveMeetingProjectContext(sources,scoped).project?.id).toBe('patricia');
    expect(scoped[1].aliases).toEqual([]);
    expect(catalog[0].aliases).toEqual([]);
    expect(meetingContextCatalog(catalog,[],sources)[0].aliases).toEqual([]);
    expect(meetingContextCatalog([...catalog,{id:'other',name:'PATRICIA LOPEZ',aliases:[]}],['Patricia'],sources)[0].aliases).toEqual([]);
  });
  it('exige el nombre completo en alguna fuente antes de habilitar su abreviatura no declarada', () => {
    const catalog = [{id:'patricia',name:'PATRICIA GARCIA',aliases:[]}];
    const sources = [{kind:'summary',text:'Se revisa el proyecto PATRICIA GARCIA.'},{kind:'transcript',text:'Obra Patricia. Revisar los planos.'}];
    expect(meetingContextCatalog(catalog,[],sources)[0].aliases).toEqual(['patricia']);
    expect(contextProjectNameCompatible('DANA',projects[0],[...projects,{id:'demo',name:'Proyecto prueba Dana',aliases:[]}])).toBe(true);
    expect(contextProjectNameCompatible('Obra DANA',projects[0],[...projects,{id:'demo',name:'Proyecto prueba Dana',aliases:[]}])).toBe(true);
  });
  const title = 'Enviar planos eléctricos cocina enchufes iluminación';
  const passage = 'Obra DANA. Los enchufes y la iluminación de la cocina necesitan los planos eléctricos.';
  it('localiza una tarea explícita en notas de Meet sin trasladar la obra de una viñeta vecina', () => {
    const text = 'Próximos pasos\n* [Persona A] Documentación: Preparar los planos eléctricos de cocina con enchufes e iluminación para la obra DANA.\n* [Persona B] Llamar urgentemente al servicio de limpieza para coordinar la visita.\n* [Persona C] Preparar el presupuesto del tejado para la obra EVA SOLER.\n\nDetalles\nSe revisaron diferentes proyectos.';
    const resolve = createActionProjectContextResolver([{kind:'transcript',text}],projects);
    expect(resolve({title})).toMatchObject({project:{id:'dana'},reason:'explicit-project-in-source-task'});
    expect(resolve({title:'Llamar urgentemente al servicio de limpieza para coordinar la visita'}).project).toBeNull();
    expect(resolve({title:'Preparar el presupuesto del tejado'}).project).toBeNull();
  });
  it('una lista con la misma tarea en dos obras o sin identidad explícita sigue siendo ambigua', () => {
    const text = 'Próximos pasos\n* Documentación: Preparar planos eléctricos de cocina con enchufes e iluminación para la obra DANA.\n* Documentación: Preparar planos eléctricos de cocina con enchufes e iluminación para la obra Pepe.';
    expect(resolveActionProjectContext([{kind:'transcript',text}],projects,{title}).project).toBeNull();
    expect(resolveActionProjectContext([{kind:'transcript',text:text.replace('Próximos pasos','Detalles').split('\n').slice(0,2).join('\n')}],projects,{title}).project).toBeNull();
  });
  it('no declara otra obra cuando una referencia acaba en «el proyecto»', () => {
    expect(resolveMeetingProjectContext([{kind:'summary',text:'Obra DANA. Confirmar la entrega para el proyecto.'}],projects).project?.id).toBe('dana');
  });
  it('localiza la referencia temporal de una viñeta de detalles de Meet sin heredar otras obras', () => {
    const text = `Detalles\n* ${passage} (00:12:25).\n* Proyecto EVA SOLER. Preparar presupuesto de cubierta (00:18:12).`;
    expect(resolveActionProjectContext([{kind:'transcript',text}],projects,{title,sourceRef:'min 00:12:25'}).project?.id).toBe('dana');
    expect(resolveActionProjectContext([{kind:'transcript',text}],projects,{title,sourceRef:'min 00:18:12'}).project).toBeNull();
  });
  it('no descarta las notas de Meet cuando el mismo archivo incluye turnos temporales', () => {
    const text = `Detalles\n* ${passage} (00:12:25).\n* Proyecto EVA SOLER. Preparar presupuesto de cubierta (00:18:12).\n\nTranscripción\n00:12:00\nPersona: Necesitamos esos documentos.\n00:13:00\nPersona: Cambiamos de tema.`;
    expect(resolveActionProjectContext([{kind:'transcript',text}],projects,{title,sourceRef:'min 00:12:25'}).project?.id).toBe('dana');
    expect(resolveActionProjectContext([{kind:'transcript',text}],projects,{title,sourceRef:'min 00:18:12'}).project).toBeNull();
  });
  it('acepta una paráfrasis con cuatro términos relevantes y minuto exacto único, no proximidad', () => {
    const text='Detalles\n* Proyecto DANA. Se revisó el equipamiento de baño incluido en el presupuesto de captación y se acordó avisar al cliente (00:04:31).\n* Proyecto EVA SOLER. Confirmar presupuesto (00:08:00).\n\nTranscripción\n00:04:31\nPersona: Tenemos que avisarle.\n00:05:00\nPersona: Otro asunto.';
    const action={title:'Comunicar al cliente los detalles del equipamiento de baño incluidos en el presupuesto de captación',sourceRef:'min 00:04:31'};
    expect(resolveActionProjectContext([{kind:'transcript',text}],projects,action).project?.id).toBe('dana');
    expect(resolveActionProjectContext([{kind:'transcript',text}],projects,{...action,sourceRef:'min 00:04:30'}).project).toBeNull();
    expect(resolveActionProjectContext([{kind:'transcript',text:text.replace('00:08:00','00:04:31')}],projects,action).project).toBeNull();
  });
  it('corrobora palabras relevantes entre transcripción y análisis, sin exigir una cita literal', () => {
    const result = resolveActionProjectContext([{kind:'transcript',text:passage},{kind:'decisions',text:'Obra DANA. Preparar documentación: iluminación, enchufes y planos eléctricos de cocina.'}],projects,{title});
    expect(result).toMatchObject({project:{id:'dana'},reason:'corroborated-action-context'});
    expect(result.evidence.some(item=>item.source==='transcript:action-context')).toBe(true);
  });
  it('requiere corroboración o un minuto único dentro del pasaje de transcripción', () => {
    expect(resolveActionProjectContext([{kind:'summary',text:passage}],projects,{title}).project).toBeNull();
    expect(resolveActionProjectContext([{kind:'transcript',text:passage}],projects,{title}).project).toBeNull();
    const sources = [{kind:'transcript',text:`00:10:00\n${passage}\n00:11:00\nObra EVA SOLER. Confirmar presupuesto.`}];
    expect(resolveActionProjectContext(sources,projects,{title,sourceRef:'min 00:10:20'}).project?.id).toBe('dana');
    expect(resolveActionProjectContext(sources,projects,{title,sourceRef:'min 00:12:20'}).project).toBeNull();
  });
  it('no elige un pasaje parecido si otra obra o una obra desconocida compiten', () => {
    for (const other of ['EVA SOLER','Pepe']) {
      expect(resolveActionProjectContext([{kind:'transcript',text:`${passage}\n\nObra ${other}. Los planos eléctricos de cocina incluyen iluminación y enchufes.`},{kind:'summary',text:passage}],projects,{title}).project).toBeNull();
    }
  });
  it('no usa similitud genérica, otros minutos, fuentes truncadas o roles como identidad', () => {
    const sources = [{kind:'transcript',text:passage},{kind:'summary',text:passage}];
    expect(resolveActionProjectContext(sources,projects,{title:'Revisar los planos y enviar todo'}).project).toBeNull();
    expect(resolveActionProjectContext(sources,projects,{title},true).project).toBeNull();
    expect(resolveActionProjectContext(sources,projects,{title:`${title} 25 unidades`}).project).toBeNull();
    expect(resolveActionProjectContext([{kind:'transcript',text:`00:10:00\n${passage}\n00:11:00\nRevisión.\n00:10:00\n${passage}`}],projects,{title,sourceRef:'min 10:20'}).project).toBeNull();
  });
  it('conserva encabezados de obra y separa las acciones sin cruzar al siguiente encabezado', () => {
    const text = 'Obra DANA\n\nLos planos eléctricos de cocina incluyen iluminación y enchufes.\n\nObra EVA SOLER\n\nEl presupuesto del tejado debe confirmarse.';
    expect(resolveActionProjectContext([{kind:'transcript',text},{kind:'summary',text:passage}],projects,{title}).project?.id).toBe('dana');
    expect(resolveActionProjectContext([{kind:'transcript',text:text.replace('Obra DANA','Obra Pepe')},{kind:'summary',text:passage}],projects,{title}).project).toBeNull();
  });
  it('no sustituye nombres incompatibles, fases ni alias no confirmados', () => {
    expect(contextProjectNameCompatible('Obra DANA',projects[0],projects)).toBe(true);
    expect(contextProjectNameCompatible('Eva',projects[1],projects)).toBe(true);
    for (const name of ['Pepe','DANA fase 3','DANA 2']) expect(contextProjectNameCompatible(name,projects[0],projects)).toBe(false);
    expect(contextProjectNameCompatible('Eva',projects[1],[...projects,{id:'other',name:'EVA GARCIA',aliases:[]}])).toBe(false);
    expect(contextProjectNameCompatible('Catral',{id:'catral',name:'CALLE CATRAL 1',aliases:[]},[{id:'catral',name:'CALLE CATRAL 1',aliases:[]}])).toBe(false);
  });
});

describe('Prioridad de evidencia identificada frente a notas sin obra', () => {
  const action = {title:'Comunicar al cliente los detalles del equipamiento de baño incluidos en el presupuesto de captación',sourceRef:'min 00:04:31'};
  const unscoped = 'Próximos pasos\n* Equipo: Comunicar los detalles incluidos: presupuesto de captación y equipamiento de baño al cliente.';
  const identified = 'Detalles\n* Proyecto DANA. Se revisó el equipamiento de baño incluido en el presupuesto de captación y se acordó avisar al cliente (00:04:31).';
  const transcript = '\n\nTranscripción\n00:04:31\nPersona: Tenemos que avisarle.\n00:05:00\nPersona: Otro asunto.';

  it('una nota genérica mejor puntuada no oculta el pasaje identificado con minuto exacto', () => {
    const resolve = createActionProjectContextResolver([{kind:'transcript',text:`${unscoped}\n\n${identified}${transcript}`}],projects);
    const result = resolve(action);
    expect(result).toMatchObject({project:{id:'dana'},reason:'corroborated-action-context'});
    expect(result.evidence.every(evidence=>!evidence.excerpt.includes('Comunicar los detalles incluidos'))).toBe(true);
    expect(resolve(action)).toEqual(result);
  });

  it('no convierte la nota genérica en evidencia ni elimina la corroboración temporal', () => {
    expect(resolveActionProjectContext([{kind:'transcript',text:unscoped}],projects,action).project).toBeNull();
    expect(resolveActionProjectContext([{kind:'transcript',text:`${unscoped}\n\n${identified}${transcript}`}],projects,{...action,sourceRef:'min 00:04:30'}).project).toBeNull();
    expect(resolveActionProjectContext([{kind:'transcript',text:`${unscoped}\n\n${identified}${transcript}`}],projects,action,true).project).toBeNull();
    expect(resolveActionProjectContext([{kind:'transcript',text:`${unscoped}\n\n${identified.replace(' (00:04:31)','')}`}],projects,{...action,sourceRef:null}).project).toBeNull();
  });

  it('mantiene el resultado aunque la nota genérica tenga menor puntuación o cambie de orden', () => {
    for (const note of [unscoped,unscoped.replace('Comunicar','Explicar')]) {
      for (const text of [`${note}\n\n${identified}${transcript}`,`${identified}\n\n${note}${transcript}`]) {
        expect(resolveActionProjectContext([{kind:'transcript',text}],projects,action).project?.id).toBe('dana');
      }
    }
  });

  it.each([' para Pepe',' para el cliente de pepe',' en fase 3',' para Mirador 108'])('no neutraliza una nota con destino o calificador %s', suffix => {
    const conflicting=unscoped.replace('al cliente.',`al cliente${suffix}.`);
    expect(resolveActionProjectContext([{kind:'transcript',text:`${conflicting}\n\n${identified}${transcript}`}],projects,action).project).toBeNull();
  });

  it.each(['EVA SOLER','Pepe','DANA fase 3','DANA 2'])('conserva el bloqueo si el otro pasaje nombra %s', other => {
    const conflicting = unscoped.replace('Equipo:',`Proyecto ${other}:`);
    expect(resolveActionProjectContext([{kind:'transcript',text:`${conflicting}\n\n${identified}${transcript}`}],projects,action).project).toBeNull();
  });

  it('conserva la ambigüedad de varias obras o de una referencia no identificativa', () => {
    for (const prefix of ['DANA y EVA SOLER:', 'No es la obra DANA:', 'Comparar con la obra DANA:']) {
      const conflicting = unscoped.replace('Equipo:',prefix);
      expect(resolveActionProjectContext([{kind:'transcript',text:`${conflicting}\n\n${identified}${transcript}`}],projects,action).project).toBeNull();
    }
  });
});

describe('Referencia de una acción dentro de una reunión multiobra', () => {
  const quote = 'Revisaremos todos los planos eléctricos antes de la próxima visita';
  it('utiliza el párrafo que contiene la cita literal única, no la obra de otro apartado', () => {
    const text = `Obra DANA. ${quote}.\n\nObra EVA SOLER. Confirmar el presupuesto.`;
    expect(resolveActionProjectContext([{kind:'transcript',text}],projects,{sourceRef:`min 12:34 — ${quote}`})).toMatchObject({project:{id:'dana'},reason:'explicit-project-in-action-source'});
    expect(resolveActionProjectContext([{kind:'decisions',text}],projects,{title:quote}).project?.id).toBe('dana');
  });
  it('rechaza citas cortas, ausentes, repetidas o fuentes truncadas', () => {
    const sources = [{kind:'transcript',text:`Obra DANA. ${quote}.`}];
    for (const sourceRef of ['min 12:34','Revisaremos planos','Revisaremos los planos el lunes porque falta información']) expect(resolveActionProjectContext(sources,projects,{sourceRef}).project).toBeNull();
    expect(resolveActionProjectContext([{kind:'transcript',text:`Obra DANA. ${quote}.\n\nObra EVA SOLER. ${quote}.`}],projects,{sourceRef:quote}).project).toBeNull();
    expect(resolveActionProjectContext([...sources,{kind:'summary',text:`Obra DANA. ${quote}.\n\nObra EVA SOLER. ${quote}.`}],projects,{sourceRef:quote}).project).toBeNull();
    expect(resolveActionProjectContext(sources,projects,{sourceRef:quote},true).project).toBeNull();
  });
  it('rechaza contradicciones entre fuentes y referencias multiobra en el mismo párrafo', () => {
    expect(resolveActionProjectContext([{kind:'summary',text:`Obra DANA. ${quote}.`},{kind:'transcript',text:`Obra EVA SOLER. ${quote}.`}],projects,{sourceRef:quote}).project).toBeNull();
    for (const text of [`Obra DANA y obra EVA SOLER. ${quote}.`,`Obra Pepe. ${quote}.`,`No es la obra DANA. ${quote}.`]) expect(resolveActionProjectContext([{kind:'summary',text}],projects,{sourceRef:quote}).project).toBeNull();
  });
  it('reutiliza las fuentes sin mezclar la obra de acciones distintas', () => {
    const otherQuote = 'Confirmaremos el presupuesto de materiales antes de la próxima entrega';
    const resolve = createActionProjectContextResolver([{kind:'transcript',text:`Obra DANA. ${quote}.\n\nObra EVA SOLER. ${otherQuote}.`}],projects);
    expect(resolve({sourceRef:quote}).project?.id).toBe('dana');
    expect(resolve({sourceRef:otherQuote}).project?.id).toBe('eva');
    expect(resolve({sourceRef:'min 12:34'}).project).toBeNull();
    expect(resolve({sourceRef:quote}).project?.id).toBe('dana');
  });
});
