/**
 * Admitting a browser-supplied answer.
 *
 * This module used to *hold* the questions too, by listening on a
 * `user-questions/request` waterfall. That event does not exist on this harness
 * (0.1.1-rc.1): `ask_user_question` is a service with a single provider slot,
 * `ctx.userQuestions.registerProvider`, and that slot belongs to the native web
 * UI. The listener therefore never fired once, and the answer form it fed was
 * unreachable — a whole feature that looked implemented and was not.
 *
 * The questions now come from `./bridge.ts`, which mirrors the harness's own
 * question stream and settles answers through its `/api/respond`. What stays
 * here is the part that was always this module's: turning an untrusted JSON
 * body into the shape the harness accepts.
 * @module
 */

import type { AskUserQuestionAnswerItem } from '@deepseek-ai/dsh-user-questions'

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
