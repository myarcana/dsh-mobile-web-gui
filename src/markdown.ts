/**
 * Markdown text into the closed {@link Node} vocabulary.
 *
 * This is a deliberately partial markdown: it covers what a coding transcript
 * actually contains and maps everything else to text. An inline-HTML construct
 * has no target variant other than `text`, so raw HTML in model output becomes
 * visible characters rather than markup — not a sanitizer setting, the only
 * destination.
 * @module
 */

import { SafeUrl, type Node } from './node.ts'

/** A fenced block opener, capturing the optional language label. */
const FENCE = /^```(\w*)\s*$/

/** Inline constructs, alternated so the leftmost match wins in one pass. */
const INLINE = /(\*\*|__)(.+?)\1|(\*|_)(.+?)\3|`([^`]+)`|\[([^\]]*)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+)/

/**
 * Parse markdown into transcript nodes.
 * @param source - raw markdown, of any origin and any hostility.
 * @returns block-level nodes; never markup, only data.
 */
export function markdown(source: string): Node[] {
  const lines = source.split('\n')
  const blocks: Node[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    const fence = FENCE.exec(line)
    if (fence !== null) {
      const body: string[] = []
      index += 1
      while (index < lines.length && FENCE.exec(lines[index] ?? '') === null) {
        body.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      blocks.push({ t: 'code', lang: fence[1] === undefined || fence[1] === '' ? null : fence[1], s: body.join('\n') })
      continue
    }
    if (line.trim() === '') {
      index += 1
      continue
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (index < lines.length && /^\s*>/.test(lines[index] ?? '')) {
        body.push((lines[index] ?? '').replace(/^\s*>\s?/, ''))
        index += 1
      }
      blocks.push({ t: 'quote', c: markdown(body.join('\n')) })
      continue
    }
    const bullet = /^\s*([-*+]|\d+[.)])\s+/.exec(line)
    if (bullet !== null) {
      const ordered = /\d/.test(bullet[1] ?? '')
      const items: Node[] = []
      while (index < lines.length) {
        const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index] ?? '')
        if (item === null) break
        items.push({ t: 'li', c: inline(item[2] ?? '') })
        index += 1
      }
      blocks.push({ t: ordered ? 'ol' : 'ul', c: items })
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      index += 1
      blocks.push({ t: 'p', c: [{ t: 'strong', c: inline(heading[2] ?? '') }] })
      continue
    }
    const paragraph: string[] = []
    while (index < lines.length) {
      const next = lines[index] ?? ''
      if (next.trim() === '' || FENCE.exec(next) !== null || /^\s*>/.test(next)
        || /^\s*([-*+]|\d+[.)])\s+/.test(next) || /^#{1,6}\s+/.test(next)) break
      paragraph.push(next)
      index += 1
    }
    blocks.push({ t: 'p', c: inline(paragraph.join('\n')) })
  }
  return blocks
}

/**
 * Parse inline markdown within one block.
 * @param source - the block's raw text.
 * @returns inline nodes, with unmatched text preserved literally.
 */
function inline(source: string): Node[] {
  const nodes: Node[] = []
  let rest = source
  while (rest !== '') {
    const match = INLINE.exec(rest)
    if (match === null || match.index === undefined) break
    if (match.index > 0) nodes.push({ t: 'text', s: rest.slice(0, match.index) })
    const [, , strongBody, , emBody, codeBody, linkText, linkHref, bareUrl] = match
    if (strongBody !== undefined) nodes.push({ t: 'strong', c: inline(strongBody) })
    else if (emBody !== undefined) nodes.push({ t: 'em', c: inline(emBody) })
    else if (codeBody !== undefined) nodes.push({ t: 'mono', s: codeBody })
    else if (linkHref !== undefined) nodes.push(anchor(linkHref, linkText ?? linkHref))
    else if (bareUrl !== undefined) nodes.push(anchor(bareUrl, bareUrl))
    rest = rest.slice(match.index + match[0].length)
  }
  if (rest !== '') nodes.push({ t: 'text', s: rest })
  return nodes
}

/**
 * Build a link, degrading to plain text when the href is not admissible.
 *
 * A refused scheme is shown rather than dropped, so a `javascript:` href in
 * model output stays legible to the reader as the text it is.
 * @param href - candidate URL from the source text.
 * @param label - the link's visible text.
 * @returns an anchor node, or text when {@link SafeUrl} refuses the href.
 */
function anchor(href: string, label: string): Node {
  try {
    return { t: 'a', href: SafeUrl(href), c: [{ t: 'text', s: label }] }
  } catch {
    return { t: 'text', s: label === href ? href : `${label} (${href})` }
  }
}
