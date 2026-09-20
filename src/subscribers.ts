/**
 * The browsers that have asked to be notified, and the identity used to reach
 * them.
 *
 * This is the only durable state the GUI keeps, and it has to be: a push
 * subscription outlives the tab that created it — that is the entire point —
 * and the VAPID keypair outlives every subscription, because a browser pins the
 * key it subscribed with. Regenerating the keypair on restart would silently
 * orphan every install, with no error anywhere.
 *
 * It is one small JSON file under `DSH_HOME`, written whole. A database would
 * be a dependency and a migration story for what is, on any real box, a handful
 * of rows — one per phone the reader has installed the app on.
 *
 * Every write is atomic (write a temp file, then rename), because the
 * alternative is a truncated JSON file after a crash, which would lose every
 * subscription and be indistinguishable from "nobody has subscribed".
 * @module
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { generateVapidKeys, type Subscription, type VapidKeys } from './push.ts'

/** One subscribed browser, with enough context to explain itself to the reader. */
export interface Subscriber extends Subscription {
  /**
   * When this subscription was recorded, epoch ms.
   *
   * Shown to the reader so a list of devices is readable ("this one is the
   * phone I set up last week") rather than an inventory of opaque endpoints.
   */
  readonly created: number
  /** A short, human-recognisable name for the device, taken from its user agent. */
  readonly label: string
}

/** The whole persisted file. */
interface Stored {
  readonly vapid: VapidKeys
  readonly subscribers: readonly Subscriber[]
}

/**
 * Where the file lives.
 *
 * `DSH_HOME` is the harness's own convention and is what the rest of the box
 * uses; falling back to `~/.dsh` matches what the harness itself does when the
 * variable is unset.
 * @returns the absolute path of the subscription file.
 */
function storePath(): string {
  const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  return join(home, 'web-gui', 'push-subscribers.json')
}

/**
 * Read one string field from parsed JSON without asserting a type.
 * @param source - the parsed value, shape unknown.
 * @param key - the field to read.
 * @returns the string, or empty when absent or the wrong type.
 */
function field(source: object, key: string): string {
  if (!(key in source)) return ''
  const value: unknown = Reflect.get(source, key)
  return typeof value === 'string' ? value : ''
}

/**
 * Validate one stored subscriber.
 *
 * A row missing any of its three crypto fields cannot be pushed to, so it is
 * dropped rather than kept and retried forever.
 * @param value - one element of the stored array.
 * @returns the subscriber, or undefined when the row is unusable.
 */
function toSubscriber(value: unknown): Subscriber | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const endpoint = field(value, 'endpoint')
  const p256dh = field(value, 'p256dh')
  const auth = field(value, 'auth')
  if (endpoint === '' || p256dh === '' || auth === '') return undefined
  const created: unknown = Reflect.get(value, 'created')
  return {
    endpoint,
    p256dh,
    auth,
    created: typeof created === 'number' && Number.isFinite(created) ? created : Date.now(),
    label: field(value, 'label'),
  }
}

/**
 * The durable set of subscribers, loaded once and written on every change.
 */
export class Subscribers {
  private vapid: VapidKeys | undefined
  private rows: Subscriber[] = []
  private loaded = false

  /**
   * Load the file, creating the keypair on first use.
   *
   * Tolerates every kind of missing and malformed: a reader who has never
   * enabled notifications has no file, and a corrupt file must not stop the GUI
   * from serving. Either way the result is a working keypair and an empty list.
   * @returns nothing; the instance is ready afterwards.
   */
  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const path = storePath()
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null) {
        const vapid: unknown = Reflect.get(parsed, 'vapid')
        if (typeof vapid === 'object' && vapid !== null) {
          const publicKey = field(vapid, 'publicKey')
          const privateKey = field(vapid, 'privateKey')
          if (publicKey !== '' && privateKey !== '') this.vapid = { publicKey, privateKey }
        }
        const list: unknown = Reflect.get(parsed, 'subscribers')
        if (Array.isArray(list)) {
          for (const row of list) {
            const subscriber = toSubscriber(row)
            if (subscriber !== undefined) this.rows.push(subscriber)
          }
        }
      }
    } catch {
      // No file yet, or an unreadable one. Both mean "start fresh"; neither is
      // worth failing a request over.
    }
    if (this.vapid === undefined) {
      this.vapid = generateVapidKeys()
      await this.save()
    }
  }

  /** Write the whole file atomically, so a crash cannot truncate it. */
  private async save(): Promise<void> {
    if (this.vapid === undefined) return
    const path = storePath()
    const stored: Stored = { vapid: this.vapid, subscribers: this.rows }
    const body = JSON.stringify(stored, null, 2)
    await mkdir(dirname(path), { recursive: true })
    // The temp name carries the pid so two servers on one box cannot collide
    // mid-rename, and rename is atomic within a filesystem.
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, body, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, path)
  }

  /**
   * The public key a browser needs to subscribe.
   * @returns the base64url application server key.
   */
  async publicKey(): Promise<string> {
    await this.load()
    return this.vapid?.publicKey ?? ''
  }

  /**
   * The signing identity, for the delivery path.
   * @returns the keypair, or undefined when it could not be established.
   */
  async keys(): Promise<VapidKeys | undefined> {
    await this.load()
    return this.vapid
  }

  /**
   * Record one browser's subscription.
   *
   * Idempotent on the endpoint: a browser that re-subscribes (a new tab, a
   * reinstall, a refreshed key) replaces its row rather than adding a second
   * one, which is what stops a phone receiving four copies of every notice.
   * @param subscriber - the subscription as the browser reported it.
   */
  async add(subscriber: Subscriber): Promise<void> {
    await this.load()
    this.rows = this.rows.filter(row => row.endpoint !== subscriber.endpoint)
    this.rows.push(subscriber)
    await this.save()
  }

  /**
   * Forget one browser, by endpoint.
   * @param endpoint - the endpoint to drop.
   * @returns true when a row was actually removed.
   */
  async remove(endpoint: string): Promise<boolean> {
    await this.load()
    const before = this.rows.length
    this.rows = this.rows.filter(row => row.endpoint !== endpoint)
    if (this.rows.length === before) return false
    await this.save()
    return true
  }

  /**
   * Drop several dead endpoints at once.
   *
   * Used after a delivery round, where the push service has told us which
   * subscriptions no longer exist. Batched so a fan-out to twenty phones costs
   * one write rather than twenty.
   * @param endpoints - the endpoints the push service reported as gone.
   */
  async removeAll(endpoints: readonly string[]): Promise<void> {
    if (endpoints.length === 0) return
    await this.load()
    const dead = new Set(endpoints)
    const before = this.rows.length
    this.rows = this.rows.filter(row => !dead.has(row.endpoint))
    if (this.rows.length !== before) await this.save()
  }

  /**
   * Every subscribed browser.
   * @returns the current rows.
   */
  async all(): Promise<readonly Subscriber[]> {
    await this.load()
    return this.rows
  }

  /**
   * Whether one endpoint is already recorded.
   *
   * The page asks this on load so its control can say "Notifications are on for
   * this device" from what the server actually holds, rather than from anything
   * the browser believes about itself.
   * @param endpoint - the endpoint to look for.
   * @returns true when this exact browser is subscribed.
   */
  async has(endpoint: string): Promise<boolean> {
    await this.load()
    return this.rows.some(row => row.endpoint === endpoint)
  }
}
