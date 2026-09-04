const CACHE='url-format-shisa-v7-calculator';
const CORE=[
  './',
  './index.html',
  './manifest.webmanifest',
  './shisa-maskable.png',
  './link-1-transparent.png',
  './link-2-transparent.png',
  './link-3-transparent.png',
  './link-4-transparent.png',
  './calculator-mascot.png'
];
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(CORE)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))))
      .then(()=>self.clients.claim())
  );
});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  event.respondWith(
    fetch(event.request).then(response=>{
      const copy=response.clone();
      caches.open(CACHE).then(cache=>cache.put(event.request,copy));
      return response;
    }).catch(()=>caches.match(event.request).then(response=>response||caches.match('./index.html')))
  );
});
