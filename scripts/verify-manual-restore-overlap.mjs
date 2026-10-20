import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';

const [dealsPath] = process.argv.slice(2);
if(!dealsPath)throw new Error('Usage: node scripts/verify-manual-restore-overlap.mjs <deals.json>');
const source=JSON.parse(await readFile(dealsPath,'utf8'));
const query="SELECT deal_ticket,payload FROM telemetry_deals ORDER BY deal_ticket";
const args=[...(process.platform==='win32'?['node_modules/wrangler/bin/wrangler.js']:['node_modules/wrangler/bin/wrangler.js']),'d1','execute','helix-performance','--remote','--config','performance-worker/wrangler.jsonc','--command',query,'--json'];
const result=spawnSync(process.execPath,args,{encoding:'utf8',maxBuffer:16*1024*1024});
if(result.status!==0)throw new Error(result.error?.message||result.stderr||result.stdout||`Remote D1 read-only comparison failed (status ${result.status})`);
const start=result.stdout.indexOf('[');if(start<0)throw new Error('Wrangler did not return JSON');
const response=JSON.parse(result.stdout.slice(start));
const current=response.flatMap(x=>x.results||[]);
if(current.length!==104)throw new Error(`Expected existing D1 ledger count 104, found ${current.length}`);
const expected=new Map(source.map(d=>[d.id,d]));
const fields=['time','type','entry','volume','profit','commission','swap','fee','position','magic'];
for(const row of current){
  const actual=JSON.parse(row.payload), wanted=expected.get(row.deal_ticket);
  if(!wanted)throw new Error(`D1-only ticket ${row.deal_ticket}; do not import/publish until reconciled`);
  for(const field of fields)if((actual[field]??null)!==(wanted[field]??null))throw new Error(`Existing D1 overlap mismatch ticket ${row.deal_ticket}, field ${field}`);
}
const overlap=new Set(current.map(x=>x.deal_ticket)).size;
process.stdout.write(JSON.stringify({d1_existing:current.length,source_tickets:source.length,exact_overlap:overlap,new_expected:source.length-overlap,read_only:true}));
