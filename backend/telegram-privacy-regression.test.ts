import test from'node:test';import assert from'node:assert/strict';
import{configureAiPrivacy,prepareAiPayload,withAiPrivacyScope}from'./telegram-ai-privacy.ts';
const configure=()=>configureAiPrivacy({enabled:()=>true,secret:'synthetic-privacy-regression-secret-only-20261113',loadPeople:async()=>[],audit:async()=>{}});
async function mask(text:string){configure();return(await withAiPrivacyScope('telegram:regression',()=>prepareAiPayload({text},'local-fixture','local-fixture'))).text;}

test('a business amount does not make the same digits public when explicitly given as a phone',async()=>{
 const safe=await mask('Importe 1250000 EUR; teléfono: 1250000.');
 assert.match(safe,/1250000 EUR/);assert.equal(safe.split('1250000').length-1,1);assert.match(safe,/\[TELÉFONO\]/);
});
test('an invoice reference does not override explicit phone labeling or an international prefix',async()=>{
 const safe=await mask('Factura 20261113001; móvil 20261113001; factura +34612345678.');
 assert.equal(safe.split('20261113001').length-1,1);assert.ok(!safe.includes('34612345678'));assert.equal(safe.split('[TELÉFONO]').length-1,2);
});
test('the DNI correction keeps work dates and hides punctuated or individually spaced labeled identifiers',async()=>{
 const safe=await mask('Entrega el 13-11-2026 a las 17:00; DNI 12.345.678-Z; DNI 1 2 3 4 5 6 7 8 Z.');
 assert.match(safe,/13-11-2026 a las 17:00/);assert.ok(!safe.includes('345.678'));assert.ok(!safe.includes('1 2 3 4 5 6 7 8'));assert.equal(safe.split('[DNI]').length-1,2);
});
test('common multiline IBANs end at the account rather than consuming the following payment state',async()=>{
 const safe=await mask('ES91 2100\n0418 4502 0005 1332 pago pendiente; GB29 NWBK 6016 1331 9268 19 pago pendiente.');
 assert.ok(!safe.includes('ES91'));assert.ok(!safe.includes('GB29'));assert.equal(safe.split('pago pendiente').length-1,2);assert.equal(safe.split('[IBAN]').length-1,2);
});
test('private URL fields and userinfo are hidden while a public documentation URL is retained',async()=>{
 const safe=await mask('https://example.test/manual?version=3; https://example.test/ficha?%65mail=persona%2540example.test; https://persona:Secreto77@example.test/manual');
 assert.ok(safe.includes('https://example.test/manual?version=3'));assert.ok(!safe.includes('persona'));assert.ok(!safe.includes('Secreto77'));assert.equal(safe.split('[ENLACE_PRIVADO]').length-1,2);
});
test('uppercase names keep one pseudonym regardless of the capitalization of their introduction',async()=>{
 const safe=await mask('Me llamo PEDRO FICTICIO. ME LLAMO PEDRO FICTICIO. Me llamo Pedro Ficticio.');
 assert.ok(!/pedro|ficticio/iu.test(safe));const markers=safe.match(/\[PERSONA:[a-f0-9]{16}\]/gu);assert.equal(markers?.length,3);assert.equal(new Set(markers).size,1);
});
test('non-ASCII decimal digits cannot bypass explicit phone and PIN fields',async()=>{
 const safe=await mask('Teléfono: +३४ ६१२ ३४५ ६७८; PIN de entrada: ١٧٣٩.');
 assert.ok(!/[\p{Nd}]/u.test(safe));assert.match(safe,/\[TELÉFONO\]/);assert.match(safe,/\[CÓDIGO_ACCESO\]/);
});
test('quoted passwords and access-specific codes stay private beside a reference to a drawing',async()=>{
 const safe=await mask('Contraseña de acceso: "Casa! 2026"; Código del portal: P-02; es una referencia de plano.');
 assert.ok(!safe.includes('Casa!'));assert.ok(!safe.includes('P-02'));assert.equal(safe.split('[CÓDIGO_ACCESO]').length-1,2);
});
test('only explicit drawing references are kept; a bare code is still hidden',async()=>{
 assert.equal(await mask('Código: P-02; es una referencia de plano.'),'Código: P-02; es una referencia de plano.');
 const safe=await mask('Código: P-02; avisa al entrar.');assert.ok(!safe.includes('P-02'));assert.match(safe,/\[CÓDIGO_ACCESO\]/);
});
test('camelCase, snake_case and dashed personal fields are treated consistently',async()=>{
 configure();const safe=await withAiPrivacyScope('telegram:regression',()=>prepareAiPayload({accessCode:'Secreto77',access_code:'Secreto88','access-code':'Secreto99',phoneNumber:'612345678',firstName:'Persona sintética',lastName:'Apellido sintético'},'local-fixture','local-fixture'));
 assert.equal(Object.values(safe).filter(v=>v.startsWith('[DATO_PERSONAL:')).length,6);
 for(const raw of ['Secreto77','Secreto88','Secreto99','612345678','Persona sintética','Apellido sintético'])assert.ok(!JSON.stringify(safe).includes(raw));
});
test('user-written business markers cannot exempt a telephone from masking',async()=>{
 const safe=await mask('[IMPORTE:612345678] [REFERENCIA:612345678]');assert.ok(!safe.includes('612345678'));
});
test('a personal field cannot evade masking by wrapping its value in a list or object',async()=>{
 configure();const safe=await withAiPrivacyScope('telegram:regression',()=>prepareAiPayload({accessCode:['Secreto77'],address:{details:'Domicilio sintético sin prefijo'}},'local-fixture','local-fixture'));
 assert.equal(Object.values(safe).filter(v=>typeof v==='string'&&v.startsWith('[DATO_PERSONAL:')).length,2);
 assert.ok(!JSON.stringify(safe).includes('Secreto77'));assert.ok(!JSON.stringify(safe).includes('Domicilio sintético'));
});
test('treating Dirección as a department does not expose addresses without a street prefix',async()=>{
 const safe=await mask('Dirección Mayor 12, Madrid; domicilio Lisboa 17; Dirección confirma visita a Calle Ejemplo 37; falta el permiso.');
 for(const raw of ['Mayor 12','Madrid','Lisboa 17','Ejemplo 37'])assert.ok(!safe.includes(raw));
 assert.ok(safe.includes('Dirección confirma visita a'));assert.ok(safe.includes('falta el permiso'));
});
