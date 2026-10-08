import { ORDER_COLUMNS } from '@/lib/admin'

/*
 * "BF Sales Sync" bookmarklet: runs on an admin.barneysfarm.us page the user is already signed in to
 * (so Cloudflare Access and the admin login are already done), reads Sales → Orders newest first
 * back to a chosen date, and posts the rows to /api/admin-sync/push in parts of whole days, then downloads each year's
 * retail and wholesale products report and posts it to /api/admin-sync/strains, showing
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
const b64=buf=>{const u=new Uint8Array(buf);let s='';for(let i=0;i<u.length;i+=32768)s+=String.fromCharCode.apply(null,u.subarray(i,i+32768));return btoa(s);};
const csrf=(document.querySelector('meta[name=csrf-token]')||{}).content||'';
async function grab(rep,y){const from=y+'-01-01 00:00:00',to=y+'-12-31 23:59:59';
const page='/admin/reporting/reports?report='+rep+'&products=all&from='+encodeURIComponent(from)+'&to='+encodeURIComponent(to);
const fix=u=>{let x;try{x=new URL(u,location.origin+page);}catch(e){return null;}if(x.origin!==location.origin)return null;x.searchParams.set('from',from);x.searchParams.set('to',to);if(!x.searchParams.has('report'))x.searchParams.set('report',rep);if(!x.searchParams.has('products'))x.searchParams.set('products','all');return x.toString();};
const html=await(await fetch(page,{credentials:'include'})).text();const doc=new DOMParser().parseFromString(html,'text/html');
const RX=/export|download|xlsx|excel/i,tries=[],seen=new Set();const add=t=>{if(!t.u||seen.has(t.u+(t.post?'#p':'')))return;seen.add(t.u+(t.post?'#p':''));tries.push(t);};
doc.querySelectorAll('form').forEach(f=>{if(RX.test(f.textContent+' '+(f.getAttribute('action')||''))){const d=new URLSearchParams();for(const el of f.querySelectorAll('input[name],select[name]'))d.set(el.name,el.value);d.set('from',from);d.set('to',to);add({u:fix(f.getAttribute('action')||page),post:/post/i.test(f.getAttribute('method')||''),d});}});
doc.querySelectorAll('a[href]').forEach(a=>{if(RX.test(a.textContent+' '+a.getAttribute('href')))add({u:fix(a.getAttribute('href'))});});
const flat=html.split('\\\\/').join('/');const re=/["']([^"'\\s<>]*(?:export|download)[^"'\\s<>]*)["']/gi;let m;while((m=re.exec(flat))){if(/^(\\/|https?:)/.test(m[1])&&!/\\.(js|css|png|svg)(\\?|$)/i.test(m[1]))add({u:fix(m[1])});}
for(const g of['&export=1','&export=xlsx','&format=xlsx','&download=1'])add({u:fix(page+g)});
add({u:fix('/admin/reporting/reports/export?report='+rep)});
const notes=[];for(const t of tries){if(!t.u)continue;try{let r=await fetch(t.u,t.post?{method:'POST',credentials:'include',headers:{'X-CSRF-TOKEN':csrf},body:t.d}:{credentials:'include'});
let buf=await r.arrayBuffer(),u8=new Uint8Array(buf);
if(!(u8[0]===80&&u8[1]===75)&&/json/.test(r.headers.get('content-type')||'')){try{const j=JSON.parse(new TextDecoder().decode(u8));const link=j.url||j.file||j.download_url||(j.data&&(j.data.url||j.data.file));if(link){r=await fetch(link,{credentials:'include'});buf=await r.arrayBuffer();u8=new Uint8Array(buf);}}catch(e){}}
if(u8.length>100&&u8[0]===80&&u8[1]===75)return buf;notes.push(t.u.replace(location.origin,'')+' ('+r.status+')');}catch(e){notes.push(t.u.replace(location.origin,'')+' ('+e+')');}}
throw new Error('could not find the Excel export. Tried: '+notes.slice(0,8).join(' ; '));}
const sy=Number(since.slice(0,4)),ny=new Date().getFullYear();
for(let y=sy;y<=ny;y++)for(const[rep,ch]of[['retail_products','retail'],['wholesale_products','wholesale']]){say('reading '+ch+' strain sales for '+y+'…');
try{const buf=await grab(rep,y);say('saving '+ch+' strain sales for '+y+'…');const res=await fetch(APP+'/api/admin-sync/strains',{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({key:KEY,channel:ch,year:y,xlsx:b64(buf)})});const out=await res.json();
saved.push(out.ok?out.message:'Strains '+ch+' '+y+' not saved: '+out.error);}catch(e){saved.push('Strains '+ch+' '+y+' not saved: '+(e.message||e));}}
done('Sales dashboard synced.\\n'+saved.join('\\n'));return;}
catch(e){if(saved.length){done('Sales sync stopped partway: '+e+'\\nAlready saved: '+saved.join('; '));return;}}
box.remove();const payload=JSON.stringify({key:KEY,since,keys,rows});
if(!confirm('The admin page blocked the background send. Send the orders by opening the sales dashboard in this tab instead?'))return;
const f=document.createElement('form');f.method='POST';f.enctype='text/plain';f.action=APP+'/api/admin-sync/push';
const i=document.createElement('input');i.type='hidden';i.name=payload.slice(0,-1)+',"x":"';i.value='"}';f.appendChild(i);document.body.appendChild(f);f.submit();})();`
  return 'javascript:' + encodeURIComponent(src)
}
