/**
 * The session list: every session the harness knows, minus the archived ones,
 * grouped by workspace.
 *
 * `ctx.agents.roots()` answers "what can I command right now" from a live
 * in-process registry. That is a different question from "what exists", and the
 * difference is the whole screen: a restart empties the registry while every log
 * stays on disk, so a registry-driven list reads as "no sessions" on a box with
 * hundreds of them.
 *
 * Reading a session's log is the expensive part, because the query engine loads
 * the whole JSONL for any call that wants text. So each row's content is cached
 * by id and re-read only when that log actually grew. A cold session is read
 * once; a live one is read from memory. Neither blocks the response: the pump
 * runs in the background and a later summary broadcast fills in what the first
 * paint could not wait for.
 * @module
 */

import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionRecord } from '@deepseek-ai/dsh-session-query'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { Questions } from './questions.ts'
import { renderEvent } from './render.ts'
import type { SessionListing, SessionSummary, WorkspaceGroup } from './types.ts'

/** Longest preview line kept on a row. */
const LAST_LINE_MAX = 120

/** How long one corpus listing is reused before persistence is read again. */
const LISTING_TTL_MS = 5_000

/** Session logs read at once while filling the cache. */
const READ_CONCURRENCY = 6

/** Group order for sessions no workspace record owns; every real workspace sorts before this. */
const UNGROUPED_ORDER = 1_000_000

/** One session's content, derived from a single log read. */
interface Derived {
  readonly title: string
  readonly lastLine: string
  /**
   * Whether the read log renders no transcript frame at all.
   *
   * False when the log has not been read: a row must never claim a session is
   * empty on the strength of a read that has not happened, or a session that is
   * merely unread would look the same as one with nothing in it.
   */
  readonly empty: boolean
  readonly time: number
  readonly seq: number
}

/** A row with nothing derived yet, which is a real state rather than a failure. */
function underived(header: SessionHeader): Derived {
  return { title: '', lastLine: '', empty: false, time: header.createdAt, seq: -1 }
}

/** The workspace registry surface this plugin reads. Structural, so the plugin never imports the package. */
interface Registry {
  list(): readonly Workspace[]
  readonly archivedSessionIds: readonly string[]
}

/** The session list, cached across requests and broadcasts. */
export class Corpus {
  private readonly ctx: Context
  private readonly changed: () => void
  /**
   * The workspace registry, captured through an optional injection.
   *
   * Cordis throws on reading a service the plugin did not inject, so a plain
   * property read here would throw on every call and be swallowed by the
   * caller's catch — leaving grouping and archive filtering silently dead while
   * the screen still looked plausible. Injecting optionally both proves the
   * binding and keeps this plugin bootable on a profile without the row.
   */
  private registry: Registry | undefined
  /** Derived content by session id. */
  private readonly derived = new Map<string, Derived>()
  /** Sessions whose log grew since they were last read. */
  private readonly stale = new Set<string>()
  /** Ids queued for a background read. */
  private readonly queued = new Set<string>()
  /**
   * Ids whose read produced nothing usable.
   *
   * Without this, a header the listing cannot resolve would be re-queued on
   * every request forever, re-reading nothing each time.
   */
  private readonly unattemptable = new Set<string>()
  private snapshot: readonly SessionRecord[] = []
  private listedAt = 0
  private pumping = false

  /**
   * Rows' visible content changed, so a broadcast is worth making.
   *
   * Bumped rather than compared: the alternative is serializing every row on
   * every refresh to discover it is identical, and on a phone link the payload
   * is exactly what the skip exists to avoid.
   */
  version = 0

  /**
   * @param ctx - the plugin context, for the registry, the query engine, and live agents.
   * @param changed - called when rows changed, so the stream can push them.
   */
  constructor(ctx: Context, changed: () => void) {
    this.ctx = ctx
    this.changed = changed
    ctx.inject(['workspaceRegistry'], (child: Context) => {
      const registry = (child as Context & { workspaceRegistry: Registry }).workspaceRegistry
      this.registry = registry
      child.effect(() => () => {
        // A replacement registry must not be cleared by an older disposer.
        if (this.registry === registry) this.registry = undefined
      }, 'webGui.corpusWorkspaceRegistry')
    })
  }

  /**
   * Mark one session's cached content as stale.
   * @param id - the session whose durable log grew.
   */
  noteEvent(id: string): void {
    if (!this.derived.has(id)) return
    this.stale.add(id)
    this.queued.add(id)
    // The version is bumped by the re-read, not here: an event only queues the
    // work, and broadcasting before the content moves would send every client
    // the same rows twice.
    this.pump()
  }

  /**
   * Every session except the archived ones, newest first.
   *
   * Never waits for a log read it has not already done: the first paint carries
   * whatever is cached, and the pump's completion pushes the rest.
   * @param questions - the questions this server is holding, for the ask badges.
   * @returns one row per session, ready to group by `workspaceId`.
   */
  async rows(questions: Questions): Promise<SessionSummary[]> {
    return (await this.listing(questions)).rows
  }

  /**
   * The rows, and every heading they file under.
   *
   * The headings are the registry's own workspaces, including ones holding no
   * visible session. Deriving them from rows instead made an empty workspace
   * disappear, so a project the reader had registered but not yet worked in
   * looked like it did not exist. The desktop UI lists every workspace for the
   * same reason.
   *
   * Never waits for a log read it has not already done: the first paint carries
   * whatever is cached, and the pump's completion pushes the rest.
   * @param questions - the questions this server is holding, for the ask badges.
   * @returns every row and every heading to render.
   */
  async listing(questions: Questions): Promise<SessionListing> {
    const records = await this.records()
    const archived = this.archived()
    const { bySession, ordered } = this.grouping(records, archived)
    const rows: SessionSummary[] = []
    for (const record of records) {
      const id = record.header.id
      if (archived.has(id)) continue
      const group = bySession.get(id) ?? this.fallback(record.header)
      const derived = this.derived.get(id) ?? underived(record.header)
      const agent = this.ctx.agents.get(id)
      rows.push({
        id,
        title: derived.title === '' ? (record.header.cwd ?? 'Untitled session') : derived.title,
        running: agent?.status === 'running',
        latestSeq: derived.seq,
        workspace: group.title,
        workspaceId: group.id,
        workspaceOrder: group.order,
        lastLine: derived.lastLine,
        empty: derived.empty,
        time: derived.time,
        // Every visible session accepts a prompt. A cold one — a log with no
        // live agent, which is every session after a restart — is resumed when
        // a prompt arrives rather than refused, so the capability belongs to
        // the session instead of to whichever agents happen to be live.
        actions: agent?.status === 'running' ? ['send', 'stop'] : ['send'],
        asks: questions.of(id),
      })
      this.want(record)
    }
    rows.sort((left, right) => right.time - left.time)
    return { rows, groups: ordered }
  }

  /**
   * The full corpus, re-listed no more often than the TTL.
   *
   * Live sessions missing from the listing are merged in, so a session created
   * since the last read appears immediately instead of at the next expiry.
   * @returns every session the engine can name.
   */
  private async records(): Promise<readonly SessionRecord[]> {
    const now = Date.now()
    if (this.snapshot.length === 0 || now - this.listedAt >= LISTING_TTL_MS) {
      this.snapshot = await this.ctx.sessionQuery.listSessions()
      this.listedAt = now
    }
    const known = new Set(this.snapshot.map(record => record.header.id))
    let merged: readonly SessionRecord[] = this.snapshot
    for (const agent of this.ctx.agents.roots()) {
      if (known.has(agent.session.id)) continue
      if (merged === this.snapshot) merged = [...this.snapshot]
      ;(merged as SessionRecord[]).push({ header: agent.session.header, live: true, persisted: false })
    }
    return merged
  }

  /**
   * The archived set, which the display hides but never deletes.
   * @returns session ids the reader has archived.
   */
  private archived(): ReadonlySet<string> {
    return new Set(this.registry?.archivedSessionIds ?? [])
  }

  /**
   * File every session under the workspace that owns it, by registry order.
   *
   * Membership is taken from the registry's own account rather than by
   * comparing paths here: the registry already validates each candidate's
   * header cwd against its canonical directory, and a second opinion computed
   * from raw path strings would disagree with it on symlinks and trailing
   * separators. A session no record owns still appears, grouped by its own
   * directory after every real workspace.
   *
   * Every registry workspace becomes a group even when nothing is filed under
   * it, so the headings follow the reader's own workspaces rather than the logs
   * that happen to exist today.
   * @param records - the sessions being listed.
   * @param archived - the archive set, so a directory known only for archived work is not a heading.
   * @returns the group for each session id, and every group in render order.
   */
  private grouping(records: readonly SessionRecord[], archived: ReadonlySet<string>): {
    readonly bySession: Map<string, WorkspaceGroup>
    readonly ordered: WorkspaceGroup[]
  } {
    const bySession = new Map<string, WorkspaceGroup>()
    const owned = new Set<string>()
    const workspaces = this.registry?.list() ?? []
    const byPath = new Map<string, WorkspaceGroup>()
    const ordered: WorkspaceGroup[] = []
    workspaces.forEach((workspace, index) => {
      const ref: WorkspaceGroup = { id: workspace.id, title: workspace.title, order: index }
      byPath.set(normalizePath(workspace.path), ref)
      // Listed before its members are counted: an empty workspace is still a
      // heading the reader expects to see.
      ordered.push(ref)
      for (const id of workspace.sessionIds) {
        bySession.set(id, ref)
        owned.add(id)
      }
    })
    const orphans = new Map<string, SessionRecord[]>()
    for (const record of records) {
      if (owned.has(record.header.id)) continue
      // An archived session is not a reason to show a directory. A workspace the
      // reader created keeps its heading when empty, but a `cwd:` group is
      // inferred from the logs alone — so a directory whose every session has
      // been archived is not a place with nothing in it, it is not a place at
      // all. Showing it would put junk headings (`/root`, `~/.dsh`) on a list
      // the reader never asked about.
      if (archived.has(record.header.id)) continue
      // Same directory, different id spelling. The registry's account and the
      // corpus's headers do not always agree on a session's id (some are stored
      // with a `session-` prefix and some without), so matching on the id alone
      // would file one directory under two headings. The path is the durable
      // fact both sides share, and workspaces are unique per canonical path.
      const cwd = record.header.cwd
      if (cwd !== undefined) {
        const ref = byPath.get(normalizePath(cwd))
        if (ref !== undefined) {
          bySession.set(record.header.id, ref)
          owned.add(record.header.id)
          continue
        }
      }
      const key = cwd ?? ''
      const bucket = orphans.get(key)
      if (bucket === undefined) orphans.set(key, [record])
      else bucket.push(record)
    }
    const sorted = [...orphans.keys()].sort()
    sorted.forEach((cwd, index) => {
      const ref: WorkspaceGroup = {
        id: cwd === '' ? '' : `cwd:${cwd}`,
        title: cwd === '' ? 'No working directory' : basename(cwd),
        order: UNGROUPED_ORDER + index,
      }
      ordered.push(ref)
      for (const record of orphans.get(cwd) ?? []) bySession.set(record.header.id, ref)
    })
    return { bySession, ordered }
  }

  /** The group for a session the table did not cover. */
  private fallback(header: SessionHeader): WorkspaceGroup {
    const cwd = header.cwd ?? ''
    return {
      id: cwd === '' ? '' : `cwd:${cwd}`,
      title: cwd === '' ? 'No working directory' : basename(cwd),
      order: UNGROUPED_ORDER,
    }
  }

  /** Queue one session for a read when it has none cached yet. */
  private want(record: SessionRecord): void {
    const id = record.header.id
    if (this.unattemptable.has(id)) return
    if (this.derived.has(id) && !this.stale.has(id)) return
    this.queued.add(id)
    this.pump()
  }

  /**
   * Read what is queued, a batch at a time, in the background.
   *
   * Single-flight: a request that arrives mid-pump adds to the queue rather than
   * starting a second pass over the same logs.
   */
  private pump(): void {
    if (this.pumping || this.queued.size === 0) return
    this.pumping = true
    void this.drain()
  }

  private async drain(): Promise<void> {
    try {
      while (this.queued.size > 0) {
        const batch = [...this.queued].slice(0, READ_CONCURRENCY)
        for (const id of batch) this.queued.delete(id)
        await Promise.all(batch.map(async id => {
          const header = this.headerOf(id)
          if (header === undefined) {
            this.unattemptable.add(id)
            return
          }
          this.derived.set(id, await this.derive(header))
          this.stale.delete(id)
        }))
        this.version += 1
      }
      // One broadcast per drain, not one per batch: refilling a few hundred cold
      // rows would otherwise re-serialize the whole list sixty times and make
      // every client re-render for each one.
      this.changed()
    } catch {
      // The pump is best-effort: rows fall back to their header and the next
      // event retries. Throwing here would reject a floating promise and take
      // the process with it, which is the failure mode this plugin exists to avoid.
    } finally {
      this.pumping = false
    }
    // An id queued between the last check and the flag clearing would otherwise
    // wait for an unrelated event to be read.
    if (this.queued.size > 0) this.pump()
  }

  /** The header the listing holds for one session, which the read path needs for its fallback. */
  private headerOf(id: string): SessionHeader | undefined {
    for (const record of this.snapshot) if (record.header.id === id) return record.header
    return this.ctx.agents.get(id)?.session.header
  }

  /**
   * Read one session's content.
   *
   * A live session is read from the agent's in-memory log: it is already there,
   * and a disk round trip for a session being actively written is both slower
   * and staler than the object the agent is appending to.
   * @param header - the session to read.
   * @returns the row's derived content.
   */
  private async derive(header: SessionHeader): Promise<Derived> {
    try {
      const agent = this.ctx.agents.get(header.id)
      if (agent !== undefined) {
        const events = agent.session.events
        if (events !== undefined) return summarize(header, events)
      }
      const loaded = await this.ctx.sessionQuery.readSession(header.id)
      return summarize(loaded.session, loaded.events)
    } catch {
      // A log that cannot be read still deserves a row: its header names it.
      // Nothing may propagate, because one unreadable session must not stop the
      // batch it shares with fifty readable ones.
      return underived(header)
    }
  }
}

/**
 * Compare two directory spellings for grouping.
 *
 * A light normalization rather than `fs.realpath`: this runs per session on the
 * first paint, and a syscall each would trade the screen's latency for a case
 * the path strings already cover. A session reached through a symlinked
 * directory groups under its own name instead of its workspace's — a cosmetic
 * fallback, never a wrong grouping of a session into someone else's workspace.
 * @param path - a directory path.
 * @returns the path without trailing separators.
 */
function normalizePath(path: string): string {
  return path.replace(/\/+$/, '')
}

/**
 * Fold one log into what a row shows.
 * @param header - the session header, for the timestamp fallback.
 * @param events - the session's events in seq order.
 * @returns the row's derived content.
 */
function summarize(header: SessionHeader, events: readonly SessionEvent[]): Derived {
  let title = ''
  let lastLine = ''
  let time = header.createdAt
  let seq = -1
  for (const event of events) {
    if (event.type === 'session/title') title = event.data.title
    const line = preview(event)
    if (line !== null) {
      lastLine = line
      time = event.time
    }
    if (event.seq > seq) seq = event.seq
  }
  // A preview line proves content, so the expensive check is only reached for
  // logs with no message text — the short boot stubs, which are cheap to scan.
  // It asks the same question the transcript asks, so a row and its own page
  // can never disagree about whether the session is empty.
  const empty = lastLine === '' && !events.some(event => renderEvent(event, header.id) !== null)
  return { title, lastLine, empty, time, seq }
}

/**
 * Reduce markdown to the words a reader would actually read.
 *
 * A row is prose, not a document: fence markers and emphasis asterisks are
 * noise there, and a row full of backticks says nothing about the session.
 * @param source - the message's raw text.
 * @returns a single line of plain words.
 */
function plain(source: string): string {
  return source
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/(^|\s)[*_]([^*_]+)[*_]/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Reduce one event to a row's preview line.
 * @param event - a durable event.
 * @returns the line, or null when the event says nothing a reader would recognize.
 */
function preview(event: SessionEvent): string | null {
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return null
  const message = event.type === 'user/message' ? event.data : event.data.message
  let out = ''
  for (const block of message.content) if (block.type === 'text') out += block.text
  const line = plain(out)
  if (line === '') return null
  return line.length > LAST_LINE_MAX ? `${line.slice(0, LAST_LINE_MAX)}…` : line
}
