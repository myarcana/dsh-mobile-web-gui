/**
 * The wire contract, and the durable marker that makes a resent prompt safe.
 * @module
 */

import type {} from '@deepseek-ai/dsh-llm'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * A prompt composed in the web GUI.
     *
     * `clientMessageId` is minted by the browser before anything touches the
     * network and rides into the durable `user/message` event, so "has this
     * session already accepted this prompt?" is a question asked of the log.
     * That survives a restart, which an in-memory idempotency table does not —
     * and a restart is exactly when retries pile up.
     */
    webgui: { kind: 'webgui'; clientMessageId: string }
  }
}

/** One row of the session chooser. */
export interface SessionSummary {
  /** The session's stable id, used in every route. */
  readonly id: string
  /** Durable title, or a placeholder before `session/title` lands. */
  readonly title: string
  /** Whether the agent is currently working. */
  readonly running: boolean
  /** Last durable event position, so the client knows a cached render is stale before the user taps. */
  readonly latestSeq: number
  /** The workspace this session belongs to, as a display title. */
  readonly workspace: string
  /**
   * Stable id of the group this row belongs to.
   *
   * A workspace record's own id when one owns the session, and a
   * `cwd:`-prefixed directory otherwise — never a display title, which two
   * workspaces may legitimately share.
   */
  readonly workspaceId: string
  /**
   * Where this row's group sorts, lowest first.
   *
   * The registry's own durable order, so the list matches the desktop UI's
   * workspace order rather than re-deriving one from activity. Sessions no
   * record owns sort after every workspace.
   */
  readonly workspaceOrder: number
  /**
   * Stable id of the worktree this row files under, or `''` for none.
   *
   * Empty where the session's directory is in no repository, which is a real
   * answer rather than a missing one: those rows hang directly under their
   * workspace instead of under an invented heading.
   */
  readonly worktreeId: string
  /** The worktree heading text — its directory's name — or `''` when there is no worktree level. */
  readonly worktree: string
  /** One line of the most recent content. */
  readonly lastLine: string
  /**
   * Whether this session is known to hold no messages at all.
   *
   * False while the log has not been read yet, so a row never claims emptiness
   * on the strength of a read that has not happened. This is what lets the list
   * say a session has no messages instead of showing a blank preview line that
   * reads as a failed render.
   */
  readonly empty: boolean
  /** Epoch milliseconds of the last durable event. */
  readonly time: number
  /**
   * What this session currently supports, decided by the server.
   *
   * The client renders what it is handed and branches on nothing else, so no
   * notion of a user role exists in the page's source and a capability cannot
   * be present in one operator's view and silently absent from another's.
   */
  readonly actions: readonly ('send' | 'stop' | 'archive')[]
  /**
   * Prompts this server has accepted for this session but the log does not show yet.
   *
   * The browser's own `clientMessageId`s, echoed back. This is the server's
   * answer to "is my message on its way?", and it exists so the page never has
   * to infer that from a queue only the page can see: a prompt is Queued when
   * this server has never named its key, Sending while the key is named here,
   * and Delivered once the transcript carries the durable message. The three
   * states come from one authority, so there is nothing left to reconcile.
   *
   * Empty for the overwhelmingly common case, and never grows beyond the
   * prompts genuinely in flight — a key is retired the moment its message is
   * appended to the log.
   */
  readonly sending: readonly string[]
  /** Questions this session's agent is waiting on a person to answer, oldest first. */
  readonly asks: readonly PendingAsk[]
  /**
   * Permissions this session's agent is waiting on a person to grant, oldest first.
   *
   * A sibling of {@link SessionSummary.asks} rather than a member of it: a
   * question and a permission request are answered through different endpoints
   * with different vocabularies, and a reader acts on them differently.
   */
  readonly approvals: readonly PendingApproval[]
}

/**
 * One workspace heading on the session list.
 *
 * A group exists whether or not it holds a visible session: a workspace is a
 * durable record the reader created, not a consequence of what happens to have
 * a log. Carrying the headings on the wire is what lets an empty workspace stay
 * on screen instead of vanishing.
 */
export interface WorkspaceGroup {
  /** The workspace record's id, or a `cwd:`-prefixed directory for a session no record owns. */
  readonly id: string
  /** The heading text, which two workspaces may legitimately share. */
  readonly title: string
  /** Where this heading sorts, lowest first. */
  readonly order: number
}

/**
 * One worktree heading, nested under the workspace that holds it.
 *
 * Every worktree on disk gets one, whether or not a session is filed under it:
 * a checkout is a place the reader made and can start work in, so a workspace's
 * headings describe the project rather than only today's activity. This mirrors
 * {@link WorkspaceGroup}, where an empty workspace keeps its heading too.
 *
 * One heading per workspace is synthetic: the {@link UNKNOWN_WORKTREE} bucket
 * for sessions whose worktree cannot be determined. The harness records a single
 * cwd per session — the project folder, not the checkout — so a session that
 * never named its worktree genuinely has no derivable one, and saying so is
 * better than filing it under a guess. A checkout **deleted** after its session
 * ran is not that case: the session's own evidence still names it, so its
 * heading carries the folder's real name with `(deleted)` after it, and
 * {@link departed} marks it as a place that is gone.
 */
export interface WorktreeGroup {
  /** Matches {@link SessionSummary.worktreeId}. */
  readonly id: string
  /** The workspace heading this nests under. */
  readonly workspaceId: string
  /** The heading text: the working tree's own directory name. */
  readonly title: string
  /** Where this heading sorts within its workspace, lowest first. */
  readonly order: number
  /**
   * Whether this names a checkout that is gone from disk.
   *
   * {@link title} carries the real name either way, because the reader watched
   * the folder exist and knows what it was called. This flag is what lets a
   * surface act on the difference — there is no directory left to open, so a
   * control that would start work inside it must not promise one.
   */
  readonly departed?: boolean
}

/**
 * Id suffix marking the bucket for sessions with no determinable worktree.
 *
 * A real id, not a blank: the session list is always three levels deep, so a
 * session that cannot be placed still needs a heading to sit under rather than
 * being promoted to the workspace level.
 */
export const UNKNOWN_WORKTREE = 'wt:unknown'

/** One session-list frame: every heading in render order, and every visible row. */
export interface SessionListing {
  /** The rows, newest first, each naming its group by {@link SessionSummary.workspaceId}. */
  readonly rows: readonly SessionSummary[]
  /** Every heading to render, in order, including ones with no rows. */
  readonly groups: readonly WorkspaceGroup[]
  /** Every worktree heading, each naming the workspace it nests under. */
  readonly worktrees: readonly WorktreeGroup[]
}

/** A session this server just created. */
export interface CreatedSession {
  /** Its identity, which is also its route. */
  readonly sessionId: string
  /** The workspace it was filed under, or `''` when it went to the host's default directory. */
  readonly workspaceId: string
}

/** A workspace this server just registered, or resolved to one that already existed. */
export interface WorkspaceCreated {
  readonly workspaceId: string
  /** The display title, which defaults to the directory's own name. */
  readonly title: string
  /** False when the directory was already owned, which makes a double tap harmless. */
  readonly created: boolean
}

/** One directory row in the workspace browser. */
export interface DirectoryRow {
  /** Base name shown in the row; a root crumb carries its whole path. */
  readonly name: string
  /** Absolute host path, so the browser never joins segments itself. */
  readonly path: string
  /** Dot-prefixed on this platform. The browser decides whether to show it. */
  readonly hidden: boolean
}

/** One directory level, plus the way back up. */
export interface DirectoryView {
  readonly path: string
  /** The host account's home, for a "Home" root on the breadcrumb. */
  readonly home: string
  /** Ancestors from the filesystem root to this level, each a jump target. */
  readonly crumbs: readonly DirectoryRow[]
  /** Direct children, name-sorted. */
  readonly entries: readonly DirectoryRow[]
  /** True when the level holds more children than were reported. */
  readonly truncated: boolean
  /** Whether this host can create a folder here at all. */
  readonly canCreateDirectory: boolean
}

/** A question an agent is waiting on, as the browser renders it. */
export interface PendingAsk {
  /** Minted by this server per request; the answer names it, so it can only reach the tool call that asked. */
  readonly askId: string
  /** The questions exactly as the agent asked them. */
  readonly questions: readonly AskUserQuestionItem[]
  /**
   * The child asking, when this request was carried up from a hidden subagent.
   *
   * Absent for a session's own question. Present means the form is rendered in
   * an ancestor's transcript, so it must name the child or it reads as the
   * ancestor's own question.
   */
  readonly from?: string
  /**
   * The id of the child named by {@link from}, so the form can link to it.
   *
   * A hidden subagent is left off the listing but its transcript stays readable
   * at its own `/s/<id>` URL, and that transcript is the *only* durable record
   * of a carried question: the parent's log never receives the child's ask, its
   * preface or its answer. Naming the child in prose alone therefore pointed at
   * a record with no way to reach it, and the moment the question was answered
   * the carried ask disappeared and took the whole exchange off the screen with
   * it.
   *
   * Carrying the id turns that dead end into a deep link, which is what keeps
   * the exchange reachable after it stops being pending. Absent for a session's
   * own question, exactly like {@link from}.
   */
  readonly fromId?: string
  /**
   * What the agent said in the same breath as asking, when it said anything.
   *
   * A model writes its reasoning as ordinary text and then calls the ask tool,
   * and both land in **one** `assistant/message`. The host's
   * `question/requested` frame carries only the questions, so a form built from
   * that frame alone drops the half of the message that makes it answerable: a
   * question opening "Given that" names a "that" the reader was never shown.
   *
   * Empty when the call carried no text, which is common and is not a failure —
   * a self-contained question needs no preface, and inventing one would be
   * worse than the absence.
   *
   * This is presentation, never identity: the answer names {@link askId} alone,
   * so a preface that could not be found costs context and never the ability to
   * answer.
   *
   * Carried as **serialized HTML**, not as the raw source. A model writes this
   * half of the message in the same markdown it writes every other half in — a
   * list of the options it is weighing, a `code` span naming the field it is
   * asking about, a bold word carrying the contrast the question turns on — and
   * shown as plain text that markup degrades into punctuation noise sitting
   * between the reader and the thing they must decide. It goes through the same
   * `markdown` → `serializeAll` path the transcript uses, so it is safe for the
   * same structural reason: {@link Node} has no script, style, or
   * attribute-bearing variant, so nothing expressible here needs sanitizing.
   */
  readonly prefaceHtml?: string
}

/**
 * A permission an agent is waiting on, as the browser renders it.
 *
 * The harness's own vocabulary: `allowed-once` and `rejected` are the only two
 * outcomes a client may send, and a grant is one-shot — the same action asks
 * again next time. Carried whole rather than as a sentence so the form can put
 * the tool's name and the agent's reason in separate, selectable places.
 */
export interface PendingApproval {
  /**
   * The id a decision names, which is the host's `rpcId` for this request.
   *
   * Deliberately the same field name {@link PendingAsk.askId} uses: it is the
   * same notion — the handle that reaches only the tool call that asked — so the
   * outbox and the routes keep one vocabulary for "the thing being answered".
   */
  readonly askId: string
  /** The tool asking for permission, as the agent named it; `''` when unnamed. */
  readonly toolName: string
  /** The one-shot grant the reader is being asked for, in the agent's own words; `''` when unstated. */
  readonly reason: string
  /**
   * The child asking, when this permission was carried up from a hidden
   * subagent. Absent for a session's own request; see {@link PendingAsk.from}.
   */
  readonly from?: string
}

/** A durable transcript frame for the focused session. */
export interface EventFrame {
  readonly sessionId: string
  readonly seq: number
  /** One `<article>` produced by the serializer. */
  readonly html: string
  /**
   * True when a full read found nothing renderable in the whole log.
   *
   * Only a full read — a `replace` — can answer this, because a tail window
   * that happened to hold no frames says nothing about the log behind it.
   * Absent on live per-event frames, where it carries no meaning.
   */
  readonly empty?: boolean
}

/** A coalesced live token snapshot. Ephemeral: never carries an SSE `id:`. */
export interface TokenFrame {
  readonly sessionId: string
  /** Monotone per agent lifecycle; a restart resets it and invalidates older text. */
  readonly revision: number
  /** Character offset this snapshot starts at; a mismatch means resync, not corruption. */
  readonly off: number
  /** The text from {@link off} onward. */
  readonly s: string
}

/** The response to an accepted prompt. Acceptance, not delivery — delivery is the stream showing the message. */
export interface SendAccepted {
  readonly accepted: true
  /** Whether the log already held this `clientMessageId`, making the resend a no-op. */
  readonly duplicate: boolean
}

/** A refusal carrying everything a reader needs to hand a developer. */
export interface WireError {
  readonly error: true
  readonly message: string
  readonly detail: string
}
