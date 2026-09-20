/**
 * The GUI as its own process.
 *
 * Same page, same rendering, same routes — but the HTTP server, the SSE fan-out
 * and every `renderEvent` call run here instead of inside the harness's event
 * loop. That loop is what a turn and the UI were competing for: a heavy
 * transcript render blocked it for 13s in measurement, which is the whole reason
 * this process exists.
 *
 *   HARNESS_ORIGIN=http://127.0.0.1:3080 PORT=7777 node standalone/server.mjs
 *
 * Nothing in `src/` is modified. `loadAssets`, `listen` and `StreamHub` are the
 * plugin's own modules, imported unchanged and handed the wire-backed context
 * from `adapter.mjs`.
 *
 * @module
 */

import { fileURLToPath } from 'node:url'
import { loadAssets } from '../src/assets.ts'
import { listen } from '../src/http.ts'
import { StreamHub } from '../src/stream.ts'
import { createContext } from './adapter.mjs'

const PORT = Number(process.env.PORT ?? 7778)
const HOST = process.env.HOST ?? '127.0.0.1'
const HARNESS_ORIGIN = process.env.HARNESS_ORIGIN ?? 'http://127.0.0.1:3080'
const STORE_ROOT = process.env.DSH_SESSIONS_ROOT ?? '/root/.dsh/sessions'

const { ctx, wire, logs, ready, stop } = createContext({
  origin: HARNESS_ORIGIN,
  storeRoot: STORE_ROOT,
})

await ready()
if (!logs.faithful) {
  console.warn('standalone web gui: storage-record decoder unavailable — transcripts will be partial')
}

// The plugin's own hub and server, unchanged. `hostOrigin` is where `Bridge`
// mirrors questions from and settles them, which is the harness, not this
// process.
const hub = new StreamHub(ctx, HARNESS_ORIGIN)
// The boot-time running seed lands after the first rows have already been
// served as idle, so its corrections are pushed on the same seam every other
// row change uses.
ctx.on('sessions/changed', () => { hub.notify() })
const assets = await loadAssets(fileURLToPath(new URL('../client', import.meta.url)))

const server = await listen(ctx, assets, hub, PORT, HOST)
console.log(`standalone web gui: http://${HOST}:${PORT}  (harness ${HARNESS_ORIGIN}, store ${logs.root})`)

const shutdown = signal => {
  console.log(`standalone web gui: ${signal}, closing`)
  server.closeAllConnections?.()
  server.close(() => {
    stop()
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 3_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
