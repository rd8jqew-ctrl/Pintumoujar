(function(){
  // Admin has its own inline player inside the Live Music section. Do not create
  // a second floating iframe there; two YouTube iframes can play simultaneously.
  if(location.pathname.endsWith('/admin.html') || location.pathname==='/admin') return;
  if(window.__PINTUMOUJAR_MUSIC_PLAYER__) return;
  window.__PINTUMOUJAR_MUSIC_PLAYER__=true;
  // Persistent site-wide YouTube player + SPA-style navigation.
  // The player is moved outside <body>, so changing public pages does not destroy
  // the YouTube iframe. Internal navigation is handled without a full reload.
  let last='';
  let routing=false;
  let ytPlayer=null;
  let ytApiPromise=null;
  let resumeTimer=null;
  const PLAYER_ID='ytLiveMusic';
  const RESUME_KEY='pintumoujar_music_resume_v2';

  function getResume(){try{return JSON.parse(sessionStorage.getItem(RESUME_KEY)||'null')}catch(_){return null}}
  function saveResume(force=false){
    try{
      if(!ytPlayer||!ytPlayer.getCurrentTime)return;
      const videoId=String(player()?.dataset.videoId||''); if(!videoId)return;
      const state=ytPlayer.getPlayerState?.();
      const time=Number(ytPlayer.getCurrentTime()||0);
      if(!Number.isFinite(time))return;
      const old=getResume();
      sessionStorage.setItem(RESUME_KEY,JSON.stringify({videoId,time,playing:state===1,updatedAt:Date.now()}));
    }catch(_){}
  }
  function loadYTApi(){
    if(window.YT&&window.YT.Player)return Promise.resolve(window.YT);
    if(ytApiPromise)return ytApiPromise;
    ytApiPromise=new Promise(resolve=>{
      const old=window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady=function(){try{old&&old()}catch(_){} resolve(window.YT)};
      if(!document.querySelector('script[data-pintumoujar-yt-api]')){
        const sc=document.createElement('script');sc.src='https://www.youtube.com/iframe_api';sc.async=true;sc.setAttribute('data-pintumoujar-yt-api','1');document.head.appendChild(sc);
      }
    });
    return ytApiPromise;
  }
  function bindYT(el,videoId){
    loadYTApi().then(YT=>{
      if(!el.isConnected)return;
      try{
        ytPlayer=new YT.Player(el,{
          events:{
            onReady:function(ev){
              const r=getResume();
              if(r&&r.videoId===videoId&&Number(r.time)>1){try{ev.target.seekTo(Math.max(0,Number(r.time)),true)}catch(_){}}
              if(r&&r.videoId===videoId&&r.playing){try{ev.target.playVideo()}catch(_){}}
            },
            onStateChange:function(ev){
              if(ev.data===YT.PlayerState.PLAYING||ev.data===YT.PlayerState.PAUSED||ev.data===YT.PlayerState.ENDED)saveResume(true);
            }
          }
        });
        if(resumeTimer)clearInterval(resumeTimer);
        resumeTimer=setInterval(saveResume,700);
      }catch(_){}
    });
  }

  function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  function player(){return document.getElementById(PLAYER_ID)}

  async function load(){
    try{
      const r=await fetch('/api/music/current',{cache:'no-store'});
      if(!r.ok)return;
      const m=await r.json();
      if(!m.active||!m.videoId){remove();return}
      if(last===m.videoId&&player())return;
      if(player() && player().dataset.videoId===String(m.videoId)){ last=m.videoId; return; }
      last=m.videoId;
      render(m);
    }catch(_){}
  }

  function render(m){
    remove();
    // Only one public music iframe is ever allowed.
    document.querySelectorAll('#ytLiveMusic iframe').forEach((x,i)=>{if(i>0)x.remove()});
    const el=document.createElement('div');
    el.id=PLAYER_ID;
    el.dataset.videoId=String(m.videoId||'');
    el.innerHTML=`<div class="ytm-inner"><img class="ytm-art" src="${esc(m.thumbnail||('https://i.ytimg.com/vi/'+m.videoId+'/hqdefault.jpg'))}" data-video-id="${esc(m.videoId)}" alt="${esc(m.title||'Live Music')}" onerror="if(!this.dataset.fallback){this.dataset.fallback='1';this.src='https://i.ytimg.com/vi/'+encodeURIComponent(this.dataset.videoId)+'/0.jpg'}else{this.style.visibility='hidden'}"><div><div class="ytm-title">${esc(m.title||'Live Music')}</div><div class="ytm-channel">${esc(m.channel||'YouTube')} · LIVE NOW</div></div><div class="ytm-controls"><button class="ytm-play" aria-label="Play">▶</button><button class="ytm-expand" aria-label="Expand">↗</button></div></div><div class="ytm-frame"><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(m.videoId)}?playsinline=1&rel=0&modestbranding=1&enablejsapi=1" title="Live Music" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>`;
    // IMPORTANT: keep the player outside <body>. Route changes replace body content,
    // but this node and its iframe remain alive.
    document.documentElement.appendChild(el);
    const frame=el.querySelector('iframe');
    bindYT(frame,String(m.videoId));
    const play=el.querySelector('.ytm-play'), exp=el.querySelector('.ytm-expand');
    play.onclick=()=>{
      el.classList.add('expanded');
      play.textContent='■';
    };
    exp.onclick=()=>el.classList.toggle('expanded');
  }

  function remove(){
    saveResume(true);
    try{if(ytPlayer&&ytPlayer.destroy)ytPlayer.destroy()}catch(_){}
    ytPlayer=null;
    if(resumeTimer){clearInterval(resumeTimer);resumeTimer=null;}
    const el=player();if(el)el.remove();
  }

  function isInternalHtml(url){
    try{
      const u=new URL(url,location.href);
      return u.origin===location.origin && !u.pathname.startsWith('/api/') && !u.pathname.match(/\.(zip|pdf|jpg|jpeg|png|webp|gif|mp4|mp3|svg)$/i);
    }catch(_){return false}
  }

  function cleanHead(nextDoc){
    // Remove only route-specific head nodes from an earlier virtual page.
    document.head.querySelectorAll('[data-yt-route-head]').forEach(n=>n.remove());
    nextDoc.head.querySelectorAll('link[rel="stylesheet"],style').forEach(node=>{
      if(node.matches('style[data-yt-player-style]'))return;
      const copy=node.cloneNode(true);
      copy.setAttribute('data-yt-route-head','1');
      document.head.appendChild(copy);
    });
    const t=nextDoc.querySelector('title');
    if(t)document.title=t.textContent;
  }

  function runPageScripts(body){
    const scripts=[...body.querySelectorAll('script')];
    for(const oldScript of scripts){
      const src=oldScript.getAttribute('src')||'';
      if(src && /music-player\.js(?:\?|$)/i.test(src))continue;
      const s=document.createElement('script');
      for(const a of oldScript.attributes){if(a.name!=='src')s.setAttribute(a.name,a.value)}
      if(src)s.src=new URL(src,location.href).href;
      else {
        // Route scripts can be executed more than once during in-app navigation.
        // Use function-scoped var declarations to avoid global let/const redeclaration errors.
        s.textContent=(oldScript.textContent||'').replace(/\b(?:const|let)\b/g,'var');
      }
      document.body.appendChild(s);
    }
  }

  async function navigate(url, push=true){
    if(routing)return;
    const target=new URL(url,location.href);
    if(target.origin!==location.origin)return;
    if(target.pathname===location.pathname && target.search===location.search && target.hash){
      if(push)history.pushState({},'',target.href);
      requestAnimationFrame(()=>document.getElementById(decodeURIComponent(target.hash.slice(1)))?.scrollIntoView({behavior:'smooth'}));
      return;
    }
    routing=true;
    try{
      const r=await fetch(target.href,{cache:'no-store',headers:{'X-YT-SPA':'1'}});
      if(!r.ok){location.href=target.href;return}
      const html=await r.text();
      const doc=new DOMParser().parseFromString(html,'text/html');
      cleanHead(doc);
      // Keep the persistent player node alive by replacing only the body contents.
      document.body.innerHTML=doc.body.innerHTML;
      runPageScripts(document.body);
      // Re-run page lifecycle hooks for the newly inserted page.
      try{window.dispatchEvent(new Event('pageshow'));}catch(_){}
      try{document.dispatchEvent(new Event('DOMContentLoaded'));}catch(_){}
      if(push)history.pushState({},'',target.href);
      requestAnimationFrame(()=>{
        if(target.hash){
          const id=decodeURIComponent(target.hash.slice(1));
          document.getElementById(id)?.scrollIntoView({behavior:'smooth',block:'start'});
        }else window.scrollTo({top:0,behavior:'auto'});
      });
      // If the public page has changed while an admin page was open, refresh the
      // current live metadata without rebuilding the iframe when the video is same.
      load();
    }catch(_){
      location.href=target.href;
    }finally{routing=false}
  }

  window.ytNavigate=navigate;

  // Admin can change the live song instantly. Rebuild the player immediately
  // instead of waiting for the 15-second polling interval.
  window.addEventListener('pintumoujar:music-live-changed',function(e){
    const m=e.detail||{};
    if(m.active&&m.videoId){
      last='';
      render(m);
    }else{
      remove();
      last='';
    }
  });

  document.addEventListener('click',function(e){
    if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
    const a=e.target.closest('a[href]');
    if(!a||a.target==='_blank'||a.hasAttribute('download'))return;
    const href=a.getAttribute('href');
    if(!href||href.startsWith('mailto:')||href.startsWith('tel:')||href.startsWith('javascript:'))return;
    const u=new URL(href,location.href);
    if(u.origin!==location.origin)return;
    if(u.pathname===location.pathname && u.search===location.search && u.hash)return;
    if(!isInternalHtml(u.href))return;
    e.preventDefault();
    navigate(u.href,true);
  },true);

  window.addEventListener('popstate',()=>navigate(location.href,false));

  window.addEventListener('pagehide',()=>saveResume(true));
  window.addEventListener('beforeunload',()=>saveResume(true));
  load();
  setInterval(load,15000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)load()});
})();
