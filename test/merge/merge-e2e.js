process.env.SYNC_SECRET='t3st'; process.env.DATABASE_URL=process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:55432/spatest';
const R=require('path').resolve(__dirname, '../..') + '/';
const express=require(R+'node_modules/express'); const { pool, initSchema } = require(R+'src/db/database.js');
let pass=0, fail=0; const ok=(l,c,x)=>{ if(c){pass++;console.log('  ✓',l)} else {fail++;console.log('  ✗',l, x!==undefined?JSON.stringify(x):'')} };
(async()=>{
 await initSchema();
 for (const t of ['client_merges','client_duplicate_flags','deleted_records','loyalty_events','vouchers','appointments','client_medical','clients']) await pool.query(`DELETE FROM ${t}`);
 let role='manager';
 const app=express(); app.use(express.json()); app.use((q,r,n)=>{q.staff={id:7,name:'Mia',role};n();});
 app.use('/api/clients', require(R+'src/routes/clients.js'));
 app.use('/api/sync', require(R+'src/routes/sync.js'));
 const srv=app.listen(0); const B=`http://127.0.0.1:${srv.address().port}/api`;
 const j=async(path,opt={})=>{const r=await fetch(B+path,{...opt,headers:{'content-type':'application/json','x-sync-secret':process.env.SYNC_SECRET||''},body:opt.body?JSON.stringify(opt.body):undefined});return {status:r.status, body:await r.json().catch(()=>null)};};
 const mk=async(b)=>(await j('/clients',{method:'POST',body:b})).body.client;
 const keep=await mk({name:'Sara Dodd',phone:'07700 900222',email:'sara@x.com',gdpr_consent:true,marketing_consent:true,notes:'likes firm pressure'});
 const dup =await mk({name:'Sarah Dod',phone:'+44 7700 900333',email:'SARA@x.com',gdpr_consent:false,marketing_consent:false,notes:'allergic to nuts oil'});
 await pool.query(`UPDATE clients SET loyalty_visits=3, loyalty_cycle=0, created_at=now()-interval '400 days' WHERE id=$1`,[dup.id]);
 await pool.query(`UPDATE clients SET loyalty_visits=2 WHERE id=$1`,[keep.id]);
 for (const id of [keep.id,dup.id,dup.id]) await pool.query(`INSERT INTO appointments (client_id,starts_at,ends_at,status,source) VALUES ($1,now(),now()+interval '1h','completed','walkin')`,[id]);
 await pool.query(`INSERT INTO vouchers (code, client_id, initial_value, remaining_value) VALUES ('V-T1',$1,50,50)`,[dup.id]).catch(e=>console.log('voucher insert skipped:',e.message));
 await pool.query(`INSERT INTO client_medical (client_id) VALUES ($1)`,[dup.id]);
 await pool.query(`INSERT INTO loyalty_events (client_id,type,cycle,visits_before,cycle_before,visits_after,cycle_after) VALUES ($1,'earn',0,2,0,3,0)`,[dup.id]);

 console.log('Possible duplicates:');
 const pd=await j('/clients/possible-duplicates'); ok('pair found (same email)', pd.body.pairs.some(p=>p.reasons.includes('email')), pd.body);

 console.log('Permissions:');
 role='reception';
 ok('reception preview → 403', (await j(`/clients/${keep.id}/merge-preview?duplicate_id=${dup.id}`)).status===403);
 ok('reception merge → 403', (await j(`/clients/${keep.id}/merge`,{method:'POST',body:{duplicate_id:dup.id}})).status===403);
 ok('reception can flag', (await j('/clients/duplicate-flags',{method:'POST',body:{client_a:dup.id,client_b:keep.id}})).status===200);
 role='manager';
 const pd2=await j('/clients/possible-duplicates'); ok('flagged pair listed first', pd2.body.pairs[0].flagged===true);

 console.log('Preview:');
 const pv=(await j(`/clients/${keep.id}/merge-preview?duplicate_id=${dup.id}`)).body;
 ok('counts dup 2 appts', pv.duplicate.counts.appointments===2, pv.duplicate.counts);
 ok('preview medical moved', pv.medical==='moved', pv.medical);
 ok('preview marketing OFF (only one agreed)', pv.result.marketing_consent===false);
 ok('preview has no medical answers', !JSON.stringify(pv).includes('pregnan'));

 console.log('Merge:');
 const m=await j(`/clients/${keep.id}/merge`,{method:'POST',body:{duplicate_id:dup.id}});
 ok('merge 200', m.status===200, m.body);
 const k=(await pool.query('SELECT * FROM clients WHERE id=$1',[keep.id])).rows[0];
 ok('dup removed', (await pool.query('SELECT 1 FROM clients WHERE id=$1',[dup.id])).rows.length===0);
 ok('voucher moved', (await pool.query('SELECT client_id FROM vouchers WHERE code=$1',['V-T1'])).rows[0]?.client_id===keep.id); ok('3 appts on main', Number((await pool.query('SELECT count(*) n FROM appointments WHERE client_id=$1',[keep.id])).rows[0].n)===3);
 ok('medical moved', (await pool.query('SELECT 1 FROM client_medical WHERE client_id=$1',[keep.id])).rows.length===1);
 ok('loyalty event moved', (await pool.query('SELECT 1 FROM loyalty_events WHERE client_id=$1',[keep.id])).rows.length===1);
 ok('stamps 2+3=5', Number(k.loyalty_visits)===5, k.loyalty_visits);
 ok('marketing OFF', k.marketing_consent===false);
 ok('gdpr consent kept ON', k.gdpr_consent===true);
 ok('main phone kept, other in alt', k.phone==='07700 900222' && k.alt_phone==='+44 7700 900333', [k.phone,k.alt_phone]);
 ok('same email (case) not duplicated', k.email==='sara@x.com' && !k.alt_email, [k.email,k.alt_email]);
 ok('notes kept both', k.notes.includes('firm pressure') && k.notes.includes('nuts oil') && k.notes.includes('Sarah Dod'), k.notes);
 ok('client-since = older profile', new Date(k.created_at) < new Date(Date.now()-300*864e5));
 const au=(await pool.query('SELECT * FROM client_merges')).rows[0];
 ok('audit row: who + ids', au && au.kept_id===keep.id && au.merged_id===dup.id && au.staff_name==='Mia');
 ok('tombstone merged_into', (await pool.query('SELECT merged_into FROM deleted_records WHERE cloud_id=$1',[dup.id])).rows[0]?.merged_into===keep.id);
 ok('flag cleared', (await pool.query('SELECT count(*) n FROM client_duplicate_flags')).rows[0].n==='0');
 const del=await j('/sync/deletions?since=1970-01-01'); ok('deletions feed carries merged_into', del.body.deletions?.some(d=>d.merged_into===keep.id), del.body);

 console.log('Unsubscribe sticks:');
 const a=await mk({name:'Tom One',email:'t@x.com',marketing_consent:true}); const b=await mk({name:'Tom Uno',marketing_consent:true});
 await pool.query('UPDATE clients SET unsubscribed_at=now() WHERE id=$1',[b.id]);
 await j(`/clients/${a.id}/merge`,{method:'POST',body:{duplicate_id:b.id}});
 const ta=(await pool.query('SELECT * FROM clients WHERE id=$1',[a.id])).rows[0];
 ok('both agreed but one unsubscribed → OFF + unsubscribed', ta.marketing_consent===false && !!ta.unsubscribed_at);

 console.log('Till upload (sync push):');
 const c1=await mk({name:'Ann Lee'}); const c2=await mk({name:'Anne Lee'});
 const push=async(key)=> (await j('/sync/push',{method:'POST',body:{ops:[{op_key:key,action:'merge_client',data:{keep_id:c1.id,duplicate_id:c2.id,loyalty_visits:4,loyalty_cycle:1}}]}})).body;
 const p1=await push('t-dev:q1'); ok('push merge ok', p1.results?.[0]?.ok, p1);
 ok('till stamps applied', Number((await pool.query('SELECT loyalty_visits v FROM clients WHERE id=$1',[c1.id])).rows[0].v)===4);
 const p2=await push('t-dev:q1'); ok('same op again = duplicate, ok', p2.results[0].ok && p2.results[0].duplicate);
 const p3=await push('t-dev2:q9'); ok('other till, dup already gone → ok no-op', p3.results[0].ok, p3);

 console.log('Not the same person:');
 const x=await mk({name:'Lee Wong',phone:'07111 222333'}); const y=await mk({name:'Mei Wong',phone:'07111 222333'});
 ok('listed (same phone)', (await j('/clients/possible-duplicates')).body.pairs.some(p=>[p.a.id,p.b.id].includes(x.id)));
 await j('/clients/duplicate-flags/not-duplicate',{method:'POST',body:{client_a:y.id,client_b:x.id}});
 ok('hidden after "not the same person"', !(await j('/clients/possible-duplicates')).body.pairs.some(p=>[p.a.id,p.b.id].includes(x.id)));

 console.log('GDPR erase:');
 role='admin'; await j(`/clients/${keep.id}`,{method:'DELETE'});
 ok('merge audit wiped', (await pool.query('SELECT count(*) n FROM client_merges WHERE kept_id=$1',[keep.id])).rows[0].n==='0');

 console.log(`\n${pass} passed, ${fail} failed`); srv.close(); process.exit(fail?1:0);
})().catch(e=>{console.error('CRASH',e);process.exit(1);});
