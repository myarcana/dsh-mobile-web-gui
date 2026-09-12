/**
 * Creating a session, and registering a workspace.
 *
 * A session is created through the host's own API face when this profile mounts
 * one, so its agent is composed exactly as a session made in the desktop UI —
 * the same preset, the same tools, the same model default. Reimplementing that
 * composition here would drift from the desktop the first time either changed.
 *
 * A workspace can only adopt a directory that already exists. The registry is a
 * record of directories, and registering a path nothing can open would put a
 * heading on the list that no shell could use. Creating the directory is the
 * browser's job, one level at a time.
 * @module
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { CreatedSession, DirectoryView, WorkspaceCreated } from './types.ts'

/** The workspace registry surface this plugin reads, structurally typed so it never imports the package. */
interface Registry {
  list(): readonly WorkspaceLike[]
  get(id: string): WorkspaceLike | undefined
  create(path: string, title?: string): Promise<WorkspaceLike>
}

/** One durable workspace record, as this plugin consumes it. */
interface WorkspaceLike {
  readonly id: string
  readonly title: string
  readonly path: string
  attachSession(id: SessionId): Promise<void>
}

/** The host API face the desktop UI calls, when this profile mounts one. */
interface Gateway {
  sessions: { create(request: unknown): Promise<unknown> }
}

/** The directory-picker seam. The backend chooses its own interaction shape at boot. */
interface Picker {
  capability(): {
    readonly kind: string
    readonly list?: (path?: string, signal?: AbortSignal) => Promise<Listing>
    readonly createDirectory?: (path: string, name: string) => Promise<string>
  }
}

/** One directory level as a browse backend reports it. */
interface Listing {
  readonly path: string
  readonly home: string
  readonly crumbs: readonly Entry[]
  readonly entries: readonly Entry[]
  readonly truncated: boolean
}

/** One directory row: a breadcrumb ancestor or a listing child. */
interface Entry {
  readonly name: string
  readonly path: string
  readonly hidden: boolean
}

/** The preset roster, when the deployment mounts one. */
interface Presets {
  resolve(id?: string): Promise<{ readonly id: string }>
  mount(agentCtx: never, id?: string): Promise<unknown>
}

/** The default model selection for a session that names none. */
interface DefaultModel {
  currentSelection(): { readonly provider: string; readonly model: string }
}

/** The id shape this server accepts from a caller: a prefix and a UUID's worth of hex, never a path segment that could escape a directory. */
const CALLER_SESSION_ID = /^session-[A-Za-z0-9-]{8,64}$/

/**
 * Create one session, filed under a workspace when the caller named one.
 *
 * The id is resolved here and sent with the request, which is what makes a
 * retry safe: the host resolves a known id to the same session instead of
 * making a second one, so a lost response cannot cost a duplicate.
 *
 * A caller may name the id itself. That is what lets the browser keep one id
 * for a create it is still waiting on: a second tap, or a retry after a dropped
 * response, carries the same id and lands on the same session rather than
 * minting another. When the caller names none, one is minted here.
 * @param ctx - the plugin context.
 * @param options - the workspace to file it under, and the caller's own id when it has one.
 * @returns the new session and the workspace it landed in.
 * @throws Error when the named workspace is unknown, the id is malformed, or the host refuses the create.
 */
export async function createSession(
  ctx: Context,
  options: { readonly workspaceId?: string; readonly sessionId?: string },
): Promise<CreatedSession> {
  const registry = ctx.get('workspaceRegistry') as Registry | undefined
  const workspace = options.workspaceId === undefined ? undefined : registry?.get(options.workspaceId)
  if (options.workspaceId !== undefined && workspace === undefined) {
    throw new Error(`no workspace '${options.workspaceId}' is registered`)
  }
  // A caller-supplied id is validated rather than trusted: it becomes a
  // directory name on disk, so a value carrying a separator or a parent
  // reference must be refused here, with the caller's own blame, before it
  // reaches the host.
  if (options.sessionId !== undefined && !CALLER_SESSION_ID.test(options.sessionId)) {
    throw new Error(`invalid session id '${options.sessionId}'`)
  }
  const sessionId = options.sessionId ?? `session-${randomUUID()}`
  const gateway = ctx.get('apiProxy') as Gateway | undefined
  if (gateway !== undefined) {
    // Exactly one of the two: the request schema refuses both, because a
    // workspace already implies its own directory. With neither, the host's own
    // default project directory applies — the same one the desktop UI's
    // "new session" uses, rather than a guess at this process's cwd.
    const payload = workspace === undefined ? { sessionId } : { sessionId, workspaceId: workspace.id }
    const value = unwrap(await gateway.sessions.create({ rpcId: randomUUID(), payload }))
    const created = value as { readonly sessionId?: unknown }
    if (typeof created.sessionId !== 'string') throw new Error('the host created a session but named no id')
    return { sessionId: created.sessionId, workspaceId: workspace?.id ?? '' }
  }
  await composeHere(ctx, SessionId(sessionId), workspace)
  return { sessionId, workspaceId: workspace?.id ?? '' }
}

/**
 * Create an agent without the host API face, for a profile that mounts none.
 *
 * Mirrors what the gateway itself does: resolve the preset, mount it on the new
 * agent's scope so its tools and prompt sections exist before publication, and
 * pass the default model selection. A roster is optional — a deployment with no
 * presets composes nothing and every session shares the host composition.
 * @param ctx - the plugin context.
 * @param sessionId - the minted identity.
 * @param workspace - the workspace to file it under, when one was named.
 */
async function composeHere(ctx: Context, sessionId: SessionId, workspace: WorkspaceLike | undefined): Promise<void> {
  const presets = ctx.get('agentPresets') as Presets | undefined
  const defaults = ctx.get('agentDefaultModel') as DefaultModel | undefined
  let agentPreset: string | undefined
  let setup: ((agentCtx: never) => Promise<void>) | undefined
  if (presets !== undefined) {
    const resolved = await presets.resolve()
    agentPreset = resolved.id
    setup = async (agentCtx: never) => { await presets.mount(agentCtx, resolved.id) }
  }
  const selection = defaults?.currentSelection()
  await ctx.agents.create({
    sessionId,
    ...(selection === undefined ? {} : { agentOptions: { provider: selection.provider, model: selection.model } }),
    meta: {
      ...(workspace === undefined ? {} : { cwd: workspace.path }),
      ...(agentPreset === undefined ? {} : { agentPreset }),
    },
    ...(setup === undefined ? {} : { setup }),
  } as never)
  // Durable membership, so the session is accounted under the workspace rather
  // than merely grouped there by its directory.
  await workspace?.attachSession(sessionId)
}

/**
 * Make a session's agent live, resuming it when this process holds none.
 *
 * Every session on disk is cold after a restart, because a live agent exists
 * only in memory. The composer is offered for those sessions anyway, so the
 * first prompt has to bring the agent back rather than fail: this is what makes
 * "the box is always there" true rather than decorative.
 *
 * Resuming goes through the host's own `sessions.create` when one is mounted,
 * because a create with a known id resolves to a resume — the same call the
 * desktop UI makes, composing the preset the LOG recorded and validating the
 * directory. The session's own cwd is passed so the host adopts the directory
 * the session actually ran in; a resume naming any other is refused as a
 * conflict, which is the behaviour worth keeping.
 * @param ctx - the plugin context.
 * @param sessionId - the session to bring live.
 * @throws Error when the session cannot be resumed.
 */
export async function ensureLive(ctx: Context, sessionId: SessionId): Promise<void> {
  if (ctx.agents.get(sessionId) !== undefined) return
  const gateway = ctx.get('apiProxy') as Gateway | undefined
  if (gateway !== undefined) {
    const { session } = await ctx.sessionQuery.readSession(sessionId)
    const cwd = (session as { readonly cwd?: unknown }).cwd
    const payload = cwd === undefined ? { sessionId } : { sessionId, cwd }
    unwrap(await gateway.sessions.create({ rpcId: randomUUID(), payload }))
  } else {
    await resumeHere(ctx, sessionId)
  }
  if (ctx.agents.get(sessionId) === undefined) {
    throw new Error(`session ${sessionId} could not be resumed`)
  }
}

/**
 * Resume a cold session without the host API face, for a profile that mounts none.
 *
 * The preset is taken from the session's own header rather than from the
 * roster's default: resuming under a different preset than the log was written
 * with would compose the wrong tools for the history being continued.
 * @param ctx - the plugin context.
 * @param sessionId - the session to bring live.
 */
async function resumeHere(ctx: Context, sessionId: SessionId): Promise<void> {
  const presets = ctx.get('agentPresets') as Presets | undefined
  const defaults = ctx.get('agentDefaultModel') as DefaultModel | undefined
  const { session } = await ctx.sessionQuery.readSession(sessionId)
  const stored = (session as { readonly agentPreset?: unknown }).agentPreset
  let setup: ((agentCtx: never) => Promise<void>) | undefined
  if (presets !== undefined) {
    const resolved = await presets.resolve(typeof stored === 'string' ? stored : undefined)
    setup = async (agentCtx: never) => { await presets.mount(agentCtx, resolved.id) }
  }
  const selection = defaults?.currentSelection()
  await ctx.agents.resume({
    resumeSessionId: sessionId,
    ...(selection === undefined ? {} : { agentOptions: { provider: selection.provider, model: selection.model } }),
    ...(setup === undefined ? {} : { setup }),
  } as never)
}

/**
 * Register a workspace over an existing directory.
 *
 * Idempotent: a directory already owned by a workspace resolves to that
 * workspace with `created: false`, which is what makes a double tap harmless.
 * @param ctx - the plugin context.
 * @param path - the directory to own, in any spelling the host can canonicalize.
 * @returns the workspace, and whether this call is what made it.
 * @throws Error when the path is blank or is not an existing directory.
 */
export async function createWorkspace(ctx: Context, path: string): Promise<WorkspaceCreated> {
  if (path.trim() === '') throw new Error('a workspace needs a directory')
  const registry = ctx.get('workspaceRegistry') as Registry | undefined
  if (registry === undefined) throw new Error('this harness has no workspace registry')
  const before = new Set(registry.list().map(candidate => candidate.id))
  // `create` canonicalizes through realpath and reuses the existing record for a
  // directory that already has one, so a non-canonical spelling still lands on
  // the same workspace instead of making a second.
  const workspace = await registry.create(path)
  return {
    workspaceId: workspace.id,
    title: workspace.title,
    created: !before.has(workspace.id),
  }
}

/**
 * List one directory level, for the workspace browser.
 * @param ctx - the plugin context.
 * @param path - the directory to list; absent lists the host account's home.
 * @returns the level, its ancestry, and whether the host can create a folder here.
 * @throws Error when this host's picker offers no browsing at all.
 */
export async function browse(ctx: Context, path?: string): Promise<DirectoryView> {
  const capability = (ctx.get('directoryPicker') as Picker | undefined)?.capability()
  if (capability === undefined || capability.kind !== 'browse' || capability.list === undefined) {
    throw new Error('this host has no browsable directory picker')
  }
  const listing = await capability.list(path)
  return {
    path: listing.path,
    home: listing.home,
    // Crumb names are never hidden: an ancestor of the level you are looking at
    // is not a dotfile to be filtered, it is the way back up.
    crumbs: listing.crumbs.map(row => ({ name: row.name, path: row.path, hidden: false })),
    entries: listing.entries.map(row => ({ name: row.name, path: row.path, hidden: row.hidden })),
    truncated: listing.truncated === true,
    canCreateDirectory: capability.createDirectory !== undefined,
  }
}

/**
 * Create one directory inside an existing parent.
 * @param ctx - the plugin context.
 * @param path - the absolute existing parent directory.
 * @param name - a single path segment, with no separators.
 * @returns the created directory's absolute path.
 * @throws Error when this host cannot create directories, or the parent refuses.
 */
export async function makeDirectory(ctx: Context, path: string, name: string): Promise<string> {
  const capability = (ctx.get('directoryPicker') as Picker | undefined)?.capability()
  if (capability === undefined || capability.createDirectory === undefined) {
    throw new Error('this host cannot create a directory')
  }
  return await capability.createDirectory(path, name)
}

/**
 * Unwrap one host API result.
 *
 * The business failure travels in the result rather than as a rejection, so it
 * is raised here with the host's own message — the reason a create failed reads
 * the same in this page as it would in the desktop UI.
 * @param response - the host's response envelope.
 * @returns the success value.
 * @throws Error carrying the host's message, or a description of a shapeless answer.
 */
function unwrap(response: unknown): unknown {
  const result = (response as { readonly result?: unknown } | null | undefined)?.result
  if (typeof result !== 'object' || result === null) throw new Error('the host answered a create with no result')
  const branch = result as { readonly ok?: unknown; readonly value?: unknown; readonly error?: unknown }
  if (branch.ok === true) return branch.value
  const error = branch.error as { readonly code?: unknown; readonly message?: unknown } | undefined
  throw new Error(typeof error?.message === 'string'
    ? error.message
    : `the host refused the request (${String(error?.code ?? 'unknown')})`)
}
