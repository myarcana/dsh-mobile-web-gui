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
import type { SendAccepted } from './types.ts'

/**
 * Accept one prompt for a session, ignoring a resend of one already in the log.
 * @param ctx - the plugin context.
 * @param sessionId - the session the prompt is addressed to.
 * @param clientMessageId - the browser-minted key carried in `source`.
 * @param text - the prompt body.
 * @returns whether the log already held this key, making the resend a no-op.
 * @throws Error when no live agent owns that session.
 */
export async function send(
  ctx: Context,
  sessionId: SessionId,
  clientMessageId: string,
  text: string,
): Promise<SendAccepted> {
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error(`session ${sessionId} has no live agent to receive a prompt`)
  if (await alreadyAccepted(ctx, sessionId, clientMessageId)) return { accepted: true, duplicate: true }
  agent.followup(createUserMessage({
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
 * @returns true when a `user/message` in the log already carries this key.
 */
async function alreadyAccepted(
  ctx: Context,
  sessionId: SessionId,
  clientMessageId: string,
): Promise<boolean> {
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
