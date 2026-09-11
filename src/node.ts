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

/** Inline and block content a transcript may hold. Adding a variant is a compile error at the serializer. */
export type Node =
  | { readonly t: 'text'; readonly s: string }
  | { readonly t: 'p' | 'em' | 'strong' | 'li' | 'ul' | 'ol' | 'quote'; readonly c: readonly Node[] }
  | { readonly t: 'code'; readonly lang: string | null; readonly s: string }
  | { readonly t: 'mono'; readonly s: string }
  | { readonly t: 'a'; readonly href: SafeUrl; readonly c: readonly Node[] }

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
