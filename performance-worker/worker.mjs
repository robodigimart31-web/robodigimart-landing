import {calculate,mergeDealLedger,validateIncoming} from './metrics.mjs';
const origins = new Set(['https://www.robodigimart.com','https://robodigimart.com','http://127.0.0.1:8788']);
const MAX_LEDGER_DEALS=100000, SOFT_LEDGER_LIMIT=99000;
const hash = async text => new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));
async function authorized(request,secret) {
  if (!secret || secret.length<32) return false;
  const supplied=request.headers.get('authorization') || '';
  const a=await hash(supplied), b=await hash('Bearer '+secret);
  let different=0;for(let i=0;i<a.length;i++)different|=a[i]^b[i];return different===0;
}
async function boundedJSON(request) {
  const reader=request.body?.getReader();if(!reader)throw Error('Missing body');
  const chunks=[];let size=0;
  while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>3000000){await reader.cancel();throw Error('Payload too large');}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}return JSON.parse(new TextDecoder().decode(bytes));
}
function statement(db,sql,...args){return db.prepare(sql).bind(...args);}
export default {async fetch(request,env) {
  const url=new URL(request.url), origin=request.headers.get('origin');
  const headers={'Content-Type':'application/json','X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Vary':'Origin'};
  if(origins.has(origin)) headers['Access-Control-Allow-Origin']=origin;
  const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});
  if(request.method==='GET' && url.pathname==='/api/performance') {
    try {
      const control=await env.DB.prepare('SELECT mode FROM telemetry_control WHERE id=1').first();
      const state=control?.mode==='ledger_verified'
        ? await env.DB.prepare('SELECT payload FROM live_state WHERE id=1').first()
        : await env.DB.prepare('SELECT payload FROM telemetry_legacy_baseline WHERE id=1').first()
          || await env.DB.prepare('SELECT payload FROM live_state WHERE id=1').first();
      if(!state)return response({configured:true,live:null,backtest:null,live_status:'awaiting_baseline'});
      const data=JSON.parse(state.payload);
      if(data.schema_version!==3 || data.scope!=='helix_magic_681')return response({configured:true,live:null,backtest:null,live_status:'publisher_update_required'});
      headers['Cache-Control']='public, max-age=60';
      const status=control?.mode==='ledger_verified'?'ledger_verified':control?.mode==='ledger_approved_waiting_publish'?'ledger_approved_waiting_publish':'legacy_baseline_preserved';
      return response({configured:true,live:data,backtest:null,live_status:status});
    } catch {return response({error:'Data temporarily unavailable'},503);}
  }
  if(request.method!=='POST' || url.pathname!=='/api/publisher/mt5')return response({error:'Not found'},404);
  if(!await authorized(request,env.PUBLISHER_API_KEY))return response({error:'Unauthorized'},401);
  let p,incoming;
  try {p=await boundedJSON(request);incoming=validateIncoming(p);}catch(e){return response({error:e.message},422);}
  try {
    if(!env.ACCOUNT_HASH_SALT)return response({error:'Server not configured'},503);
    // Preserve the legacy SHA-256 wire/account identity exactly.
    const accountHash=Array.from(await hash(env.ACCOUNT_HASH_SALT+'\0'+p.broker+'\0'+p.account_login),b=>b.toString(16).padStart(2,'0')).join('');
    const at=new Date(p.recorded_at_unix*1000).toISOString();
    const control=await env.DB.prepare('SELECT account_hash,mode,revision,last_accepted_at FROM telemetry_control WHERE id=1').first();
    if(!control)return response({error:'Ledger migration is required'},503);
    if(control.account_hash && control.account_hash!==accountHash)return response({error:'Account locked to another terminal account'},409);
    if(control.last_accepted_at && Date.parse(at)<=Date.parse(control.last_accepted_at))return response({error:'Older or duplicate snapshot'},409);
    if(control.last_accepted_at && Date.parse(at)-Date.parse(control.last_accepted_at)<300000)return response({error:'Wait at least five minutes between updates'},429);
    const rows=await env.DB.prepare('SELECT payload FROM telemetry_deals WHERE account_hash=? ORDER BY deal_ticket LIMIT 100001').bind(accountHash).all();
    const existing=rows.results||[];
    if(existing.length>MAX_LEDGER_DEALS || existing.length>=SOFT_LEDGER_LIMIT && !incoming.every(d=>existing.some(r=>JSON.parse(r.payload).id===d.id)))
      return response({error:'History ledger is near capacity; snapshot not published'},503);
    const ledger=mergeDealLedger(existing.map(row=>JSON.parse(row.payload)),incoming);
    if(ledger.length>MAX_LEDGER_DEALS)return response({error:'History ledger limit reached; snapshot not published'},503);
    const data=calculate({...p,deals:ledger},Date.now(),MAX_LEDGER_DEALS), payload=JSON.stringify(data);
    const revision=control.revision+1, operation=crypto.randomUUID();
    const incomingJSON=JSON.stringify(incoming);
    // D1 batch is an atomic transaction. The first CAS serializes publishers;
    // every following write is fenced by this operation token and revision.
    const batch=await env.DB.batch([
      statement(env.DB,`UPDATE telemetry_control SET account_hash=?,revision=?,last_operation=?,last_accepted_at=?
        WHERE id=1 AND revision=? AND (account_hash IS NULL OR account_hash=?)
        AND (last_accepted_at IS NULL OR (julianday(?)>julianday(last_accepted_at) AND julianday(?)-julianday(last_accepted_at)>=5.0/1440))`,accountHash,revision,operation,at,control.revision,accountHash,at,at),
      statement(env.DB,`INSERT INTO telemetry_deal_revisions(account_hash,deal_ticket,observed_at,previous_payload,replacement_payload)
        SELECT ?,json_extract(i.value,'$.id'),?,d.payload,i.value FROM json_each(?) i
        JOIN telemetry_deals d ON d.account_hash=? AND d.deal_ticket=json_extract(i.value,'$.id')
        WHERE d.payload IS NOT i.value AND EXISTS(SELECT 1 FROM telemetry_control WHERE id=1 AND last_operation=? AND revision=?)
        ON CONFLICT(account_hash,deal_ticket,observed_at) DO NOTHING`,accountHash,at,incomingJSON,accountHash,operation,revision),
      statement(env.DB,`INSERT INTO telemetry_deals(account_hash,deal_ticket,payload,updated_at)
        SELECT ?,json_extract(value,'$.id'),value,? FROM json_each(?)
        WHERE json_extract(value,'$.type') IN (0,1) AND EXISTS(SELECT 1 FROM telemetry_control WHERE id=1 AND last_operation=? AND revision=?)
        ON CONFLICT(account_hash,deal_ticket) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at
        WHERE telemetry_deals.payload IS NOT excluded.payload`,accountHash,at,incomingJSON,operation,revision),
      statement(env.DB,`INSERT INTO telemetry_candidate(id,account_hash,revision,recorded_at,payload)
        SELECT 1,?,?,?,? WHERE EXISTS(SELECT 1 FROM telemetry_control WHERE id=1 AND last_operation=? AND revision=?)
        ON CONFLICT(id) DO UPDATE SET account_hash=excluded.account_hash,revision=excluded.revision,recorded_at=excluded.recorded_at,payload=excluded.payload`,accountHash,revision,at,payload,operation,revision),
      statement(env.DB,`INSERT INTO live_state(id,account_hash,recorded_at,payload)
        SELECT 1,?,?,? WHERE EXISTS(SELECT 1 FROM telemetry_control WHERE id=1 AND last_operation=? AND revision=? AND mode IN ('ledger_approved_waiting_publish','ledger_verified'))
        ON CONFLICT(id) DO UPDATE SET recorded_at=excluded.recorded_at,payload=excluded.payload
        WHERE live_state.account_hash=excluded.account_hash AND julianday(excluded.recorded_at)>julianday(live_state.recorded_at)`,accountHash,at,payload,operation,revision),
      statement(env.DB,`UPDATE telemetry_control SET mode='ledger_verified',published_revision=? WHERE id=1 AND last_operation=? AND revision=?
        AND mode IN ('ledger_approved_waiting_publish','ledger_verified')
        AND EXISTS(SELECT 1 FROM live_state WHERE id=1 AND account_hash=? AND recorded_at=? AND payload=?)`,revision,operation,revision,accountHash,at,payload)
    ]);
    if(!batch?.[0]?.meta?.changes)return response({error:'Concurrent update; retry later'},409);
    const final=await env.DB.prepare('SELECT mode,revision,published_revision,last_operation FROM telemetry_control WHERE id=1').first();
    if(final?.last_operation!==operation)return response({error:'Concurrent update; retry later'},409);
    if((control.mode==='ledger_approved_waiting_publish'||control.mode==='ledger_verified')&&(final.mode!=='ledger_verified'||final.published_revision!==revision))return response({error:'Snapshot publication did not complete'},503);
    return response({ok:true,stored_strategy_deals:ledger.length,next_sync_hours:12,publication_status:final.mode==='ledger_verified'?'ledger_verified':'legacy_baseline_preserved'});
  }catch{return response({error:'Could not save snapshot'},503);}
}};
