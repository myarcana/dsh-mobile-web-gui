/**
 * GitHub Flavored Markdown into the closed {@link Node} vocabulary.
 *
 * The parsing is done by `marked` (vendored, see `vendor/README.md`), but only
 * its **lexer** — literally: the vendored copy is trimmed to the lexer, and the
 * renderer that would emit HTML is not present to be called. The token tree is
 * mapped here into {@link Node} instead. That distinction is the whole safety
 * argument.
 * `Node` has no `script`, `style`, `iframe`, `img`, or attribute-bearing
 * variant, so an inline-HTML construct in model output has no target other than
 * `text` and becomes visible characters. Raw HTML is therefore neutralised by
 * the shape of the destination rather than by a sanitizer pass that could be
 * misconfigured, which is what lets the browser keep using `insertAdjacentHTML`
 * and ship no sanitizer.
 *
 * GFM specifics covered: tables with per-column alignment, strikethrough, task
 * lists, headings, thematic breaks, and hard line breaks.
 * @module
 */

import { Lexer } from './vendor/marked.js'
import { SafeUrl, type Align, type Depth, type Node } from './node.ts'

/**
 * A lexer token. `marked`'s own token union is broader than the subset reached
 * here and its shapes are structural, so this names only the fields read below.
 * Every access is guarded, and an unrecognised token degrades to its raw text.
 */
interface Token {
  readonly type: string
  readonly raw?: string
  readonly text?: string
  readonly tokens?: readonly Token[]
  readonly items?: readonly Token[]
  readonly ordered?: boolean
  readonly depth?: number
  readonly href?: string
  readonly task?: boolean
  readonly checked?: boolean
  readonly header?: readonly Token[]
  readonly rows?: readonly (readonly Token[])[]
  readonly align?: readonly (string | null)[]
}

/** Entities the lexer leaves encoded, undone here so serialization escapes once, not twice. */
const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': '\u00a0',
}

/**
 * Decode the HTML entities the lexer passes through untouched.
 *
 * The lexer hands back `&amp;` verbatim because its own output stage would emit
 * it as-is. This vocabulary instead escapes every variable byte at
 * serialization, so leaving it encoded would render the literal text `&amp;`.
 * Decoding here makes exactly one escape happen, in the serializer.
 * @param raw - token text straight from the lexer.
 * @returns the text with known entities resolved to their characters.
 */
function decode(raw: string): string {
  return raw.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, entity => ENTITIES[entity] ?? entity)
}

/**
 * Map the alignment the delimiter row requested onto the closed union.
 * @param value - marked's alignment for one column.
 * @returns the admitted alignment, or `null` when unset or unrecognised.
 */
function alignment(value: string | null | undefined): Align {
  return value === 'left' || value === 'center' || value === 'right' ? value : null
}

/**
 * Clamp a heading level into the closed {@link Depth} union.
 *
 * The lexer only ever reports 1-6, but the type is a plain number; narrowing it
 * here is what keeps the serializer's tag name one of six literals.
 * @param value - the reported heading depth.
 * @returns a level between 1 and 6.
 */
function depth(value: number | undefined): Depth {
  switch (value) {
    case 1: return 1
    case 2: return 2
    case 3: return 3
    case 4: return 4
    case 5: return 5
    default: return value === 6 ? 6 : 3
  }
}

/**
 * Parse markdown into transcript nodes.
 * @param source - raw markdown, of any origin and any hostility.
 * @returns block-level nodes; never markup, only data.
 */
export function markdown(source: string): Node[] {
  // `gfm` is marked's default, named here so the intent survives a version bump.
  // `breaks` stays off: a single newline is not a hard break in GFM, and the
  // transcript's `pre-wrap` already preserves authored line breaks visually.
  return blocks(Lexer.lex(source, { gfm: true, breaks: false }))
}

/**
 * Map a run of block-level tokens.
 * @param tokens - lexer output at block level.
 * @returns the corresponding block nodes.
 */
function blocks(tokens: readonly Token[]): Node[] {
  const nodes: Node[] = []
  for (const token of tokens) {
    const node = block(token)
    if (node !== null) nodes.push(node)
  }
  return nodes
}

/**
 * Map one block-level token.
 * @param token - a lexer token.
 * @returns its node, or `null` when the token contributes nothing to render.
 */
function block(token: Token): Node | null {
  switch (token.type) {
    case 'space':
      return null
    case 'heading':
      return { t: 'heading', depth: depth(token.depth), c: inline(token.tokens ?? []) }
    case 'code':
      return { t: 'code', lang: language(token), s: token.text ?? '' }
    case 'blockquote':
      return { t: 'quote', c: blocks(token.tokens ?? []) }
    case 'list':
      return { t: token.ordered === true ? 'ol' : 'ul', c: (token.items ?? []).map(item) }
    case 'table':
      return table(token)
    case 'hr':
      return { t: 'hr' }
    case 'html':
      // No markup variant exists to route this to. The raw source becomes the
      // paragraph's visible text, which is the only representable outcome.
      return { t: 'p', c: [{ t: 'text', s: token.raw ?? token.text ?? '' }] }
    case 'paragraph':
    case 'text':
      return { t: 'p', c: inline(token.tokens ?? [{ type: 'text', text: token.text ?? '' }]) }
    default:
      // An unmapped construct still has to reach the reader, so it is shown as
      // the characters the author typed rather than dropped.
      return token.raw === undefined || token.raw.trim() === ''
        ? null
        : { t: 'p', c: [{ t: 'text', s: token.raw }] }
  }
}

/**
 * Read a fenced block's language label.
 * @param token - a `code` token.
 * @returns the label, or `null` when the fence carried none.
 */
function language(token: Token): string | null {
  const raw = token.raw ?? ''
  const fence = /^\s*(?:```|~~~)([^\s`]*)/.exec(raw)
  const label = fence?.[1] ?? ''
  return label === '' ? null : label
}

/**
 * Map one list item, carrying its task-list marker when it has one.
 * @param token - a `list_item` token.
 * @returns the list-item node.
 */
function item(token: Token): Node {
  const content: Node[] = []
  // A task item's marker is reported both as the item's `task` flag and as a
  // leading `checkbox` token. Rendering the flag and then mapping the token
  // would draw the box twice, so the token is dropped here and the flag wins.
  for (const child of token.tokens ?? []) {
    if (child.type === 'checkbox') continue
    // A tight item's text and paragraph children hold the line's inline
    // content. Emitting a `p` around them would both nest needlessly and
    // defeat `li { white-space: normal }` in the stylesheet, so their inline
    // content is lifted directly into the item; only real nested blocks (a
    // sub-list, a fenced block) keep their own element.
    if (child.type === 'text' || child.type === 'paragraph') {
      content.push(...inline(child.tokens ?? [{ type: 'text', text: child.text ?? '' }]))
      continue
    }
    const node = block(child)
    if (node !== null) content.push(node)
  }
  if (token.task !== true) return { t: 'li', c: content }
  return { t: 'li', c: [{ t: 'task', done: token.checked === true }, ...content] }
}

/**
 * Map a GFM table, splitting head from body so the serializer never decides.
 * @param token - a `table` token.
 * @returns the table node.
 */
function table(token: Token): Node {
  const align = token.align ?? []
  const head: Node = {
    t: 'tr',
    c: (token.header ?? []).map((cell, column) => cellNode('th', cell, alignment(align[column]))),
  }
  const body = (token.rows ?? []).map(row => ({
    t: 'tr' as const,
    c: row.map((cell, column) => cellNode('td', cell, alignment(align[column]))),
  }))
  return { t: 'table', head: [head], body }
}

/**
 * Build one table cell.
 * @param tag - whether the cell belongs to the head or the body.
 * @param cell - the cell token carrying its inline content.
 * @param align - the column's admitted alignment.
 * @returns the cell node.
 */
function cellNode(tag: 'th' | 'td', cell: Token, align: Align): Node {
  return { t: tag, align, c: inline(cell.tokens ?? []) }
}

/**
 * Map a run of inline tokens.
 * @param tokens - lexer output at inline level.
 * @returns the corresponding inline nodes.
 */
function inline(tokens: readonly Token[]): Node[] {
  const nodes: Node[] = []
  for (const token of tokens) nodes.push(...inlineOne(token))
  return nodes
}

/**
 * Map one inline token.
 * @param token - a lexer token.
 * @returns its nodes; a list because some tokens degrade to plain text.
 */
function inlineOne(token: Token): Node[] {
  switch (token.type) {
    case 'text':
    case 'escape':
      // A `text` token may itself carry children once the inline lexer has run
      // over it; prefer those so nested emphasis is not flattened.
      return token.tokens !== undefined && token.tokens.length > 0
        ? inline(token.tokens)
        : [{ t: 'text', s: decode(token.text ?? '') }]
    case 'strong':
      return [{ t: 'strong', c: inline(token.tokens ?? []) }]
    case 'em':
      return [{ t: 'em', c: inline(token.tokens ?? []) }]
    case 'del':
      return [{ t: 'strike', c: inline(token.tokens ?? []) }]
    case 'codespan':
      return [{ t: 'mono', s: decode(token.text ?? '') }]
    case 'br':
      return [{ t: 'br' }]
    case 'link':
      return [anchor(token.href ?? '', inline(token.tokens ?? []), token.text ?? '')]
    case 'image':
      // No image variant exists: rendering a remote reference would let a model
      // that has read your files exfiltrate them through a URL. It reads as its
      // alt text, matching how an attached image is shown elsewhere.
      return [{ t: 'text', s: decode(token.text ?? '') }]
    case 'html':
      // Markup has no target variant; it becomes the characters it is made of.
      return [{ t: 'text', s: token.raw ?? token.text ?? '' }]
    default:
      return [{ t: 'text', s: decode(token.raw ?? token.text ?? '') }]
  }
}

/**
 * Build a link, degrading to plain text when the href is not admissible.
 *
 * A refused scheme is shown rather than dropped, so a `javascript:` href in
 * model output stays legible to the reader as the text it is.
 * @param href - candidate URL from the source text.
 * @param content - the link's already-mapped visible content.
 * @param label - the link's text, used when the href is refused.
 * @returns an anchor node, or text when {@link SafeUrl} refuses the href.
 */
function anchor(href: string, content: readonly Node[], label: string): Node {
  try {
    return { t: 'a', href: SafeUrl(href), c: content }
  } catch {
    const text = decode(label)
    return { t: 'text', s: text === href ? href : `${text} (${href})` }
  }
}
