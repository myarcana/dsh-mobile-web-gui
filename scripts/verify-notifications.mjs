// Notifications: the crypto, the edge detector, and the screen that turns it on.
//
//   node scripts/verify-notifications.mjs [origin]   default http://localhost:7778
//
// Three things are checked here because all three fail silently. Web Push
// crypto that is subtly wrong produces bytes a phone discards with no error
// anywhere; an edge detector that notifies on state rather than transition
// rings a phone every second and is only noticed by the person holding it; and
// a control that reports the browser's permission instead of the server's
// record claims notifications are on when nothing is subscribed.
//
// The RFC 8291 §5 vectors are the only numbers here not produced by our own
// code, which is what makes them worth asserting on.

import { createDecipheriv, createECDH, createHmac, createPublicKey, createVerify } from 'node:crypto'
import { createServer } from 'node:http'
import { chromium } from '/usr/lib/node_modules/playwright/index.mjs'
import { generateVapidKeys, sendPush } from '../src/push.ts'
import { Transitions, stateOf } from '../src/notify.ts'

const origin = process.argv[2] ?? 'http://localhost:7778'
const failures = []

function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

const un = s => Buffer.from(s.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
const b64 = b => b.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
const hkdf = (salt, ikm, info, len) =>
  createHmac('sha256', createHmac('sha256', salt).update(ikm).digest())
    .update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, len)

// ---- RFC 8291 §5, verbatim --------------------------------------------------
{
  const auth = un('BTBZMqHH6r4Tts7J_aSIgg')
  const salt = un('DGv6ra1nlYgDCS1FRnbzlw')
  const asPub = un('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8')
  const uaPub = un('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4')
  const e = createECDH('prime256v1')
  e.setPrivateKey(un('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'))
  const ikm = hkdf(auth, e.computeSecret(uaPub), Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32)
  check('RFC 8291 IKM', b64(ikm) === 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg')
  check('RFC 8291 content encryption key',
    b64(hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16)) === 'oIhVW04MRdy2XN9CiKLxTg')
  check('RFC 8291 nonce',
    b64(hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12)) === '4h_95klXJ5E_qnoN')
}

// ---- a real delivery, decrypted as a browser would --------------------------
{
  const ua = createECDH('prime256v1')
  ua.generateKeys()
  const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16)))
  const received = []
  const service = createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const salt = body.subarray(0, 16)
      const idLength = body.readUInt8(20)
      const serverPublic = body.subarray(21, 21 + idLength)
      const sealed = body.subarray(21 + idLength)
      const ikm = hkdf(auth, ua.computeSecret(serverPublic),
        Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), serverPublic]), 32)
      const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
      const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12)
      const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
      decipher.setAuthTag(sealed.subarray(sealed.length - 16))
      const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()])
      received.push({ headers: req.headers, payload: JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8')) })
      res.writeHead(201)
      res.end()
    })
  })
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${service.address().port}/push/verify`
  const keys = generateVapidKeys()
  const message = { sessionId: 'session-x', title: 'A session has finished', body: 'Done.', state: 'done' }
  const result = await sendPush(keys, 'https://example.invalid', { endpoint, p256dh: b64(ua.getPublicKey()), auth: b64(auth) }, message)
  check('push accepted by service', result.ok, result.detail)
  check('browser can decrypt the payload', JSON.stringify(received[0]?.payload) === JSON.stringify(message))
  check('urgency is high so a dozing phone surfaces it', received[0]?.headers.urgency === 'high')

  // The VAPID token must verify under the key the request advertises.
  const authorization = received[0]?.headers.authorization ?? ''
  const token = /t=([^,]+)/.exec(authorization)?.[1] ?? ''
  const advertised = /k=(.+)$/.exec(authorization)?.[1] ?? ''
  const [header, claims, signature] = token.split('.')
  const point = un(advertised)
  const verifier = createVerify('SHA256')
  verifier.update(`${header}.${claims}`)
  const publicKey = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64(point.subarray(1, 33)), y: b64(point.subarray(33, 65)) },
    format: 'jwk',
  })
  check('VAPID signature verifies under the advertised key',
    advertised === keys.publicKey && verifier.verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, un(signature)))
  service.close()
}

// ---- the edge detector ------------------------------------------------------
{
  const row = (id, extra = {}) => ({ id, title: id, running: false, asks: [], approvals: [], lastLine: 'x', ...extra })
  const t = new Transitions()
  check('a first listing seeds without notifying', t.fold([row('a'), row('b', { running: true })]).length === 0)
  check('an unchanged listing is silent', t.fold([row('a'), row('b', { running: true })]).length === 0)
  const stopped = t.fold([row('a'), row('b')])
  check('working to finished notifies once', stopped.length === 1 && stopped[0].sessionId === 'b')
  check('the notice says which session and what it wants', stopped[0]?.heading === 'b has finished')
  check('the same state does not notify again', t.fold([row('a'), row('b')]).length === 0)
  t.fold([row('c', { running: true })])
  const asked = t.fold([row('c', { running: true, asks: [{ askId: '1', questions: [] }] })])
  check('working to asking notifies with its own wording', asked[0]?.heading === 'c is asking you')
  check('asking to finished is not a second interruption', t.fold([row('c')]).length === 0)
  check('a session that appears already waiting is silent', t.fold([row('c'), row('fresh')]).length === 0)
  // The definition itself, which must not drift from client/chooser.js.
  check('state() matches the session list',
    stateOf(row('x', { running: true, asks: [{}] })) === 'asking'
    && stateOf(row('x', { running: true })) === 'working'
    && stateOf(row('x')) === 'done')
}

// ---- the screen -------------------------------------------------------------
{
  const browser = await chromium.launch()
  const errors = []

  // Headless Chrome reports `Notification.permission` as denied whatever the
  // context is granted, so the granted states are reached by replacing the API
  // before app code runs. The server, the routing and the rendering are real.
  const open = async (init) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
    if (init !== undefined) await context.addInitScript(init)
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${origin}/sessions`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.alerts', { timeout: 15_000 })
    await page.waitForTimeout(800)
    return { context, page }
  }

  const granted = () => {
    Object.defineProperty(Notification, 'permission', { get: () => 'granted', configurable: true })
    Notification.requestPermission = async () => 'granted'
  }

  {
    const { context, page } = await open(granted)
    check('the list offers notifications', (await page.locator('.alerts').first().textContent()) === 'Notifications are off for this device')
    await page.locator('.alerts').first().click()
    await page.waitForTimeout(500)
    check('it is a screen with its own URL', new URL(page.url()).pathname === '/sessions/notifications')
    check('the screen is open', await page.locator('#alerts .sheet').isVisible())
    const button = page.locator('#alerts button').first()
    check('the control says what it will do', (await button.textContent()) === 'Turn on notifications for this device')
    const box = await button.boundingBox()
    check('the control meets the 44px minimum', box.height >= 44, `${box.height}px`)
    await page.goBack()
    await page.waitForTimeout(400)
    check('the back button is the way out', !(await page.locator('#alerts .sheet').isVisible()))
    await context.close()
  }

  {
    // A device the server already holds must read as on, from the server's
    // answer rather than from the browser's permission.
    const endpoint = 'https://push.example.invalid/verify-subscribed'
    await fetch(`${origin}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscription: { endpoint, keys: { p256dh: 'x', auth: 'y' } }, label: 'Verification' }),
    })
    const { context, page } = await open(() => {
      Object.defineProperty(Notification, 'permission', { get: () => 'granted', configurable: true })
      const endpoint = 'https://push.example.invalid/verify-subscribed'
      const fake = { endpoint, toJSON: () => ({ endpoint, keys: { p256dh: 'x', auth: 'y' } }), unsubscribe: async () => true }
      const real = navigator.serviceWorker.register.bind(navigator.serviceWorker)
      navigator.serviceWorker.register = async (...args) => {
        const registration = await real(...args)
        return new Proxy(registration, {
          get: (target, property) => property === 'pushManager'
            ? { getSubscription: async () => fake, subscribe: async () => fake }
            : Reflect.get(target, property),
        })
      }
    })
    check('a subscribed device reads as on', (await page.locator('.alerts').first().textContent()) === 'Notifications are on for this device')
    await context.close()
    await fetch(`${origin}/api/push/unsubscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    })
  }

  {
    const { context, page } = await open(() => { delete window.PushManager })
    check('a browser without push says so plainly',
      (await page.locator('.alerts').first().textContent()) === 'Notifications are not available in this browser')
    await context.close()
  }

  check('no JavaScript errors on any of it', errors.length === 0, errors.join(' | '))
  await browser.close()
}

console.log(failures.length === 0 ? '\nAll checks passed.' : `\n${failures.length} failed: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
