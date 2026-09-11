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
  /** The workspace this session belongs to, for breadcrumbs. */
  readonly workspace: string
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
