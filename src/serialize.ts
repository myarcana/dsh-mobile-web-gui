/**
 * The only producer of HTML strings in this package.
 *
 * Every variable byte leaves through {@link escape}, which no other module can
 * reach. The switch is exhaustive over {@link Node}, so adding a variant without
 * a case here is a compile error rather than a silently unserialized node.
 * @module
 */

import type { Node } from './node.ts'

/** Characters that would otherwise end an element or attribute early. */
const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Escape text for both element content and double-quoted attribute values.
 * @param raw - untrusted text of any origin.
 * @returns the text with every HTML-significant character replaced.
 */
function escape(raw: string): string {
  return raw.replace(/[&<>"']/g, character => ESCAPES[character] ?? character)
}

/**
 * Serialize one node and its descendants to HTML.
 * @param node - a node from the closed vocabulary.
 * @returns HTML whose only variable parts passed {@link escape}.
 */
export function serialize(node: Node): string {
  switch (node.t) {
    case 'text':
      return escape(node.s)
    case 'p':
    case 'em':
    case 'strong':
    case 'li':
    case 'ul':
    case 'ol':
      return `<${node.t}>${serializeAll(node.c)}</${node.t}>`
    case 'quote':
      return `<blockquote>${serializeAll(node.c)}</blockquote>`
    case 'mono':
      return `<code>${escape(node.s)}</code>`
    case 'code':
      // The language label is the one attribute value this vocabulary carries.
      return node.lang === null
        ? `<pre><code>${escape(node.s)}</code></pre>`
        : `<pre><code class="lang-${escape(node.lang)}">${escape(node.s)}</code></pre>`
    case 'a':
      // `href` carries the SafeUrl brand, so its scheme was admitted at mint
      // time; escaping still runs because a safe scheme can carry a quote.
      return `<a href="${escape(node.href)}" rel="noreferrer noopener">${serializeAll(node.c)}</a>`
  }
}

/**
 * Serialize a node list in order.
 * @param nodes - the children to serialize.
 * @returns their concatenated HTML.
 */
export function serializeAll(nodes: readonly Node[]): string {
  let html = ''
  for (const node of nodes) html += serialize(node)
  return html
}
