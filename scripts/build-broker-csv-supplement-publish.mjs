import fs from 'node:fs';
import crypto from 'node:crypto';
import {calculate} from '../performance-worker/metrics.mjs';

const [ledgerPath,csvPath,outputPath,controlPath,at] = process.argv.slice(2);
if (!ledgerPath||!csvPath||!outputPath||!controlPath||!at) throw new Error('Usage: node scripts/build-broker-csv-supplement-publish.mjs <ledger-export.json> <broker.csv> <output.sql> <control-export.json> <recorded-at-iso>');
const controlRaw=fs.readFileSync(controlPath,'utf8').replace(/^\uFEFF/,''),control=JSON.parse(controlRaw)[0].results[0],time=new Date(at);
if (!Number.isFinite(time.getTime())||time.toISOString()!==at) throw new Error('Timestamp must be canonical UTC ISO format');
if (control.mode!=='ledger_verified'||control.revision!==14||control.published_revision!==14||control.last_operation!=='b36a04c2-1449-4b08-a213-e75a8ad60e7b'||control.last_accepted_at!=='2026-10-20T22:11:11.000Z'||control.deal_count!==429) throw new Error('Production ledger/control changed; refresh and reconcile before generating SQL');
const parseCsvLine=line=>[...line.matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/g)].map(m=>(m[1]??m[2]??'').replaceAll('""','"'));
const csv=fs.readFileSync(csvPath,'utf8').replace(/^\uFEFF/,'').trim().split(/\r?\n/),headers=parseCsvLine(csv.shift());
const rows=csv.map(line=>Object.fromEntries(parseCsvLine(line).map((v,i)=>[headers[i],v])));
const selected=rows.filter(r=>['1','1.0','1.00'].includes(r.lots)&&r.symbol==='XAUUSDc'&&r.closing_time_utc>='2026-10-01T00:00:00'&&r.closing_time_utc<='2026-10-20T12:23:42');
const ticket=selected.filter(r=>r.ticket==='2024489373');
if(selected.length!==209||ticket.length!==1||ticket[0].profit!=='-1000'||ticket[0].type!=='sell'||ticket[0].closing_time_utc!=='2026-10-13T04:38:34') throw new Error('Broker CSV selection differs from the reviewed reconciliation');
const raw=fs.readFileSync(ledgerPath,'utf8').replace(/^\uFEFF/,'');
const ledger=JSON.parse(raw)[0].results.map(r=>JSON.parse(r.payload));
if(ledger.length!==429||ledger.some(d=>d.position==='2024489373')) throw new Error('Ledger changed or target position already exists; do not publish this supplement');
const csvSha=crypto.createHash('sha256').update(fs.readFileSync(csvPath)).digest('hex');
const supplement={id:'CSV1-2024489373',time:'2026.10.13 04:38:34',type:1,entry:1,magic:null,position:'2024489373',volume:1,profit:-1000,commission:0,swap:0,fee:0,restore_batch_id:'HELIX_BROKER_CSV_20261021',restore_owner_selected:true,restore_source:'broker_csv_closed_position',source_sha256:csvSha};
const epoch=Math.floor(time.getTime()/1000),p={version:3,scope:'helix_magic_681',history_from:'2026.10.04 00:00:00',broker_now:'2026.10.20 22:11:11',recorded_at_unix:epoch,account_type:'real',account_login:'257471789',broker:'Exness-MT5Real36',currency:'USC',symbol:'XAUUSDc',deals:[...ledger,supplement]};
const snapshot=calculate(p,time.getTime(),100000),payload=JSON.stringify(snapshot),q=s=>`'${String(s).replaceAll("'","''")}'`;
const operation='owner-csv-20261021-2024489373-'+epoch,recordedAt=time.toISOString(),hash=control.account_hash;
if(!hash)throw new Error('Production account hash is missing; refusing write');
const sql=[
 `-- Guarded owner-approved broker CSV supplement; one missing 1.00-lot closed position only.`,
 `-- Source SHA-256: ${csvSha}; do not use against a different D1 revision.`,
 `INSERT OR IGNORE INTO telemetry_deals(account_hash,deal_ticket,payload,updated_at) SELECT c.account_hash,${q(supplement.id)},${q(JSON.stringify(supplement))},${q(recordedAt)} FROM telemetry_control c WHERE c.id=1 AND c.account_hash=${q(hash)} AND c.mode='ledger_verified' AND c.revision=14 AND c.published_revision=14 AND c.last_operation='b36a04c2-1449-4b08-a213-e75a8ad60e7b' AND c.last_accepted_at='2026-10-20T22:11:11.000Z' AND (SELECT COUNT(*) FROM telemetry_deals d WHERE d.account_hash=c.account_hash)=429;`,
 `UPDATE telemetry_control SET revision=15,last_operation=${q(operation)},last_accepted_at=${q(recordedAt)} WHERE id=1 AND account_hash=${q(hash)} AND mode='ledger_verified' AND revision=14 AND published_revision=14 AND last_operation='b36a04c2-1449-4b08-a213-e75a8ad60e7b' AND last_accepted_at='2026-10-20T22:11:11.000Z' AND EXISTS(SELECT 1 FROM telemetry_deals d WHERE d.account_hash=telemetry_control.account_hash AND d.deal_ticket=${q(supplement.id)}) AND (SELECT COUNT(*) FROM telemetry_deals d WHERE d.account_hash=telemetry_control.account_hash)=430;`,
 `INSERT INTO telemetry_candidate(id,account_hash,revision,recorded_at,payload) SELECT 1,account_hash,revision,last_accepted_at,${q(payload)} FROM telemetry_control WHERE id=1 AND mode='ledger_verified' AND revision=15 AND last_operation=${q(operation)} ON CONFLICT(id) DO UPDATE SET account_hash=excluded.account_hash,revision=excluded.revision,recorded_at=excluded.recorded_at,payload=excluded.payload WHERE EXISTS(SELECT 1 FROM telemetry_control c WHERE c.id=1 AND c.mode='ledger_verified' AND c.revision=excluded.revision AND c.last_operation=${q(operation)});`,
 `INSERT INTO live_state(id,account_hash,recorded_at,payload) SELECT 1,c.account_hash,c.last_accepted_at,p.payload FROM telemetry_control c JOIN telemetry_candidate p ON p.id=1 AND p.account_hash=c.account_hash AND p.revision=c.revision AND p.recorded_at=c.last_accepted_at WHERE c.id=1 AND c.mode='ledger_verified' AND c.revision=15 AND c.last_operation=${q(operation)} AND p.payload=${q(payload)} ON CONFLICT(id) DO UPDATE SET recorded_at=excluded.recorded_at,payload=excluded.payload WHERE live_state.account_hash=excluded.account_hash AND julianday(excluded.recorded_at)>julianday(live_state.recorded_at);`,
 `UPDATE telemetry_control SET mode='ledger_verified',published_revision=revision WHERE id=1 AND account_hash=${q(hash)} AND mode='ledger_verified' AND revision=15 AND last_operation=${q(operation)} AND EXISTS(SELECT 1 FROM live_state s JOIN telemetry_candidate p ON p.id=1 WHERE s.id=1 AND s.account_hash=telemetry_control.account_hash AND s.recorded_at=telemetry_control.last_accepted_at AND s.payload=p.payload AND p.revision=telemetry_control.revision AND p.payload=${q(payload)}) AND (SELECT COUNT(*) FROM telemetry_deals d WHERE d.account_hash=telemetry_control.account_hash)=430;`,
].join('\n')+'\n';
fs.writeFileSync(outputPath,sql,{flag:'wx'});
console.log(JSON.stringify({csv_sha256:csvSha,selected_csv_rows:selected.length,ledger_rows_before:ledger.length-1,ledger_rows_after:ledger.length,operation,expected:snapshot.report,sql_path:outputPath}));
