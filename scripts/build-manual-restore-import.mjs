import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';

const [sourcePath, outputPath, jsonPath] = process.argv.slice(2);
if (!sourcePath || !outputPath) throw new Error('Usage: node scripts/build-manual-restore-import.mjs <FINAL.md> <output.sql> [deals.json]');
const source = await readFile(sourcePath, 'utf8');
const section = source.split('## Tabel seluruh deal terpilih')[1]?.split('\n## ')[0];
if (!section) throw new Error('Could not locate the complete deal table');
const amount = value => {
  const clean=value.replaceAll('`','').trim().replaceAll('.','').replace(',','.');
  const n=Number(clean);if(!Number.isFinite(n))throw new Error(`Invalid amount: ${value}`);return n;
};
const clean=value=>value.replaceAll('`','').trim();
const rows=[];
for (const line of section.split(/\r?\n/)) {
  if (!/^\|\s*`\d{9,20}`\s*\|/.test(line)) continue;
  const c=line.split('|').slice(1,-1).map(clean);
  if(c.length!==11)throw new Error(`Unexpected column count on row: ${line}`);
  const [id,time,position,direction,volume,profit,commission,swap,fee,magic]=c;
  const match=direction.match(/^(BUY|SELL)\/(IN|OUT)$/);if(!match)throw new Error(`Invalid deal direction: ${direction}`);
  const timeIso=time.replaceAll('.','-').replace(' ','T')+'Z';
  if(!Number.isFinite(Date.parse(timeIso)))throw new Error(`Invalid time ${time}`);
  rows.push({id,time:time.replaceAll('-','.'),position:/^\d+$/.test(position)?position:null,type:match[1]==='BUY'?0:1,entry:match[2]==='IN'?0:1,volume:amount(volume),profit:amount(profit),commission:amount(commission),swap:amount(swap),fee:amount(fee),magic:/^\d+$/.test(magic)?Number(magic):null});
}
const unique=new Map();for(const row of rows){if(unique.has(row.id))throw new Error(`Duplicate ticket ${row.id}`);unique.set(row.id,row);}
const deals=[...unique.values()];
const net=deals.reduce((sum,d)=>sum+d.profit+d.commission+d.swap+d.fee,0);
const incoming=deals.filter(d=>d.entry===0).length, outgoing=deals.filter(d=>d.entry===1).length;
const unknownMagic=deals.filter(d=>d.magic===null).length, unmapped=deals.filter(d=>d.position===null).length;
if(deals.length!==418||incoming!==210||outgoing!==208||Math.round(net*100)!==5035140||unmapped!==8||deals.some(d=>d.volume!==1))
  throw new Error(`Report integrity check failed: count=${deals.length}, IN=${incoming}, OUT=${outgoing}, net=${net}, unmapped=${unmapped}`);
const sha=createHash('sha256').update(source).digest('hex');
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
const json=d=>JSON.stringify({...d,restore_batch_id:'HELIX_REAL_257471789_DEAL_RECON_2026-10-01_to_20_LOT1_FINAL',restore_owner_selected:true});
const sql=[];
sql.push('-- Owner-authorized manual Landing Page restore; idempotent by (account_hash, deal_ticket).');
sql.push('-- Generated from the FINAL reconciliation report. Do not use for Admin/VIP telemetry.');
for(const d of deals){
  sql.push(`INSERT OR IGNORE INTO telemetry_deals(account_hash,deal_ticket,payload,updated_at) SELECT account_hash,${quote(d.id)},${quote(json(d))},strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM telemetry_control WHERE id=1 AND account_hash IS NOT NULL;`);
}
sql.push(`INSERT OR IGNORE INTO telemetry_restore_batches(id,restore_batch_id,source_name,source_sha256,account_hash,period_start,period_end,selection_filter,source_deal_count,expected_new_deal_count,net_profit,currency,magic_unverified_count,unmapped_position_count,owner_approved_at) SELECT 1,${quote('HELIX_REAL_257471789_DEAL_RECON_2026-10-01_to_20_LOT1_FINAL')},${quote('HELIX_REAL_257471789_DEAL_RECON_2026-10-01_to_20_LOT1_FINAL.md')},${quote(sha)},account_hash,'2026-10-01T00:00:00Z','2026-10-20T12:23:42Z','volume = 1.00 lot',418,314,50351.4,'USC',${unknownMagic},${unmapped},strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM telemetry_control WHERE id=1 AND account_hash IS NOT NULL;`);
await writeFile(outputPath,sql.join('\n')+'\n','utf8');
if(jsonPath)await writeFile(jsonPath,JSON.stringify(deals.map(d=>JSON.parse(json(d)))),'utf8');
process.stdout.write(JSON.stringify({rows:deals.length,incoming,outgoing,net_profit:Math.round(net*100)/100,currency:'USC',unknown_magic:unknownMagic,unmapped_position:unmapped,sha256:sha,output:outputPath}));
