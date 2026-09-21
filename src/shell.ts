/**
 * The document shell.
 *
 * The import map is derived from the *live* asset table rather than from a
 * hand-maintained list of names. That list used to live here as `LEAVES`, and it
 * was read once at boot while the client files were re-read per request — so a
 * newly added client module was served to a page whose import map had no key for
 * it, and the browser, unable to resolve the specifier the entry imports, ran no
 * client code at all: a blank page with a healthy `/api/sessions` and no
 * server-side error. Deriving the map from `assets.modules` removes the second
 * schedule the two halves could disagree on, so the keys and the files can no
 * longer drift — there is nothing to forget.
 *
 * The map is emitted *before* the preload links, and the order is load-bearing:
 * `modulepreload` initiates a module load, and an import map that arrives after
 * the first module load is rejected. Emitting the preloads first breaks
 * specifier resolution intermittently, depending on cache timing.
 *
 * A specifier with no key is still possible — a client module naming one that
 * does not exist on disk — so it is detected and said out loud in the document
 * instead of failing silently. Server HTML is present with zero JavaScript, so
 * the notice is exactly what a reader sees when nothing else can run.
 *
 * The shell also carries the requested view's transcript already rendered. A
 * cold deep link therefore paints its content from the first response, before
 * any module has executed — the property that matters most on a bad link.
 * @module
 */

import { randomBytes } from 'node:crypto'
import type { Asset, AssetTable } from './assets.ts'
import { MANIFEST_URL } from './manifest.ts'
import type { PendingApproval, PendingAsk } from './types.ts'

/**
 * The client file that is the service worker rather than an app module.
 *
 * It lives in `client/` because that is where the client source lives and it is
 * read, hashed and compressed by the same table — but it is reached at a stable
 * root url instead of a stamped `/m/` one, because a worker only controls pages
 * at or below its own path.
 */
export const SERVICE_WORKER = 'sw'

/** Where the service worker is served. Stable and root-scoped by necessity. */
export const SERVICE_WORKER_URL = '/sw.js'

/** A module's bare import that the import map cannot resolve. */
export interface UnresolvedImport {
  /** The client module holding the import, without its extension. */
  readonly module: string
  /** The bare specifier it named, which has no `client/<name>.js` behind it. */
  readonly specifier: string
}

/** What the shell needs to render one route's first paint. */
export interface ShellState {
  /** Serialized `<article>` frames for the focused session, already safe. */
  readonly frames: string
  /** The focused session id, or null for the chooser and the empty state. */
  readonly sessionId: string | null
  /** The title shown in the header. */
  readonly title: string
  /** Last durable seq already present in {@link frames}. */
  readonly renderedThrough: number
  /**
   * Whether the focused session's whole log holds no transcript at all.
   *
   * A blank transcript is otherwise ambiguous — a session with nothing in it and
   * one whose content has not arrived look identical. This is what lets the
   * first paint say which it is.
   */
  readonly empty: boolean
  /**
   * Whether the log holds events older than the ones in {@link frames}.
   *
   * The first paint is one bounded chunk, so this is what tells the page to
   * offer the link back into the rest — without it the page would have to spend
   * a request discovering there is nothing there.
   */
  readonly more: boolean
  /**
   * The seq a backwards read must start from.
   *
   * Not the oldest frame in {@link frames}: the first paint keeps every prompt
   * and every answered question however far back it sits, so the oldest row on
   * screen can be the first message of the log while the work between it and the
   * bounded window has not been shown at all. Reading back from the page would
   * ask for everything before the first message — nothing — and strand the
   * middle of the transcript, so the bounded window's own edge travels instead.
   * `-1` when the route paints no transcript.
   */
  readonly oldest: number
  /** Questions the focused session is waiting on, so a cold deep link shows them before the stream connects. */
  readonly asks: readonly PendingAsk[]
  /** Permissions the focused session is waiting on, for the same reason as {@link ShellState.asks}. */
  readonly approvals: readonly PendingApproval[]
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
  // Every module the table holds gets a key, exactly as the table is at this
  // moment. The map and the files a page is told to fetch are therefore one
  // snapshot, not two that can be read at different times.
  const imports: Record<string, string> = {}
  const preloads: string[] = []
  for (const [name, asset] of assets.modules) {
    // The service worker is not an app module: it is fetched by the browser at
    // its own stable root url, runs in a separate global, and imports nothing.
    // Given a key here it would be preloaded on every page load — bytes no page
    // ever executes — and listed as a specifier the entry could import.
    if (name === SERVICE_WORKER) continue
    imports[name] = asset.url
    preloads.push(`<link rel=modulepreload href="${asset.url}">`)
  }
  const entry = assets.modules.get('app')
  const unresolved = unresolvedImports(assets)
  const boot = JSON.stringify({
    sessionId: state.sessionId,
    renderedThrough: state.renderedThrough,
    empty: state.empty,
    more: state.more,
    oldest: state.oldest,
    asks: state.asks,
    approvals: state.approvals,
    showTools: state.showTools,
  })
  const html = `<!doctype html>
<html lang=en>
<meta charset=utf-8>
<meta name=viewport content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<title>${escapeText(state.title)}</title>
${installTags(assets)}
<link rel=stylesheet href="${assets.stylesheet.url}">
<script type=importmap nonce="${nonce}">${JSON.stringify({ imports })}</script>
${preloads.join('\n')}
<header${state.showTools ? ' hidden' : ''}>
<a id=pick href="/sessions">Sessions</a>
<p id=where hidden></p>
<h1><button type=button id=title>${escapeText(state.title)}</button></h1>
</header>
<section id=menu hidden></section>
<div id=tools${state.showTools ? '' : ' hidden'}>
<button type=button id=new-session>New session</button>
<button type=button id=new-workspace>New workspace</button>
</div>
<section id=dialog></section>
<section id=alerts hidden></section>
${notice(entry, unresolved)}
<main id=log>${state.frames}${state.empty ? '<p class=state data-notice=empty>This session has no messages yet.</p>' : ''}</main>
<section id=ask></section>
<section id=approval></section>
<section id=errors></section>
<form id=composer${state.sessionId === null ? ' hidden' : ''}>
<!-- The checkout-name button is always last. It is the widest control here by
     far — a worktree name is shown in full and never truncated — and the row is
     one line that scrolls sideways, so anything placed after it would be pushed
     off the visible end and have to be scrolled to. Keep the fixed-width,
     short-labelled actions first, where they are always in view. -->
<div id=actions><button type=button id=clear>Clear</button><button type=button id=merge>Merge</button><button type=button id=rebase>Rebase</button><button type=button id=undo disabled>Undo</button><button type=button id=insert-worktree hidden></button></div>
<textarea id=box rows=1 placeholder="Message this session" enterkeyhint=send></textarea>
<button id=send type=submit>Send</button>
</form>
<script type=application/json id=boot nonce="${nonce}">${escapeJson(boot)}</script>
${entry === undefined ? '' : `<script type=module src="${entry.url}" nonce="${nonce}"></script>`}
`
  return { html, nonce }
}

/**
 * The tags that let this page be added to a home screen.
 *
 * Two audiences, because they do not read the same things:
 *
 * - **Android and desktop** read the manifest, and everything — name, icons,
 *   colours, launch url — comes from there.
 * - **iOS does not.** Safari has never implemented manifest icons for "Add to
 *   Home Screen"; it reads `apple-touch-icon`, and without that link it
 *   screenshots the page and uses that as the icon. `apple-mobile-web-app-*` is
 *   likewise how iOS is told to launch without browser chrome and what to title
 *   the icon. These tags are not legacy cruft — dropping them silently
 *   downgrades every iPhone install to a screenshot in a browser frame.
 *
 * `theme-color` is what paints the status bar on Android, and it is emitted per
 * scheme so the bar matches the page the reader actually gets rather than
 * forcing a light bar onto a dark page.
 *
 * Every icon href is the digest-stamped url, so the icons are immutable and
 * cached forever; only the manifest itself sits at a stable, revalidated path.
 * @param assets - the table holding the stamped icons.
 * @returns the head tags, with the icon links omitted if no icon is on disk.
 */
function installTags(assets: AssetTable): string {
  const tags = [`<link rel=manifest href="${MANIFEST_URL}">`]
  const icon = assets.extras.get('icon')
  if (icon !== undefined) tags.push(`<link rel=icon href="${icon.url}" type="image/svg+xml">`)
  // iOS wants a raster here and has never read an SVG for it: pointed at one it
  // silently falls back to screenshotting the page, which is the blurry-tile
  // install this link exists to prevent. 192 is the smallest icon that is
  // comfortably larger than every size iOS asks for, so it is the one offered,
  // and the SVG is deliberately not a fallback for it — no link at all is better
  // than one Safari cannot read.
  const touch = assets.extras.get('icon-192')
  if (touch !== undefined) tags.push(`<link rel=apple-touch-icon href="${touch.url}">`)
  tags.push('<meta name=apple-mobile-web-app-capable content=yes>')
  // `black-translucent` would run the page under the status bar, which this
  // layout does not inset for; `default` keeps the bar its own solid strip.
  tags.push('<meta name=apple-mobile-web-app-status-bar-style content=default>')
  tags.push('<meta name=apple-mobile-web-app-title content="Harness">')
  tags.push('<meta name=mobile-web-app-capable content=yes>')
  tags.push('<meta name=theme-color media="(prefers-color-scheme: light)" content="#fff">')
  tags.push('<meta name=theme-color media="(prefers-color-scheme: dark)" content="#121212">')
  return tags.join('\n')
}

/**
 * The server-rendered notice for a page whose client code cannot run.
 *
 * Rendered into the document rather than logged alone, because the failure mode
 * this replaces is a page that looks fine to every server-side check and runs no
 * code at all: `/api/sessions` answers 200, nothing is thrown, and the reader
 * sees an empty screen. The notice is the only thing that can tell them why, and
 * it is server HTML, so it is present even when no module ever executes.
 *
 * Empty when the page is sound, so a healthy response carries no extra bytes.
 * @param entry - the entry module, absent if `client/app.js` is missing.
 * @param unresolved - the imports no key can satisfy.
 * @returns the notice markup, or an empty string.
 */
function notice(entry: Asset | undefined, unresolved: readonly UnresolvedImport[]): string {
  const lines: string[] = []
  if (entry === undefined) {
    lines.push('The client entry module is missing: no client/app.js is being served, so this page cannot run at all.')
  }
  for (const problem of unresolved) {
    lines.push(`The import map has no entry for "${problem.specifier}", which ${problem.module}.js imports. There is no client/${problem.specifier}.js, so the browser cannot resolve it and no client code runs.`)
  }
  if (lines.length === 0) return ''
  lines.push('Nothing else on this page is functional until this is fixed. The server itself is answering normally.')
  return `<pre class=error data-notice=unresolved>${escapeText(lines.join('\n\n'))}</pre>`
}

/**
 * The bare specifiers the served client modules import that no key can satisfy.
 *
 * The whole set is checked, not only the entry: a nested module that names a
 * missing file breaks the chain the entry loads through, so it blanks the page
 * exactly as a missing entry import would. Relative and absolute specifiers are
 * skipped — those resolve without a map key — and so are `node:`-style URLs.
 *
 * Cached against the module set, keyed by each name and its digest, so the
 * parse runs once per change to the client files rather than once per page.
 * @param assets - the table to check.
 * @returns every unresolved import, empty when the page is sound.
 */
export function unresolvedImports(assets: AssetTable): readonly UnresolvedImport[] {
  const key = [...assets.modules].map(([name, asset]) => `${name}:${asset.url}`).sort().join(',')
  if (checked.key === key) return checked.problems
  const problems: UnresolvedImport[] = []
  for (const [name, asset] of assets.modules) {
    for (const specifier of importedSpecifiers(asset)) {
      if (assets.modules.has(specifier)) continue
      problems.push({ module: name, specifier })
    }
  }
  checked = { key, problems }
  return problems
}

/** The last check, and the module set it was made against. */
let checked: { key: string; problems: readonly UnresolvedImport[] } = { key: '\u0000', problems: [] }

/**
 * Separate one module's static imports from the rest of its source.
 *
 * Two alternatives, because ESM admits two statement shapes and they need
 * different guards:
 *
 * - `import 'y'` — a side-effect import, which has no clause at all.
 * - `import … from 'y'` / `export … from 'y'` — a clause and then `from`.
 *
 * The second requires the literal `from`, and that requirement is what makes
 * this correct: matching any `import`/`export` followed by quotes instead would
 * read `export const proof = 'a string'` as an import of `a string`, inventing a
 * missing module out of ordinary text. The clause is allowed to span lines but
 * never a `;`, so the next statement cannot be swallowed, and it excludes `(`,
 * which keeps a dynamic `import('y')` out — that resolves at run time and its
 * failure is a rejected promise, not a page where nothing runs.
 *
 * A leading `^`/newline/`;`/`}` keeps a match from starting mid-token.
 */
const IMPORT_CLAUSE = /(?:^|[\n;}])\s*import\s*['"]([^'"]+)['"]|(?:^|[\n;}])\s*(?:import|export)\s+[\w\s*{},$]*?\bfrom\s*['"]([^'"]+)['"]/g

/**
 * The bare specifiers one module names statically.
 *
 * The argument is the asset, and its bytes are the same ones the browser will
 * fetch, so what is checked is what will actually be loaded. Relative paths
 * (`./x`) and absolute ones (`/m/x.js`) resolve without the map and are skipped,
 * as is anything with a scheme (`node:fs`).
 * @param asset - the module to read.
 * @returns the specifiers that need a map key.
 */
function importedSpecifiers(asset: Asset): string[] {
  const out: string[] = []
  for (const match of asset.bytes.toString('utf8').matchAll(IMPORT_CLAUSE)) {
    // Either alternative may be the one that matched, so the specifier is
    // whichever group is populated.
    const specifier = match[1] ?? match[2]
    if (specifier === undefined || specifier === '') continue
    // A leading `.` or `/` is a path, and a scheme is a URL; neither is a bare
    // specifier, so neither is the map's to resolve.
    if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':')) continue
    out.push(specifier)
  }
  return out
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
    // Named explicitly rather than left to `default-src`. The manifest is what
    // makes the page installable, and a blocked one fails as "not installable"
    // with no visible error on the page — the exact failure that is hardest to
    // attribute later.
    "manifest-src 'self'",
    // Same reasoning as the manifest, and the same failure mode: the service
    // worker is what receives a push while no page is open, and a blocked
    // registration surfaces only in the console — the page looks fine and
    // notifications simply never arrive. It would be allowed by `default-src`
    // anyway, being same-origin; naming it says so on purpose.
    "worker-src 'self'",
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
