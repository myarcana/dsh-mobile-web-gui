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
  /** One line of the most recent content. */
  readonly lastLine: string
  /** Epoch milliseconds of the last durable event. */
  readonly time: number
  /**
   * What this session currently supports, decided by the server.
   *
   * The client renders what it is handed and branches on nothing else, so no
   * notion of a user role exists in the page's source and a capability cannot
   * be present in one operator's view and silently absent from another's.
   */
  readonly actions: readonly ('send' | 'stop')[]
  /** Questions this session's agent is waiting on a person to answer, oldest first. */
  readonly asks: readonly PendingAsk[]
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

/** One session-list frame: every heading in render order, and every visible row. */
export interface SessionListing {
  /** The rows, newest first, each naming its group by {@link SessionSummary.workspaceId}. */
  readonly rows: readonly SessionSummary[]
  /** Every heading to render, in order, including ones with no rows. */
  readonly groups: readonly WorkspaceGroup[]
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
}

/** A durable transcript frame for the focused session. */
export interface EventFrame {
  readonly sessionId: string
  readonly seq: number
  /** One `<article>` produced by the serializer. */
  readonly html: string
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
