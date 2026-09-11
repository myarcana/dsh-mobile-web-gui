/**
 * The web GUI: an in-process cordis plugin serving a no-build vanilla page for
 * commanding and orchestrating sessions from a phone.
 *
 * In-process rather than a separate process over the SDK's stdio boundary,
 * because three of the seams this GUI needs only exist in-process: one
 * consistent transcript cut for a live or cold session alike
 * (`sessionQuery.readSession`), the durable event feed (`session/event`), and
 * the live token stream (`agent/assistant-stream`). The SDK exposes durable
 * events only — a stdio server could not stream tokens at all.
 *
 * @module @deepseek-ai/dsh-web-gui
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { errorChain } from '@deepseek-ai/dsh-llm'
import Schema from '@deepseek-ai/schemastery'
import { fileURLToPath } from 'node:url'
import type { Server } from 'node:http'
import { loadAssets } from './assets.ts'
import { listen } from './http.ts'
import { StreamHub } from './stream.ts'

export type * from './types.ts'
export { SafeUrl } from './node.ts'
export type { Node } from './node.ts'
export { serialize, serializeAll } from './serialize.ts'
export { markdown } from './markdown.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    webGui: WebGui
  }
}

/** Plugin configuration. */
export interface Config {
  /** TCP port to bind. */
  port: number
  /**
   * Interface to bind. The default answers on every interface, because the
   * hostname must never matter: `localhost:PORT`, `192.168.1.8:PORT`,
   * `something.local:PORT` and any name pointed at the host all work.
   */
  host: string
}

/** Configuration schema. */
export const Config: Schema<Config> = Schema.object({
  port: Schema.natural().max(65_535).default(7777).description('TCP port the web GUI listens on.'),
  host: Schema.string().default('::').description('Interface to bind. Answers on every interface by default.'),
})

/** The running web GUI server. */
export class WebGui extends Service {
  static inject = ['agents', 'sessionQuery']

  /** Config schema, read by the loader from the plugin class. */
  static Config: Schema<Config> = Config

  private server: Server | undefined
  private readonly config: Config

  /**
   * Start the server and tie its lifetime to the plugin's.
   * @param ctx - the plugin context.
   * @param config - the validated configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'webGui')
    this.config = config
    // An async rejection crashes modern Node by default, and this process is
    // also running live agents. Log and keep serving.
    const onUncaught = (error: unknown): void => {
      ctx.logger.warn(`web-gui: ${errorChain(error)}`)
    }
    process.on('uncaughtException', onUncaught)
    process.on('unhandledRejection', onUncaught)
    ctx.effect(() => () => {
      process.off('uncaughtException', onUncaught)
      process.off('unhandledRejection', onUncaught)
      this.server?.closeAllConnections()
      this.server?.close()
    }, 'webGui.lifecycle()')
  }

  /**
   * Load the client assets and open the socket.
   *
   * `[Service.init]` is cordis' post-construction hook — there is no `start()`
   * in the Service base class, so async setup must land here or never run.
   */
  protected async [Service.init](): Promise<void> {
    const dir = fileURLToPath(new URL('../client', import.meta.url))
    const assets = await loadAssets(dir)
    const hub = new StreamHub(this.ctx)
    this.server = await listen(this.ctx, assets, hub, this.config.port, this.config.host)
    this.ctx.logger.info(
      `web-gui: listening on port ${this.config.port} — reachable by any hostname that resolves here`,
    )
  }
}

export default WebGui
