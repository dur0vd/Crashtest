// Build replaces this list with every local asset, including lazy chunks/fonts.
const PRECACHE = ['__PRECACHE__'];
const CACHE = 'crashtest-__CACHE_HASH__';
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(PRECACHE)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('crashtest-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);
  if(e.request.method!=='GET'||url.origin!==self.location.origin)return;
  // Cache only the build's explicit asset list. No projects, URL-shares, uploads.
  const relative='./'+url.pathname.slice(new URL('./',self.location).pathname.length);
  if(!PRECACHE.includes(relative))return;
  e.respondWith(caches.open(CACHE).then(cache=>cache.match(e.request,{ignoreVary:true})).then(cached=>cached||fetch(e.request)));
});
