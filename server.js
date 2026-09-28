const http=require('http');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {URL}=require('url');
const supabaseStore=require('./supabase-store');

const ROOT=__dirname;
const DATA=path.join(ROOT,'data.json');
const PORT=process.env.PORT||3000;
const UPLOADS=path.join(ROOT,'uploads');
const ADMIN_AUTH_FILE=path.join(ROOT,'admin-auth.json');
const ADMIN_USER=process.env.ADMIN_USER||'admin';
const ADMIN_PASS=process.env.ADMIN_PASS||'';
const ADMIN_RESET_TOKEN=process.env.ADMIN_RESET_TOKEN||'';
const YOUTUBE_API_KEY=process.env.YOUTUBE_API_KEY||'';
const STATUSES=['New','Processing','Confirmed','Packed','Shipped','Out for Delivery','Delivered','Cancelled'];
const SIZES=['S','M','L','XL','XXL'];
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.mp4':'video/mp4','.txt':'text/plain; charset=utf-8'};

fs.mkdirSync(UPLOADS,{recursive:true});

function strongPassword(s){return typeof s==='string'&&s.length>=12&&s.length<=128&&/[A-Z]/.test(s)&&/[a-z]/.test(s)&&/[0-9]/.test(s)&&/[^A-Za-z0-9]/.test(s)}
function hashPassword(s,salt){return crypto.scryptSync(String(s),salt,64).toString('hex')}
function loadAdminAuth(){try{return JSON.parse(fs.readFileSync(ADMIN_AUTH_FILE,'utf8'))}catch{return null}}
function saveAdminAuth(password){const salt=crypto.randomBytes(16).toString('hex');const auth={algorithm:'scrypt',salt,hash:hashPassword(password,salt),updatedAt:new Date().toISOString()};fs.writeFileSync(ADMIN_AUTH_FILE,JSON.stringify(auth,null,2),{mode:0o600});return auth}
let adminAuth=loadAdminAuth();
if(!adminAuth&&ADMIN_PASS){if(!strongPassword(ADMIN_PASS))console.warn('ADMIN_PASS is weak; use 12+ chars with upper/lowercase, number and symbol.');else adminAuth=saveAdminAuth(ADMIN_PASS)}
function verifyAdminPassword(password){if(!adminAuth)return false;const a=Buffer.from(hashPassword(password,adminAuth.salt),'hex'),b=Buffer.from(adminAuth.hash,'hex');return a.length===b.length&&crypto.timingSafeEqual(a,b)}
function load(){
  for(const f of [DATA,DATA+'.bak']){
    try{if(fs.existsSync(f))return JSON.parse(fs.readFileSync(f,'utf8'))}
    catch(e){console.error('[data] could not read '+path.basename(f)+':',e.message);try{fs.copyFileSync(f,f+'.corrupt-'+Date.now())}catch{}}
  }
  return {orders:[],newsletter:[],users:[],products:[],sessions:{}};
}
// Safe write: write to a temp file, keep the previous good copy as .bak, then swap in place (never leaves a half-written data.json).
function writeDataFile(db){
  const tmp=DATA+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(db,null,2));
  try{if(fs.existsSync(DATA))fs.copyFileSync(DATA,DATA+'.bak')}catch{}
  fs.renameSync(tmp,DATA);
}
let storageReady=false;
function save(db){
  writeDataFile(db);
  if(storageReady && supabaseStore.enabled){
    supabaseStore.queueSave(db).catch(err=>console.error('[Supabase] save failed:',err.message||err));
  }
}
async function saveAndFlush(db){
  save(db);
  if(storageReady && supabaseStore.enabled) await supabaseStore.flush();
}
const db=load();
db.orders ||= []; db.newsletter ||= []; db.users ||= []; db.products ||= []; db.sessions ||= {}; db.reviews ||= []; db.coupons ||= []; db.returns ||= []; db.notifications ||= []; db.audit ||= [];
db.settings ||= {gst:5,shipping:99,freeShipping:1999,sellerState:''};
db.settings.sellerState ||= db.settings.businessState || db.settings.state || '';
db.music ||= {active:false,videoId:'',title:'',channel:'',thumbnail:'',duration:'',updatedAt:null};
db.site ||= {hero:'YOUR TYPE',announcement:'New drops every week',sections:{home:true,collections:true,motion:true,featured:true,bestSellers:true,newCollection:true,trending:true,womenTops:true,highlights:true,editorial:true,newsletter:true},sectionProducts:{},colorPalette:['Black','White','Charcoal','Red','Blue','Green']};
db.site.sections ||= {home:true,collections:true,motion:true,featured:true,bestSellers:true,newCollection:true,trending:true,womenTops:true,highlights:true,editorial:true,newsletter:true};
db.site.sectionProducts ||= {}; db.site.colorPalette ||= ['Black','White','Charcoal','Red','Blue','Green'];
db.site.store ||= {name:'YOUR TYPE',phone:'',whatsapp:'',email:'',address:'',currency:'INR'}; db.site.content ||= {banner:'',bannerButton:'',bannerLink:''};
db.site.categories ||= [];
const localDeletedProductIds=new Set((db.deletedProductIds||[]).map(String));
db.products.forEach((p,i)=>{if(!p.id)p.id='p_'+crypto.createHash('sha1').update(String(p.name||'')+'|'+String(p.image||'')+'|'+i).digest('hex').slice(0,12);if(!p.sizes)p.sizes=Object.fromEntries(SIZES.map(s=>[s,Math.max(0,Number(p.stock||0))]));if(!p.sku)p.sku='YT-'+String(i+1).padStart(3,'0');if(!Array.isArray(p.colors)||!p.colors.length)p.colors=['Black','White','Charcoal'];if(!Array.isArray(p.images)||!p.images.length)p.images=[p.image||''];if(p.active===undefined)p.active=true});
// Never allow a product already marked deleted in the local source to be resurrected.
db.products=db.products.filter(p=>!localDeletedProductIds.has(String(p.id)));


function hash(s){return crypto.createHash('sha256').update(String(s)).digest('hex')}
function originFor(req){const o=req.headers.origin||'';return o&&o===('http://'+req.headers.host)?o:''}
function send(res,status,data,type='application/json',origin=''){const h={'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN','Referrer-Policy':'strict-origin-when-cross-origin','Permissions-Policy':'camera=(), microphone=(), geolocation=(self)','Content-Security-Policy':"default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; img-src 'self' https: data: blob:; media-src 'self' https: data: blob:; frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com; connect-src 'self' https://www.googleapis.com https://api.bigdatacloud.net",'Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS'};if(origin)h['Access-Control-Allow-Origin']=origin;res.writeHead(status,h);res.end(type==='application/json'?JSON.stringify(data):data)}
const rate=new Map();
function limited(req,key,limit=60,windowMs=60000){const now=Date.now();const forwarded=String(req.headers['x-forwarded-for']||'').split(',')[0].trim();const ip=forwarded||req.socket.remoteAddress||'local';const k=key+'|'+ip;const arr=(rate.get(k)||[]).filter(t=>now-t<windowMs);arr.push(now);rate.set(k,arr);return arr.length>limit}
function body(req){return new Promise((resolve,reject)=>{let b='';req.on('data',c=>{b+=c;if(b.length>45e6){req.destroy();reject(new Error('Payload too large'))}});req.on('end',()=>{try{resolve(b?JSON.parse(b):{})}catch(e){reject(e)}});req.on('error',reject)})}
function tokenFor(req){const h=req.headers.authorization||'';return h.startsWith('Bearer ')?h.slice(7):''}
function auth(req,role){const s=db.sessions[tokenFor(req)];return s&&s.expires>Date.now()&&(!role||s.role===role)?s:null}
function newSession(role,userId){const token=crypto.randomBytes(32).toString('hex');db.sessions[token]={role,userId:userId||null,expires:Date.now()+8*60*60*1000};save(db);return token}
function orderId(){return 'YT-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(2).toString('hex').toUpperCase()}
function priceNumber(v){return Number(String(v??'').replace(/[^0-9.-]/g,''))||0}
function cleanSizes(z){const src=z||{};return Object.fromEntries(SIZES.map(s=>[s,Math.max(0,Math.floor(Number(src[s]||0)))]))}
function normalizeImageRef(v){const s=String(v||'').trim();if(!s)return '';if(/^data:|^https?:|^\//i.test(s))return s;if(/^uploads\//i.test(s))return '/'+s;if(/^photos\//i.test(s))return '/'+s;const localUpload=path.join(UPLOADS,path.basename(s));if(fs.existsSync(localUpload))return '/uploads/'+encodeURIComponent(path.basename(s));return '/uploads/'+encodeURIComponent(s)}
function safeProduct(p){const sizes=cleanSizes(p.sizes),images=(Array.isArray(p.images)?p.images:[]).map(normalizeImageRef).filter(Boolean),image=normalizeImageRef(p.image||images[0]||'');return {id:String(p.id),name:String(p.name||''),price:String(p.price||''),gstRate:Math.max(0,Math.min(100,Number(p.gstRate??db.settings.gst??5)||0)),hsn:String(p.hsn||''),image,images:images.length?images:(image?[image]:[]),badge:String(p.badge||''),oldPrice:String(p.oldPrice||''),description:String(p.description||''),category:String(p.category||'T-Shirts'),sku:String(p.sku||''),cost:Number(p.cost||0),sizes,colors:Array.isArray(p.colors)&&p.colors.length?p.colors:['Black','White','Charcoal'],active:p.active!==false,featured:Boolean(p.featured),sections:Array.isArray(p.sections)?p.sections:[],stock:Object.values(sizes).reduce((a,b)=>a+b,0)}}
db.slip ||= {settings:{},orders:{}}; db.slip.settings ||= {}; db.slip.orders ||= {};
const SLIP_BOOL=['gift','fragile','hidePrice'],SLIP_STR={giftMessage:300,note:500,weight:40};
const SLIP_SET={name:80,gstin:20,address:300,phone:30,email:120,policy:400,promo:160,social:80,returnUrl:300,trackUrl:300};
function cleanStr(v,n){return String(v==null?'':v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').trim().slice(0,n)}
function applySlipOptions(id,x){
  const cur=db.slip.orders[id]||{};let touched=false;
  for(const k of SLIP_BOOL)if(x[k]!==undefined){cur[k]=Boolean(x[k]);touched=true}
  for(const k in SLIP_STR)if(x[k]!==undefined){cur[k]=cleanStr(x[k],SLIP_STR[k]);touched=true}
  if(x.slipLang!==undefined){cur.slipLang=['en','hi'].includes(x.slipLang)?x.slipLang:'';touched=true}
  if(touched)db.slip.orders[id]=cur;
  return touched;
}
function audit(action,meta={}){db.audit.unshift({id:crypto.randomUUID(),action,meta,time:new Date().toISOString()});db.audit=db.audit.slice(0,500)}
function findProduct(item){const id=String(item.productId||'');if(id){const p=db.products.find(v=>String(v.id)===id);if(p)return p}const sku=String(item.sku||'');if(sku){const p=db.products.find(v=>String(v.sku)===sku);if(p)return p}const name=String(item.name||'');const image=String(item.image||'');return db.products.find(v=>v.name===name&&( !image || v.image===image))}
function youtubeThumb(videoId){return 'https://i.ytimg.com/vi/'+encodeURIComponent(videoId)+'/hqdefault.jpg'}
async function enrichYouTubeMusic(videoId,x){
  const fallbackThumb=youtubeThumb(videoId);
  let title=String(x.title||'').trim();
  let channel=String(x.channel||'').trim();
  let thumbnail=String(x.thumbnail||'').trim();
  let duration=String(x.duration||'').trim();
  if(!thumbnail || /\/vi\/(?:0|undefined)\//.test(thumbnail)) thumbnail=fallbackThumb;
  if(title==='YouTube Live Song' || !thumbnail || !channel){
    try{
      const u='https://www.youtube.com/oembed?url='+encodeURIComponent('https://www.youtube.com/watch?v='+videoId)+'&format=json';
      const rr=await fetch(u,{headers:{'User-Agent':'Mozilla/5.0'}});
      if(rr.ok){const d=await rr.json(); title=title==='YouTube Live Song'||!title?String(d.title||title||'YouTube Music'):title; channel=!channel?String(d.author_name||'YouTube'):channel; thumbnail=String(d.thumbnail_url||thumbnail||fallbackThumb)}
    }catch(_){ }
  }
  return {title:title||'YouTube Music',channel:channel||'YouTube',thumbnail:thumbnail||fallbackThumb,duration};
}


async function api(req,res,p){
 const origin=originFor(req);
 try{
  const key=p.startsWith('/api/admin')?'admin':p.startsWith('/api/auth')?'auth':'api';
  const rateKey=p==='/api/admin/login'?'admin-login':(p.startsWith('/api/admin')?'admin-api':key);
  const rateLimit=p==='/api/admin/login'?8:180;
  if(limited(req,rateKey,rateLimit,60000))return send(res,429,{error:'Too many requests. Please try again shortly.'},'application/json',origin);
  if(req.method==='OPTIONS')return send(res,204,'','text/plain',origin);

  if(req.method==='POST'&&p==='/api/admin/login'){const x=await body(req);if(String(x.username||'')!==ADMIN_USER||!verifyAdminPassword(x.password))return send(res,401,{error:'Invalid admin credentials'},'application/json',origin);return send(res,200,{token:newSession('admin')},'application/json',origin)}
  if(req.method==='POST'&&p==='/api/admin/change-password'){if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);const x=await body(req);if(!verifyAdminPassword(x.currentPassword))return send(res,401,{error:'Current password is incorrect'},'application/json',origin);if(!strongPassword(x.newPassword))return send(res,400,{error:'New password must be 12–128 characters and include uppercase, lowercase, number and symbol'},'application/json',origin);adminAuth=saveAdminAuth(x.newPassword);db.sessions={};audit('admin.change-password');save(db);return send(res,200,{ok:true},'application/json',origin)}
  if(req.method==='POST'&&p==='/api/admin/reset-password'){const x=await body(req);if(!ADMIN_RESET_TOKEN||x.resetToken!==ADMIN_RESET_TOKEN)return send(res,401,{error:'Invalid reset token'},'application/json',origin);if(!strongPassword(x.newPassword))return send(res,400,{error:'New password must be 12–128 characters and include uppercase, lowercase, number and symbol'},'application/json',origin);adminAuth=saveAdminAuth(x.newPassword);db.sessions={};save(db);return send(res,200,{ok:true},'application/json',origin)}

  if(req.method==='POST'&&p==='/api/auth/signup'){const x=await body(req),name=String(x.name||'').trim(),email=String(x.email||'').trim().toLowerCase(),password=String(x.password||'');if(!name||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<8)return send(res,400,{error:'Name, valid email and an 8+ character password are required'},'application/json',origin);if(db.users.some(u=>u.email===email))return send(res,409,{error:'Account already exists'},'application/json',origin);const u={id:crypto.randomUUID(),name,email,password:hash(password),createdAt:new Date().toISOString()};db.users.push(u);save(db);return send(res,201,{ok:true,token:newSession('customer',u.id),name,email},'application/json',origin)}
  if(req.method==='POST'&&p==='/api/auth/signin'){const x=await body(req),email=String(x.email||'').trim().toLowerCase(),u=db.users.find(v=>v.email===email&&v.password===hash(x.password||''));if(!u)return send(res,401,{error:'Invalid email or password'},'application/json',origin);return send(res,200,{ok:true,token:newSession('customer',u.id),name:u.name,email:u.email},'application/json',origin)}
  if(req.method==='GET'&&p==='/api/auth/me'){const s=auth(req,'customer');if(!s)return send(res,401,{error:'Unauthorized'},'application/json',origin);const u=db.users.find(v=>v.id===s.userId);if(!u)return send(res,404,{error:'Account not found'},'application/json',origin);return send(res,200,{id:u.id,name:u.name,email:u.email},'application/json',origin)}
  if(req.method==='GET'&&p==='/api/auth/orders'){const s=auth(req,'customer');if(!s)return send(res,401,{error:'Unauthorized'},'application/json',origin);return send(res,200,{orders:db.orders.filter(o=>o.userId===s.userId).map(o=>({orderId:o.orderId,status:o.status,date:o.date,total:o.total,items:o.items}))},'application/json',origin)}
  if(req.method==='POST'&&p==='/api/newsletter'){const x=await body(req),email=String(x.email||'').trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return send(res,400,{error:'Invalid email'},'application/json',origin);if(!db.newsletter.some(v=>v.email===email))db.newsletter.push({email,createdAt:new Date().toISOString()});save(db);return send(res,201,{ok:true},'application/json',origin)}
  if(req.method==='GET'&&p==='/api/site-config')return send(res,200,{site:db.site,settings:{gst:Number(db.settings.gst||0),shipping:Number(db.settings.shipping||0),freeShipping:Number(db.settings.freeShipping||0)}},'application/json',origin);
  if(req.method==='PATCH'&&p==='/api/admin/site-config'){if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);const x=await body(req);if(x.hero!==undefined)db.site.hero=String(x.hero);if(x.announcement!==undefined)db.site.announcement=String(x.announcement);if(x.sections&&typeof x.sections==='object')db.site.sections=x.sections;if(x.sectionProducts&&typeof x.sectionProducts==='object'){const incoming={};Object.entries(x.sectionProducts).forEach(([section,ids])=>{if(!Array.isArray(ids))return;incoming[String(section)]=[...new Set(ids.map(v=>String(v)).filter(id=>db.products.some(prod=>String(prod.id)===id)))];});const current=db.site.sectionProducts&&typeof db.site.sectionProducts==='object'?db.site.sectionProducts:{};const merged={...current,...incoming};const touchedIds=new Set(Object.values(incoming).flat());Object.keys(merged).forEach(section=>{if(incoming[section]===undefined)return;merged[section]=incoming[section];});Object.keys(merged).forEach(section=>{if(!Array.isArray(merged[section]))merged[section]=[];merged[section]=[...new Set(merged[section].map(v=>String(v)).filter(id=>db.products.some(prod=>String(prod.id)===id)))];});if(touchedIds.size){Object.keys(merged).forEach(section=>{if(incoming[section]!==undefined)return;merged[section]=merged[section].filter(id=>!touchedIds.has(String(id)));});}db.site.sectionProducts=merged}if(Array.isArray(x.colorPalette))db.site.colorPalette=x.colorPalette.map(v=>String(v).trim()).filter(Boolean);audit('site.update');await saveAndFlush(db);return send(res,200,{ok:true,site:db.site},'application/json',origin)}

  if(req.method==='GET'&&/^\/api\/pincode\/\d{6}$/.test(p)){
   const pin=p.slice('/api/pincode/'.length);
   try{
     const rr=await fetch('https://api.postalpincode.in/pincode/'+encodeURIComponent(pin),{headers:{'User-Agent':'YOUR-TYPE/1.0'},signal:AbortSignal.timeout(6000)});
     if(!rr.ok)throw new Error('PIN lookup failed');
     const data=await rr.json();
     const first=Array.isArray(data)&&data[0]?data[0]:null;
     if(!first||first.Status!=='Success'||!Array.isArray(first.PostOffice)||!first.PostOffice.length)return send(res,404,{error:'PIN code not found'},'application/json',origin);
     const rows=first.PostOffice;
     const state=String(rows[0]?.State||'').trim();
     const districts=[...new Set(rows.map(r=>String(r?.District||'').trim()).filter(Boolean))];
     const blocks=[...new Set(rows.map(r=>String(r?.Block||'').trim()).filter(Boolean))];
     // Delhi's India Post records often expose an administrative district
     // (e.g. South West Delhi / North West Delhi) as District. That is not
     // the customer-facing City/Town. Keep Delhi as the city and expose the
     // district separately for internal/order records.
     const cityOptions=/^delhi$/i.test(state)?['Delhi']:(districts.length?districts:blocks);
     return send(res,200,{pin,state,cities:cityOptions,districts,postOffices:rows.map(r=>String(r?.Name||'').trim()).filter(Boolean)},'application/json',origin);
   }catch(e){return send(res,502,{error:'PIN lookup service is temporarily unavailable'},'application/json',origin)}
  }

  if(req.method==='GET'&&p==='/api/products')return send(res,200,{products:db.products.filter(p=>p.active!==false).map(safeProduct)},'application/json',origin);
  if(req.method==='GET'&&p==='/api/reverse-geocode'){
   try{
     const lat=Number(new URL(req.url,'http://localhost').searchParams.get('lat'));
     const lon=Number(new URL(req.url,'http://localhost').searchParams.get('lon'));
     if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat<-90||lat>90||lon<-180||lon>180)return send(res,400,{error:'Invalid location coordinates'},'application/json',origin);

     // Ask two independent reverse-geocoding services for the same GPS point.
     // We use their agreement as a confidence signal for postal PINs. A single
     // reverse-geocoder result must never silently overwrite customer-entered data.
     const nominatimUrl='https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18&lat='+encodeURIComponent(lat)+'&lon='+encodeURIComponent(lon);
     const bigDataUrl='https://api.bigdatacloud.net/data/reverse-geocode-client?latitude='+encodeURIComponent(lat)+'&longitude='+encodeURIComponent(lon)+'&localityLanguage=en';
     const [nr,br]=await Promise.allSettled([
       fetch(nominatimUrl,{headers:{'User-Agent':'YOUR-TYPE/1.0 (delivery address lookup)'},signal:AbortSignal.timeout(9000)}).then(async r=>r.ok?r.json():null),
       fetch(bigDataUrl,{headers:{'Accept':'application/json'},signal:AbortSignal.timeout(9000)}).then(async r=>r.ok?r.json():null)
     ]);
     const n=nr.status==='fulfilled'?nr.value:null;
     const b=br.status==='fulfilled'?br.value:null;
     if(!n&&!b)throw new Error('Reverse geocoding failed');

     const cleanPin=v=>String(v||'').replace(/\D/g,'').slice(0,6);
     const nAddr=n?.address||{};
     const nPin=cleanPin(nAddr.postcode);
     const bPin=cleanPin(b?.postcode);
     const pin=(nPin||bPin);
     const pinConfidence=(nPin&&bPin&&nPin===bPin)?'confirmed':(nPin||bPin?'single-source':'unknown');
     const pinConflict=Boolean(nPin&&bPin&&nPin!==bPin);

     const nState=String(nAddr.state||'').trim();
     const bState=String(b?.principalSubdivision||'').trim();
     const state=nState||bState;
     let city=String(nAddr.city||nAddr.town||nAddr.village||nAddr.municipality||'').trim()||String(b?.city||b?.localityInfo?.administrative?.[2]?.name||'').trim();
     if(/^delhi$/i.test(state)||/delhi/i.test(state)||/delhi/i.test(city))city='Delhi';
     if(!city&&/delhi/i.test(String(nAddr.state_district||'')))city='Delhi';
     const locality=String(nAddr.neighbourhood||nAddr.suburb||nAddr.quarter||nAddr.village||nAddr.town||b?.locality||b?.city||city||'').trim();
     const district=String(nAddr.state_district||nAddr.county||b?.localityInfo?.administrative?.[3]?.name||'').trim();
     const road=String(nAddr.road||'').trim();
     const houseNumber=String(nAddr.house_number||'').trim();
     const source=n&&b?'nominatim+bigdatacloud':(n?'nominatim':'bigdatacloud');
     return send(res,200,{
       displayName:String(n?.display_name||[b?.locality,b?.city,b?.principalSubdivision,b?.postcode].filter(Boolean).join(' · ')||''),
       pin,state,city,locality,district,address:[houseNumber,road].filter(Boolean).join(', '),source,
       pinConfidence,pinConflict,nominatimPin:nPin,bigDataCloudPin:bPin
     },'application/json',origin);
   }catch(e){return send(res,503,{error:'Location address lookup is temporarily unavailable. Please enter the address manually.'},'application/json',origin)}
  }
  if(req.method==='GET'&&p.startsWith('/api/reviews/')){const name=decodeURIComponent(p.slice('/api/reviews/'.length));return send(res,200,{reviews:db.reviews.filter(r=>r.product===name&&r.status!=='rejected').slice(-50).reverse()},'application/json',origin)}
  if(req.method==='POST'&&p==='/api/reviews'){const x=await body(req),name=String(x.product||'').trim(),title=String(x.title||'').trim(),text=String(x.text||'').trim(),rating=Math.max(1,Math.min(5,Math.floor(Number(x.rating||5))));const s=auth(req,'customer');if(!name||!title||!text||text.length>800)return send(res,400,{error:'Product, title and review text are required'},'application/json',origin);if(!s)return send(res,401,{error:'Please sign in to review'},'application/json',origin);const verified=db.orders.some(o=>o.userId===s.userId&&o.status!=='Cancelled'&&o.items?.some(it=>it.name===name));const u=db.users.find(v=>v.id===s.userId);const r={id:crypto.randomUUID(),product:name,rating,title,text,name:u?.name||'Customer',verified,status:'pending',reply:'',createdAt:new Date().toISOString()};db.reviews.push(r);audit('review.create',{id:r.id});await saveAndFlush(db);return send(res,201,{ok:true,review:r},'application/json',origin)}

  if(req.method==='POST'&&p==='/api/orders'){
   const x=await body(req);if(!x.name||!x.email||!x.phone||!x.address||!x.pin||!Array.isArray(x.items)||!x.items.length||!/^\d{6}$/.test(String(x.pin)))return send(res,400,{error:'Complete shipping details and cart are required'},'application/json',origin);
   const idem=String(req.headers['x-idempotency-key']||x.idempotencyKey||'').trim();
   if(idem){const prior=db.orders.find(o=>o.idempotencyKey===idem);if(prior)return send(res,200,{orderId:prior.orderId,total:prior.total,gst:prior.gst,taxableSubtotal:prior.taxableSubtotal,cgst:prior.cgst||0,sgst:prior.sgst||0,igst:prior.igst||0,taxSplitConfigured:prior.taxSplitConfigured!==false,taxSplitStatus:prior.taxSplitStatus||'',duplicate:true},'application/json',origin)}
   const requested=[],reserved=new Map();
   for(const item of x.items){const pr=findProduct(item);if(!pr||pr.active===false)return send(res,400,{error:'Product no longer available: '+String(item.name||item.productId||'')},'application/json',origin);const size=SIZES.includes(String(item.size))?String(item.size):'M';const qty=Math.min(99,Math.max(1,Math.floor(Number(item.qty||1))));const key=pr.id+'|'+size;const already=reserved.get(key)||0;const available=Number(pr.sizes?.[size]||0)-already;if(available<qty)return send(res,409,{error:`${pr.name} size ${size} is out of stock`},'application/json',origin);reserved.set(key,already+qty);requested.push({productId:pr.id,name:pr.name,image:pr.image,sku:pr.sku||'',hsn:String(pr.hsn||''),gstRate:Math.max(0,Math.min(100,Number(pr.gstRate??db.settings.gst??5)||0)),price:priceNumber(pr.price),size,color:String(item.color||'Black'),qty});}
   for(const [key,qty] of reserved){const [id,size]=key.split('|');const pr=db.products.find(v=>v.id===id);pr.sizes[size]=Math.max(0,Number(pr.sizes[size]||0)-qty)}
   const customer=auth(req,'customer'),subtotal=requested.reduce((sum,it)=>sum+priceNumber(it.price)*it.qty,0),shipping=subtotal>=Number(db.settings.freeShipping||1999)?0:Number(db.settings.shipping||99),id=orderId();
   // Re-validate any coupon on the server (never trust a discount amount sent by the client).
   let discount=0,couponCode='';
   const requestedCode=String(x.coupon||x.couponCode||'').trim().toUpperCase();
   if(requestedCode){
     const c=db.coupons.find(v=>String(v.code).toUpperCase()===requestedCode);
     if(c&&c.active!==false&&(!c.expiresAt||new Date(c.expiresAt).getTime()>=Date.now())&&subtotal>=Number(c.minOrder||0)){
       discount=Math.round(subtotal*Number(c.value||0)/100);
       if(Number(c.maxDiscount||0)>0)discount=Math.min(discount,Number(c.maxDiscount));
       discount=Math.min(discount,subtotal);
       couponCode=c.code;
     }
   }
   const customerState=String(x.state||x.customerState||'').trim();
   const customerCity=String(x.city||'').trim();
   // Re-validate the customer's PIN -> State/City on the server. Never trust the
   // values selected in the browser because the browser can be modified.
   if(!customerState||!customerCity)return send(res,400,{error:'State and City are required'},'application/json',origin);
   let detectedDistrict='';
   try{
     const rr=await fetch('https://api.postalpincode.in/pincode/'+encodeURIComponent(String(x.pin)),{headers:{'User-Agent':'YOUR-TYPE/1.0'},signal:AbortSignal.timeout(6000)});
     if(!rr.ok)throw new Error('PIN lookup failed');
     const pdata=await rr.json();
     const first=Array.isArray(pdata)&&pdata[0]?pdata[0]:null;
     if(!first||first.Status!=='Success'||!Array.isArray(first.PostOffice)||!first.PostOffice.length)return send(res,400,{error:'PIN code could not be verified. Please check the PIN.'},'application/json',origin);
     const rows=first.PostOffice;
     const normalizeState=v=>String(v||'').toLowerCase().replace(/&/g,'and').replace(/[^a-z0-9]+/g,' ').trim();
     const stateAliases={
       'nct of delhi':'delhi','national capital territory of delhi':'delhi',
       'orissa':'odisha','pondicherry':'puducherry','uttaranchal':'uttarakhand',
       'andaman and nicobar':'andaman and nicobar islands','andaman nicobar islands':'andaman and nicobar islands',
       'dadra and nagar haveli':'dadra and nagar haveli and daman and diu','daman and diu':'dadra and nagar haveli and daman and diu'
     };
     const stateKey=v=>stateAliases[normalizeState(v)]||normalizeState(v);
     const detectedState=String(rows[0]?.State||'').trim();
     const detectedStateKey=stateKey(detectedState), selectedStateKey=stateKey(customerState);
     if(!detectedStateKey||detectedStateKey!==selectedStateKey)return send(res,400,{error:'The selected State does not match the PIN code. Please use the detected State.'},'application/json',origin);
     const allowedCities=[...new Set(rows.map(r=>String(r?.District||'').trim()).filter(Boolean))];
     const allowedBlocks=[...new Set(rows.map(r=>String(r?.Block||'').trim()).filter(Boolean))];
     const cityPool=allowedCities.length?allowedCities:allowedBlocks;
     // Some PIN services return an administrative district instead of the actual
     // city name. Accept the standard city name for the UTs where the city and
     // territory share the same name (notably Delhi), while still validating the PIN.
     const stateCityAliases={
       'delhi':['delhi'],
       'chandigarh':['chandigarh'],
       'puducherry':['puducherry'],
       'lakshadweep':['kavaratti'],
       'ladakh':['leh','kargil']
     };
     const normalizedStateForCity=stateKey(detectedState);
     const cityAliases=stateCityAliases[normalizedStateForCity]||[];
     const expandedCityPool=[...new Set([...cityPool,...cityAliases])];
     const cityKey=v=>normalizeState(v);
     const cityMatches=expandedCityPool.some(v=>cityKey(v)===cityKey(customerCity));
     // India Post can return a Delhi administrative district (North East Delhi,
     // North West Delhi, etc.) for a PIN. The customer-facing city remains Delhi.
     const delhiCityAccepted=normalizedStateForCity==='delhi' && cityKey(customerCity)==='delhi';
     if(!cityMatches && !delhiCityAccepted)return send(res,400,{error:'The selected City does not match the PIN code. Please use the detected City.'},'application/json',origin);
     detectedDistrict=String(rows[0]?.District||'').trim();
   }catch(e){return send(res,503,{error:'PIN verification is temporarily unavailable. Please try again.'},'application/json',origin)}
   const sellerState=String(db.settings.sellerState||'').trim();
   // Seller state is needed to split GST into CGST/SGST vs IGST, but it must not
   // block a customer from placing an otherwise valid order. Keep the GST amount
   // authoritative and mark the split as pending until the seller state is set.
   const taxSplitConfigured=Boolean(sellerState&&customerState);
   const gstInclusive=x.gstInclusive!==false && x.gstIncluded!==false;
   const discountFactor=subtotal>0?Math.max(0,1-(discount/subtotal)):0;
   let gst=0,taxableSubtotal=0;
   const rates=[];
   for(const it of requested){const gross=priceNumber(it.price)*Math.max(1,it.qty)*discountFactor;const rate=Math.max(0,Math.min(100,Number(it.gstRate)||0));rates.push(rate);const lineGst=gstInclusive?gross*rate/(100+rate):gross*rate/100;gst+=lineGst;taxableSubtotal+=gstInclusive?gross-lineGst:gross;}
   gst=Math.round(gst*100)/100;taxableSubtotal=Math.round(taxableSubtotal*100)/100;
   const interstate=taxSplitConfigured && sellerState.toLowerCase()!==customerState.toLowerCase();
   const cgst=taxSplitConfigured&&!interstate?Math.round(gst/2*100)/100:0;
   const sgst=taxSplitConfigured&&!interstate?Math.round((gst-cgst)*100)/100:0;
   const igst=taxSplitConfigured&&interstate?gst:0;
   const total=Math.round((subtotal-discount+shipping+(gstInclusive?0:gst))*100)/100;
   const uniqueRates=[...new Set(rates)].sort((a,b)=>a-b), gstRate=uniqueRates.length===1?uniqueRates[0]:0;
   const order={name:String(x.name).trim(),email:String(x.email).trim().toLowerCase(),phone:String(x.phone).trim(),address:String(x.address).trim(),city:customerCity,state:customerState,district:detectedDistrict,pin:String(x.pin),placeOfSupply:customerState,sellerState,taxSplitConfigured,taxSplitStatus:taxSplitConfigured?(interstate?'IGST':'CGST_SGST'):'PENDING_SELLER_STATE',items:requested,subtotal,discount,couponCode,taxableSubtotal,gstRate,gst,gstInclusive,cgst,sgst,igst,shipping,total,payment:String(x.payment||'cod').toLowerCase(),orderId:id,status:'New',date:new Date().toISOString(),userId:customer?.userId||null,verified:true,awb:'',courier:'',tracking_url:'',idempotencyKey:idem||''};
   db.orders.unshift(order);audit('order.created',{orderId:id});save(db);return send(res,201,{orderId:id,total,taxableSubtotal,gstRate,gst,gstInclusive,cgst,sgst,igst,taxSplitConfigured,items:requested},'application/json',origin);
  }
  if(req.method==='GET'&&p.startsWith('/api/orders/')&&!p.endsWith('/track')){const id=decodeURIComponent(p.slice('/api/orders/'.length)),o=db.orders.find(v=>v.orderId===id);if(!o)return send(res,404,{error:'Order not found'},'application/json',origin);return send(res,200,{orderId:o.orderId,status:o.status,date:o.date,total:o.total,subtotal:o.subtotal,discount:o.discount,shipping:o.shipping,taxableSubtotal:o.taxableSubtotal,gstRate:o.gstRate,gst:o.gst,gstInclusive:o.gstInclusive,cgst:o.cgst||0,sgst:o.sgst||0,igst:o.igst||0,taxSplitConfigured:o.taxSplitConfigured!==false,taxSplitStatus:o.taxSplitStatus||'',name:o.name||o.customer||'',customer:o.customer||o.name||'',phone:o.phone||'',email:o.email||'',state:o.state||'',city:o.city||'',district:o.district||'',pin:o.pin||'',address:o.address||'',payment:o.payment||'cod',coupon:o.coupon||'',awb:o.awb||'',courier:o.courier||'',tracking_url:o.tracking_url||'',verified:o.verified!==false,items:Array.isArray(o.items)?o.items:[]},'application/json',origin)}
  if(req.method==='GET'&&p.startsWith('/api/orders/')&&p.endsWith('/track')){const id=decodeURIComponent(p.slice('/api/orders/'.length,-'/track'.length));const o=db.orders.find(v=>v.orderId===id);if(!o)return send(res,404,{error:'Order not found'},'application/json',origin);return send(res,200,{orderId:o.orderId,status:o.status,date:o.date,total:o.total,awb:o.awb||'',courier:o.courier||'',tracking_url:o.tracking_url||''},'application/json',origin)}

  if(req.method==='GET'&&p==='/api/music/current'){
    const m=db.music||{};
    return send(res,200,{active:Boolean(m.active),videoId:String(m.videoId||''),title:String(m.title||''),channel:String(m.channel||''),thumbnail:String(m.thumbnail||''),duration:String(m.duration||''),updatedAt:m.updatedAt||null},'application/json',origin);
  }
  if(req.method==='GET'&&p==='/api/admin/music/current'){
    if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);
    return send(res,200,{music:db.music||{}},'application/json',origin);
  }
  if(req.method==='PUT'&&p==='/api/admin/music/current'){
    if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);
    const x=await body(req),videoId=String(x.videoId||'').trim().replace(/^.*(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{6,})?.*$/,'$1');
    if(!/^[A-Za-z0-9_-]{6,20}$/.test(videoId))return send(res,400,{error:'Valid YouTube video ID is required'},'application/json',origin);
    const meta=await enrichYouTubeMusic(videoId,x);
    db.music={active:true,videoId,title:meta.title,channel:meta.channel,thumbnail:meta.thumbnail,duration:meta.duration,updatedAt:new Date().toISOString()};
    audit('music.set-live',{videoId}); await saveAndFlush(db);
    return send(res,200,{ok:true,music:db.music},'application/json',origin);
  }
  if(req.method==='DELETE'&&p==='/api/admin/music/current'){
    if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);
    db.music={...(db.music||{}),active:false,updatedAt:new Date().toISOString()};
    audit('music.stop'); await saveAndFlush(db);
    return send(res,200,{ok:true,music:db.music},'application/json',origin);
  }
  if(req.method==='GET'&&p==='/api/admin/youtube/search'){
    if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);
    if(!YOUTUBE_API_KEY)return send(res,503,{error:'YouTube API key is not configured. Set YOUTUBE_API_KEY on the server.'},'application/json',origin);
    const q=String(new URL(req.url,'http://localhost').searchParams.get('q')||'').trim();
    if(q.length<2)return send(res,400,{error:'Search at least 2 characters'},'application/json',origin);
    const u='https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=12&q='+encodeURIComponent(q)+'&key='+encodeURIComponent(YOUTUBE_API_KEY);
    const rr=await fetch(u); const d=await rr.json();
    if(!rr.ok)return send(res,rr.status,{error:d?.error?.message||'YouTube search failed'},'application/json',origin);
    const items=(d.items||[]).map(it=>({videoId:it.id?.videoId||'',title:it.snippet?.title||'',channel:it.snippet?.channelTitle||'',thumbnail:it.snippet?.thumbnails?.medium?.url||it.snippet?.thumbnails?.default?.url||''})).filter(x=>x.videoId);
    return send(res,200,{items},'application/json',origin);
  }
  if(req.method==='GET'&&p==='/api/admin/data'){if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);return send(res,200,{orders:db.orders,newsletter:db.newsletter,products:db.products.map(safeProduct),users:db.users.map(u=>({id:u.id,name:u.name,email:u.email,phone:u.phone||'',createdAt:u.createdAt})),reviews:db.reviews,coupons:db.coupons,returns:db.returns,notifications:db.notifications,audit:db.audit,settings:db.settings,site:db.site,music:db.music||{}},'application/json',origin)}
  if(req.method==='GET'&&p==='/api/admin/settings'){if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);return send(res,200,{settings:db.settings},'application/json',origin)}
  if(req.method==='PATCH'&&p==='/api/admin/settings'){if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);const x=await body(req);db.settings={...db.settings,...x};audit('settings.update');save(db);return send(res,200,{ok:true,settings:db.settings},'application/json',origin)}

  if(req.method==='GET'&&p==='/api/admin/slip-data'){if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);return send(res,200,{settings:db.slip.settings,orders:db.slip.orders},'application/json',origin)}
  if(req.method==='PATCH'&&p==='/api/admin/slip-settings'){
    if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);
    const x=await body(req),n={};
    for(const k in SLIP_SET)if(x[k]!==undefined)n[k]=cleanStr(x[k],SLIP_SET[k]);
    for(const k of ['returnUrl','trackUrl'])if(n[k]&&!/^https?:\/\//i.test(n[k]))return send(res,400,{error:k+' must start with http:// or https://'},'application/json',origin);
    if(x.lang!==undefined)n.lang=['en','hi'].includes(x.lang)?x.lang:'en';
    if(x.badges!==undefined)n.badges=Boolean(x.badges);
    if(x.logo!==undefined){const l=String(x.logo||'');if(l&&(!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(l)||l.length>400000))return send(res,400,{error:'Logo must be a PNG/JPG/WEBP image under 300 KB'},'application/json',origin);n.logo=l}
    db.slip.settings={...db.slip.settings,...n};audit('slip.settings.update',{fields:Object.keys(n)});await saveAndFlush(db);
    return send(res,200,{ok:true,settings:db.slip.settings},'application/json',origin);
  }
  if(req.method==='POST'&&p==='/api/admin/slip-print'){
    if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);
    const x=await body(req),f=x.kind==='label'?'labelPrints':'slipPrints',out={};
    for(const id of (Array.isArray(x.ids)?x.ids:[]).slice(0,200).map(String)){if(!db.orders.some(v=>v.orderId===id))continue;const cur=db.slip.orders[id]||(db.slip.orders[id]={});cur[f]=Math.min(1e6,(cur[f]||0)+1);out[id]={slipPrints:cur.slipPrints||0,labelPrints:cur.labelPrints||0}}
    await saveAndFlush(db);return send(res,200,{ok:true,counts:out},'application/json',origin);
  }
  if(req.method==='PATCH'&&p.startsWith('/api/admin/orders/')){if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);const id=decodeURIComponent(p.slice('/api/admin/orders/'.length)),x=await body(req),o=db.orders.find(v=>v.orderId===id);if(!o)return send(res,404,{error:'Order not found'},'application/json',origin);if(x.status!==undefined&&!STATUSES.includes(x.status))return send(res,400,{error:'Invalid order status'},'application/json',origin);for(const k of ['status','awb','courier','tracking_url','verified'])if(x[k]!==undefined)o[k]=x[k];applySlipOptions(id,x);audit('order.update',{orderId:id,fields:Object.keys(x)});await saveAndFlush(db);return send(res,200,{...o,...(db.slip.orders[id]||{})},'application/json',origin)}
  if(req.method==='DELETE'&&p.startsWith('/api/admin/orders/')){if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);const id=decodeURIComponent(p.slice('/api/admin/orders/'.length)),i=db.orders.findIndex(v=>v.orderId===id);if(i<0)return send(res,404,{error:'Order not found'},'application/json',origin);db.orders.splice(i,1);delete db.slip.orders[id];audit('order.delete',{orderId:id});await saveAndFlush(db);return send(res,200,{ok:true},'application/json',origin)}

  if(req.method==='PATCH'&&p.startsWith('/api/admin/reviews/')){if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);const id=decodeURIComponent(p.slice('/api/admin/reviews/'.length)),x=await body(req),r=db.reviews.find(v=>v.id===id);if(!r)return send(res,404,{error:'Review not found'},'application/json',origin);if(x.status!==undefined&&['pending','approved','rejected'].includes(x.status))r.status=x.status;if(x.reply!==undefined)r.reply=String(x.reply);audit('review.update',{id});await saveAndFlush(db);return send(res,200,r,'application/json',origin)}
  if(req.method==='DELETE'&&p.startsWith('/api/admin/reviews/')){if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);const id=decodeURIComponent(p.slice('/api/admin/reviews/'.length)),n=db.reviews.length;db.reviews=db.reviews.filter(v=>v.id!==id);if(n===db.reviews.length)return send(res,404,{error:'Review not found'},'application/json',origin);audit('review.delete',{id});await saveAndFlush(db);return send(res,200,{ok:true},'application/json',origin)}

  if(req.method==='PATCH'&&p.startsWith('/api/admin/users/')){if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);const id=decodeURIComponent(p.slice('/api/admin/users/'.length)),x=await body(req),u=db.users.find(v=>v.id===id);if(!u)return send(res,404,{error:'Customer not found'},'application/json',origin);['name','phone'].forEach(k=>{if(x[k]!==undefined)u[k]=String(x[k])});audit('customer.update',{id});await saveAndFlush(db);return send(res,200,{id:u.id,name:u.name,email:u.email,phone:u.phone||''},'application/json',origin)}
  if(req.method==='DELETE'&&p.startsWith('/api/admin/users/')){if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);const id=decodeURIComponent(p.slice('/api/admin/users/'.length)),n=db.users.length;db.users=db.users.filter(v=>v.id!==id);if(n===db.users.length)return send(res,404,{error:'Customer not found'},'application/json',origin);db.orders.forEach(o=>{if(o.userId===id)o.userId=null});audit('customer.delete',{id});await saveAndFlush(db);return send(res,200,{ok:true},'application/json',origin)}

  if(req.method==='POST'&&p==='/api/admin/products/bulk'){if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);const x=await body(req),ids=Array.isArray(x.ids)?x.ids.map(String):[],action=String(x.action||'');if(!ids.length||!['show','hide','delete'].includes(action))return send(res,400,{error:'Invalid bulk action'},'application/json',origin);if(action==='delete'){db.products=db.products.filter(p=>!ids.includes(String(p.id)));db.deletedProductIds=Array.isArray(db.deletedProductIds)?db.deletedProductIds:[];for(const id of ids)if(!db.deletedProductIds.includes(id))db.deletedProductIds.push(id);}else db.products.forEach(p=>{if(ids.includes(String(p.id)))p.active=action==='show'});audit('products.bulk',{action,ids});await saveAndFlush(db);return send(res,200,{ok:true},'application/json',origin)}
  if(req.method==='POST'&&p==='/api/admin/upload'){
   if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);
   const x=await body(req),name=path.basename(String(x.name||'')).replace(/[^a-zA-Z0-9._-]/g,'_'),data=String(x.data||'');
   const m=data.match(/^data:(image\/(?:png|jpeg|webp)|video\/(?:mp4|webm));base64,(.+)$/);
   if(!name||!m)return send(res,400,{error:'Valid PNG, JPG, WEBP, MP4 or WEBM media data is required'},'application/json',origin);
   const buf=Buffer.from(m[2],'base64'),isVideo=m[1].startsWith('video/'),max=isVideo?30*1024*1024:5*1024*1024;
   if(buf.length>max)return send(res,413,{error:(isVideo?'Video':'Image')+' must be '+(isVideo?'30MB':'5MB')+' or smaller'},'application/json',origin);
   const extMap={'image/jpeg':'.jpg','image/webp':'.webp','image/png':'.png','video/mp4':'.mp4','video/webm':'.webm'};
   const ext=extMap[m[1]]||path.extname(name).toLowerCase()||'.bin',base=path.basename(name,path.extname(name))||'media';
   const filename=base.replace(/[^a-zA-Z0-9._-]/g,'_')+'-'+crypto.randomBytes(4).toString('hex')+ext;
   let url='/uploads/'+encodeURIComponent(filename);
   if(supabaseStore.enabled){
     const remote=await supabaseStore.uploadMedia(buf,'products/'+filename,m[1]);
     url=remote.url;
     // Keep a temporary local copy for immediate local serving, but the product always stores the persistent Supabase URL.
     fs.writeFileSync(path.join(UPLOADS,filename),buf);
   }else{
     fs.writeFileSync(path.join(UPLOADS,filename),buf);
   }
   audit('upload',{filename,type:m[1],size:buf.length,url});
   await saveAndFlush(db);
   return send(res,201,{ok:true,filename,url,type:m[1],size:buf.length,persistent:Boolean(supabaseStore.enabled)},'application/json',origin);
  }
  if(req.method==='GET'&&p.startsWith('/uploads/')){const filename=path.basename(decodeURIComponent(p.slice('/uploads/'.length))),file=path.join(UPLOADS,filename);if(!fs.existsSync(file)||fs.statSync(file).isDirectory())return send(res,404,'Not found','text/plain',origin);return send(res,200,fs.readFileSync(file),mime[path.extname(file).toLowerCase()]||'application/octet-stream',origin)}

  if(req.method==='POST'&&p==='/api/admin/products'){if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);const x=await body(req);const image=String(x.image||((x.images||[])[0]||''));if(!String(x.name||'').trim()||priceNumber(x.price)<=0||!image)return send(res,400,{error:'Name, price and image are required'},'application/json',origin);const pr=safeProduct({...x,id:'p_'+crypto.randomBytes(6).toString('hex'),image,sizes:cleanSizes(x.sizes)});db.products.push(pr);audit('product.create',{id:pr.id});await saveAndFlush(db);return send(res,201,pr,'application/json',origin)}
  if(req.method==='PATCH'&&p.startsWith('/api/admin/products/')){if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);const id=decodeURIComponent(p.slice('/api/admin/products/'.length)),x=await body(req),i=db.products.findIndex(v=>String(v.id)===id);if(i<0)return send(res,404,{error:'Product not found'},'application/json',origin);const current=db.products[i],merged={...current,...x,id:current.id,image:String(x.image||((Array.isArray(x.images)&&x.images[0])||current.image)),sizes:x.sizes?cleanSizes(x.sizes):cleanSizes(current.sizes)};if(!merged.name||priceNumber(merged.price)<=0||!merged.image)return send(res,400,{error:'Name, price and image are required'},'application/json',origin);db.products[i]=safeProduct(merged);audit('product.update',{id});await saveAndFlush(db);return send(res,200,db.products[i],'application/json',origin)}
  if(req.method==='DELETE'&&p.startsWith('/api/admin/products/')){if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);const id=decodeURIComponent(p.slice('/api/admin/products/'.length)),i=db.products.findIndex(v=>String(v.id)===id);if(i<0)return send(res,404,{error:'Product not found'},'application/json',origin);db.products.splice(i,1);db.deletedProductIds=Array.isArray(db.deletedProductIds)?db.deletedProductIds:[];if(!db.deletedProductIds.includes(id))db.deletedProductIds.push(id);audit('product.delete',{id});await saveAndFlush(db);return send(res,200,{ok:true},'application/json',origin)}

  if(req.method==='POST'&&p==='/api/admin/coupons'){if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);const x=await body(req),code=String(x.code||'').trim().toUpperCase(),value=Number(x.value||0),minOrder=Math.max(0,Number(x.minOrder||0)),maxDiscount=Math.max(0,Number(x.maxDiscount||0));if(!/^[A-Z0-9_-]{3,40}$/.test(code))return send(res,400,{error:'Coupon code must be 3-40 characters (letters, numbers, - or _ only)'},'application/json',origin);if(!(value>0)||value>100)return send(res,400,{error:'Discount must be between 1 and 100 percent'},'application/json',origin);if(db.coupons.some(c=>String(c.code).toUpperCase()===code))return send(res,409,{error:'Coupon already exists'},'application/json',origin);const c={id:'c_'+crypto.randomBytes(6).toString('hex'),code,type:'percent',value,minOrder,maxDiscount,expiresAt:x.expiresAt||null,active:x.active!==false,createdAt:new Date().toISOString()};db.coupons.push(c);audit('coupon.create',{id:c.id});await saveAndFlush(db);return send(res,201,c,'application/json',origin)}
  if(req.method==='PATCH'&&p.startsWith('/api/admin/coupons/')){if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);const id=decodeURIComponent(p.slice('/api/admin/coupons/'.length)),x=await body(req),c=db.coupons.find(v=>v.id===id);if(!c)return send(res,404,{error:'Coupon not found'},'application/json',origin);if(x.code!==undefined)c.code=String(x.code).trim().toUpperCase();if(x.value!==undefined)c.value=Math.min(100,Math.max(0,Number(x.value||0)));if(x.minOrder!==undefined)c.minOrder=Math.max(0,Number(x.minOrder||0));if(x.maxDiscount!==undefined)c.maxDiscount=Math.max(0,Number(x.maxDiscount||0));if(x.expiresAt!==undefined)c.expiresAt=x.expiresAt||null;if(x.active!==undefined)c.active=Boolean(x.active);audit('coupon.update',{id});await saveAndFlush(db);return send(res,200,c,'application/json',origin)}
  if(req.method==='DELETE'&&p.startsWith('/api/admin/coupons/')){if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);const id=decodeURIComponent(p.slice('/api/admin/coupons/'.length)),n=db.coupons.length;db.coupons=db.coupons.filter(v=>v.id!==id);if(n===db.coupons.length)return send(res,404,{error:'Coupon not found'},'application/json',origin);audit('coupon.delete',{id});await saveAndFlush(db);return send(res,200,{ok:true},'application/json',origin)}
  if(req.method==='POST'&&p==='/api/coupons/validate'){const x=await body(req),code=String(x.code||'').trim().toUpperCase(),subtotal=Math.max(0,Number(x.subtotal||0));if(!code)return send(res,400,{error:'Enter a coupon code'},'application/json',origin);const c=db.coupons.find(v=>String(v.code).toUpperCase()===code);if(!c||c.active===false)return send(res,404,{error:'Invalid or inactive coupon'},'application/json',origin);if(c.expiresAt&&new Date(c.expiresAt).getTime()<Date.now())return send(res,400,{error:'This coupon has expired'},'application/json',origin);if(subtotal<Number(c.minOrder||0))return send(res,400,{error:'Minimum order of ₹'+Number(c.minOrder||0)+' required for this coupon'},'application/json',origin);let discount=Math.round(subtotal*Number(c.value||0)/100);if(Number(c.maxDiscount||0)>0)discount=Math.min(discount,Number(c.maxDiscount));discount=Math.min(discount,subtotal);return send(res,200,{ok:true,code:c.code,discount,value:c.value},'application/json',origin)}

  if(req.method==='PATCH'&&p.startsWith('/api/admin/returns/')){if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);const id=decodeURIComponent(p.slice('/api/admin/returns/'.length)),x=await body(req),r=db.returns.find(v=>String(v.id)===id);if(!r)return send(res,404,{error:'Return not found'},'application/json',origin);if(x.status!==undefined)r.status=String(x.status);if(x.refundAmount!==undefined)r.refundAmount=Math.max(0,Number(x.refundAmount||0));audit('return.update',{id});await saveAndFlush(db);return send(res,200,r,'application/json',origin)}


  // FULL WEBSITE CONTROL compatibility endpoints
  if(req.method==='PATCH'&&p==='/api/admin/store-settings'){
    if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);
    const x=await body(req);db.site.store={...(db.site.store||{}),name:String(x.name||'YOUR TYPE'),phone:String(x.phone||''),whatsapp:String(x.whatsapp||''),email:String(x.email||''),address:String(x.address||''),currency:String(x.currency||'INR')};audit('store.settings.update');await saveAndFlush(db);return send(res,200,{ok:true,store:db.site.store},'application/json',origin);
  }
  if(req.method==='PATCH'&&p==='/api/admin/categories'){
    if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);
    const x=await body(req);
    const categories=Array.isArray(x.categories)?[...new Set(x.categories.map(v=>String(v).trim()).filter(Boolean))]:[];
    db.site.categories=categories;
    audit('categories.update',{count:categories.length});await saveAndFlush(db);
    return send(res,200,{ok:true,categories:db.site.categories},'application/json',origin);
  }
  if(req.method==='PATCH'&&p==='/api/admin/site-content'){
    if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);
    const x=await body(req);
    const trendCardImages=Array.from({length:3},(_,i)=>String((Array.isArray(x.trendCardImages)?x.trendCardImages[i]:'')||'').trim());
    db.site.content={...(db.site.content||{}),banner:String(x.banner||''),bannerButton:String(x.bannerButton||''),bannerLink:String(x.bannerLink||''),editorialImage:String(x.editorialImage||''),trendCardImages};
    audit('site.content.update');await saveAndFlush(db);return send(res,200,{ok:true,content:db.site.content},'application/json',origin);
  }
  if(req.method==='GET'&&p==='/api/admin/media'){
    if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);
    if(supabaseStore.enabled){const media=await supabaseStore.listMedia();return send(res,200,{media},'application/json',origin)}
    const media=fs.readdirSync(UPLOADS,{withFileTypes:true}).filter(e=>e.isFile()).map(e=>{const file=path.join(UPLOADS,e.name),st=fs.statSync(file),ext=path.extname(e.name).toLowerCase();const type=mime[ext]||'application/octet-stream';return {name:e.name,size:st.size,type,updatedAt:st.mtime.toISOString(),url:'/uploads/'+encodeURIComponent(e.name)}}).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
    return send(res,200,{media},'application/json',origin);
  }
  if(req.method==='DELETE'&&p.startsWith('/api/admin/media/')){
    if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);
    const name=decodeURIComponent(p.slice('/api/admin/media/'.length));
    if(supabaseStore.enabled){
      await supabaseStore.deleteMedia('products/'+path.basename(name));
      const local=path.join(UPLOADS,path.basename(name));if(fs.existsSync(local))fs.unlinkSync(local);
      audit('media.delete',{name});await saveAndFlush(db);return send(res,200,{ok:true},'application/json',origin);
    }
    const localName=path.basename(name),file=path.join(UPLOADS,localName);if(!fs.existsSync(file)||!fs.statSync(file).isFile())return send(res,404,{error:'Media not found'},'application/json',origin);fs.unlinkSync(file);audit('media.delete',{name:localName});save(db);return send(res,200,{ok:true},'application/json',origin);
  }
  if(req.method==='GET'&&p==='/api/admin/backup'){
    if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);
    const backup={version:1,createdAt:new Date().toISOString(),orders:db.orders,newsletter:db.newsletter,users:db.users.map(u=>({...u,password:undefined})),products:db.products,coupons:db.coupons,returns:db.returns,notifications:db.notifications,settings:db.settings,site:db.site,slip:db.slip,deletedProductIds:db.deletedProductIds||[]};audit('backup.download');await saveAndFlush(db);return send(res,200,backup,'application/json',origin);
  }
  if(req.method==='POST'&&p==='/api/admin/restore'){
    if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);
    const x=await body(req);if(x.confirm!=='RESTORE_YOUR_TYPE'||!x.backup||typeof x.backup!=='object')return send(res,400,{error:'Valid restore confirmation and backup are required'},'application/json',origin);
    const b=x.backup;if(b.slip&&typeof b.slip==='object'&&b.slip.orders&&typeof b.slip.orders==='object')db.slip={settings:(b.slip.settings&&typeof b.slip.settings==='object')?b.slip.settings:{},orders:b.slip.orders};db.orders=Array.isArray(b.orders)?b.orders:db.orders;db.newsletter=Array.isArray(b.newsletter)?b.newsletter:db.newsletter;db.users=Array.isArray(b.users)?b.users:db.users;const restoreDeleted=new Set([...(db.deletedProductIds||[]).map(String),...((b.deletedProductIds||[]).map(String))]);db.deletedProductIds=[...restoreDeleted];db.products=Array.isArray(b.products)?b.products.filter(p=>!restoreDeleted.has(String(p.id))):db.products.filter(p=>!restoreDeleted.has(String(p.id)));db.coupons=Array.isArray(b.coupons)?b.coupons:db.coupons;db.returns=Array.isArray(b.returns)?b.returns:db.returns;db.notifications=Array.isArray(b.notifications)?b.notifications:db.notifications;db.settings={...(db.settings||{}),...(b.settings||{})};db.site={...(db.site||{}),...(b.site||{})};db.sessions ||= {};audit('backup.restore');await saveAndFlush(db);return send(res,200,{ok:true},'application/json',origin);
  }
  if(req.method==='POST'&&p==='/api/admin/notifications/test'){
    if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);
    audit('notification.test');await saveAndFlush(db);return send(res,200,{ok:true,message:'Notification test recorded. Configure a real provider/webhook to deliver externally.'},'application/json',origin);
  }
  if(req.method==='POST'&&p==='/api/admin/reset-role'){
    if(!auth(req,'admin'))return send(res,401,{error:'Unauthorized'},'application/json',origin);
    const x=await body(req);if(!verifyAdminPassword(String(x.currentPassword||'')))return send(res,401,{error:'Current password is incorrect'},'application/json',origin);db.settings.role='Super Admin';audit('admin.role.reset');await saveAndFlush(db);return send(res,200,{ok:true,role:'Super Admin'},'application/json',origin);
  }
  return send(res,404,{error:'Not found'},'application/json',origin);
 }catch(e){console.error(e);return send(res,500,{error:'Server error'},'application/json',origin)}
}

const server=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://localhost'),p=u.pathname;
 if(p.startsWith('/api/')||p.startsWith('/uploads/'))return api(req,res,p);
 const file=path.normalize(path.join(ROOT,p==='/'?'index.html':p));
 if(!file.startsWith(ROOT)||!fs.existsSync(file)||fs.statSync(file).isDirectory())return send(res,404,'Not found','text/plain');
 try{const ext=path.extname(file).toLowerCase();res.writeHead(200,{'Content-Type':mime[ext]||'application/octet-stream','Cache-Control':'no-store'});res.end(fs.readFileSync(file))}catch{send(res,404,'Not found','text/plain')}
});
async function bootstrap(){
  try{
    if(supabaseStore.enabled){
      await supabaseStore.hydrateDb(db,{preserveDeletedIds:[...localDeletedProductIds]});
      // Re-apply local tombstones after hydration. Do not perform a destructive full-table rewrite during startup.
      // Normal admin/customer writes are flushed explicitly after successful API operations.
      db.deletedProductIds=[...new Set([...(db.deletedProductIds||[]).map(String),...localDeletedProductIds])];
      db.products=db.products.filter(p=>!db.deletedProductIds.includes(String(p.id)));
    }
    storageReady=true;
    writeDataFile(db);
    server.listen(PORT,()=>console.log(`YOUR TYPE running at http://localhost:${PORT}`));
  }catch(e){
    console.error('[Storage] Startup failed:',e.message||e);
    process.exit(1);
  }
}
bootstrap();
