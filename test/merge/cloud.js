process.env.SYNC_SECRET='t3st'; process.env.DATABASE_URL=process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:55432/spatest';
const R=require('path').resolve(__dirname, '../..') + '/';
const express=require(R+'node_modules/express'); const { pool, initSchema } = require(R+'src/db/database.js');
(async()=>{
 await initSchema();
 for (const t of ['client_merges','client_duplicate_flags','deleted_records','sync_applied_ops','loyalty_events','vouchers','appointments','client_medical','clients']) await pool.query(`DELETE FROM ${t}`);
 const ins=async(n,ph,em,mk,lv)=>(await pool.query(`INSERT INTO clients (name,phone,email,marketing_consent,gdpr_consent,loyalty_visits) VALUES ($1,$2,$3,$4,true,$5) RETURNING id`,[n,ph,em,mk,lv])).rows[0].id;
 const keep=await ins('Sara Dodd','07700 900222','sara@x.com',true,2);
 const dup=await ins('Sarah Dod','07700 900333',null,false,3);
 await pool.query(`INSERT INTO appointments (client_id,starts_at,ends_at,status,source) VALUES ($1,now(),now()+interval '1h','booked','walkin')`,[dup]);
 await pool.query(`INSERT INTO client_medical (client_id) VALUES ($1)`,[dup]);
 const app=express(); app.use(express.json());
 app.get('/api/health',(q,r)=>r.json({ok:true}));
 app.use('/api/sync', require(R+'src/routes/sync.js'));
 app.get('/test/state',async(q,r)=>{ const c=(await pool.query('SELECT id,name,phone,alt_phone,marketing_consent,loyalty_visits FROM clients ORDER BY id')).rows;
   const a=(await pool.query('SELECT id,client_id FROM appointments')).rows; const m=(await pool.query('SELECT client_id FROM client_medical')).rows;
   const d=(await pool.query('SELECT cloud_id,merged_into FROM deleted_records')).rows; const au=(await pool.query('SELECT kept_id,merged_id,source FROM client_merges')).rows; r.json({c,a,m,d,au,keep,dup}); });
 const srv=app.listen(55433,()=>console.log('cloud up', keep, dup));
})();
