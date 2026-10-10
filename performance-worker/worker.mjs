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
      const {results}=await env.DB.prepare('SELECT recorded_at,balance,equity,cashflow FROM snapshots ORDER BY recorded_at DESC LIMIT 2000').all();
      const points=results.reverse();
      // Never report drawdown across cash-flow changes as trading drawdown.
      if(points.length>=2 && points.every(p=>p.cashflow===points[0].cashflow)) {
        let peak=0,dd=0;for(const p of points){peak=Math.max(peak,p.equity);if(peak>0)dd=Math.max(dd,(peak-p.equity)/peak*100);}data.report.max_drawdown_pct=Math.round(dd*100)/100;
      }
      data.points=points.map(({recorded_at,balance,equity})=>({recorded_at,balance,equity}));
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
      env.DB.prepare('INSERT OR IGNORE INTO snapshots(recorded_at,balance,equity,cashflow) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM live_state WHERE id=1 AND account_hash=? AND recorded_at=?)').bind(at,p.balance,p.equity,data.cashflow,accountHash,at),
    ]);
    const stored=await env.DB.prepare('SELECT account_hash,recorded_at FROM live_state WHERE id=1').first();
    if(stored.account_hash!==accountHash || stored.recorded_at!==at)return response({error:'Concurrent update; retry later'},409);
    return response({ok:true,next_sync_hours:12});
  }catch{return response({error:'Could not save snapshot'},503);}
}};
