// Two stores, one purpose: never paint a blank screen and never lose a prompt.
//
// IndexedDB is asynchronous, so "read the cache and paint" cannot by itself
// make a switch instant. The memory Map is the paint source and is always read
// synchronously; IndexedDB only fills it, at boot, when nobody is waiting.
//
// IndexedDB works on an insecure origin, which matters because this page is
// reached by bare IP and .local names as often as by localhost.

const DB = 'web-gui'
const VERSION = 1

// sessionId -> { html, renderedThrough }
const transcripts = new Map()

let db = null

function open () {
  return new Promise(resolve => {
    let request
    try { request = indexedDB.open(DB, VERSION) } catch (error) { resolve(null); return }
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains('transcripts')) database.createObjectStore('transcripts')
      if (!database.objectStoreNames.contains('outbox')) database.createObjectStore('outbox')
    }
    request.onsuccess = () => resolve(request.result)
    // A browser in private mode, or one that evicted us, is not an error the
    // reader should see: the app is correct with no cache at all.
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
}

function tx (name, mode, run) {
  return new Promise(resolve => {
    if (db === null) { resolve(undefined); return }
    let store
    try { store = db.transaction(name, mode).objectStore(name) } catch (error) { resolve(undefined); return }
    const request = run(store)
    if (request === undefined) { resolve(undefined); return }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(undefined)
  })
}

// Open the database and hydrate every cached transcript into memory once, so
// every later switch paints in the same frame.
export async function boot () {
  db = await open()
  const rows = await tx('transcripts', 'readonly', store => store.getAll())
  const keys = await tx('transcripts', 'readonly', store => store.getAllKeys())
  if (Array.isArray(rows) && Array.isArray(keys)) {
    // The server already rendered this route into the document, and that copy
    // is newer than anything on disk. Cache fills gaps; it never overwrites.
    for (let i = 0; i < keys.length; i += 1) {
      if (!transcripts.has(keys[i])) transcripts.set(keys[i], rows[i])
    }
  }
  // Not a guarantee anywhere, so the UI never promises on the strength of it.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {})
}

// Synchronous. This is the property the whole switching design rests on.
export function cached (sessionId) {
  return transcripts.get(sessionId)
}

// A cached render claiming to be ahead of the log cannot be true. It means the
// session was reset behind us, so the cache is dropped rather than trusted.
export function invalidateIfAhead (sessionId, latestSeq) {
  const row = transcripts.get(sessionId)
  if (row === undefined || row.renderedThrough <= latestSeq) return false
  transcripts.delete(sessionId)
  tx('transcripts', 'readwrite', store => store.delete(sessionId))
  return true
}

export function remember (sessionId, html, renderedThrough) {
  const row = { html, renderedThrough }
  transcripts.set(sessionId, row)
  tx('transcripts', 'readwrite', store => store.put(row, sessionId))
}

// ---- outbox ----------------------------------------------------------------

// A queued prompt survives a reload, a crash, and a week of no signal. It
// carries its own sessionId, so switching never retargets a pending send.
export async function enqueue (row) {
  await tx('outbox', 'readwrite', store => store.put(row, row.clientMessageId))
}

export async function dequeue (clientMessageId) {
  await tx('outbox', 'readwrite', store => store.delete(clientMessageId))
}

export async function pending () {
  const rows = await tx('outbox', 'readonly', store => store.getAll())
  return Array.isArray(rows) ? rows : []
}

// crypto.randomUUID exists only in a secure context, and this page is routinely
// opened over plain HTTP on a LAN address. The fallback only has to be unique
// among one browser's own queued prompts.
export function mintId () {
  if (crypto.randomUUID) return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}
