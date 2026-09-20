/**
 * The session list: every session the harness knows, minus the ones the reader
 * should not see (archived, and the agents' own subagent children), grouped by
 * workspace.
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

import { existsSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionRecord } from '@deepseek-ai/dsh-session-query'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { answerIndex, renderEvent, settledAsks } from './render.ts'
import { UNKNOWN_WORKTREE } from './types.ts'
import type { PendingApproval, PendingAsk, SessionListing, SessionSummary, WorkspaceGroup, WorktreeGroup } from './types.ts'
import { identify, label, worktreesIn } from './worktree.ts'

/**
 * What one session is waiting on a person for, named by what it does rather
 * than by which class does it.
 *
 * Structural on purpose: the corpus needs one answer — what is this session
 * waiting on — and should not care whether that comes from a table in this
 * process or from the harness's own stream. Depending on the class instead is
 * what made a whole feature quietly follow the wrong seam. Questions and
 * permissions are two questions, so the interface carries both: they ride
 * different seams on the host and are settled through different endpoints.
 */
export interface AskSource {
  of(sessionId: string): PendingAsk[]
  approvalsOf(sessionId: string): PendingApproval[]
  /**
   * The prompt keys this server holds for a session but the log does not show yet.
   *
   * Live for the same reason the questions are: a prompt is accepted and lands
   * in the log between requests without the record set moving at all, so this
   * cannot be cached with the row's shape.
   */
  sendingOf(sessionId: string): readonly string[]
}

/** Longest preview line kept on a row. */
const LAST_LINE_MAX = 120

/** How long one corpus listing is reused before persistence is read again. */
const LISTING_TTL_MS = 5_000

/** Session logs read at once while filling the cache. */
const READ_CONCURRENCY = 6

/**
 * How long events are collected before the rows they touched are read again.
 *
 * A session being written emits events continuously, and each one would
 * otherwise re-read and re-broadcast every row it touched. One pass per window
 * keeps a long turn's cost flat instead of growing with the turn's length.
 */
const FOLD_DELAY_MS = 200

/** Group order for sessions no workspace record owns; every real workspace sorts before this. */
const UNGROUPED_ORDER = 1_000_000

/**
 * Characters kept from a session's first prompt, for naming an untitled session.
 *
 * Holding whole prompts for every session on the box would keep megabytes alive
 * to answer one question.
 */
const OPENING_MAX = 2_000

/**
 * Ancestor directories credited for one file write.
 *
 * A write is counted against its parent and that parent's parents, so a change
 * deep inside a checkout still counts toward the checkout root. Bounded because
 * the tally is per session and only the first few levels can ever be a worktree;
 * walking to `/` would add a count to `/root` and `/` for every edit on the box.
 */
const WRITE_ANCESTORS = 12

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
  /**
   * The session's first prompt, used to name a session that never titled itself.
   */
  readonly opening: string
  /**
   * How many files this session wrote under each directory, keyed by absolute path.
   *
   * Which worktree a session belongs to is decided by where it actually wrote,
   * because that is evidence of work rather than a description of it. The
   * harness stores one cwd per session and it is always the project folder, and
   * the opening prompt is unreliable — it names a checkout in well under half of
   * real sessions, and mentions others in passing. A file the session edited is
   * a fact about where the work happened.
   *
   * Counted per write rather than per distinct file, so a session that touched
   * one worktree forty times and glanced at another once is not a close call.
   */
  readonly writes: ReadonlyMap<string, number>
}

/**
 * Everything about a listing that depends on the record set rather than on any
 * session's content.
 *
 * Held together rather than as separate caches because they are computed from
 * one another — the worktree headings need the workspace grouping, which needs
 * the hidden set — so they are only ever valid as a set. One field to check,
 * one field to drop.
 */
interface Shape {
  /** The record set this was computed from, compared by identity. */
  readonly from: readonly SessionRecord[]
  /**
   * The registry state this was computed against.
   *
   * The record set is not the only input: a workspace added, renamed or
   * removed, and a session archived from another surface, both change the shape
   * while every session on the list still exists. The harness announces those
   * on a seam this plugin does not subscribe to, so the shape is keyed on a
   * cheap digest of the registry instead of trusting a notification to arrive.
   */
  readonly registry: string
  /** Sessions kept off the list, after stranded children are handed back. */
  readonly hidden: ReadonlySet<string>
  /** Only the records that produce a row, so the row loop stops walking hidden ones. */
  readonly visible: readonly SessionRecord[]
  readonly bySession: ReadonlyMap<string, WorkspaceGroup>
  readonly groups: readonly WorkspaceGroup[]
  readonly trees: ReadonlyMap<string, WorktreeGroup>
  readonly worktrees: readonly WorktreeGroup[]
}

/** One checkout's heading and the directory whose writes belong to it. */
interface Rooted {
  readonly heading: WorktreeGroup
  readonly root: string
}

/** A row with nothing derived yet, which is a real state rather than a failure. */
function underived(header: SessionHeader): Derived {
  return { title: '', lastLine: '', empty: false, time: header.createdAt, seq: -1, opening: '', writes: new Map() }
}

/** One row's content, and how much of its log that content already covers. */
interface Fold {
  readonly derived: Derived
  /** How many leading events are folded into {@link Fold.derived}. */
  readonly count: number
  /** The seq at that boundary, so a log rewritten under us is re-read rather than trusted. */
  readonly lastSeq: number
}

/** The workspace registry surface this plugin reads. Structural, so the plugin never imports the package. */
interface Registry {
  list(): readonly Workspace[]
  readonly archivedSessionIds: readonly string[]
  /**
   * Hide one session from every grouping surface, durably.
   *
   * The registry keeps the session's workspace slot, so this hides rather than
   * deletes: no log is touched and the transcript stays readable at its own URL.
   * Already-archived ids resolve without writing, which is what makes a retry
   * after a lost response harmless.
   */
  archiveSession(sessionId: string): Promise<void>
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
  /** Row content by session id, with the log boundary each row was folded through. */
  private readonly folded = new Map<string, Fold>()
  /** Sessions whose log grew since they were last read. */
  private readonly stale = new Set<string>()
  /** Whether a directory a session worked in is gone, so the check is made once. */
  private readonly vanished = new Map<string, boolean>()
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
  /**
   * The re-list in flight, so concurrent requests share one call.
   *
   * The engine's own `listSessions` is not guaranteed to be fast — it is a
   * network call to the harness in the standalone process, and a harness busy
   * with a turn has been measured taking tens of seconds to answer it. Without
   * this, every request arriving in that window started its *own* call, so a
   * slow list was multiplied by the number of readers waiting on it.
   */
  private relisting: Promise<void> | undefined
  private pumping = false
  /** The coalesced re-read, while one is pending. */
  private timer: ReturnType<typeof setTimeout> | undefined
  /**
   * The snapshot's shape, computed once and reused until the snapshot changes.
   *
   * Which sessions are hidden, which workspace each belongs to, and which
   * worktree heading each files under are all functions of the record set and
   * the registry — **not** of a session's content. Rebuilding them per request
   * meant walking all 192 records to emit 27 rows, on a list whose shape had
   * not moved: measured at 2.3 ms of the 6.4 ms a warm listing cost, repeated
   * for every reader and every broadcast.
   *
   * Invalidated by {@link Corpus.reshape}, which every path that can change the
   * shape already calls.
   */
  private shape: Shape | undefined

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
    ctx.effect(() => () => {
      if (this.timer !== undefined) clearTimeout(this.timer)
    }, 'webGui.corpusFoldTimer')
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
    if (!this.folded.has(id)) {
      // A session the snapshot has never seen. It was just created, and the
      // corpus cannot fold a row it does not know exists, so the snapshot is
      // expired rather than ignored: the next listing re-lists and the row
      // appears immediately instead of at the TTL's convenience.
      this.listedAt = 0
      this.changed()
      return
    }
    this.stale.add(id)
    this.queued.add(id)
    // The version is bumped by the re-read, not here: an event only queues the
    // work, and broadcasting before the content moves would send every client
    // the same rows twice.
    this.schedule()
  }

  /**
   * Every session except the hidden ones, newest first.
   *
   * Never waits for a log read it has not already done: the first paint carries
   * whatever is cached, and the pump's completion pushes the rest.
   * @param questions - the questions this server is holding, for the ask badges.
   * @returns one row per session, ready to group by `workspaceId`.
   */
  async rows(questions: AskSource): Promise<SessionSummary[]> {
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
  async listing(questions: AskSource): Promise<SessionListing> {
    const records = await this.records()
    // The questions are live, so attribution is the one part that cannot be
    // cached with the shape: a child's pending ask arrives and settles between
    // requests without the record set moving at all.
    const { carried } = this.attributed(records, questions)
    const { hidden, visible, bySession, groups, trees, worktrees } = await this.shaped(records, questions)
    // One question for the whole listing: archiving is a registry capability,
    // not a per-session one.
    const canArchive = this.registry !== undefined
    const rows: SessionSummary[] = []
    // Only the records that produce a row. The hidden ones were filtered when
    // the shape was built, so a box whose subagents outnumber its sessions six
    // to one no longer walks them on every request.
    for (const record of visible) {
      const id = record.header.id
      const group = bySession.get(id) ?? this.fallback(record.header)
      const derived = this.folded.get(id)?.derived ?? underived(record.header)
      const agent = this.ctx.agents.get(id)
      const tree = trees.get(id)
      rows.push({
        id,
        // An explicit user rename wins, then the first prompt's content words,
        // then a plain statement of fact. A model-generated title is not in this
        // chain at all: it reads as invented next to a name made of the words
        // the reader actually typed.
        // The cwd is deliberately not in this chain either:
        // every session in a workspace shares one, so a path names the folder
        // the reader is already looking at rather than the session.
        title: derived.title !== '' ? derived.title : (nameFromPrompt(derived.opening) || 'New session'),
        running: agent?.status === 'running',
        latestSeq: derived.seq,
        workspace: group.title,
        workspaceId: group.id,
        workspaceOrder: group.order,
        worktreeId: tree?.id ?? '',
        worktree: tree?.title ?? '',
        lastLine: derived.lastLine,
        empty: derived.empty,
        time: derived.time,
        // Every visible session accepts a prompt. A cold one — a log with no
        // live agent, which is every session after a restart — is resumed when
        // a prompt arrives rather than refused, so the capability belongs to
        // the session instead of to whichever agents happen to be live.
        //
        // `archive` rides the same list so the page branches on what this
        // server can actually do rather than on a rule written into the client:
        // a profile with no workspace registry sends no archive action and the
        // button is simply absent, instead of appearing and then failing.
        actions: [
          ...(agent?.status === 'running' ? ['send' as const, 'stop' as const] : ['send' as const]),
          ...(canArchive ? ['archive' as const] : []),
        ],
        // Read live, never folded into the cached shape: a prompt is accepted
        // and lands in the log between listings without the record set moving.
        sending: questions.sendingOf(id),
        asks: [...(carried.get(id)?.asks ?? []), ...questions.of(id)],
        approvals: [...(carried.get(id)?.approvals ?? []), ...questions.approvalsOf(id)],
      })
      this.want(record)
    }
    rows.sort((left, right) => right.time - left.time)
    // `hidden` is read above only through `visible`; naming it here keeps the
    // destructure honest about what the shape carries.
    void hidden
    return { rows, groups, worktrees }
  }

  /**
   * The listing's shape for one record set, computed once and then reused.
   *
   * Everything here is a function of which sessions exist plus the registry:
   * who is hidden, which workspace owns each session, which worktree heading it
   * files under, and the order the headings render in. None of it moves when a
   * session's *content* changes, which is what almost every refresh actually
   * is — a log grew, so one row's title or preview line moved.
   *
   * The one live input is attribution: a hidden child holding a question is
   * handed its row back, and questions arrive and settle constantly. So the
   * stranded set is recomputed per call and applied on top of the cached hidden
   * set, which costs a walk of the hidden ids rather than a rebuild of the
   * whole shape.
   * @param records - the session set the shape is built for.
   * @param questions - the live pending tables, for the stranded-child carve-out.
   * @returns the shape, from cache when the record set has not changed.
   */
  private async shaped(records: readonly SessionRecord[], questions: AskSource): Promise<Shape> {
    const registry = this.registryKey()
    const cached = this.shape
    if (cached !== undefined && cached.from === records && cached.registry === registry) {
      return this.carved(cached, records, questions)
    }
    // The set before any carve-out. It is what gets cached, because the
    // carve-out is recomputed per request against it: subtracting first and
    // caching the result would make the next request ask "is this stranded
    // child hidden?" of a set it had already been removed from, the answer
    // would be no, and the child's row would vanish the moment the shape was
    // reused — which is exactly what the carve-out exists to prevent.
    const base = new Set(this.hidden(records))
    const carveOut = this.stranded(records, base, questions)
    const hidden = new Set(base)
    for (const id of carveOut) hidden.delete(id)
    const { bySession, ordered } = this.grouping(records, hidden)
    const trees = await this.worktrees(records, hidden, bySession, ordered)
    const shape: Shape = {
      from: records,
      registry,
      hidden: base,
      visible: records.filter(record => !hidden.has(record.header.id)),
      bySession,
      groups: ordered,
      trees: trees.bySession,
      worktrees: trees.ordered,
    }
    this.shape = shape
    return shape
  }

  /**
   * Apply the live stranded carve-out to a cached shape.
   *
   * The only part of the shape that moves without the record set moving: a
   * hidden child's question arrives, so its row has to appear, and settles, so
   * the row goes away again. Everything else on the cached shape still holds.
   * @param cached - the shape for this record set, with the uncarved hidden set.
   * @param records - the sessions being listed.
   * @param questions - the live pending tables.
   * @returns the cached shape when nothing is stranded, or a copy with those rows restored.
   */
  private carved(cached: Shape, records: readonly SessionRecord[], questions: AskSource): Shape {
    const stranded = this.stranded(records, cached.hidden, questions)
    if (stranded.size === 0) return cached
    const hidden = new Set(cached.hidden)
    for (const id of stranded) hidden.delete(id)
    // `hidden` on the copy stays the uncarved set, so a later reuse of this same
    // shape asks the same question of the same set and gets the same answer.
    return { ...cached, visible: records.filter(record => !hidden.has(record.header.id)) }
  }

  /** Drop the cached shape, so the next listing recomputes who is hidden and where each row files. */
  private reshape(): void {
    this.shape = undefined
  }

  /**
   * A cheap digest of everything the registry contributes to the shape.
   *
   * Ids and titles, plus the archive set — the fields the headings and the
   * hidden set are actually built from. Compared as one string so a workspace
   * renamed elsewhere, or a session archived from another surface, is noticed
   * without this plugin subscribing to a notification the host may not send.
   * Cheap on purpose: it runs once per listing over a list that holds a dozen
   * entries, where the work it guards walks every session on the box.
   * @returns a string that changes whenever the registry's shape-relevant state does.
   */
  private registryKey(): string {
    const registry = this.registry
    if (registry === undefined) return ''
    let key = ''
    // `sessionIds` rides along because membership is what files a session under
    // a workspace: a session attached elsewhere moves headings without any
    // other field changing.
    for (const workspace of registry.list()) {
      key += `${workspace.id}\u0000${workspace.title}\u0000${workspace.path}\u0000${workspace.sessionIds.length}\u0001`
    }
    // The archive set is summarised by its size rather than its contents.
    // Archiving through this server calls `reshape` directly, so the only case
    // left for this to catch is a change made elsewhere — and every such change
    // adds or removes an id, which moves the count. Joining a few hundred ids
    // per request to detect what a number already detects is exactly the work
    // this cache exists to remove.
    return `${key}\u0002${registry.archivedSessionIds.length}`
  }

  /**
   * Every worktree heading, and the one each session files under.
   *
   * The middle level of the hierarchy, and the level that decides the shape of
   * the whole screen. Three rules, in order of how much they cost:
   *
   * 1. **Every worktree on disk is a heading**, listed whether or not a session
   *    sits under it. A checkout is a place the reader made and can work in, so
   *    the headings describe the project rather than this week's activity.
   * 2. **Every workspace also gets an "Unknown worktree" heading** when any of
   *    its sessions could not be placed. The harness records one cwd per
   *    session and it is the project folder, never the checkout, so a session
   *    that never named a worktree genuinely has no derivable one.
   * 3. **A session is never left at the workspace level.** Placed or not, it
   *    hangs under a worktree heading, so the list is always exactly three deep
   *    and a row is always a leaf.
   *
   * Worktrees are found by looking inside the workspace directory rather than
   * above the session's cwd, because the real layout is a project folder
   * holding a bare repository and a checkout per branch, with every session
   * started on the folder itself.
   * @param records - the sessions being listed.
   * @param hidden - the hidden set, so a hidden session cannot create a heading.
   * @param bySession - the workspace each session files under, which the worktree nests inside.
   * @param groups - every workspace heading, so each is scanned for its worktrees.
   * @returns each session's worktree, and every heading in render order.
   */
  private async worktrees(
    records: readonly SessionRecord[],
    hidden: ReadonlySet<string>,
    bySession: ReadonlyMap<string, WorkspaceGroup>,
    groups: readonly WorkspaceGroup[],
  ): Promise<{ bySession: Map<string, WorktreeGroup>; ordered: WorktreeGroup[] }> {
    // Every workspace's checkouts, read once per workspace rather than per
    // session: one directory listing answers for all 300 of its sessions.
    const byWorkspace = new Map<string, WorktreeGroup[]>()
    const rooted = new Map<string, Rooted[]>()
    await Promise.all(groups.map(async group => {
      const dir = this.pathOf(group)
      const checkouts = dir === '' ? [] : await worktreesIn(dir)
      const headings: WorktreeGroup[] = []
      const roots: Rooted[] = []
      for (const checkout of checkouts) {
        const heading: WorktreeGroup = {
          id: identify(checkout),
          workspaceId: group.id,
          title: label(checkout),
          order: 0,
        }
        headings.push(heading)
        roots.push({ heading, root: checkout.root })
      }
      byWorkspace.set(group.id, headings)
      rooted.set(group.id, roots)
    }))

    const out = new Map<string, WorktreeGroup>()
    const unplaced = new Set<string>()
    // Headings minted for checkouts that no longer exist, keyed by root so
    // several sessions from one removed worktree share a single heading.
    const departed = new Map<string, WorktreeGroup>()
    for (const record of records) {
      const id = record.header.id
      if (hidden.has(id)) continue
      const workspace = bySession.get(id)
      const roots = workspace === undefined ? undefined : rooted.get(workspace.id)
      const heading = roots === undefined ? undefined : this.placement(id, roots)
      if (heading !== undefined) {
        out.set(id, heading)
        continue
      }
      // No live checkout matched. The session may still have worked in one that
      // has since been removed — a finished branch whose worktree was pruned —
      // and its own evidence names it. Discarding that would file a session
      // that wrote three hundred files under "Unknown worktree" purely because
      // the directory was tidied up afterwards.
      const gone = workspace === undefined ? undefined : this.departedRoot(id, workspace)
      if (gone === undefined) {
        if (workspace !== undefined) unplaced.add(workspace.id)
        continue
      }
      let heard = departed.get(gone)
      if (heard === undefined) {
        // Named, and marked. The name is real and the reader knows it; the
        // marker plus `departed` keep it from reading as a checkout still on
        // disk — nothing can be opened or started in a folder that is gone.
        heard = { id: `wt:${gone}`, workspaceId: workspace.id, title: `${basename(gone)} (deleted)`, order: 0, departed: true }
        departed.set(gone, heard)
        const headings = byWorkspace.get(workspace.id)
        if (headings === undefined) byWorkspace.set(workspace.id, [heard])
        else headings.push(heard)
      }
      out.set(id, heard)
    }

    // The synthetic bucket, added only to workspaces that need one so a project
    // whose every session is placed shows no "Unknown worktree" heading at all.
    for (const workspaceId of unplaced) {
      const bucket: WorktreeGroup = {
        id: UNKNOWN_WORKTREE,
        workspaceId,
        title: 'Unknown worktree',
        order: 0,
      }
      const headings = byWorkspace.get(workspaceId)
      if (headings === undefined) byWorkspace.set(workspaceId, [bucket])
      else headings.push(bucket)
    }
    // Sessions that named no worktree file under their workspace's bucket, so a
    // row is a leaf under a heading rather than a child of the workspace.
    for (const record of records) {
      const id = record.header.id
      if (hidden.has(id) || out.has(id)) continue
      const workspace = bySession.get(id)
      if (workspace === undefined) continue
      const bucket = byWorkspace.get(workspace.id)?.find(heading => heading.id === UNKNOWN_WORKTREE)
      if (bucket !== undefined) out.set(id, bucket)
    }

    // Ordered by workspace, so the wire order reads the way the screen does.
    // Within a workspace: checkouts by name, then the unknown bucket last —
    // it is a fallback, not a place, and belongs after the real ones.
    const ordered: WorktreeGroup[] = []
    const rank = new Map(groups.map(group => [group.id, group.order]))
    const workspaces = [...byWorkspace.keys()]
      .sort((left, right) => (rank.get(left) ?? 0) - (rank.get(right) ?? 0) || left.localeCompare(right))
    for (const workspaceId of workspaces) {
      const bucket = byWorkspace.get(workspaceId) ?? []
      bucket
        .sort((left, right) => {
          if (left.id === UNKNOWN_WORKTREE) return right.id === UNKNOWN_WORKTREE ? 0 : 1
          if (right.id === UNKNOWN_WORKTREE) return -1
          return left.title.localeCompare(right.title) || left.id.localeCompare(right.id)
        })
        .forEach((group, index) => { ordered.push({ ...group, order: index }) })
    }
    // The ordered copies carry the final order, so rows must name those rather
    // than the zero-order originals they were built from.
    const byKey = new Map(ordered.map(group => [`${group.workspaceId}\u0000${group.id}`, group]))
    for (const [sessionId, group] of out) {
      const final = byKey.get(`${group.workspaceId}\u0000${group.id}`)
      if (final !== undefined) out.set(sessionId, final)
    }
    return { bySession: out, ordered }
  }

  /**
   * The directory a workspace heading stands for.
   *
   * A registry workspace knows its own path; a `cwd:`-derived group carries it
   * in its id. Both are scanned for checkouts, so a directory the reader never
   * registered still shows its worktrees.
   * @param group - the workspace heading.
   * @returns the absolute directory, or `''` when the group names none.
   */
  private pathOf(group: WorkspaceGroup): string {
    if (group.id.startsWith('cwd:')) return group.id.slice('cwd:'.length)
    for (const workspace of this.registry?.list() ?? []) {
      if (workspace.id === group.id) return workspace.path
    }
    return ''
  }

  /**
   * Which worktree a session worked in, decided by where it wrote.
   *
   * A session's own record of its work is the files it changed, so the checkout
   * holding the most of them is the one it belongs to. This replaces reading the
   * opening prompt, which was measured against every session on this box and
   * placed 42% — most of those by matching a bare directory name that also
   * occurs as an ordinary word, so a session saying `origin/develop` in passing
   * was filed under `develop`. Counting writes places 84%, and the winner
   * usually leads by hundreds of edits to none.
   *
   * A session that wrote nothing has no answer here and falls to the unknown
   * bucket, which is correct: a read-only investigation genuinely did not work
   * in a checkout.
   * @param sessionId - the session to place.
   * @param roots - each checkout's root path and its heading.
   * @returns the heading it wrote into most, or undefined when it wrote into none.
   */
  /**
   * The removed checkout a session worked in, when no live one matched.
   *
   * A worktree deleted after its session ran leaves no directory to scan, so
   * {@link worktreesIn} cannot offer it and {@link placement} cannot pick it.
   * The session's own evidence still names it, and that name is the heading: a
   * pruned checkout is reported as the directory it was, marked deleted, rather
   * than filed under "Unknown worktree". The reader watched the folder while it
   * existed, so its name is known — discarding it is the one answer worse than a
   * stale one.
   *
   * Only immediate children of the workspace folder or of its parent: a deeper
   * directory is a path *inside* a checkout rather than a checkout, and
   * promoting one would invent a heading the reader never made.
   *
   * Qualifying evidence is what the session did *inside* the directory, not the
   * tally standing at its own path. A checkout is a tree the session worked in,
   * so its children carry the credit; a directory merely named in a shell command
   * has no such children, and a scratch directory the session made and forgot
   * (`verify2`, `tmp-verify`) holds a file or two and nothing below them.
   * Measured over every stored log on this box, the two separate by orders of
   * magnitude: real pruned checkouts carry hundreds and up below them, while the
   * scratch directories carry about a dozen. The path's own tally cannot tell
   * them apart — the reported checkout stood at 400 and `verify2` at 527, both
   * around one floor on the wrong sides of it — which is what filed a real
   * checkout as "Unknown worktree" while nearly promoting a scratch directory.
   * @param sessionId - the session to place.
   * @param workspace - the workspace whose immediate children are candidates.
   * @returns the removed checkout's root, or undefined when the evidence names none.
   */
  private departedRoot(sessionId: string, workspace: WorkspaceGroup): string | undefined {
    const writes = this.folded.get(sessionId)?.derived.writes
    if (writes === undefined || writes.size === 0) return undefined
    const dir = this.pathOf(workspace)
    if (dir === '') return undefined
    const here = normalizePath(dir)
    const prefix = `${here}/`
    // A checkout sits one level below the folder the session was started in, but
    // which folder that is has moved on this box: the older checkouts sat beside
    // the project folder (`/root/coding/develop`) while the current ones sit
    // inside it (`/root/coding/language-boss-and-choc/develop`). Both are one
    // level below somewhere real and the session's own evidence says which it
    // used, so both are offered and the evidence decides — otherwise a session
    // from the older layout lands under "Unknown worktree" even though its own
    // log names the folder it worked in.
    const bases = [prefix]
    const parent = dirname(here)
    if (parent !== here && parent !== '/' && parent !== '') bases.push(`${parent}/`)
    // Everything credited below a directory, accumulated in one pass: a path
    // credits itself and its ancestors, so summing the tally of every strict
    // descendant answers "how much work happened inside this one". Bounded by
    // {@link WRITE_ANCESTORS}, and O(writes) rather than a scan per candidate —
    // the fold that produces `writes` runs on every append.
    const inside = new Map<string, number>()
    for (const [path, count] of writes) {
      let up = dirname(path)
      for (let depth = 0; depth < WRITE_ANCESTORS; depth += 1) {
        inside.set(up, (inside.get(up) ?? 0) + count)
        const next = dirname(up)
        if (next === up) break
        up = next
      }
    }
    let best: string | undefined
    let most = 0
    const seen = new Set<string>()
    for (const base of bases) {
      for (const path of writes.keys()) {
        if (!path.startsWith(base)) continue
        const child = path.slice(base.length)
        // Immediate children only: a checkout sits beside its siblings, one level
        // inside the folder that holds them.
        if (child === '' || child.includes('/')) continue
        // A dotfile directory is never a checkout the reader works in, exactly as
        // `worktreesIn` holds for live ones. A session's own scratch directory
        // (`.verify-tmp` here) is otherwise indistinguishable from a removed
        // worktree by evidence alone, since both are gone and both were written to.
        if (child.startsWith('.')) continue
        // The workspace folder is itself an immediate child of its parent, so the
        // two bases can offer it twice; and it is never a departed checkout.
        if (path === here || seen.has(path)) continue
        seen.add(path)
        const worked = inside.get(path) ?? 0
        if (worked < DEPARTED_MIN) continue
        if (worked > most) {
          most = worked
          best = path
        }
      }
    }
    // A directory that still exists is not departed: it was offered to
    // `placement` already and lost, so claiming it here would override that.
    if (best === undefined) return undefined
    return this.absent(best) ? best : undefined
  }

  /**
   * Whether a directory is gone, remembered across repaints.
   *
   * The listing rebuilds whenever any log grows, and this runs for every
   * unplaced session, so an uncached `stat` here would be one syscall per
   * unplaced row per repaint. A removed worktree does not come back — and if
   * one is recreated it is a live checkout again, which `worktreesIn` finds on
   * its own 30-second cycle without needing this answer to change.
   * @param dir - the candidate directory.
   * @returns true when nothing sits at the path.
   */
  private absent(dir: string): boolean {
    const known = this.vanished.get(dir)
    if (known !== undefined) return known
    const gone = !existsSync(dir)
    this.vanished.set(dir, gone)
    return gone
  }

  private placement(sessionId: string, roots: readonly Rooted[]): WorktreeGroup | undefined {
    const writes = this.folded.get(sessionId)?.derived.writes
    if (writes === undefined || writes.size === 0) return undefined
    let best: WorktreeGroup | undefined
    let most = 0
    for (const { root, heading } of roots) {
      const count = writes.get(root) ?? 0
      if (count > most) {
        most = count
        best = heading
      }
    }
    return best
  }

  /**
   * The full corpus, re-listed no more often than the TTL.
   *
   * Live sessions missing from the listing are merged in, so a session created
   * since the last read appears immediately instead of at the next expiry.
   *
   * An expired snapshot is refreshed **in the background** rather than awaited,
   * on the same rule the rest of this class already follows: the response
   * carries what is cached and the refresh's completion pushes the rest. Only a
   * reader with nothing at all to show waits, because an empty screen is the one
   * case where stale beats nothing is false.
   *
   * This is what the endpoint's latency actually turned on. `listSessions` is a
   * wire call in the standalone process, and a harness busy with a turn was
   * measured answering it in over 20 s while this process's own store answered
   * the same question in 160 ms. Awaiting it put that entire stall on every
   * request, including the ones whose rows had not changed at all.
   * @returns every session the engine can name.
   */
  private async records(): Promise<readonly SessionRecord[]> {
    const now = Date.now()
    if (this.snapshot.length === 0 || now - this.listedAt >= LISTING_TTL_MS) {
      const refresh = this.relist()
      // Nothing cached yet: this reader has no rows to show, so it waits for the
      // first list rather than painting an empty page it would have to replace.
      if (this.snapshot.length === 0) await refresh
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
   * Re-read what exists, and wait for it.
   *
   * Creating a session writes no log event this side can see, so nothing else
   * would tell the snapshot it is out of date and the new row would not appear
   * until the TTL lapsed. Merely marking it expired is not enough either: the
   * refresh is deliberately non-blocking, so the very next request would still
   * be served the cached rows the new session is missing from — which is a
   * reader tapping a session that is not on the list yet.
   *
   * Awaited because it is the caller's own write that has to be reflected, and
   * because the list is read from the store rather than the harness, which puts
   * it in the tens of milliseconds rather than the seconds a wire call cost.
   * @returns when the corpus has been re-read.
   */
  async invalidate(): Promise<void> {
    this.listedAt = 0
    // A re-list already in flight may have read the store before this caller's
    // session existed, so joining it could still miss the new row. Wait for it
    // to settle, then take a fresh one.
    await this.relisting
    await this.relist()
  }

  /**
   * Re-list the corpus once, however many callers ask at the same time.
   *
   * The TTL is stamped when the call *settles*, not when it starts, so a list
   * that takes 20 s is not immediately considered expired again by the request
   * that follows it — which would otherwise keep a slow harness under a
   * permanent re-list, one per request.
   *
   * A failed list leaves the previous snapshot in place: the rows on screen stay
   * the rows the reader had, and the next window retries. Throwing here would
   * take the endpoint down for a transient wire error.
   * @returns the in-flight refresh, shared by every caller.
   */
  private relist(): Promise<void> {
    if (this.relisting !== undefined) return this.relisting
    const run = (async () => {
      try {
        const listed = await this.ctx.sessionQuery.listSessions()
        // A newly-listed session may differ from what the last paint showed, so
        // the version moves and the stream pushes the corrected list. Callers
        // that did not wait for this get it on that broadcast.
        const changed = listed.length !== this.snapshot.length
        this.snapshot = listed
        if (changed) {
          this.version += 1
          this.changed()
        }
      } catch {
        // Kept deliberately silent, exactly as the pump is: a list that failed
        // leaves the previous rows readable rather than blanking the screen.
      } finally {
        this.listedAt = Date.now()
        this.relisting = undefined
      }
    })()
    this.relisting = run
    return run
  }

  /**
   * Hide one session from the list, durably.
   *
   * The row disappears because {@link listing} filters the registry's archive
   * set, so this needs no cache of its own — the next listing is already correct.
   * Nothing is deleted: the transcript stays readable at its own URL, which is
   * what makes this safe to offer as a single tap.
   * @param id - the session to archive.
   * @throws Error when no registry is bound, so a tap that changed nothing says so
   * instead of reporting a success the durable state never received.
   */
  async archive(id: string): Promise<void> {
    if (this.registry === undefined) {
      throw new Error('this server has no workspace registry, so sessions cannot be archived')
    }
    await this.registry.archiveSession(id)
    // Archiving changes who is hidden without changing which sessions exist, so
    // the cached shape would still carry the row the reader just dismissed.
    this.reshape()
    // The archive set is not a log event, so no subscription would notice it.
    // Move the version by hand or every client keeps the row it just dismissed.
    this.version += 1
    this.changed()
  }

  /**
   * The archived set, which the display hides but never deletes.
   * @returns session ids the reader has archived.
   */
  private archived(): ReadonlySet<string> {
    return new Set(this.registry?.archivedSessionIds ?? [])
  }

  /**
   * Every session the listing must leave off the list, and off every heading.
   *
   * Two independent reasons, unioned here so that every consumer below asks one
   * question instead of growing a second filter of its own:
   *
   * - **Archived** — the reader hid it by hand. Durable and registry-owned.
   * - **Subagent** — the session is a child an agent spawned to do a piece of
   *   its own work, not a conversation the reader started. The harness writes
   *   these constantly (68 of the 84 rows on this box when this was written),
   *   each with a machine-templated title, so on the list they read as
   *   duplicates of the reader's own sessions and bury them.
   *
   * The discriminator is `header.origin === 'subagent'`, with
   * `delegationDepth > 0` as a second signal for a child whose origin was never
   * stamped. `parentSession` is deliberately **not** used: it is set for
   * fork/seed lineage on the reader's own sessions as well, so filtering on it
   * would hide real work.
   *
   * A child blocked on a person is NOT left visible here. Its pending question
   * or permission is carried onto the nearest visible ancestor instead — see
   * {@link attributed} — so the request stays answerable from the parent's own
   * transcript rather than stranding a row in a list it does not belong in.
   *
   * Hiding is display only. Nothing is deleted, and the transcript stays
   * readable at its own `/s/<id>` URL, exactly as an archived session's does.
   * @param records - the sessions being listed.
   * @returns ids to leave off the list, and off every heading they might create.
   */
  private hidden(records: readonly SessionRecord[]): ReadonlySet<string> {
    const hidden = new Set<string>(this.archived())
    for (const record of records) {
      if (isSubagent(record.header)) hidden.add(record.header.id)
    }
    return hidden
  }

  /**
   * A hidden child's pending work, carried onto the ancestor that should answer it.
   *
   * A subagent cannot normally ask a person at all: the harness refuses a child
   * that calls the question tool (`DELEGATED_CALLER`) and the delegation prompt
   * tells it that approval-requiring operations are rejected automatically, so
   * the ordinary way a child surfaces a blocker is its final result, which
   * already lands in the parent's transcript. This path exists for the case the
   * same rules carve out — a child with historical delegation depth that is
   * **resumed as its own runtime root**, and can therefore ask. Hiding that row
   * without moving the request would make a live blocker unreachable.
   *
   * The walk climbs `parentSession` to the nearest ancestor that is itself
   * visible, because a depth-2 child's direct parent is usually hidden too. When
   * no visible ancestor exists at all, the child is handed back in `stranded`
   * and its row is kept: a request nobody can reach is worse than a child row on
   * a list, which is the one thing the hiding is allowed not to win.
   *
   * The answer still routes by `askId` alone (see `Bridge.answer`), so this is
   * presentation only — a decision made from the parent settles the child.
   * @param records - the sessions being listed.
   * @param hidden - the ids already resolved to hidden.
   * @param questions - the live pending tables.
   * @returns pending work per visible ancestor id, and the children it could not place.
   */
  private attributed(
    records: readonly SessionRecord[],
    questions: AskSource,
  ): { carried: ReadonlyMap<string, { asks: PendingAsk[]; approvals: PendingApproval[] }> } {
    const carried = new Map<string, { asks: PendingAsk[]; approvals: PendingApproval[] }>()
    const waiting = this.waiting(records, questions)
    if (waiting.length === 0) return { carried }
    const { byId, hidden } = this.lineage(records)
    for (const record of waiting) {
      const id = record.header.id
      const asks = questions.of(id)
      const approvals = questions.approvalsOf(id)
      // Fold the child's own log even though it gets no row.
      //
      // A hidden row is dropped before the listing reaches `this.want(record)`,
      // so nothing else would ever read this session — and the label below needs
      // a *name* for the child, not just its id. This is the only fold spent on a
      // hidden session, it happens only for a child actually holding a request,
      // and it costs one read of one log. The title it produces arrives on the
      // next listing pass, exactly as every other row's does.
      this.want(record)
      let cursor = record.header.parentSession
      let target: string | undefined
      const seen = new Set<string>([bareId(id)])
      while (typeof cursor === 'string' && !seen.has(bareId(cursor))) {
        seen.add(bareId(cursor))
        const parent = byId.get(cursor)
        // An ancestor the listing already hides keeps climbing; one that is
        // visible is the row that will answer. An ancestor with no header at
        // all is a chain that leaves the listing entirely.
        if (parent !== undefined && !hidden.has(parent.id)) {
          target = parent.id
          break
        }
        cursor = parent?.parentSession
      }
      // No visible ancestor: the child keeps its own row instead, which
      // `stranded` arranges, so there is nothing to carry.
      if (target === undefined) continue
      // The child names itself on the form: a request appearing under the
      // parent's transcript must say which child is asking, or it reads as the
      // parent's own question.
      //
      // The same chain the row title uses, so the child is named here exactly as
      // it would be named on its own row: an explicit user rename, then the
      // content words of the child's own first prompt. Only `derived.title` on
      // its own would usually be empty — most titles are model paraphrases the
      // GUI deliberately ignores — and the label would fall through to a bare
      // id. The id is still the last resort: `New session` names nothing, and a
      // request that says which child is asking is the whole point.
      const derived = this.folded.get(id)?.derived
      const from = derived !== undefined
        ? (derived.title !== '' ? derived.title : (nameFromPrompt(derived.opening) || id))
        : id
      const bucket = carried.get(target) ?? { asks: [], approvals: [] }
      bucket.asks.push(...asks.map(ask => ({ ...ask, from })))
      bucket.approvals.push(...approvals.map(approval => ({ ...approval, from })))
      carried.set(target, bucket)
    }
    return { carried }
  }

  /**
   * Hidden children that are holding a question or an approval right now.
   *
   * The entry point for both attribution and the stranded carve-out, and the
   * reason neither costs a walk of the whole corpus any more. Almost always
   * empty: a subagent normally cannot ask at all, so the common case is a scan
   * that finds nothing and both callers return immediately.
   * @param records - the sessions being listed.
   * @param questions - the live pending tables.
   * @returns the hidden children with pending work, in record order.
   */
  private waiting(records: readonly SessionRecord[], questions: AskSource): readonly SessionRecord[] {
    const waiting: SessionRecord[] = []
    for (const record of records) {
      if (!isSubagent(record.header)) continue
      const id = record.header.id
      if (questions.of(id).length === 0 && questions.approvalsOf(id).length === 0) continue
      waiting.push(record)
    }
    return waiting
  }

  /**
   * The id index and hidden set the ancestor walk needs.
   *
   * Headers disagree on id spelling — some store `session-<uuid>`, some the
   * bare `<uuid>` — and `parentSession` inherits whichever the writer used, so
   * the same session can be named two ways on one list. Keying both forms to
   * the same header is what lets the walk arrive; matching the raw strings
   * would stop at the first hop that changed spelling.
   * @param records - the sessions being listed.
   * @returns every header by both spellings, and the ids hidden before carve-outs.
   */
  private lineage(records: readonly SessionRecord[]): {
    byId: ReadonlyMap<string, SessionHeader>
    hidden: ReadonlySet<string>
  } {
    const byId = new Map<string, SessionHeader>()
    for (const record of records) {
      byId.set(record.header.id, record.header)
      byId.set(bareId(record.header.id), record.header)
    }
    return { byId, hidden: this.hidden(records) }
  }

  /**
   * Hidden children whose request has nowhere to go, so they keep their row.
   *
   * Reachability outranks the tidiness the hiding exists for: this is the case
   * the harness's own rules leave open (a child resumed as its own runtime root
   * may ask), and a waiting decision with no row anywhere is unreachable.
   * @param records - the sessions being listed.
   * @param hidden - the ids resolved to hidden.
   * @param questions - the live pending tables.
   * @returns ids that must be shown despite being hidden.
   */
  private stranded(
    records: readonly SessionRecord[],
    hidden: ReadonlySet<string>,
    questions: AskSource,
  ): ReadonlySet<string> {
    const stranded = new Set<string>()
    const waiting = this.waiting(records, questions)
    if (waiting.length === 0) return stranded
    const { byId } = this.lineage(records)
    for (const record of waiting) {
      const id = record.header.id
      if (!hidden.has(id)) continue
      // Fold the child's own log even though it gets no row: the label the
      // parent shows needs a *name* for the child, not just its id. This is the
      // only fold spent on a hidden session, and only for one actually holding
      // a request.
      this.want(record)
      let cursor = record.header.parentSession
      let target: string | undefined
      const seen = new Set<string>([bareId(id)])
      while (typeof cursor === 'string' && !seen.has(bareId(cursor))) {
        seen.add(bareId(cursor))
        const parent = byId.get(cursor)
        if (parent !== undefined && !hidden.has(parent.id)) {
          target = parent.id
          break
        }
        cursor = parent?.parentSession
      }
      if (target === undefined) stranded.add(id)
    }
    return stranded
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
   * @param hidden - the hidden set, so a directory known only for hidden work is not a heading.
   * @returns the group for each session id, and every group in render order.
   */
  private grouping(records: readonly SessionRecord[], hidden: ReadonlySet<string>): {
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
      // A hidden session is not a reason to show a directory. A workspace the
      // reader created keeps its heading when empty, but a `cwd:` group is
      // inferred from the logs alone — so a directory whose every session has
      // been archived is not a place with nothing in it, it is not a place at
      // all. Showing it would put junk headings (`/root`, `~/.dsh`) on a list
      // the reader never asked about — and an unowned directory named only by a
      // subagent's cwd is exactly that same kind of junk.
      if (hidden.has(record.header.id)) continue
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
    if (this.folded.has(id) && !this.stale.has(id)) return
    this.queued.add(id)
    // A row never read before is what a cold list is waiting on, so its read
    // starts now. A row that was read and has merely grown waits for the next
    // window, because a session being written would otherwise keep it awake.
    if (this.folded.has(id)) this.schedule()
    else this.pump()
  }

  /**
   * Queue a re-read for the next window, at most one window at a time.
   *
   * A fixed window rather than a debounce: events keep arriving for as long as
   * the session is being written, and a debounce would postpone the update until
   * the turn ended.
   */
  private schedule(): void {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.pump()
    }, FOLD_DELAY_MS)
    // A pending re-read must never hold the process open by itself.
    this.timer.unref?.()
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
      // The work queued at this moment, and only that: a session being written
      // adds to the queue while this runs, and following it here would keep the
      // loop awake for the whole turn. Those ids wait for the next window.
      const pending = [...this.queued]
      this.queued.clear()
      for (let from = 0; from < pending.length; from += READ_CONCURRENCY) {
        const batch = pending.slice(from, from + READ_CONCURRENCY)
        // Cleared before the read, so an event that lands mid-read re-marks the
        // row and the next window picks it up instead of losing it here.
        for (const id of batch) this.stale.delete(id)
        await Promise.all(batch.map(async id => {
          const header = this.headerOf(id)
          if (header === undefined) {
            this.unattemptable.add(id)
            return
          }
          this.folded.set(id, await this.derive(header))
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
    // Work that arrived during the pass waits for the next window rather than
    // re-entering this loop.
    if (this.queued.size > 0) this.schedule()
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
  private async derive(header: SessionHeader): Promise<Fold> {
    const prior = this.folded.get(header.id)
    try {
      const agent = this.ctx.agents.get(header.id)
      if (agent !== undefined) {
        const events = agent.session.events
        if (events !== undefined) return summarize(header, events, prior)
      }
      const loaded = await this.ctx.sessionQuery.readSession(header.id)
      return summarize(loaded.session, loaded.events, prior)
    } catch {
      // A log that cannot be read still deserves a row: its header names it.
      // Nothing may propagate, because one unreadable session must not stop the
      // batch it shares with fifty readable ones.
      return { derived: underived(header), count: 0, lastSeq: -1 }
    }
  }
}

/**
 * Whether a session is a subagent child rather than one the reader started.
 *
 * Two signals, either of which is enough. `origin` is the harness's own
 * classification, stamped on the header at creation. `delegationDepth` is
 * documented as "absent (zero) for a top-level session, parent depth + 1 for a
 * subagent child", so it catches a child persisted before `origin` existed.
 *
 * `parentSession` is not one of the signals on purpose: it is also set for
 * fork/seed lineage on the reader's own sessions, so using it would hide real
 * work.
 * @param header - the session header.
 * @returns true when the session is a subagent child.
 */
function isSubagent(header: SessionHeader): boolean {
  if (header.origin === 'subagent') return true
  return typeof header.delegationDepth === 'number' && header.delegationDepth > 0
}

/**
 * A session id without its optional `session-` prefix.
 *
 * The prefix is a spelling, not identity: the same session is stored with and
 * without it in different places, and comparisons between the two spellings
 * silently fail rather than throwing. See {@link Corpus.attributed}.
 * @param id - a session id in either spelling.
 * @returns the id with any leading `session-` removed.
 */
function bareId(id: string): string {
  return id.startsWith('session-') ? id.slice('session-'.length) : id
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
function summarize(header: SessionHeader, events: readonly SessionEvent[], prior?: Fold): Fold {
  let title = ''
  let lastLine = ''
  let opening = ''
  let time = header.createdAt
  let seq = -1
  let index = 0
  // Carried across incremental folds rather than recounted, so a session that
  // keeps working keeps its tally instead of losing it to the tail-only read.
  const writes = new Map<string, number>()
  // A session being written appends to the array the last read already covered,
  // so only the tail is folded. Re-folding the whole transcript per event is
  // quadratic in a log's length, and a long session is the one whose events
  // arrive fastest. The boundary is checked rather than trusted, so a log
  // rewritten under us is re-read instead of resumed wrongly.
  if (
    prior !== undefined &&
    prior.count <= events.length &&
    (prior.count === 0 || events[prior.count - 1]?.seq === prior.lastSeq)
  ) {
    title = prior.derived.title
    lastLine = prior.derived.lastLine
    opening = prior.derived.opening
    time = prior.derived.time
    seq = prior.derived.seq
    index = prior.count
    for (const [dir, count] of prior.derived.writes) writes.set(dir, count)
  }
  for (; index < events.length; index += 1) {
    const event = events[index]
    if (event === undefined) continue
    // Only an explicit rename counts. A `provider` title is a model's paraphrase
    // and a `fallback` title is the harness's own word-trim, and both would
    // outrank the first-prompt name below — which is the name this GUI wants.
    // The harness also writes `session/title` from a model provider or its own
    // word-trim fallback; only an explicit user rename is honoured. `source` is
    // optional on this event, so an absent one must read as "not a user rename"
    // rather than throw — an unguarded read here loses the *whole* fold (title,
    // last line and every credited write) for that session, which is what
    // silently emptied titles and worktree placement on the mock.
    if (event.type === 'session/title' && event.data.source?.kind === 'user') title = event.data.title
    // The first prompt only. A later message may mention another checkout in
    // passing, but what the session was *told to work in* is set at the start.
    if (opening === '' && event.type === 'user/message') {
      let text = ''
      for (const block of event.data.content) if (block.type === 'text') text += block.text
      opening = text.slice(0, OPENING_MAX)
    }
    // Where this session actually worked, which is what decides its worktree.
    if (event.type === 'tool/call') noteWrite(writes, event.data)
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
  // The settled set is passed for the same reason `tail` passes it: a question
  // renders no row while it is still waiting, so without this a session whose
  // only content is an answered question would be judged empty here and drawn
  // with a row on its own page — the exact disagreement this check exists to
  // prevent. Both indexes are built once, outside the scan, rather than per
  // event: this branch is already the expensive path and must not be quadratic.
  const empty = lastLine === '' && isBlank(events, header.id)
  const last = events[events.length - 1]
  return { derived: { title, lastLine, empty, time, seq, opening, writes }, count: events.length, lastSeq: last?.seq ?? -1 }
}

/**
 * Whether a log renders no transcript row at all.
 *
 * Asks the same question the transcript asks, with the same two indexes, so a
 * session row and the session's own page can never disagree about emptiness.
 * @param events - the whole log.
 * @param id - the session, for the expand links a row may carry.
 * @returns true when nothing in the log would draw a frame.
 */
function isBlank(events: readonly SessionEvent[], id: string): boolean {
  const answers = answerIndex(events)
  const settled = settledAsks(events)
  return !events.some(event => renderEvent(event, id, answers, settled) !== null)
}

/** Tools whose call means a file was changed. */
const WRITE_TOOLS: ReadonlySet<string> = new Set(['edit', 'write', 'notebook_edit', 'multi_edit'])

/** Tools whose call means a file was looked at, naming where the session was working. */
const READ_TOOLS: ReadonlySet<string> = new Set(['read', 'grep', 'glob', 'read_image'])

/**
 * Absolute paths named inside a shell command's text.
 *
 * A session that worked through `bash` names its checkout in the command itself
 * — `git -C /root/coding/develop status` — and nowhere else, because `workdir`
 * is set on only 2.4% of real calls on this box (91 of 3810). Measured over
 * every stored log, the command text is the *only* evidence for 5 sessions that
 * are otherwise unplaceable.
 *
 * Deliberately narrow, because this is the loosest evidence the tally accepts:
 *
 * - Nothing may precede the leading `/` that would make it part of something
 *   else: a word character or `:` or `/` (so `http://host/api/x` yields no path
 *   — the authority and every segment after it are preceded by one of those), a
 *   `.` (so a relative `./src/x` is not read as `/src/x`), or `=` (so a
 *   variable assignment `a=/root/x` is not a path the session worked in).
 *   `/api/sessions`, `/dev/null` and `/m/app.css` all occur in real commands
 *   here and none of them is a checkout.
 * - First character is alphanumeric or `.`, so a bare `/` and shell operators
 *   contribute nothing.
 *
 * The regex only *offers* candidates; {@link noteWrite} still requires each to
 * sit under a directory the listing already trusts, which is what keeps a
 * mention from inventing a heading.
 */
const COMMAND_PATHS = /(?<![\w:=./])\/[A-Za-z0-9.][A-Za-z0-9._/-]*/g

/**
 * How much one tool call counts toward the checkout it names.
 *
 * A write is the strongest evidence a session was working somewhere; a read is
 * weaker but still a fact about where it was looking. The spread is wide enough
 * that no volume of reads outvotes a directory the session actually edited — 99
 * reads elsewhere still lose to a single write — which is the precedence the
 * heading needs, while reads alone still answer for a session that only looked.
 *
 * Weighting rather than strict precedence keeps one tally, so the incremental
 * fold that carries `writes` across appends carries this unchanged.
 */
const WRITE_WEIGHT = 10_000
const READ_WEIGHT = 100

/**
 * How much a path merely *named* in a shell command counts.
 *
 * Far below a read, because a command's text is a description of work rather
 * than a record of it: `grep -r x /root/coding/develop` names a directory the
 * session only searched, and a path may appear in a command that failed or was
 * never about that checkout at all. Held low enough that a single read outvotes
 * ninety-nine mentions, so this answers only where nothing better exists.
 *
 * Measured against every stored log on this box: where both kinds of evidence
 * are present the shell text picks the same checkout as the file operations in
 * 88 of 90 sessions, and the weight is what makes the 2 disagreements harmless
 * — the read/write tally wins them outright.
 */
const COMMAND_WEIGHT = 1

/**
 * Evidence a removed directory needs before it may become a heading.
 *
 * A checkout that existed is claimed from the session's own evidence, since
 * there is no directory left to scan and git keeps no record of a pruned
 * worktree. Measured as the evidence *inside* the candidate
 * ({@link Corpus.departedRoot}), the two populations separate by orders of
 * magnitude: a scratch directory a session made and deleted carries about a
 * dozen (`.verify-tmp` 3, `verify2` 11), while every real pruned checkout on this
 * box carries hundreds and up. This floor sits in that gap, so a directory the
 * session merely passed through is described as unplaced rather than promoted
 * to a heading.
 */
const DEPARTED_MIN = 6 * READ_WEIGHT

/**
 * Tally one tool call against the directory it names.
 *
 * Where a session worked, weighted by how strongly each kind of call says so: a
 * file it edited, a file it read, or a directory a shell command ran in or
 * merely named. `bash` outnumbers `edit` four to one in real logs, so a session
 * that worked entirely through shell commands left no trace at all until the
 * shell branch below was added. The weights keep a write decisive while letting
 * weaker evidence answer where there is nothing better.
 *
 * The three tiers are far enough apart that they never compete: one write beats
 * any number of reads, and one read beats any number of shell mentions.
 *
 * The arguments ride as an opaque JSON *string* on the event, so paths are
 * parsed out rather than read off a typed field. Everything here is defensive:
 * a tool call with no arguments, unparseable arguments, or no path simply
 * contributes nothing, because one odd event must not cost the whole listing.
 * @param writes - the running tally, mutated in place.
 * @param data - the `tool/call` event's payload.
 */
function noteWrite(writes: Map<string, number>, data: unknown): void {
  if (typeof data !== 'object' || data === null) return
  const { name, arguments: args }: { name?: unknown; arguments?: unknown } = data
  if (typeof name !== 'string') return
  const write = WRITE_TOOLS.has(name)
  const read = READ_TOOLS.has(name)
  const shell = name === 'bash'
  if (!write && !read && !shell) return
  let parsed: unknown = args
  if (typeof args === 'string') {
    try {
      parsed = JSON.parse(args)
    } catch {
      return
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return
  if (shell) {
    noteCommand(writes, parsed)
    return
  }
  const { file_path: filePath, path }: { file_path?: unknown; path?: unknown } = parsed
  // `read` and `write` name `file_path`; `grep` and `glob` name `path`, which
  // is already a directory. Crediting a directory's own ancestors is correct
  // either way, so both spellings fold into one walk.
  const named = typeof filePath === 'string' ? filePath : path
  if (typeof named !== 'string' || !named.startsWith('/')) return
  // A `grep`/`glob` path is the directory itself; a file path's directory is
  // its parent. Taking `dirname` of a directory would credit its parent and
  // lose the checkout when the search was rooted exactly at one.
  const from = typeof filePath === 'string' ? dirname(named) : named
  credit(writes, from, write ? WRITE_WEIGHT : READ_WEIGHT)
}

/**
 * Tally one shell call against the directories it names.
 *
 * Two sources, both weak and both treated the same. `workdir` is where the
 * command actually ran, which is a fact; the command's own text is a mention,
 * which is weaker still. They share {@link COMMAND_WEIGHT} because the stronger
 * of the two is present on only 2.4% of calls, so separating them would buy a
 * distinction that almost never applies.
 *
 * Unlike a file operation, a named path credits *only itself* — never its
 * ancestors. A command mentioning `/root/coding/develop/src/x.ts` says the
 * session was interested in that path, but crediting every ancestor would hand
 * `/root/coding` a point for each mention and let a long command outvote the
 * checkout it names. {@link placement} looks a checkout root up directly, so a
 * path deep inside one is simply not evidence this tally can use.
 * @param writes - the running tally, mutated in place.
 * @param parsed - the `bash` call's already-parsed arguments.
 */
function noteCommand(writes: Map<string, number>, parsed: object): void {
  const { workdir, command }: { workdir?: unknown; command?: unknown } = parsed
  if (typeof workdir === 'string' && workdir.startsWith('/')) {
    writes.set(workdir, (writes.get(workdir) ?? 0) + COMMAND_WEIGHT)
  }
  if (typeof command !== 'string') return
  // A command may name one path many times; each mention counts, because a
  // checkout worked in repeatedly is named repeatedly.
  for (const match of command.matchAll(COMMAND_PATHS)) {
    const named = match[0]
    // A trailing separator or dot is punctuation in the command, not part of
    // the directory, so `cd /root/coding/develop/ &&` and the path without the
    // slash must not become two different headings.
    const path = named.replace(/[./]+$/, '')
    if (path === '') continue
    writes.set(path, (writes.get(path) ?? 0) + COMMAND_WEIGHT)
  }
}

/**
 * Credit a directory and its ancestors for one piece of evidence.
 *
 * Every ancestor gets the credit, not just the directory itself, so work deep
 * inside a checkout still counts toward the checkout root and the caller can
 * look one up directly. Bounded by {@link WRITE_ANCESTORS} because only the
 * first few levels can ever be a worktree, and walking to `/` would credit
 * `/root` and `/` for every edit on the box.
 * @param writes - the running tally, mutated in place.
 * @param from - the directory the evidence names.
 * @param weight - how much this evidence is worth.
 */
function credit(writes: Map<string, number>, from: string, weight: number): void {
  let dir = from
  for (let depth = 0; depth < WRITE_ANCESTORS; depth += 1) {
    writes.set(dir, (writes.get(dir) ?? 0) + weight)
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
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
 * Function words dropped when naming a session after its first prompt.
 *
 * Closed-class words only — articles, pronouns, prepositions, conjunctions,
 * auxiliaries, and the handful of politeness and intent verbs that open almost
 * every prompt ("make", "need", "want", "please"). Those carry no information
 * *here* precisely because they are near-universal: a list where every row
 * starts "we need to make the" distinguishes nothing. Content words stay,
 * including the domain nouns that actually tell two sessions apart.
 */
const FUNCTION_WORDS: ReadonlySet<string> = new Set(
  `a an the this that these those there here and or but so then than if when while
   of in on at to for with from by as into over under out up down off again once
   is are was were be been being am do does did done have has had having
   i you we they it its our your their my me us them he she his her
   will would can could should shall may might must not no nor
   all any both each few more most other some such only own same too very just now also
   what which who whom whose why how
   make made making get got getting let lets need needs want wants
   please thanks thank ok okay yes yeah nope nah`.split(/\s+/),
)

/** Content words kept in a derived session name. */
const NAME_WORDS = 8

/** Characters kept from a URL's path before it is truncated in a derived name. */
const URL_PATH_MAX = 24

/**
 * Reduce a URL in a prompt to the part that identifies what it points at.
 *
 * An origin is the least informative text a prompt can contain here: the
 * sessions that mention one mostly mention the *same* one, so it fills a name
 * with characters shared by every row while the path — `/sessions`,
 * `/recordings/6aa03dc…` — is what tells two of them apart.
 *
 * Truncation keeps the front, because a path's leading segment is its category
 * and its tail is usually an opaque id; keeping the tail would name a session
 * after a hex string.
 * @param word - one whitespace-delimited token from a prompt.
 * @returns the shortened path, the hostname when the URL has no path, or null when not an http(s) URL.
 */
function shortenUrl(word: string): string | null {
  // Cheap reject before the expensive parse. `new URL` on every word of every
  // prompt was 62% of this endpoint's CPU: it throws for the overwhelming
  // majority of tokens, and building and unwinding that error costs far more
  // than the two-character test that proves it cannot be a web URL. Only
  // `http:`/`https:` survive the protocol check below, so anything without
  // `//` in it could never have reached it.
  if (!word.includes('//')) return null
  let parsed: URL
  try {
    parsed = new URL(word)
  } catch {
    return null
  }
  // Only the web schemes. A `mailto:` or `file:` token is already the readable
  // thing a reader would recognize, and has no origin worth removing.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const tail = `${parsed.pathname}${parsed.search}${parsed.hash}`.replace(/\/+$/, '')
  // A bare origin keeps its hostname: trimming it to '/' would name nothing.
  if (tail === '') return parsed.hostname
  return tail.length <= URL_PATH_MAX ? tail : `${tail.slice(0, URL_PATH_MAX - 1)}…`
}

/**
 * Name a session after its first prompt, minus the function words.
 *
 * This is the normal name for a session. The harness also writes `session/title`
 * events from a model provider or its own word-trim fallback, but those are
 * ignored: a paraphrase reads as invented beside the words the reader typed.
 * Only an explicit user rename outranks this.
 *
 * Words are kept in the order they were typed rather than by frequency: the
 * opening clause of a prompt is where the ask lives, and a reordered name reads
 * as noise even when it holds the right words.
 * @param opening - the session's first prompt, already captured for worktree naming.
 * @returns a short name, or '' when the prompt holds no content words.
 */
/**
 * Names already derived, keyed by the exact prompt they were derived from.
 *
 * The name is a pure function of the opening prompt, and the opening prompt is
 * captured once and never changes — but the row that shows it is rebuilt on
 * every request and every broadcast, so the same few hundred prompts were being
 * re-tokenized continuously. Keyed by the prompt rather than by session id so a
 * fold that re-derives an unchanged opening reuses the answer too.
 *
 * Bounded because the keys are whole prompts: without a cap this would hold
 * every prompt on the box alive to answer a question about titles.
 */
const named = new Map<string, string>()

/** Prompts whose derived name is kept; beyond this the oldest are dropped. */
const NAMED_MAX = 1_000

function nameFromPrompt(opening: string): string {
  const hit = named.get(opening)
  if (hit !== undefined) return hit
  const name = deriveName(opening)
  named.set(opening, name)
  // Map iterates in insertion order, so the oldest key is the first one out.
  while (named.size > NAMED_MAX) {
    const oldest = named.keys().next()
    if (oldest.done === true) break
    named.delete(oldest.value)
  }
  return name
}

/**
 * Derive a session's name from its first prompt.
 * @param opening - the session's first prompt.
 * @returns a short name, or '' when the prompt holds no content words.
 */
function deriveName(opening: string): string {
  const kept: string[] = []
  for (const word of plain(opening).split(/\s+/)) {
    // A URL is shortened before anything else touches it: the punctuation trim
    // below would eat its scheme and leave a bare `//host/path`.
    const url = shortenUrl(word.replace(/[),.:;]+$/, ''))
    if (url !== null) {
      kept.push(url)
      if (kept.length >= NAME_WORDS) break
      continue
    }
    // Trim surrounding punctuation only. Inner marks are load-bearing in the
    // vocabulary these prompts use — `titles/names`, `dsh.openclaw.test`,
    // `ask_user_question` — and a word split on them stops naming the thing.
    const bare = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    if (bare === '' || FUNCTION_WORDS.has(bare.toLowerCase())) continue
    kept.push(bare)
    if (kept.length >= NAME_WORDS) break
  }
  return kept.join(' ')
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
