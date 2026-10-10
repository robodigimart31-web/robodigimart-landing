import {calculate} from './metrics.mjs';
const origins = new Set(['https://www.robodigimart.com','https://robodigimart.com','http://127.0.0.1:8788']);
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
export default {async fetch(request,env) {
  const url=new URL(request.url), origin=request.headers.get('origin');
  const headers={'Content-Type':'application/json','X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Vary':'Origin'};
  if(origins.has(origin)) headers['Access-Control-Allow-Origin']=origin;
  const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});
  if(request.method==='GET' && url.pathname==='/api/performance') {
    try {
      const state=await env.DB.prepare('SELECT payload FROM live_state WHERE id=1').first();
      if(!state)return response({configured:true,live:null,backtest:null});
      const data=JSON.parse(state.payload);
      if(data.schema_version!==3 || data.scope!=='helix_magic_681')return response({configured:true,live:null,backtest:null,live_status:'publisher_update_required'});
      headers['Cache-Control']='public, max-age=60';
      return response({configured:true,live:data,backtest:null});
    } catch {return response({error:'Data temporarily unavailable'},503);}
  }
  if(request.method!=='POST' || url.pathname!=='/api/publisher/mt5')return response({error:'Not found'},404);
  if(!await authorized(request,env.PUBLISHER_API_KEY))return response({error:'Unauthorized'},401);
  let p,data;
  try {p=await boundedJSON(request);data=calculate(p);}catch(e){return response({error:e.message},422);}
  try {
    if(!env.ACCOUNT_HASH_SALT)return response({error:'Server not configured'},503);
    const accountHash=Array.from(await hash(env.ACCOUNT_HASH_SALT+'\0'+p.broker+'\0'+p.account_login),b=>b.toString(16).padStart(2,'0')).join('');
    const at=data.report.updated_at;
    const existing=await env.DB.prepare('SELECT account_hash,recorded_at FROM live_state WHERE id=1').first();
    if(existing && existing.account_hash!==accountHash)return response({error:'Account locked to another terminal account'},409);
    if(existing && Date.parse(at)<=Date.parse(existing.recorded_at))return response({error:'Older or duplicate snapshot'},409);
    if(existing && Date.parse(at)-Date.parse(existing.recorded_at)<300000)return response({error:'Wait at least five minutes between updates'},429);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO live_state(id,account_hash,recorded_at,payload) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET recorded_at=excluded.recorded_at,payload=excluded.payload WHERE live_state.account_hash=excluded.account_hash AND julianday(excluded.recorded_at)-julianday(live_state.recorded_at)>=5.0/1440').bind(accountHash,at,JSON.stringify(data)),

    ]);
    const stored=await env.DB.prepare('SELECT account_hash,recorded_at FROM live_state WHERE id=1').first();
    if(stored.account_hash!==accountHash || stored.recorded_at!==at)return response({error:'Concurrent update; retry later'},409);
    return response({ok:true,next_sync_hours:12});
  }catch{return response({error:'Could not save snapshot'},503);}
}};
