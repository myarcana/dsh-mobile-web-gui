// The service worker. It exists for exactly one reason: a push message has to
// be received when no page is open, and only a service worker can do that.
//
// It deliberately does NOT cache anything. Caching here would be a second,
// invisible copy of the asset story the server already tells properly with
// digest-stamped immutable urls, and a stale-serving worker is the classic way
// a no-build app starts shipping last week's code with no way to clear it.
//
// It is served from the site root, not from /m/, because a worker's scope is
// limited to its own path: one served from /m/sw-abc123.js could only control
// /m/, which is not where the app lives. So this file is the one asset with a
// stable url, and the server marks it no-cache so a change is picked up.

// A notification the reader has not dismissed is replaced rather than stacked
// when the same session speaks again: `tag` is the session id, so a session
// that finishes twice leaves one notification, not two.
self.addEventListener('push', event => {
  // A push with no payload is a keepalive some services send. Nothing to show.
  if (!event.data) return
  let notice
  try {
    notice = event.data.json()
  } catch (error) {
    return
  }
  if (!notice || typeof notice.title !== 'string') return
  event.waitUntil(self.registration.showNotification(notice.title, {
    body: typeof notice.body === 'string' ? notice.body : '',
    // The same mark the app uses, so the notification is recognisable in a
    // shade full of other apps. Stamped urls change, so these are resolved
    // from the manifest the page passed in at subscribe time and fall back to
    // nothing rather than to a broken image.
    icon: notice.icon || undefined,
    badge: notice.badge || undefined,
    tag: typeof notice.sessionId === 'string' ? notice.sessionId : 'session',
    // Replacing silently would make a second question arrive with no sound at
    // all, which reads as a missed notification.
    renotify: true,
    // The session to open, carried through the tap.
    data: { sessionId: typeof notice.sessionId === 'string' ? notice.sessionId : '' },
    // A question blocks the agent until it is answered, so it stays on screen
    // until the reader deals with it. A finished turn does not.
    requireInteraction: notice.state === 'asking',
  }))
})

// Tapping the notification opens the session it is about — the whole point of
// carrying the id through. If the app is already open somewhere, that window is
// focused and navigated rather than a second one being opened.
self.addEventListener('notificationclick', event => {
  event.notification.close()
  const id = event.notification.data && event.notification.data.sessionId
  const url = id ? '/s/' + encodeURIComponent(id) : '/sessions'
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of clients) {
      // Same origin by construction — matchAll only returns our own clients.
      if ('focus' in client) {
        await client.focus()
        if ('navigate' in client) await client.navigate(url).catch(() => {})
        return
      }
    }
    await self.clients.openWindow(url)
  })())
})

// A push service may rotate a subscription without being asked. When it does,
// the old endpoint stops working, so the new one is sent up immediately —
// otherwise notifications simply stop with nothing anywhere saying why.
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    const fresh = event.newSubscription
      || (event.oldSubscription && await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: event.oldSubscription.options.applicationServerKey,
      }).catch(() => null))
    if (!fresh) return
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subscription: fresh.toJSON(),
        replaces: event.oldSubscription ? event.oldSubscription.endpoint : '',
        label: '',
      }),
    }).catch(() => {})
  })())
})

// Claim open pages on first install so a reader who just enabled notifications
// does not have to reload before the worker is in charge of them.
self.addEventListener('install', () => { self.skipWaiting() })
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()) })

// Present so the app is installable, and deliberately empty of behaviour. A
// browser only offers to install a site whose worker handles `fetch`; without
// this listener "add to home screen" degrades to a bookmark that opens in a
// browser tab, address bar and all.
//
// It does not call `event.respondWith`, which is what keeps the no-caching
// promise at the top of this file true: an untouched event is handled by the
// network exactly as if no worker existed, so nothing here can ever serve
// yesterday's bytes. The server's digest-stamped immutable urls remain the
// whole caching story.
self.addEventListener('fetch', () => {})
