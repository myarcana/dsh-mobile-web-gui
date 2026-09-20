// Turning notifications on for this device, and keeping the server's idea of
// this browser honest.
//
// Everything on screen is driven by what the server says it holds, never by
// what the browser believes about itself: `Notification.permission` says the
// reader granted permission once, which is not the same as this device being
// subscribed — a reinstall, a cleared site, or a subscription this server never
// recorded all leave permission granted and nothing registered. So the control
// reports the server's answer for this exact endpoint.

import * as errors from 'errors'

// Base64url (what VAPID keys are) to the byte array subscribe() demands.
// Browsers accept nothing else here, and the padding must be restored.
function toKey (base64url) {
  const padded = base64url.replaceAll('-', '+').replaceAll('_', '/')
  const raw = atob(padded + '='.repeat((4 - padded.length % 4) % 4))
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}

// Whether this browser can do any of it. Three separate capabilities, and Safari
// before 16.4 has the first two but not the third.
export function supported () {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

// The one registration, shared by every caller on the page.
let registering = null

function register () {
  // The worker is registered at the site root because its scope is its own
  // path: a worker under /m/ could not receive pushes for pages at /s/.
  registering ??= navigator.serviceWorker.register('/sw.js', { scope: '/' })
  return registering
}

// This browser's current push subscription, or null. Never creates one.
async function current () {
  if (!supported()) return null
  const registration = await register()
  return registration.pushManager.getSubscription()
}

// What the server holds for this device, which is the only thing the UI reports.
//
// Returns the three facts a control needs: whether this browser could ever do
// it, whether the reader has refused permission at the OS level (which no
// button can undo, so it must be said rather than retried), and whether this
// exact endpoint is registered here.
export async function status () {
  if (!supported()) {
    return { supported: false, blocked: false, enabled: false, endpoint: '' }
  }
  const blocked = Notification.permission === 'denied'
  const subscription = await current()
  if (subscription === null) return { supported: true, blocked, enabled: false, endpoint: '' }
  // The server is asked rather than trusted to agree: a subscription this
  // browser kept across a server whose store was deleted is not enabled, and
  // showing it as on would be a notification that never arrives.
  const response = await fetch('/api/push/status?endpoint=' + encodeURIComponent(subscription.endpoint))
  if (!response.ok) {
    await errors.fromResponse('GET', '/api/push/status', response)
    return { supported: true, blocked, enabled: false, endpoint: subscription.endpoint }
  }
  const body = await response.json()
  return { supported: true, blocked, enabled: body.subscribed === true, endpoint: subscription.endpoint }
}

// Subscribe this device. Returns the new status, or throws with full detail.
export async function enable () {
  const registration = await register()
  // Asked only on a real tap: a permission prompt on page load is the fastest
  // way to be refused permanently, and a denial cannot be undone in-page.
  const granted = await Notification.requestPermission()
  if (granted !== 'granted') {
    return { supported: true, blocked: granted === 'denied', enabled: false, endpoint: '' }
  }
  const keyResponse = await fetch('/api/push/key')
  if (!keyResponse.ok) {
    await errors.fromResponse('GET', '/api/push/key', keyResponse)
    return status()
  }
  const { key } = await keyResponse.json()
  if (typeof key !== 'string' || key === '') {
    errors.show('Notifications unavailable', 'The server returned no VAPID public key, so this browser cannot subscribe.\n\nAt: ' + new Date().toString())
    return status()
  }
  // An existing subscription made with a different key is useless — the server
  // that signs for it is gone — so it is replaced rather than reused.
  const existing = await registration.pushManager.getSubscription()
  if (existing !== null) await existing.unsubscribe().catch(() => {})
  // userVisibleOnly is required by every browser that implements this: a push
  // that shows nothing is not allowed, which suits a notification exactly.
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: toKey(key)
  })
  const response = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subscription: subscription.toJSON(), label: label() })
  })
  if (!response.ok) {
    await errors.fromResponse('POST', '/api/push/subscribe', response)
  }
  return status()
}

// Unsubscribe this device, both here and on the server.
export async function disable () {
  const subscription = await current()
  if (subscription === null) return status()
  const endpoint = subscription.endpoint
  await subscription.unsubscribe().catch(() => {})
  const response = await fetch('/api/push/unsubscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint })
  })
  if (!response.ok) await errors.fromResponse('POST', '/api/push/unsubscribe', response)
  return status()
}

// A name the reader will recognise this device by in a list of them. Taken from
// the user agent because there is no other source; deliberately coarse, since
// the point is "which of my phones is this", not an inventory string.
function label () {
  const ua = navigator.userAgent
  const platform = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
      : /Android/.test(ua) ? 'Android'
        : /Macintosh/.test(ua) ? 'Mac'
          : /Windows/.test(ua) ? 'Windows'
            : /Linux/.test(ua) ? 'Linux'
              : 'This device'
  const browser = /CriOS|Chrome/.test(ua) ? 'Chrome'
    : /FxiOS|Firefox/.test(ua) ? 'Firefox'
      : /Edg/.test(ua) ? 'Edge'
        : /Safari/.test(ua) ? 'Safari'
          : ''
  return browser === '' ? platform : platform + ' · ' + browser
}

// Tell the server this device is looking at the page.
//
// This is what stops a phone buzzing about a session whose dot the reader is
// already watching go amber. It rides the existing focus/stream traffic rather
// than adding a timer: the page is already talking to the server whenever it is
// visible, and a hidden page stops — which is exactly the signal wanted.
export async function present () {
  if (!supported()) return
  if (document.hidden) return
  const subscription = await current()
  if (subscription === null) return
  await fetch('/api/push/present', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint })
  }).catch(() => {
    // Best effort. Failing to report presence only risks a redundant
    // notification, which is far better than a failed request in the page.
  })
}
