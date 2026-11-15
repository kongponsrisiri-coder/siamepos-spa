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

 console.log('A. Another till hears about a merge:');
 await sync.pullFromCloud();
 const dL=await loc(st0.dup);
 await pool.query(`INSERT INTO appointments (client_id,starts_at,ends_at,status,source) VALUES ($1,'2024-01-05T10:00:00Z','2024-01-05T11:00:00Z','completed','walkin')`,[dL.id]);
 const r=await (await fetch('http://127.0.0.1:55433/api/sync/push',{method:'POST',headers:{'content-type':'application/json','x-sync-secret':'t3st'},
   body:JSON.stringify({ops:[{op_key:'other-till:q1',action:'merge_client',data:{keep_id:st0.keep,duplicate_id:st0.dup}}]})})).json();
 ok('merge done elsewhere', r.results[0].ok, r);
 await sync.pullFromCloud();
 const kL=await loc(st0.keep);
 ok('dup dropped here', !(await loc(st0.dup)));
 ok('old local visit moved to main (not orphaned)', (await pool.query(`SELECT client_id FROM appointments WHERE starts_at LIKE '2024-01-05%'`)).rows[0]?.client_id===kL.id);
 ok('no client-less appointments', (await pool.query('SELECT count(*) n FROM appointments WHERE client_id IS NULL')).rows[0].n===0);

 console.log('B. Duplicate created offline, merged before upload:');
 const a=(await j('/clients',{method:'POST',body:{name:'Sam Lo',phone:'07123 456789'}})).body.client;
 const b=(await j('/clients',{method:'POST',body:{name:'Sam Low',phone:'07123 456780'}})).body.client;
 const m=await j(`/clients/${a.id}/merge`,{method:'POST',body:{duplicate_id:b.id}});
 ok('merge 200', m.status===200, m.body);
 const pend=(await pool.query(`SELECT op FROM sync_queue WHERE status='pending' ORDER BY id`)).rows.map(x=>x.op);
 ok("dup's create cancelled, no merge_client", pend.join(',')==='create_client', pend);
 await sync.syncOnce();
 ok('queue drained (not wedged)', (await pool.query(`SELECT count(*) n FROM sync_queue WHERE status='pending'`)).rows[0].n===0);
 const st=await cloud();
 const sams=st.c.filter(c=>c.name.startsWith('Sam'));
 ok('cloud has ONE Sam with both phones', sams.length===1 && sams[0].alt_phone==='07123 456780', sams);
 console.log(`\n${pass} passed, ${fail} failed`); srv.close(); process.exit(fail?1:0);
})().catch(e=>{console.error('CRASH',e);process.exit(1);});
