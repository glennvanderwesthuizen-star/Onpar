// On Par's alert receiver. The browser runs this in the background, even when On Par is closed,
// so an alert can be shown on the phone. It keeps no copies of pages or data.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// An alert arrived. It carries only a general line; the details are shown inside On Par after sign-in.
self.addEventListener('push', (event) => {
  let alert = {};
  try {
    alert = event.data ? event.data.json() : {};
  } catch {
    alert = {};
  }
  event.waitUntil(
    self.registration.showNotification(alert.title || 'On Par', {
      body: alert.body || 'You have a new alert.',
      tag: alert.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: typeof alert.url === 'string' && alert.url.startsWith('/') && !alert.url.startsWith('//') ? alert.url : '/alerts' },
    }),
  );
});

// The alert was tapped: bring On Par to the front on the right page (signing in first if needed).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/alerts', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
      for (const w of windows) {
        if ('navigate' in w && 'focus' in w) {
          try {
            await w.navigate(url);
            return w.focus();
          } catch {
            // Fall through to opening a new window.
          }
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
