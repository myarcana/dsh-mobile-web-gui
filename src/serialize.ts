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
    case 'tr':
      return `<${node.t}>${serializeAll(node.c)}</${node.t}>`
    case 'quote':
      return `<blockquote>${serializeAll(node.c)}</blockquote>`
    case 'strike':
      return `<del>${serializeAll(node.c)}</del>`
    case 'hr':
      return '<hr>'
    case 'br':
      return '<br>'
    case 'heading':
      // `depth` is a closed union of 1-6, so the tag name is one of six literals
      // this module admits rather than a number taken from source text.
      return `<h${node.depth}>${serializeAll(node.c)}</h${node.depth}>`
    case 'table':
      // Wrapped so a wide table scrolls within its own band instead of widening
      // the document. This is the same sanctioned exception `pre` already takes.
      return `<div class="tablewrap"><table><thead>${serializeAll(node.head)}</thead>`
        + `<tbody>${serializeAll(node.body)}</tbody></table></div>`
    case 'th':
    case 'td':
      // `align` is a closed union, so this is a fixed class name from this
      // module's vocabulary, never an attribute value derived from input.
      return node.align === null
        ? `<${node.t}>${serializeAll(node.c)}</${node.t}>`
        : `<${node.t} class="a${node.align}">${serializeAll(node.c)}</${node.t}>`
    case 'task':
      // A task-list marker records a state the author wrote down; it is not a
      // control the reader can operate, so it is disabled and out of the tab order.
      return `<input class="pick" type="checkbox"${node.done ? ' checked' : ''} disabled>`
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
    case 'line':
      // The class comes from a closed union, so it is a literal from this
      // module's own vocabulary rather than anything a model or a host supplied.
      return `<p class="${node.cls}">${escape(node.s)}</p>`
    case 'choice':
      // The same shape the live form builds, with the control disabled: a record
      // of a decision already made is not a decision still open, so it must not
      // be focusable, tabbable, or submittable. `disabled` is what takes it out
      // of the tab order; readonly would not.
      return `<label><input class="pick" type="${node.multi ? 'checkbox' : 'radio'}"`
        + `${node.checked ? ' checked' : ''} disabled>${escape(node.s)}</label>`
    case 'typed':
      // The live form's last row, frozen: the same control beside the same box.
      // `value` carries what was typed and `placeholder` what was offered, so an
      // untyped answer still reads as the box the reader declined to use. Both
      // are disabled for the same reason the choices are — a made decision is
      // not an open one, and must not be focusable, tabbable, or submittable.
      return `<label><input class="pick" type="${node.multi ? 'checkbox' : 'radio'}"`
        + `${node.checked ? ' checked' : ''} disabled>`
        + `<input class="other" value="${escape(node.s)}" placeholder="${escape(node.hint)}" disabled></label>`
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
