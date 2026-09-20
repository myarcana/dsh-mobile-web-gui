/**
 * Web Push, written against the RFCs rather than pulled from a package.
 *
 * Three specs meet here, and all three are pure `node:crypto`:
 *
 * - **RFC 8291** (Message Encryption): the payload is sealed with AES-128-GCM
 *   under a key derived from an ECDH exchange between an ephemeral P-256 key
 *   and the browser's public key, salted per message.
 * - **RFC 8188** (Encrypted Content-Encoding): the sealed bytes are framed with
 *   a header carrying the salt, the record size, and the ephemeral public key.
 * - **RFC 8292** (VAPID): the request is signed with a long-lived P-256 key so
 *   the push service can attribute it to this server.
 *
 * A dependency here would be the only runtime dependency in the whole GUI, for
 * roughly two hundred lines of well-specified crypto that Node already
 * implements. The spec is stable — these documents have not moved since 2017 —
 * so the usual argument for a library (it tracks a moving target) does not
 * apply.
 *
 * Everything is base64url, never base64: these values ride in JSON, in HTTP
 * headers, and in a JWT, none of which tolerate `+` or `/`.
 * @module
 */

import { createCipheriv, createECDH, createHmac, createPrivateKey, createSign, generateKeyPairSync, randomBytes } from 'node:crypto'

/** The curve every Web Push implementation uses. Not negotiable by either end. */
const CURVE = 'prime256v1'

/**
 * How long a signed VAPID token stays valid.
 *
 * Twelve hours rather than the twenty-four the spec permits: some push services
 * reject a token whose expiry is too far out, and a shorter window costs
 * nothing because the token is re-signed per batch anyway.
 */
const TOKEN_TTL_S = 12 * 60 * 60

/**
 * How long the push service should hold an undelivered message.
 *
 * Four hours. A notification that a session wants attention is worth waking a
 * phone for during a break, but a stale one from yesterday is noise — and the
 * session has almost certainly moved on by then.
 */
export const TTL_S = 4 * 60 * 60

/** One browser's push endpoint and the keys to seal a payload for it. */
export interface Subscription {
  /** The push service URL this browser was assigned. Opaque; treat as a secret. */
  readonly endpoint: string
  /** The browser's P-256 public key, base64url, from `getKey('p256dh')`. */
  readonly p256dh: string
  /** The browser's auth secret, base64url, from `getKey('auth')`. */
  readonly auth: string
}

/** The server's VAPID identity, persisted so installs stay subscribed across restarts. */
export interface VapidKeys {
  /** Public key, base64url. Handed to the browser as `applicationServerKey`. */
  readonly publicKey: string
  /** Private key, base64url of the raw 32-byte scalar. */
  readonly privateKey: string
}

/** Base64url with no padding, which is what every one of these specs wants. */
function b64url(input: Buffer): string {
  return input.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/**
 * Decode base64url, tolerating missing padding.
 * @param input - the encoded value, straight off the wire.
 * @returns the raw bytes.
 */
function unb64url(input: string): Buffer {
  return Buffer.from(input.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
}

/**
 * Mint a VAPID keypair.
 *
 * Called once, the first time this GUI is asked for its public key; the result
 * is persisted, because regenerating it would silently invalidate every
 * existing subscription — the browser pins the key it subscribed with.
 * @returns a fresh keypair in the base64url form the rest of this module uses.
 */
export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: CURVE })
  // The uncompressed point (0x04 ‖ X ‖ Y) is what the browser wants, and the
  // raw scalar is what signing wants. Both are extracted from the DER/JWK forms
  // rather than stored as PEM, so what is persisted is exactly what is used.
  const jwk = publicKey.export({ format: 'jwk' })
  const priv = privateKey.export({ format: 'jwk' })
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string' || typeof priv.d !== 'string') {
    throw new Error('web-push: generated key is missing its coordinates')
  }
  const point = Buffer.concat([Buffer.from([4]), unb64url(jwk.x), unb64url(jwk.y)])
  return { publicKey: b64url(point), privateKey: priv.d }
}

/**
 * Rebuild a signing key from the stored private scalar.
 *
 * The scalar alone does not make a key object, so the public point is recovered
 * from it by scalar multiplication and the pair is imported as a JWK.
 * @param keys - the persisted VAPID identity.
 * @returns a key object `createSign` will accept.
 */
function signingKey(keys: VapidKeys) {
  const point = unb64url(keys.publicKey)
  // 0x04 ‖ X ‖ Y — 65 bytes for P-256. Anything else is not a public point.
  if (point.length !== 65 || point[0] !== 4) throw new Error('web-push: stored VAPID public key is malformed')
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: b64url(point.subarray(1, 33)),
      y: b64url(point.subarray(33, 65)),
    },
    format: 'jwk',
  })
}

/**
 * Sign a VAPID JWT for one push service origin.
 *
 * The audience is the *origin* of the endpoint, not the endpoint itself — a
 * token scoped to the full path is rejected.
 * @param keys - the server's VAPID identity.
 * @param audience - the push service origin, e.g. `https://fcm.googleapis.com`.
 * @param subject - a contact URI for this server, per the spec's `sub` claim.
 * @returns the compact JWS.
 */
function vapidToken(keys: VapidKeys, audience: string, subject: string): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' }), 'utf8'))
  const claims = b64url(Buffer.from(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_S,
    sub: subject,
  }), 'utf8'))
  const body = `${header}.${claims}`
  const signer = createSign('SHA256')
  signer.update(body)
  // ES256 is the raw 64-byte r‖s pair, not the DER sequence OpenSSL emits by
  // default. Asking for the IEEE-P1363 encoding is the whole difference between
  // a token every push service accepts and one every push service rejects.
  const signature = signer.sign({ key: signingKey(keys), dsaEncoding: 'ieee-p1363' })
  return `${body}.${b64url(signature)}`
}

/** HKDF (RFC 5869) over SHA-256, which is the KDF both push RFCs specify. */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac('sha256', salt).update(ikm).digest()
  const output = createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest()
  return output.subarray(0, length)
}

/**
 * Seal a payload for one subscription, per RFC 8291 and RFC 8188.
 *
 * The result is a complete `aes128gcm` body: header, then one record. A single
 * record is correct for anything under ~4 KB, and these notifications are a
 * couple of hundred bytes — so the multi-record framing is deliberately not
 * implemented rather than implemented and never exercised.
 * @param subscription - the browser's endpoint keys.
 * @param payload - the cleartext, which is JSON here.
 * @returns the encrypted body to POST.
 */
function encrypt(subscription: Subscription, payload: Buffer): Buffer {
  const clientPublic = unb64url(subscription.p256dh)
  const auth = unb64url(subscription.auth)
  const ecdh = createECDH(CURVE)
  ecdh.generateKeys()
  const serverPublic = ecdh.getPublicKey()
  const shared = ecdh.computeSecret(clientPublic)
  const salt = randomBytes(16)
  // RFC 8291 §3.3: the auth secret mixes the two public keys into the IKM, so a
  // key derived for one subscriber is useless to any other.
  const info = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    clientPublic,
    serverPublic,
  ])
  const ikm = hkdf(auth, shared, info, 32)
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16)
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12)
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  // The padding delimiter: 0x02 marks the last record. Without it the browser
  // decrypts the bytes and then discards them as malformed.
  const sealed = Buffer.concat([cipher.update(payload), cipher.update(Buffer.from([2])), cipher.final(), cipher.getAuthTag()])
  const header = Buffer.alloc(5)
  header.writeUInt32BE(4096, 0)
  header.writeUInt8(serverPublic.length, 4)
  return Buffer.concat([salt, header, serverPublic, sealed])
}

/**
 * Copy sealed bytes into a view whose backing store is a plain `ArrayBuffer`.
 *
 * Node's `Buffer` is allocated from a shared pool, so its type is
 * `ArrayBufferLike`; the web `BufferSource` wants `ArrayBuffer` specifically.
 * The copy is a few hundred bytes once per notification, which is not worth a
 * cast to avoid.
 * @param source - the sealed payload.
 * @returns the same bytes in a standalone buffer.
 */
function bodyBytes(source: Buffer): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(source.byteLength))
  copy.set(source)
  return copy
}

/** What one delivery attempt concluded, so the caller can retire dead endpoints. */
export interface PushResult {
  /** True when the push service accepted the message. */
  readonly ok: boolean
  /** True when this endpoint is permanently gone and should be forgotten. */
  readonly gone: boolean
  /** HTTP status, or 0 when the request never completed. */
  readonly status: number
  /** Full technical detail, surfaced rather than swallowed. */
  readonly detail: string
}

/**
 * Deliver one notification to one browser.
 *
 * Never throws: a push service is a third party on the far side of the reader's
 * network, and one unreachable endpoint must not take down the fan-out or the
 * event loop. Every failure comes back as a {@link PushResult}.
 * @param keys - the server's VAPID identity.
 * @param subject - the `sub` claim, a mailto: or https: URI identifying this server.
 * @param subscription - the browser to deliver to.
 * @param payload - the JSON the service worker will receive.
 * @returns what happened, including whether the endpoint should be dropped.
 */
export async function sendPush(
  keys: VapidKeys,
  subject: string,
  subscription: Subscription,
  payload: unknown,
): Promise<PushResult> {
  let audience: string
  try {
    audience = new URL(subscription.endpoint).origin
  } catch (error) {
    return { ok: false, gone: true, status: 0, detail: `malformed endpoint: ${String(error)}` }
  }
  try {
    const body = encrypt(subscription, Buffer.from(JSON.stringify(payload), 'utf8'))
    const response = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        'ttl': String(TTL_S),
        // `urgency: high` is what persuades a dozing phone to surface this now
        // rather than batching it: the whole point is that the reader is not
        // looking at the page.
        'urgency': 'high',
        'authorization': `vapid t=${vapidToken(keys, audience, subject)}, k=${keys.publicKey}`,
      },
      // A Blob over a plain `ArrayBuffer`-backed view, rather than the Buffer
      // itself. Every runtime accepts a Buffer as a body, but a Node Buffer is
      // typed over `ArrayBufferLike` (it may sit in a pooled SharedArrayBuffer)
      // while the DOM `BufferSource` admits only `ArrayBufferView<ArrayBuffer>`
      // — and the house rule bans the assertion that would paper over it. So
      // the bytes are copied once, into memory whose type says what it is.
      body: new Blob([bodyBytes(body)], { type: 'application/octet-stream' }),
    })
    // 404 and 410 are the push service saying this subscription no longer
    // exists — the app was uninstalled, or the browser rotated it. That is the
    // one failure worth acting on rather than retrying forever.
    const gone = response.status === 404 || response.status === 410
    if (response.ok) return { ok: true, gone: false, status: response.status, detail: '' }
    const text = await response.text().catch(() => '')
    return { ok: false, gone, status: response.status, detail: `${response.status} ${response.statusText}: ${text.slice(0, 500)}` }
  } catch (error) {
    // No signal, DNS failure, TLS failure. Not `gone`: the endpoint may be
    // perfectly good and the network merely absent, which is the normal case on
    // the connections this GUI is built for.
    return { ok: false, gone: false, status: 0, detail: String(error) }
  }
}
