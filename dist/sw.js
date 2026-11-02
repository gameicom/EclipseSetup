self.addEventListener('install',event=>{event.waitUntil(self.skipWaiting());});
self.addEventListener('activate',event=>{event.waitUntil(self.clients.claim());});
self.addEventListener('push',event=>{
  let payload={};
  try {payload=event.data?.json() || {};} catch {}
  const root=self.registration.scope;
  event.waitUntil(self.registration.showNotification(
    typeof payload.title==='string' ? payload.title : '이클립스 보스타이머',
    {body:typeof payload.body==='string' ? payload.body : '리젠 시간을 확인해 주세요.',
     icon:new URL('assets/push-192.png',root).href,
     badge:new URL('assets/push-192.png',root).href,
     tag:typeof payload.tag==='string' ? payload.tag : 'eclipse-timer',
     data:{url:root},timestamp:Number(payload.timestamp)||Date.now()}
  ));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const root=self.registration.scope;
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of windows) if(client.url.startsWith(root) && 'focus' in client) return client.focus();
    return self.clients.openWindow(root);
  })());
});
