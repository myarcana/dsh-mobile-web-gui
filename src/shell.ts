/**
 * The document shell.
 *
 * The import map and the modulepreload list are emitted from one digest table,
 * so they cannot disagree, and the browser fetches the whole module set in one
 * round trip instead of discovering it one import at a time.
 *
 * The import map is emitted *before* the preload links, and the order is
 * load-bearing: `modulepreload` initiates a module load, and an import map that
 * arrives after the first module load is rejected. Emitting the preloads first
 * breaks specifier resolution intermittently, depending on cache timing.
 *
 * The shell also carries the requested view's transcript already rendered. A
 * cold deep link therefore paints its content from the first response, before
 * any module has executed — the property that matters most on a bad link.
 * @module
 */

import { randomBytes } from 'node:crypto'
import type { AssetTable } from './assets.ts'
import type { PendingAsk } from './types.ts'

/** Modules the entry point imports directly; leaves take collaborators as arguments. */
const LEAVES: readonly string[] = [
  'router', 'stream', 'outbox', 'store', 'view', 'chooser', 'errors', 'time', 'wire', 'keyboard', 'ask', 'create',
]

/** What the shell needs to render one route's first paint. */
export interface ShellState {
  /** Serialized `<article>` frames for the focused session, already safe. */
  readonly frames: string
  /** The focused session id, or null for the chooser and the empty state. */
  readonly sessionId: string | null
  /** The title shown in the header. */
  readonly title: string
  /** Breadcrumb segments, outermost first, each with its own route. */
  readonly crumbs: readonly { readonly label: string; readonly href: string }[]
  /** Last durable seq already present in {@link frames}. */
  readonly renderedThrough: number
  /**
   * Whether this view can accept a prompt.
   *
   * Only a live agent can, so a session opened from history shows its
   * transcript and no composer rather than a box whose every send is refused.
   */
  readonly canSend: boolean
  /** Questions the focused session is waiting on, so a cold deep link shows them before the stream connects. */
  readonly asks: readonly PendingAsk[]
  /**
   * Whether this route offers the create controls.
   *
   * Only the session list does. A transcript is a view of one session, and
   * putting "new session" beside its message box would be two answers to the
   * same question on one screen.
   */
  readonly showTools: boolean
}

/**
 * Render the document for one route.
 * @param assets - the digest table backing the import map and preload list.
 * @param state - the server-resolved view this URL names.
 * @returns the complete HTML document and the CSP nonce it was built with.
 */
export function shell(assets: AssetTable, state: ShellState): { html: string; nonce: string } {
  const nonce = randomBytes(16).toString('base64')
  const imports: Record<string, string> = {}
  const preloads: string[] = []
  for (const name of ['app', ...LEAVES]) {
    const asset = assets.modules.get(name)
    if (asset === undefined) continue
    imports[name] = asset.url
    preloads.push(`<link rel=modulepreload href="${asset.url}">`)
  }
  const entry = assets.modules.get('app')
  const boot = JSON.stringify({
    sessionId: state.sessionId,
    renderedThrough: state.renderedThrough,
    crumbs: state.crumbs,
    canSend: state.canSend,
    asks: state.asks,
    showTools: state.showTools,
  })
  const html = `<!doctype html>
<html lang=en>
<meta charset=utf-8>
<meta name=viewport content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<title>${escapeText(state.title)}</title>
<link rel=stylesheet href="${assets.stylesheet.url}">
<script type=importmap nonce="${nonce}">${JSON.stringify({ imports })}</script>
${preloads.join('\n')}
<header>
<a id=pick href="/sessions">Sessions</a>
<h1 id=title>${escapeText(state.title)}</h1>
</header>
<nav id=crumbs>${state.crumbs.map(crumb =>
    `<a href="${escapeText(crumb.href)}">${escapeText(crumb.label)}</a>`).join('')}</nav>
<main id=log>${state.frames}</main>
<div id=tools${state.showTools ? '' : ' hidden'}>
<button type=button id=new-session>New session</button>
<button type=button id=new-workspace>New workspace</button>
</div>
<section id=dialog></section>
<section id=ask></section>
<section id=errors></section>
<form id=composer${state.canSend ? '' : ' hidden'}>
<textarea id=box rows=1 placeholder="Message this session" enterkeyhint=send></textarea>
<button id=send type=submit>Send</button>
</form>
<script type=application/json id=boot nonce="${nonce}">${escapeJson(boot)}</script>
${entry === undefined ? '' : `<script type=module src="${entry.url}" nonce="${nonce}"></script>`}
`
  return { html, nonce }
}

/**
 * The Content-Security-Policy the shell is delivered under.
 *
 * `script-src` without `'unsafe-inline'` means even total failure of the
 * serializer cannot execute an `onerror` or `onload` attribute. Every source is
 * `'self'`, so the policy is identical on every hostname the server answers to.
 * @param nonce - the per-response nonce the shell's inline scripts carry.
 * @returns the header value.
 */
export function policy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ')
}

/**
 * Escape text interpolated into the shell's own markup.
 * @param raw - server-owned text such as a title or route.
 * @returns the text with HTML-significant characters replaced.
 */
function escapeText(raw: string): string {
  return raw.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)
}

/**
 * Escape a JSON payload for embedding in a script element.
 * @param json - already-serialized JSON.
 * @returns JSON whose `<` cannot close the element early.
 */
function escapeJson(json: string): string {
  return json.replace(/</g, '\\u003c')
}
