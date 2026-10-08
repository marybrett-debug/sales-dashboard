import { ORDER_COLUMNS } from '@/lib/admin'

/*
 * "BF Sales Sync" bookmarklet: runs on an admin.barneysfarm.us page the user is already signed in to
 * (so Cloudflare Access and the admin login are already done), reads Sales → Orders newest first
 * back to a chosen date, and posts the rows to /api/admin-sync/push in parts of whole days, showing
 * progress in a box on the page. If the admin page won't let it talk to the dashboard in the
 * background, it sends the data by opening the dashboard in that tab.
 */
export function bookmarkletCode(appOrigin: string, key: string) {
  const cols = JSON.stringify(Object.values(ORDER_COLUMNS))
  const src = `(async()=>{const APP=${JSON.stringify(appOrigin)},KEY=${JSON.stringify(key)},COLS=${cols};
if(!/admin\\.barneysfarm\\.us$/.test(location.hostname)){alert('Open admin.barneysfarm.us, sign in, then click BF Sales Sync again.');return;}
let since='';try{const r=await fetch(APP+'/api/admin-sync/push?key='+KEY);since=(await r.json()).since||'';}catch(e){}
if(!since)since=new Date(Date.now()-35*864e5).toISOString().slice(0,10);
since=prompt('Sync orders into the sales dashboard from which date? (YYYY-MM-DD)',since);if(!since)return;
if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(since)){alert('Use a date like 2026-01-01.');return;}
const box=document.createElement('div');box.style.cssText='position:fixed;top:16px;right:16px;z-index:2147483647;background:#14532d;color:#fff;font:14px/1.4 system-ui,sans-serif;padding:12px 16px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:340px';
document.body.appendChild(box);const say=t=>{box.textContent='BF Sales Sync: '+t;};const done=m=>{box.remove();alert(m);};say('starting…');
const strip=v=>String(v==null?'':v).replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/\\s+/g,' ').trim();
const pick=(r,ks)=>{for(const k of ks)if(r[k]!=null&&r[k]!=='')return strip(r[k]);return '';};
const day=s=>{const m=/(\\d{4}-\\d{2}-\\d{2})/.exec(s);if(m)return m[1];const t=Date.parse(s);return isNaN(t)?'':new Date(t).toISOString().slice(0,10);};
const prev=d=>new Date(Date.parse(d+'T00:00:00Z')-864e5).toISOString().slice(0,10);
const h={'Accept':'application/json','X-Requested-With':'XMLHttpRequest'};const rows=[];let page=1,last=1,oldest='',keys=null;
try{do{const r=await fetch('/admin/sales/orders?pagination[per_page]=100&pagination[page]='+page+'&sort[column]=created_at&sort[order]=desc',{headers:h});
if(r.status!==200){done('The admin orders list returned HTTP '+r.status+'. Are you signed in?');return;}
const j=await r.json();last=(j.meta&&j.meta.last_page)||1;const recs=j.records||[];if(!keys&&recs[0])keys=Object.keys(recs[0]);
for(const rec of recs){const row=COLS.map(ks=>pick(rec,ks));rows.push(row);const d=day(row[0]);if(d&&(!oldest||d<oldest))oldest=d;}
say('reading orders, page '+page+' of '+last+(oldest?' (back to '+oldest+')':'')+'…');page++;if(!recs.length)break;}while(page<=last&&!(oldest&&oldest<since));}
catch(e){done('Reading the admin orders failed: '+e);return;}
const parts=[];let cur=[],until=null;
for(const row of rows){const d=day(row[0]);if(d&&d<since)break;if(cur.length>=3000&&d&&d!==day(cur[cur.length-1][0])){const lo=day(cur[cur.length-1][0]);parts.push({since:lo,until,rows:cur});until=prev(lo);cur=[];}cur.push(row);}
parts.push({since,until,rows:cur});const saved=[];
try{for(let p=0;p<parts.length;p++){const k=parts[p];const span=k.since+(k.until?' to '+k.until:' onwards');say('saving part '+(p+1)+' of '+parts.length+' ('+span+')…');
const res=await fetch(APP+'/api/admin-sync/push',{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({key:KEY,since:k.since,until:k.until,keys,rows:k.rows})});const out=await res.json();
if(!out.ok){done('Sales sync failed for '+span+': '+out.error+(saved.length?'\\nAlready saved: '+saved.join('; '):''));return;}saved.push(out.message);}
done('Sales dashboard synced.\\n'+saved.join('\\n'));return;}
catch(e){if(saved.length){done('Sales sync stopped partway: '+e+'\\nAlready saved: '+saved.join('; '));return;}}
box.remove();const payload=JSON.stringify({key:KEY,since,keys,rows});
if(!confirm('The admin page blocked the background send. Send the orders by opening the sales dashboard in this tab instead?'))return;
const f=document.createElement('form');f.method='POST';f.enctype='text/plain';f.action=APP+'/api/admin-sync/push';
const i=document.createElement('input');i.type='hidden';i.name=payload.slice(0,-1)+',"x":"';i.value='"}';f.appendChild(i);document.body.appendChild(f);f.submit();})();`
  return 'javascript:' + encodeURIComponent(src)
}
