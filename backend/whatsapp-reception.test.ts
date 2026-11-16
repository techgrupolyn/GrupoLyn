import test from'node:test';import assert from'node:assert/strict';
import{isReceivableWhatsAppJid,directPhone,associateDirectClient}from'./whatsapp-reception.ts';
test('durable reception accepts groups, direct PN and LID but excludes broadcasts and malformed identifiers',()=>{
 for(const jid of ['120363000000000001@g.us','12345-67890@g.us','34911000123@s.whatsapp.net','34911000123@c.us','123456789012345@lid'])assert.ok(isReceivableWhatsAppJid(jid));
 for(const jid of ['status@broadcast','123@newsletter','abc@s.whatsapp.net','x@g.us',null,'34911000123@s.whatsapp.net.evil',' 34911000123@s.whatsapp.net'])assert.equal(isReceivableWhatsAppJid(jid),false);
});
test('canonical association uses explicit phone identifiers, never a LID number or conflicting phone pair',()=>{
 assert.equal(directPhone('123456789012345@lid','34911000123@s.whatsapp.net'),'34911000123');
 assert.equal(directPhone('34911000123@s.whatsapp.net','34911000123@c.us'),'34911000123');
 for(const pair of [['123456789012345@lid',null],['120363000000000001@g.us','34911000123@s.whatsapp.net'],['34911000123@s.whatsapp.net','34911000999@s.whatsapp.net']])assert.equal(directPhone(...pair as [unknown,unknown]),null);
});
test('outgoing or unverified identities never query the customer directory',async()=>{
 let calls=0;const query=async()=>{calls++;};
 await associateDirectClient(query,'m','a','34911000123@s.whatsapp.net',null,true);
 await associateDirectClient(query,'m','a','123456789012345@lid',null,false);assert.equal(calls,0);
 await associateDirectClient(async(_sql,p)=>{calls++;assert.deepEqual(p,['m','a','34911000123']);},'m','a','123456789012345@lid','34911000123@s.whatsapp.net',false);assert.equal(calls,1);
});
test('directory failures propagate to durable retry instead of acknowledging an incomplete association',async()=>{
 await assert.rejects(associateDirectClient(async()=>{throw Error('directory unavailable');},'m','a','34911000123@s.whatsapp.net',null,false),/directory unavailable/);
});
