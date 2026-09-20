/**
 * Web Push crypto, checked against the published RFC test vectors and against a
 * real decrypt.
 *
 * This module is hand-written against three RFCs instead of taken from a
 * package, so the vectors are the thing standing in for the community that
 * would otherwise have found a bug in it. A silent break here does not throw —
 * it produces bytes a phone quietly discards, which is invisible from the
 * server. So the assertions are the published values, not "it ran".
 */

import { createDecipheriv, createECDH, createHmac, createPublicKey, createVerify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { generateVapidKeys, sendPush } from '../src/push.ts'

function un(value: string): Buffer {
  return Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
}

function b64(value: Buffer): string {
  return value.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac('sha256', salt).update(ikm).digest()
  return createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, length)
}

describe('RFC 8291 key derivation', () => {
  // Section 5 of RFC 8291, verbatim. These are the only numbers in this file
  // that were not produced by our own code, which is what makes them worth
  // asserting on.
  it('reproduces the published IKM, CEK and nonce', () => {
    const auth = un('BTBZMqHH6r4Tts7J_aSIgg')
    const salt = un('DGv6ra1nlYgDCS1FRnbzlw')
    const asPublic = un('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8')
    const uaPublic = un('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4')
    const asPrivate = un('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw')
    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(asPrivate)
    expect(b64(ecdh.getPublicKey())).toBe(b64(asPublic))
    const shared = ecdh.computeSecret(uaPublic)
    const info = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic])
    const ikm = hkdf(auth, shared, info, 32)
    expect(b64(ikm)).toBe('S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg')
    expect(b64(hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16)))
      .toBe('oIhVW04MRdy2XN9CiKLxTg')
    expect(b64(hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12)))
      .toBe('4h_95klXJ5E_qnoN')
  })
})

/** Capture one outgoing request instead of reaching a real push service. */
async function capture(payload: unknown): Promise<{ body: Buffer, headers: Record<string, string>, ua: ReturnType<typeof createECDH>, auth: Buffer, keys: ReturnType<typeof generateVapidKeys> }> {
  const ua = createECDH('prime256v1')
  ua.generateKeys()
  const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16)))
  const keys = generateVapidKeys()
  let body = Buffer.alloc(0)
  let headers: Record<string, unknown> = {}
  const original = globalThis.fetch
  globalThis.fetch = async (_url: unknown, init: unknown): Promise<Response> => {
    if (init !== null && typeof init === 'object' && 'body' in init && 'headers' in init) {
      const raw = init.body
      if (raw instanceof Blob) body = Buffer.from(await raw.arrayBuffer())
      const head = init.headers
      if (head !== null && typeof head === 'object') headers = { ...head }
    }
    return new Response('', { status: 201 })
  }
  try {
    const result = await sendPush(keys, 'https://example.invalid', {
      endpoint: 'https://push.example.invalid/subscription',
      p256dh: b64(ua.getPublicKey()),
      auth: b64(auth),
    }, payload)
    expect(result.ok).toBe(true)
  } finally {
    globalThis.fetch = original
  }
  return { body, headers, ua, auth, keys }
}

describe('sendPush', () => {
  it('produces a body the receiving browser can decrypt', async () => {
    const message = { session: 'session-abc', title: 'A session', state: 'asking' }
    const { body, ua, auth } = await capture(message)
    // RFC 8188 §2: salt(16) ‖ record size(4) ‖ key id length(1) ‖ key id.
    const salt = body.subarray(0, 16)
    expect(body.readUInt32BE(16)).toBe(4096)
    const idLength = body.readUInt8(20)
    const serverPublic = body.subarray(21, 21 + idLength)
    expect(idLength).toBe(65)
    const sealed = body.subarray(21 + idLength)
    const shared = ua.computeSecret(serverPublic)
    const info = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), ua.getPublicKey(), serverPublic])
    const ikm = hkdf(auth, shared, info, 32)
    const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16)
    const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12)
    const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
    decipher.setAuthTag(sealed.subarray(sealed.length - 16))
    const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()])
    // The trailing 0x02 is the last-record delimiter; the browser strips it.
    expect(plain[plain.length - 1]).toBe(2)
    expect(JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8'))).toEqual(message)
  })

  it('signs a VAPID token the push service can verify with the advertised key', async () => {
    const { headers, keys } = await capture({ ok: true })
    const raw = headers['authorization']
    const authorization = typeof raw === 'string' ? raw : ''
    expect(authorization).toMatch(/^vapid t=/)
    const token = /t=([^,]+)/.exec(authorization)?.[1] ?? ''
    const advertised = /k=(.+)$/.exec(authorization)?.[1] ?? ''
    expect(advertised).toBe(keys.publicKey)
    const [header, claims, signature] = token.split('.')
    const point = un(advertised)
    const publicKey = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: b64(point.subarray(1, 33)), y: b64(point.subarray(33, 65)) },
      format: 'jwk',
    })
    const verifier = createVerify('SHA256')
    verifier.update(`${header}.${claims}`)
    // ES256 is raw r‖s, not DER. Verifying with the same encoding the signer
    // used is what catches a regression to OpenSSL's default.
    expect(verifier.verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, un(signature))).toBe(true)
    const parsed: unknown = JSON.parse(Buffer.from(claims.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'))
    expect(parsed).toMatchObject({ aud: 'https://push.example.invalid', sub: 'https://example.invalid' })
  })

  it('reports a dead subscription as gone so the caller can forget it', async () => {
    const original = globalThis.fetch
    globalThis.fetch = async (): Promise<Response> => new Response('gone', { status: 410 })
    try {
      const ua = createECDH('prime256v1')
      ua.generateKeys()
      const result = await sendPush(generateVapidKeys(), 'https://example.invalid', {
        endpoint: 'https://push.example.invalid/subscription',
        p256dh: b64(ua.getPublicKey()),
        auth: b64(Buffer.alloc(16, 7)),
      }, { any: 'thing' })
      expect(result.ok).toBe(false)
      expect(result.gone).toBe(true)
      expect(result.status).toBe(410)
    } finally {
      globalThis.fetch = original
    }
  })

  it('never throws when the network is simply absent', async () => {
    const original = globalThis.fetch
    globalThis.fetch = async (): Promise<Response> => { throw new Error('getaddrinfo ENOTFOUND') }
    try {
      const ua = createECDH('prime256v1')
      ua.generateKeys()
      const result = await sendPush(generateVapidKeys(), 'https://example.invalid', {
        endpoint: 'https://push.example.invalid/subscription',
        p256dh: b64(ua.getPublicKey()),
        auth: b64(Buffer.alloc(16, 7)),
      }, { any: 'thing' })
      expect(result.ok).toBe(false)
      // Not `gone`: an absent network says nothing about the subscription, and
      // dropping it here would unsubscribe every reader on a bad link.
      expect(result.gone).toBe(false)
      expect(result.detail).toContain('ENOTFOUND')
    } finally {
      globalThis.fetch = original
    }
  })
})
