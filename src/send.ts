/**
 * Accepting a prompt, exactly once, however many times it is sent.
 *
 * A client-minted id cannot be the message id: `createUserMessage` types its
 * input `{ readonly id?: never }` and mints identity internally. Nor does the
 * inbox provide idempotency — it rejects a duplicate id only while the message
 * is still pending, and by throwing; once a turn consumes it the same id is
 * accepted again. So a retry after a lost response, the commonest failure on
 * this link, would duplicate the prompt.
 *
 * Instead the browser's `clientMessageId` rides `source` into the durable
 * `user/message` event, and dedup becomes a question asked of the log. That
 * survives a restart, and a restart is when retries pile up.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Accepted } from './accepted.ts'
import { validKey } from './accepted.ts'
import { ensureLive } from './create.ts'
import type { SendAccepted } from './types.ts'

/**
 * Accept one prompt for a session, ignoring a resend of one already in the log.
 *
 * The prompt is delivered as steering, so it reaches a working session at its
 * next step boundary rather than after its current turn.
 *
 * The session is brought live first when this process holds no agent for it —
 * which is every session after a restart. The box is offered for cold sessions,
 * so a prompt to one resumes it rather than failing: refusing here is what
 * would make the always-present composer a lie.
 * @param ctx - the plugin context.
 * @param sessionId - the session the prompt is addressed to.
 * @param clientMessageId - the browser-minted key carried in `source`.
 * @param text - the prompt body.
 * @param accepted - the in-flight registry, recorded before the agent is handed the prompt.
 * @returns whether the log already held this key, making the resend a no-op.
 * @throws Error when the session cannot be resumed, or the key is malformed.
 */
export async function send(
  ctx: Context,
  sessionId: SessionId,
  clientMessageId: string,
  text: string,
  accepted: Accepted,
): Promise<SendAccepted> {
  // Refused rather than repaired. The key is the only thing tying the browser's
  // own copy of this prompt to the durable message, so a value that cannot be
  // stored and echoed back unchanged must fail loudly here — silently altering
  // it produces a prompt that is delivered but can never be shown as delivered.
  if (!validKey(clientMessageId)) {
    throw new Error(`malformed clientMessageId '${clientMessageId}'`)
  }
  await ensureLive(ctx, sessionId)
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error(`session ${sessionId} has no live agent to receive a prompt`)
  if (await alreadyAccepted(ctx, sessionId, clientMessageId, accepted)) return { accepted: true, duplicate: true }
  // Held before the handoff, so there is no instant where this server owns the
  // prompt without being able to say so. The hold is what the page renders as
  // "Sending"; it ends when the durable message appears, and nothing else ends it.
  accepted.hold(sessionId, clientMessageId)
  // Steering, not a follow-up turn. `followup` appends to the `next-turn` inbox,
  // so a prompt typed while the session is working waits for the whole turn to
  // finish — on a long turn that is minutes of the composer looking accepting
  // while nothing reaches the agent. `steer` appends to `next-step`, which the
  // driver claims at its next step boundary, so the prompt lands within about
  // one tool call. An idle agent is woken into a turn either way, so this is
  // strictly sooner, never later.
  //
  // The harness's own gateway takes this as a per-prompt `'queue' | 'steer'`
  // mode. This page has no such control and should not grow one: a message
  // typed here is always meant for the session *now*, and a prompt that must
  // wait for the turn is expressible by simply sending it when the turn ends.
  //
  // Dedup is unaffected — `alreadyAccepted` matches on `clientMessageId` across
  // the log and both inbox lists, and `nextStep` was already one of them.
  agent.steer(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'webgui', clientMessageId },
  }))
  return { accepted: true, duplicate: false }
}

/**
 * Ask the durable log whether this prompt already landed.
 * @param ctx - the plugin context.
 * @param sessionId - the session to inspect.
 * @param clientMessageId - the key to look for.
 * @param accepted - the in-flight registry, covering the window the other two cannot.
 * @returns true when this key has already been taken responsibility for.
 */
async function alreadyAccepted(
  ctx: Context,
  sessionId: SessionId,
  clientMessageId: string,
  accepted: Accepted,
): Promise<boolean> {
  // Asked first, and the reason this check is now correct. The agent loop claims
  // a batch out of the inbox as a pure deletion and appends `user/message` only
  // at the next step boundary, so between those two points the prompt is in
  // neither the log nor the inbox. A retry landing in that window — which is
  // exactly what stopping a session mid-turn produces, since the abort can strand
  // the claim — used to find nothing and send the prompt a second time.
  if (accepted.holds(sessionId, clientMessageId)) return true
  const { events } = await ctx.sessionQuery.readSession(sessionId)
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const source = event.data.source
    if (source.kind === 'webgui' && source.clientMessageId === clientMessageId) return true
  }
  // A prompt still queued in the inbox has no log event yet, so the pending
  // inbox is checked too — otherwise a retry racing the first turn duplicates.
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined) return false
  for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) {
    if (message.source.kind === 'webgui' && message.source.clientMessageId === clientMessageId) return true
  }
  return false
}
