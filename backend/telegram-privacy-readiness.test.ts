import test from 'node:test';import assert from 'node:assert/strict';
import {configureAiPrivacy,prepareAiPayload,withAiPrivacyScope,conversationPersonMarker} from './telegram-ai-privacy.ts';
import {runTelegramAgent} from './telegram-context.ts';
const configure=()=>configureAiPrivacy({enabled:()=>true,secret:'synthetic-readiness-key-long-enough-for-tests',loadPeople:async()=>[{id:'person-one',name:'María Inventada'},{id:'person-two',name:'Li'}],audit:async()=>{}});
const corpus=[
 {text:'El código de acceso es 8472.',forbidden:['8472']},
 {text:'El PIN es: 12 34.',forbidden:['12 34']},
 {text:'La clave para entrar es AB-72.',forbidden:['AB-72']},
 {text:'Mi teléfono es 04240000000.',forbidden:['04240000000']},
 {text:'móvil: (212) 555-0199.',forbidden:['555-0199']},
 {text:'Vivo en la calle Mayor 12, Madrid. ¿Vienes mañana?',forbidden:['Mayor 12','Madrid']},
 {text:'Dirección: Urbanización Ficticia, parcela 12.',forbidden:['Urbanización Ficticia','parcela 12']},
 {text:'DNI 12 345 678 Z y NIE X-1234567-L.',forbidden:['12 345 678 Z','X-1234567-L']},
 {text:'IBAN GB29 NWBK 6016 1331 9268 19.',forbidden:['GB29','NWBK']},
 {text:'Correo MARIA.INVENTADA+qa@EXAMPLE.COM.',forbidden:['EXAMPLE.COM','MARIA.INVENTADA']},
 {text:'María Inventada y Li acordaron la entrega.',forbidden:['María Inventada','Li']},
 {text:'Habla con Juan Inventado, por favor.',forbidden:['Juan Inventado']}
 ,{text:'[PERSONA:04240000000abcde]',forbidden:['04240000000']}
 ,{text:'Puedes llamarme al 0424 000 0000.',forbidden:['0424','000 0000']}
 ,{text:'El fijo es 555-0199.',forbidden:['555-0199']}
 ,{text:'Número alternativo: (202) 555 0199.',forbidden:['202','555 0199']}
 ,{text:'Mi correo es prueba\u200b@example.org.',forbidden:['example.org']}
 ,{text:'Correo internacional: тест@example.org.',forbidden:['example.org','тест']}
 ,{text:'Correo: ｐｒｕｅｂａ＠ｅｘａｍｐｌｅ．ｏｒｇ.',forbidden:['example.org','＠']}
 ,{text:'El código del portal es 7391.',forbidden:['7391']}
 ,{text:'El candado se abre con 9876.',forbidden:['9876']}
 ,{text:'La clave de la puerta es ZZ-042.',forbidden:['ZZ-042']}
 ,{text:'Código: 9345.',forbidden:['9345']}
 ,{text:'La dirección es Urbanización Inventada parcela 17.',forbidden:['Urbanización Inventada','parcela 17']}
 ,{text:'Avda.Ficticia 99, planta 2.',forbidden:['Ficticia 99']}
 ,{text:'La entrega es en Callejón Inventado 12.',forbidden:['Inventado 12']}
 ,{text:'Mándalo a C/ Ejemplo 37, puerta B.',forbidden:['Ejemplo 37','puerta B']}
];
for(let i=0;i<corpus.length;i++)test('ordinary privacy phrasing '+(i+1)+' is masked before egress',async()=>{configure();const c=corpus[i],safe=await withAiPrivacyScope('telegram:readiness',()=>prepareAiPayload({text:c.text},'fixture','fixture'));for(const value of c.forbidden)assert.ok(!safe.text.includes(value),value);});
test('speaker IDs and directory names share one stable pseudonym without exposing the UUID',async()=>{
 configure();const value=await withAiPrivacyScope('telegram:readiness',async()=>({marker:conversationPersonMarker('person-one'),safe:await prepareAiPayload({text:'María Inventada'},'fixture','fixture')}));assert.equal(value.safe.text,value.marker);
 let sent='';await runTelegramAgent({chatId:'telegram:readiness',messages:[{timestamp:Date.now(),autor_tipo:'cliente',cliente_id:'person-one',remitente:'Cliente verificado',texto:'Llegada a las 10'},{timestamp:Date.now(),autor_tipo:'cliente',cliente_id:'person-one',remitente:'Cliente verificado',texto:'Confirmado'},{timestamp:Date.now(),autor_tipo:'equipo',empleado_id:'person-two',remitente:'Equipo LYN',texto:'Recibido'}],specialist:{modelo:'flash',system_prompt:'Solo evidencia'},callAgent:async p=>{sent=p;return{text:'fixture',provider:'gemini',model:'fixture',fallback:false};}});
 assert.equal(sent.split(value.marker).length-1,2);assert.match(sent,/Equipo LYN \[PERSONA:/u);assert.ok(!sent.includes('person-one'));assert.ok(!sent.includes('person-two'));
});
test('ordinary work dates and amounts retain their meaning after privacy preparation',async()=>{
 configure();const text='[2026-11-12T17:00:00.000Z] Equipo: Entrega el viernes a las 17:00, 2 puertas blancas y presupuesto 1200 EUR.';
 const safe=await withAiPrivacyScope('telegram:readiness',()=>prepareAiPayload({text},'fixture','fixture'));assert.equal(safe.text,text);
 const dated='Entrega el 12-11-2026 por 1200 EUR.';assert.equal((await withAiPrivacyScope('telegram:readiness',()=>prepareAiPayload({text:dated},'fixture','fixture'))).text,dated);
});
