import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.HIPPO_PASSPHRASE='synthetic-decision-test';
process.env.HIPPO_DB_PATH=`/tmp/decision-test-${process.pid}.db`;
const principal='agent:'+'a'.repeat(64);
process.env.HIPPO_MEMORY_SYNC_PRINCIPALS=principal;
const {initDatabase,closeDatabase,getDatabase}=await import('../src/db/index.js');
const {appendDecision,decisionInventory}=await import('../src/mcp/tools/memory-sync-decision.js');
const {remember,DEDUP_THRESHOLD}=await import('../src/mcp/tools/remember.js');
const {generateEmbedding}=await import('../src/embeddings/embedder.js');
const {cosineSimilarity}=await import('../src/embeddings/similarity.js');
before(()=>initDatabase()); after(()=>closeDatabase());
function args(topic:string,id:string,extra='') {
 const entity=`project:${topic}`, source=`snapshots/${topic}/rec-${id}.md`, record_id=`rec-${id}`;
 return {record_id,entity,source,type:'project' as const,kind:'decision' as const,
 content:`retrieval_index=v1\nrecord_id=${record_id}\nentity=${entity}\nsnapshot_path=${source}\nabout=We decided to keep the existing system stable and preserve every canonical record.\nretrieve_for=System stability and canonical record preservation.${extra}\n`};
}
test('unauthenticated and forged identity cannot enable trusted append',async()=>{
 const a=args('auth','auth');
 await assert.rejects(appendDecision('anonymous',a));
 await assert.rejects(appendDecision('oauth:forged',{...a}));
 await assert.rejects(appendDecision(principal,{...a,kind:'fact'} as never));
 assert.equal(decisionInventory(principal,((({content,...id})=>id)(a))).observation_count,0);
});
for(const reverse of [false,true]) test(`same UTC day >=0.85 collision survives both length orders ${reverse}`,async()=>{
 const topic=reverse?'reverse':'forward';
 const first=args(topic,topic+'1',reverse?' Extra detail.':''), second=args(topic,topic+'2',reverse?'':' Extra detail.');
 const sim=cosineSimilarity(await generateEmbedding(first.content),await generateEmbedding(second.content));
 assert.ok(sim>=DEDUP_THRESHOLD,`fixture similarity ${sim}`);
 const a=await appendDecision(principal,first), b=await appendDecision(principal,second);
 assert.notEqual(a.observationId,b.observationId);
 assert.equal((getDatabase().prepare('SELECT count(*) AS n FROM observations WHERE id IN (?,?)').get(a.observationId,b.observationId) as {n:number}).n,2);
 assert.equal((await appendDecision(principal,first)).observationId,a.observationId);
});
test('ordinary project remember keeps same-day dedup',async()=>{
 const input={entity:'project:ordinary',type:'project',kind:'decision',content:'Synthetic unchanged ordinary project decision.'};
 const a=await remember(input),b=await remember(input);
 assert.equal(b.deduplicated,true); assert.equal(a.observationId,b.observationId);
});
test('legacy exact identity reuses without embedding or write; conflicts and duplicates stop',async()=>{
 const {findOrCreateEntity}=await import('../src/db/entities.js');
 const {createObservation}=await import('../src/db/observations.js');
 const a=args('legacy','legacy');
 const e=findOrCreateEntity(a.entity,a.type);
 const old=createObservation(e.id,a.content,a.source,1,a.kind);
 assert.equal((await appendDecision(principal,a)).observationId,old.id);
 createObservation(e.id,a.content,a.source,1,a.kind);
 await assert.rejects(appendDecision(principal,a),/identity_conflict/);
 const b=args('wrong','wrong');
 const wrong=findOrCreateEntity('project:wrong-entity','project');
 createObservation(wrong.id,b.content,b.source,1,b.kind);
 await assert.rejects(appendDecision(principal,b),/identity_conflict/);
});
