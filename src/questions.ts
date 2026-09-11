/**
 * Questions an agent is waiting on a person to answer.
 *
 * The harness asks through the `user-questions/request` waterfall and keeps no
 * record of it: a question exists only as the promise its tool call awaits.
 * The host holds that promise here and every browser reads it from the session
 * summaries, so a dropped signal, a slept radio and a reopened tab all come
 * back to the same waiting question.
 *
 * A harness restart still loses it, because the tool call awaiting it dies
 * with the process. That limit is the harness's.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionAnswer, AskUserQuestionAnswerItem } from '@deepseek-ai/dsh-user-questions'
import { randomUUID } from 'node:crypto'
import type { PendingAsk, SendAccepted } from './types.ts'

/** Answered asks remembered, so a resend after a lost response reads as a duplicate rather than a refusal. */
const ANSWERED_KEPT = 1000

/** One waiting question and the way to settle the tool call awaiting it. */
interface Waiting extends PendingAsk {
  readonly sessionId: string
  readonly settle: (outcome: AskUserQuestionAnswer | Error) => void
}

/** The questions this server is holding, keyed by the ask id it minted. */
export class Questions {
  private readonly waiting = new Map<string, Waiting>()
  /** Ask id to the outbox key of the answer that settled it. */
  private readonly answered = new Map<string, string>()

  /**
   * Answer every agent-scoped question from this GUI.
   *
   * Prepended, so that if anything else in the harness also registers as an
   * answerer, this GUI still sees every question first. A request with no
   * agent belongs to no session, so it passes on.
   * @param ctx - the plugin context; disposing it fails whatever is still waiting.
   * @param changed - called whenever the waiting set changes, to refresh summaries.
   */
  constructor(ctx: Context, changed: () => void) {
    ctx.on('user-questions/request', (request, next) => {
      const sessionId = request.agent?.session.id
      if (sessionId === undefined) return next()
      const signal = request.signal
      return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
        const askId = randomUUID()
        const abort = (): void => { settle(new Error('the question was cancelled', { cause: signal?.reason })) }
        const settle = (outcome: AskUserQuestionAnswer | Error): void => {
          this.waiting.delete(askId)
          signal?.removeEventListener('abort', abort)
          changed()
          if (outcome instanceof Error) reject(outcome)
          else resolve(outcome)
        }
        signal?.addEventListener('abort', abort, { once: true })
        this.waiting.set(askId, { askId, sessionId, questions: request.questions, settle })
        changed()
        // An abort that landed before the listener was added never fires it.
        if (signal?.aborted === true) abort()
      })
    }, true)
    ctx.effect(() => () => {
      for (const waiting of this.waiting.values()) {
        waiting.settle(new Error('the web GUI stopped before this question was answered'))
      }
    }, 'webGui.questions()')
  }

  /**
   * The questions one session is waiting on, oldest first.
   * @param sessionId - the session.
   * @returns what the browser renders, without the settle function.
   */
  of(sessionId: string): PendingAsk[] {
    const asks: PendingAsk[] = []
    for (const waiting of this.waiting.values()) {
      if (waiting.sessionId === sessionId) asks.push({ askId: waiting.askId, questions: waiting.questions })
    }
    return asks
  }

  /**
   * Settle one waiting question, exactly once however many times it is sent.
   * @param askId - the ask being answered.
   * @param clientMessageId - the browser's outbox key for this answer.
   * @param answers - one answer per question.
   * @returns the acceptance, or null when the question is no longer waiting for this answer.
   */
  answer(askId: string, clientMessageId: string, answers: AskUserQuestionAnswerItem[]): SendAccepted | null {
    const settledBy = this.answered.get(askId)
    if (settledBy !== undefined) return settledBy === clientMessageId ? { accepted: true, duplicate: true } : null
    const waiting = this.waiting.get(askId)
    if (waiting === undefined) return null
    this.answered.set(askId, clientMessageId)
    for (const oldest of this.answered.keys()) {
      if (this.answered.size <= ANSWERED_KEPT) break
      this.answered.delete(oldest)
    }
    waiting.settle({ answers })
    return { accepted: true, duplicate: false }
  }
}

/**
 * Admit a browser-supplied answer list.
 * @param value - the raw JSON value.
 * @returns the answers, shaped as the harness expects.
 * @throws Error naming the offending value when it is malformed.
 */
export function toAnswers(value: unknown): AskUserQuestionAnswerItem[] {
  if (!Array.isArray(value)) throw new Error(`answers must be an array, got ${JSON.stringify(value)}`)
  return value.map((item: unknown) => {
    if (typeof item !== 'object' || item === null) throw new Error(`malformed answer ${JSON.stringify(item)}`)
    const { id, selected, custom }: Record<string, unknown> = { ...item }
    if (typeof id !== 'string' || !Array.isArray(selected) || !selected.every(label => typeof label === 'string')) {
      throw new Error(`malformed answer ${JSON.stringify(item)}`)
    }
    return typeof custom === 'string' ? { id, selected, custom } : { id, selected }
  })
}
