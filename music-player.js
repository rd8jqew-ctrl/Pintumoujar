(function(){
  if(window.__PINTUMOUJAR_MUSIC_PLAYER__) return;
  window.__PINTUMOUJAR_MUSIC_PLAYER__=true;

  const ADMIN_PATH = location.pathname.endsWith('/admin.html') || location.pathname === '/admin';
  const PLAYER_ID='ytLiveMusic';
  const RESUME_KEY='pintumoujar_music_resume_v4';
  let last='';
  let ytPlayer=null;
  let ytApiPromise=null;
  let resumeTimer=null;
  let routing=false;

  function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  function getResume(){try{return JSON.parse(localStorage.getItem(RESUME_KEY)||'null')}catch(_){return null}}
  function saveResume(){
    try{
      if(!ytPlayer?.getCurrentTime)return;
      const videoId=String(document.querySelector('#'+PLAYER_ID)?.dataset.videoId||window.__PINTUMOUJAR_TRANSFER_VIDEO__||'');
      if(!videoId)return;
      const time=Number(ytPlayer.getCurrentTime()||0);
      if(!Number.isFinite(time))return;
      const state=ytPlayer.getPlayerState?.();
      localStorage.setItem(RESUME_KEY,JSON.stringify({videoId,time,playing:state===1,updatedAt:Date.now()}));
    }catch(_){ }
  }
  function loadYTApi(){
    if(window.YT?.Player)return Promise.resolve(window.YT);
    if(ytApiPromise)return ytApiPromise;
    ytApiPromise=new Promise(resolve=>{
      const old=window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady=function(){try{old&&old()}catch(_){} resolve(window.YT)};
      if(!document.querySelector('script[data-pintumoujar-yt-api]')){
        const sc=document.createElement('script');sc.src='https://www.youtube.com/iframe_api';sc.async=true;sc.dataset.pintumoujarYtApi='1';document.head.appendChild(sc);
      }
    });
    return ytApiPromise;
  }
  function player(){return document.getElementById(PLAYER_ID)}

  function bindPlayer(frame,videoId){
    loadYTApi().then(YT=>{
      if(!frame?.isConnected)return;
      try{
        ytPlayer=new YT.Player(frame,{
          events:{
            onReady:function(ev){
              const r=getResume();
              if(r?.videoId===videoId && Number(r.time)>1){try{ev.target.seekTo(Number(r.time),true)}catch(_){} }
              // Try autoplay for visitors/admin transfer. Browser policy may still require one tap.
              try{ev.target.playVideo()}catch(_){}
              updateOverlay();
            },
            onStateChange:function(ev){
              saveResume();
              updateOverlay();
              if(ev.data===YT.PlayerState.PLAYING){
                document.querySelectorAll('audio,video').forEach(v=>{try{v.pause()}catch(_){} });
              }
            }
          }
        });
        if(resumeTimer)clearInterval(resumeTimer);
        resumeTimer=setInterval(saveResume,800);
      }catch(_){ }
    });
  }

  function updateOverlay(){
    const el=player(); if(!el)return;
    const btn=el.querySelector('.ytm-overlay-play');
    const hint=el.querySelector('.ytm-overlay-hint');
    let state=-1; try{state=ytPlayer?.getPlayerState?.()??-1}catch(_){ }
    if(btn)btn.textContent=state===1?'❚❚':'▶';
    if(hint)hint.textContent=state===1?'Playing here':'Tap to play here';
  }

  function makePlayerShell(m, iframe){
    const el=document.createElement('div');
    el.id=PLAYER_ID;
    el.dataset.videoId=String(m.videoId||'');
    el.innerHTML='<div class="ytm-inner"><img class="ytm-art" src="'+esc(m.thumbnail||('https://i.ytimg.com/vi/'+m.videoId+'/hqdefault.jpg'))+'" alt="'+esc(m.title||'Live Music')+'"><div><div class="ytm-title">'+esc(m.title||'Live Music')+'</div><div class="ytm-channel">'+esc(m.channel||'YouTube')+' · LIVE NOW</div></div><div class="ytm-controls"><button class="ytm-play" aria-label="Play or pause">▶</button><button class="ytm-expand" aria-label="Show video">↗</button></div></div><div class="ytm-frame"></div><div class="ytm-overlay" aria-label="Play music here"><div class="ytm-overlay-card"><button class="ytm-overlay-play" type="button">▶</button><b>'+esc(m.title||'Live Music')+'</b><span class="ytm-overlay-hint">Tap to play here</span></div></div>';
    el.querySelector('.ytm-frame').appendChild(iframe);
    document.documentElement.appendChild(el);
    const toggle=()=>{try{if(ytPlayer?.getPlayerState?.()===1)ytPlayer.pauseVideo();else ytPlayer?.playVideo()}catch(_){} updateOverlay()};
    el.querySelector('.ytm-play').onclick=toggle;
    el.querySelector('.ytm-overlay').onclick=e=>{e.preventDefault();e.stopPropagation();toggle()};
    el.querySelector('.ytm-overlay').onpointerdown=e=>{e.stopPropagation()};
    el.querySelector('.ytm-expand').onclick=e=>{e.preventDefault();e.stopPropagation();el.classList.toggle('expanded')};
    updateOverlay();
    return el;
  }

  function removePublicPlayer(){
    saveResume();
    try{ytPlayer?.destroy?.()}catch(_){ }
    ytPlayer=null;
    if(resumeTimer){clearInterval(resumeTimer);resumeTimer=null;}
    player()?.remove();
  }

  function renderPublic(m){
    removePublicPlayer();
    const iframe=document.createElement('iframe');
    const r=getResume();
    const start=(r?.videoId===String(m.videoId)&&Number(r.time)>1)?Math.floor(Number(r.time)):0;
    iframe.src='https://www.youtube-nocookie.com/embed/'+encodeURIComponent(m.videoId)+'?playsinline=1&rel=0&modestbranding=1&autoplay=1&enablejsapi=1&controls=1'+(start?'&start='+start:'');
    iframe.title=m.title||'Live Music';
    iframe.allow='autoplay; encrypted-media; picture-in-picture; web-share';
    iframe.allowFullscreen=true;
    iframe.setAttribute('tabindex','-1');
    iframe.setAttribute('aria-hidden','true');
    const el=makePlayerShell(m,iframe);
    last=String(m.videoId);
    bindPlayer(iframe,String(m.videoId));
    return el;
  }

  async function loadPublic(){
    try{
      const r=await fetch('/api/music/current',{cache:'no-store'}); if(!r.ok)return;
      const m=await r.json();
      if(!m.active||!m.videoId){removePublicPlayer();last='';return}
      if(player()?.dataset.videoId===String(m.videoId)){last=String(m.videoId);return}
      renderPublic(m);
    }catch(_){ }
  }

  // Kept for compatibility with older admin markup; normal page navigation no longer moves DOM nodes.
  // Navigation note:
  // Do NOT hijack the storefront navigation and rebuild document.body here.
  // The old SPA approach caused the storefront theme/layout scripts to run in
  // the wrong document and made the page look like a different theme.
  // Normal browser navigation keeps every page's original layout intact.
  // The music position is persisted in localStorage so the new page resumes
  // the same song instead of starting from zero.
  function isInternalPage(url){
    try{
      const u=new URL(url,location.href);
      return u.origin===location.origin && !u.pathname.startsWith('/api/');
    }catch(_){return false}
  }

  async function navigate(url,push=true){
    const target=new URL(url,location.href);
    if(target.origin!==location.origin)return;
    saveResume();
    if(push) history.pushState({},'',target.href);
    location.href=target.href;
  }

  window.ytGoStore=function(){saveResume();location.href='/'};
  window.ytNavigate=navigate;

  // Never intercept normal storefront links. This is important: every page
  // must load with its own original HTML/CSS/JS so the YOUR TYPE theme cannot
  // be altered by the music system.
  window.addEventListener('pagehide',saveResume);
  window.addEventListener('beforeunload',saveResume);
  window.addEventListener('pintumoujar:music-live-changed',e=>{if(!ADMIN_PATH){last='';if(e.detail?.active&&e.detail.videoId)renderPublic(e.detail);else removePublicPlayer()}});

  if(ADMIN_PATH){
    // Admin's inline player remains the only player until Store is pressed.
    // The Store button calls ytGoStore(), which transfers that iframe intact.
  }else{
    loadPublic();
    setInterval(loadPublic,15000);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)loadPublic()});
  }
})();
