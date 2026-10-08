import { ORDER_COLUMNS } from '@/lib/admin'

/*
 * "BF Sales Sync" bookmarklet: runs on an admin.barneysfarm.us page the user is already signed in to
 * (so Cloudflare Access and the admin login are already done), reads Sales → Orders newest first
 * back to a chosen date, and posts the rows to /api/admin-sync/push. If the admin page won't let it
 * talk to the dashboard in the background, it sends the data by opening the dashboard in that tab.
 */
export function bookmarkletCode(appOrigin: string, key: string) {
  const cols = JSON.stringify(Object.values(ORDER_COLUMNS))
  const src = `(async()=>{const APP=${JSON.stringify(appOrigin)},KEY=${JSON.stringify(key)},COLS=${cols};
if(!/admin\\.barneysfarm\\.us$/.test(location.hostname)){alert('Open admin.barneysfarm.us, sign in, then click BF Sales Sync again.');return;}
let since='';try{const r=await fetch(APP+'/api/admin-sync/push?key='+KEY);since=(await r.json()).since||'';}catch(e){}
if(!since)since=new Date(Date.now()-35*864e5).toISOString().slice(0,10);
since=prompt('Sync retail orders into the sales dashboard from which date? (YYYY-MM-DD)',since);if(!since)return;
if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(since)){alert('Use a date like 2026-01-01.');return;}
const strip=v=>String(v==null?'':v).replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/\\s+/g,' ').trim();
const pick=(r,ks)=>{for(const k of ks)if(r[k]!=null&&r[k]!=='')return strip(r[k]);return '';};
const day=s=>{const m=/(\\d{4}-\\d{2}-\\d{2})/.exec(s);if(m)return m[1];const t=Date.parse(s);return isNaN(t)?'':new Date(t).toISOString().slice(0,10);};
const h={'Accept':'application/json','X-Requested-With':'XMLHttpRequest'};const rows=[];let page=1,last=1,oldest='',keys=null;const title=document.title;
try{do{const r=await fetch('/admin/sales/orders?pagination[per_page]=100&pagination[page]='+page+'&sort[column]=created_at&sort[order]=desc',{headers:h});
if(r.status!==200){alert('The admin orders list returned HTTP '+r.status+'. Are you signed in?');return;}
const j=await r.json();last=(j.meta&&j.meta.last_page)||1;const recs=j.records||[];if(!keys&&recs[0])keys=Object.keys(recs[0]);
for(const rec of recs){const row=COLS.map(ks=>pick(rec,ks));rows.push(row);const d=day(row[0]);if(d&&(!oldest||d<oldest))oldest=d;}
document.title='BF Sales Sync: page '+page+' of '+last;page++;if(!recs.length)break;}while(page<=last&&!(oldest&&oldest<since));}
catch(e){document.title=title;alert('Reading the admin orders failed: '+e);return;}
document.title=title;
const payload=JSON.stringify({key:KEY,since,keys,rows});
if(payload.length>4e6){alert('That is too many orders to send at once. Pick a later start date and sync in steps.');return;}
try{const res=await fetch(APP+'/api/admin-sync/push',{method:'POST',headers:{'Content-Type':'text/plain'},body:payload});const out=await res.json();alert(out.ok?'Sales dashboard synced.\\n'+out.message:'Sales sync failed: '+out.error);return;}catch(e){}
if(!confirm('The admin page blocked the background send. Send the orders by opening the sales dashboard in this tab instead?'))return;
const f=document.createElement('form');f.method='POST';f.enctype='text/plain';f.action=APP+'/api/admin-sync/push';
const i=document.createElement('input');i.type='hidden';i.name=payload.slice(0,-1)+',"x":"';i.value='"}';f.appendChild(i);document.body.appendChild(f);f.submit();})();`
  return 'javascript:' + encodeURIComponent(src)
}
