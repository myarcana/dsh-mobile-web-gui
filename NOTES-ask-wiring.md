# Answering `ask_user_question` on dsh 0.1.1-rc.1

Findings from reading the installed harness, verified against the live process.
Written down because the seam is not what the plugin was originally built
against, and the difference is invisible until a question silently never arrives.

## What the plugin assumed, and why it never fired

`src/questions.ts` listens on the `user-questions/request` waterfall:

```ts
ctx.on('user-questions/request', (request, next) => { … }, true)
```

**That event does not exist on 0.1.1-rc.1.** `@deepseek-ai/dsh-user-questions`
exposes a *service*, not an event: `ctx.userQuestions` with a single
`registerProvider({ ask })` slot and an `ask()` API. Nothing ever emits
`user-questions/request`, so the listener is inert — the form UI in
`client/ask.js` is real and correct, but no question was ever routed to it.

## Why the plugin cannot simply register a provider

`registerProvider` admits exactly one provider per context:

```js
registerProvider(provider) {
  if (this.provider !== void 0) throw new UserQuestionError(
    "a user-questions provider is already registered", "DUPLICATE_PROVIDER")
  …
}
```

On this box `@deepseek-ai/dsh-host-apiproxy` already holds that slot (it is what
serves the native web UI on 3080). So registering from this plugin would either
throw at boot or, if it won it first, take every question *away* from the native
UI. Neither is acceptable: the mobile GUI is an additional head on the same
harness, not a replacement for it.

## The seam that actually works

`apiproxy` keeps its waiting questions in an in-memory `pendingQuestions` map
keyed by `rpcId`, pushes each one to every connected mux queue, and settles it
through `respond()`. Both halves are reachable over HTTP on 127.0.0.1:3080:

### Intake — `GET /api/events.mux`

A **WebSocket**, not SSE, on this deployment: `dsh-client-connection` answers a
plain GET with `426 Upgrade Required`. No subprotocol is negotiated and the
stream is downlink-only (client frames are a protocol violation). Frames are
JSON `server-request` envelopes; the one that matters:

```json
{"type":"server-request","rpcId":"…","method":"question/requested",
 "payload":{"type":"question/requested","sessionId":"session-…","questions":[…]}}
```

`sessionId` comes from `request.agent?.id`, so it is the session the question
belongs to — which is exactly the key the mobile GUI already groups asks by.

### Settle — `POST /api/respond`

Plain HTTP POST, `content-type: application/json`, no auth:

```json
{"type":"client-response","rpcId":"<echoed>",
 "result":{"ok":true,"value":{"sessionId":"session-…","answer":{"answers":[
   {"id":"q1","selected":["Yes"],"custom":"optional"}]}}}}
```

Replies `{"accepted":true}`, or `{"accepted":false,"reason":"not-pending"|"bad-response"}`.
Verified live: an unknown rpcId returns `not-pending` rather than hanging.

A cancel is the error form, which must use exactly `code: "cancelled"`:

```json
{"type":"client-response","rpcId":"…","result":{"ok":false,"error":{"code":"cancelled","message":"…"}}}
```

`respond` validates that the answer's question ids match the pending request
(`matchesQuestions`), so an answer cannot be accepted for the wrong question.

## Consequences that shape the implementation

1. **`rpcId` is in-memory and never durable.** It appears in no session log, so a
   harness restart loses every waiting question. The GUI must therefore treat a
   question as ephemeral and must not promise to redeliver one across a restart.
2. **First claimant wins.** `claimQuestion` deletes before settling, so the
   native UI and the mobile GUI answering at once is safe — the loser gets
   `not-pending`, which must be surfaced as "already answered", not as an error.
3. **The bridge is a client of 3080, not a provider.** This keeps the native UI
   fully working and makes the mobile GUI strictly additive.
