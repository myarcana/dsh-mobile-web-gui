/**
 * The closed document vocabulary the transcript is allowed to express, and the
 * minted URL brand its links carry.
 *
 * Unsafe output is unrepresentable here rather than filtered later: there is no
 * `script`, `style`, `iframe`, `img`, or attribute-bearing variant, so no
 * expression in this package can produce one. That is what lets the browser
 * insert transcript HTML with `insertAdjacentHTML` and ship no sanitizer.
 * @module
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** A URL admitted by {@link SafeUrl}; minted by check, never asserted. */
export type SafeUrl = Branded<'SafeUrl'>

/**
 * Apply a compile-time string brand without changing the value.
 *
 * Inlined rather than imported from `@deepseek-ai/dsh-brand`'s `brandString`:
 * the host's installed `dsh-brand` predates that runtime export, and the
 * package documents itself as carrying no runtime identity, so a same-shape
 * local copy is exactly equivalent.
 */
function brandString<T extends string>(value: string): T {
  return value as T
}

/** Schemes a transcript link may address. `javascript:` and `data:` are absent by construction. */
const SAFE_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:'])

/**
 * Admit a raw href as a transcript-safe URL.
 *
 * Mirrors the `SessionSeq(value)` minting convention: the only way to obtain
 * the brand is to pass this check, so an `a` node cannot be constructed around
 * an unchecked href.
 * @param raw - candidate href from model or user text.
 * @returns the same string carrying the safe-URL brand.
 * @throws TypeError when the scheme is not http, https, or mailto, and the value is not a same-origin relative path.
 */
export function SafeUrl(raw: string): SafeUrl {
  const trimmed = raw.trim()
  if (trimmed === '') throw new TypeError('SafeUrl must not be empty')
  // A same-origin relative path: no scheme, and no protocol-relative prefix.
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return brandString<SafeUrl>(trimmed)
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new TypeError(`SafeUrl must be absolute or root-relative, got ${JSON.stringify(raw)}`)
  }
  if (!SAFE_SCHEMES.has(parsed.protocol)) {
    throw new TypeError(`SafeUrl refuses scheme ${parsed.protocol} in ${JSON.stringify(raw)}`)
  }
  return brandString<SafeUrl>(parsed.href)
}

/**
 * The presentation classes a paragraph may carry.
 *
 * A closed set rather than a free string: these name the styles the answered
 * record shares with the live answer form, so the two cannot drift into looking
 * like different things, and no arbitrary class can be injected into the page.
 */
export type TextClass = 'question' | 'detail' | 'from'

/**
 * Column alignment a GFM delimiter row can request.
 *
 * A closed union, not a free string: the serializer maps it to a fixed class
 * name, so a cell carries no attribute value derived from source text.
 * `null` is the unaligned default.
 */
export type Align = 'left' | 'center' | 'right' | null

/** Heading levels GFM admits, closed so a tag name is never computed from input. */
export type Depth = 1 | 2 | 3 | 4 | 5 | 6

/** Inline and block content a transcript may hold. Adding a variant is a compile error at the serializer. */
export type Node =
  | { readonly t: 'text'; readonly s: string }
  | { readonly t: 'p' | 'em' | 'strong' | 'strike' | 'li' | 'ul' | 'ol' | 'quote'; readonly c: readonly Node[] }
  | { readonly t: 'code'; readonly lang: string | null; readonly s: string }
  | { readonly t: 'mono'; readonly s: string }
  | { readonly t: 'a'; readonly href: SafeUrl; readonly c: readonly Node[] }
  // A paragraph carrying one of the answer form's own classes, so a question
  // kept in the transcript is styled by the same rules as a waiting one.
  | { readonly t: 'line'; readonly cls: TextClass; readonly s: string }
  // One already-made choice, drawn as the disabled control the reader used.
  // `checked` is what they picked; `multi` decides whether it draws as a
  // checkbox or a radio, exactly as the live form does.
  | { readonly t: 'choice'; readonly multi: boolean; readonly checked: boolean; readonly s: string }
  // The free-text option, drawn as the disabled pair the live form builds: a
  // control that says whether typing was the answer, and the box itself holding
  // what was typed. `s` empty means they answered by picking instead, and the
  // box keeps the placeholder it offered rather than becoming a different shape.
  | { readonly t: 'typed'; readonly multi: boolean; readonly checked: boolean; readonly s: string; readonly hint: string }
  // GFM block constructs. A table carries its rows already split into head and
  // body so the serializer never has to decide which is which.
  | { readonly t: 'heading'; readonly depth: Depth; readonly c: readonly Node[] }
  | { readonly t: 'table'; readonly head: readonly Node[]; readonly body: readonly Node[] }
  | { readonly t: 'tr'; readonly c: readonly Node[] }
  | { readonly t: 'th' | 'td'; readonly align: Align; readonly c: readonly Node[] }
  | { readonly t: 'hr' }
  // A hard line break, which GFM writes as two trailing spaces or a backslash.
  | { readonly t: 'br' }
  // A task-list marker, drawn as the disabled control it is. Distinct from
  // `choice`: this one is inline, inside a list item the reader did not answer.
  | { readonly t: 'task'; readonly done: boolean }

/**
 * Build a plain text node.
 * @param s - literal text, escaped once at serialization.
 * @returns the text node.
 */
export function text(s: string): Node {
  return { t: 'text', s }
}

/**
 * Build a link node around already-admitted content.
 * @param href - a minted safe URL.
 * @param c - link content.
 * @returns the anchor node.
 */
export function link(href: SafeUrl, c: readonly Node[]): Node {
  return { t: 'a', href, c }
}
