/**
 * Admitting a browser-supplied permission decision.
 *
 * The approval half of `./questions.ts`, and separate for the same reason the
 * bridge keeps two maps: a question is answered with a list of answers and a
 * permission is decided with one outcome from a two-word vocabulary. The host's
 * schema is a strict union, so anything else is refused here with its own value
 * named rather than posted and silently dropped.
 *
 * `allowed-once` and `rejected` are the only two outcomes a client may send. The
 * host's vocabulary also holds `cancelled` and `unavailable`, but both arise from
 * the request's own signal or from a missing answerer, never from a tap.
 * @module
 */

import type { ApprovalOutcome } from './bridge.ts'

/**
 * Admit a browser-supplied decision.
 * @param value - the raw JSON value.
 * @returns the outcome the host accepts.
 * @throws Error naming the offending value when it is anything but the two.
 */
export function toOutcome(value: unknown): ApprovalOutcome {
  if (value === 'allowed-once' || value === 'rejected') return value
  throw new Error(`outcome must be "allowed-once" or "rejected", got ${JSON.stringify(value)}`)
}
