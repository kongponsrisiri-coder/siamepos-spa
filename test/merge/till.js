process.env.DB_MODE='local'; process.env.SYNC_SECRET='t3st'; process.env.CLOUD_API_URL='http://127.0.0.1:55433';
process.env.SQLITE_PATH=process.argv[2];
const R=require('path').resolve(__dirname, '../..') + '/';
const express=require(R+'node_modules/express'); const { pool, initSchema } = require(R+'src/db/dbAdapter');
let pass=0, fail=0; const ok=(l,c,x)=>{ if(c){pass++;console.log('  ✓',l)} else {fail++;console.log('  ✗',l, x!==undefined?JSON.stringify(x):'')} };
(async()=>{
 await initSchema();
 const sync=require(R+'src/services/syncService');
 const cloud=async()=>(await fetch('http://127.0.0.1:55433/test/state')).json();
 const st0=await cloud();
 const app=express(); app.use(express.json()); app.use((q,r,n)=>{q.staff={id:7,name:'Mia',role:'manager'};n();});
 app.use('/api/clients', require(R+'src/routes/clients.js'));
 const srv=app.listen(0); const B=`http://127.0.0.1:${srv.address().port}/api`;
 const j=async(p,o={})=>{const r=await fetch(B+p,{...o,headers:{'content-type':'application/json'},body:o.body?JSON.stringify(o.body):undefined});return {status:r.status,body:await r.json().catch(()=>null)};};
 const loc=async(cid)=>(await pool.query('SELECT * FROM clients WHERE cloud_id=$1',[cid])).rows[0];

 console.log('1. Online pull:');
 await sync.pullFromCloud();
 const kL=await loc(st0.keep), dL=await loc(st0.dup);
 ok('both clients on till', kL && dL);
 ok('dup appointment on till', (await pool.query('SELECT 1 FROM appointments WHERE client_id=$1',[dL.id])).rows.length===1);
 ok('till search works (alias column)', (await j('/clients/search?q=sarah')).status===200);
 ok('till fuzzy search', (await j('/clients/search?q=Sara%20Dod')).body.clients.length===2);

 console.log('2. Offline merge on the till:');
 const m=await j(`/clients/${kL.id}/merge`,{method:'POST',body:{duplicate_id:dL.id}});
 ok('merge 200', m.status===200, m.body);
 ok('dup gone locally', !(await loc(st0.dup)));
 ok('appointment moved locally', (await pool.query('SELECT 1 FROM appointments WHERE client_id=$1',[kL.id])).rows.length===1);
 const q=(await pool.query(`SELECT op,payload,status FROM sync_queue ORDER BY id`)).rows.filter(r=>r.status==='pending');
 ok('queued merge_client then update_client', q.map(r=>r.op).join(',')==='merge_client,update_client', q);
 ok('local audit source=till', (await pool.query('SELECT source FROM client_merges')).rows[0]?.source==='till');

 console.log('3. Pull BEFORE upload must not bring the duplicate back:');
 await pool.query(`DELETE FROM sync_state WHERE key='clients_since'`);   // force a full clients re-pull
 await sync.pullFromCloud();
 ok('dup NOT re-created', !(await loc(st0.dup)));
 ok('main keeps merged phone (not overwritten)', (await loc(st0.keep)).alt_phone==='07700 900333', await loc(st0.keep));

 console.log('4. Reconnect → upload:');
 await sync.syncOnce();
 ok('queue drained', (await pool.query(`SELECT count(*) n FROM sync_queue WHERE status='pending'`)).rows[0].n===0);
 const st=await cloud();
 ok('cloud: dup gone', !st.c.some(c=>c.id===st.dup), st.c);
 ok('cloud: appointment on main', st.a.every(a=>a.client_id===st.keep), st.a);
 ok('cloud: medical on main', st.m.every(x=>x.client_id===st.keep));
 const ck=st.c.find(c=>c.id===st.keep);
 ok('cloud: stamps 5', Number(ck.loyalty_visits)===5, ck);
 ok('cloud: marketing OFF', ck.marketing_consent===false);
 ok('cloud: alt phone', ck.alt_phone==='07700 900333');
 ok('cloud: tombstone merged_into', st.d.some(d=>d.cloud_id===st.dup && d.merged_into===st.keep));
 ok('cloud: audit source=till', st.au.some(a=>a.source==='till'));

 console.log('5. Pull after upload stays clean:');
 await sync.pullFromCloud();
 ok('still one Sara on till', (await pool.query(`SELECT count(*) n FROM clients WHERE name LIKE 'Sar%'`)).rows[0].n===1);
 console.log(`\n${pass} passed, ${fail} failed`); srv.close(); process.exit(fail?1:0);
})().catch(e=>{console.error('CRASH',e);process.exit(1);});
