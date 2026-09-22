// Assignments to names that are not in scope where they are assigned.
//
// This exists because of a real bug that cost a working button. `create()` in
// client/create.js ended with:
//
//     } finally {
//       running = false        // ← declared in startInline, NOT in scope here
//       clearInterval(ticker)
//     }
//
// ES modules are always strict, so that is not an implicit global — it is a
// ReferenceError. It sat in a `finally`, so it threw on the SUCCESS path, after
// the session had been created and after `onCreated` had already navigated.
// The visible symptom was nothing at all: the session appeared, the reader
// landed on it, and the one thing that never ran was the listener that records
// which worktree the session was started in. Merge and Rebase then had no
// checkout name and fell through a silent `return`.
//
// A ReferenceError in a `finally` on a success path is close to invisible:
// nothing on screen changes, and the rejection is unhandled in a console nobody
// has open. So it is worth a static check rather than trusting review.
//
// Scope is resolved with a real parser, not a regex. The name in the bug above
// IS declared in the file — one function over — so a file-wide "is this word
// declared anywhere" test passes happily while the code throws. Only real
// lexical scoping distinguishes the two, which is the whole point of the check.
//
//   node scripts/verify-no-undeclared.mjs
//
// Exits non-zero listing file, line and name, so it can be trusted in a check.

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

// Playwright is already a dependency of the verify scripts in this directory
// and bundles Babel's parser. Using it keeps this check at zero new packages.
const require = createRequire(import.meta.url)
const { babelParse } = require('/usr/lib/node_modules/playwright/lib/transform/babelBundle.js')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientDir = join(root, 'client')

// Everything the browser supplies that this GUI reaches for. A name missing
// here surfaces as a false positive, so it is generous rather than minimal.
const GLOBALS = new Set([
  'window', 'document', 'console', 'localStorage', 'sessionStorage', 'location', 'history',
  'navigator', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback',
  'prompt', 'confirm', 'alert', 'matchMedia', 'getComputedStyle', 'scrollTo', 'scrollBy',
  'visualViewport', 'crypto', 'performance', 'queueMicrotask', 'structuredClone',
  'Date', 'JSON', 'Math', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Error', 'TypeError', 'RegExp', 'BigInt',
  'URL', 'URLSearchParams', 'AbortController', 'EventSource', 'WebSocket',
  'CustomEvent', 'Event', 'Intl', 'TextEncoder', 'TextDecoder', 'Notification',
  'DocumentFragment', 'HTMLElement', 'Node', 'FormData', 'Blob', 'File', 'Image',
  'globalThis', 'undefined', 'NaN', 'Infinity', 'parseInt', 'parseFloat', 'isNaN',
  'btoa', 'atob', 'encodeURIComponent', 'decodeURIComponent', 'Reflect', 'Proxy',
  'IntersectionObserver', 'MutationObserver', 'ResizeObserver', 'CSS', 'Range'
])

// Node types that open a new variable scope. `var` and function declarations
// hoist to the nearest FUNCTION scope; `let`/`const`/`class` stop at the
// nearest BLOCK. Both distinctions matter: the bug was a `let` in a sibling
// function, and treating every block as a function scope would miss a `var`
// legitimately shared across blocks.
const FUNCTION_SCOPE = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
  'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod', 'Program'
])
const BLOCK_SCOPE = new Set([
  'BlockStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement',
  'SwitchStatement', 'CatchClause', 'StaticBlock'
])

// Every identifier bound by a pattern: plain, destructured, defaulted, rest.
function bindPattern (node, out) {
  if (node === null || node === undefined || typeof node !== 'object') return
  switch (node.type) {
    case 'Identifier': out.push(node.name); break
    case 'ObjectPattern': for (const p of node.properties) bindPattern(p, out); break
    case 'ObjectProperty': bindPattern(node.value, out); break
    case 'ArrayPattern': for (const e of node.elements) bindPattern(e, out); break
    case 'RestElement': bindPattern(node.argument, out); break
    case 'AssignmentPattern': bindPattern(node.left, out); break
    default: break
  }
}

function childNodes (node) {
  const out = []
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (const v of value) if (v !== null && typeof v === 'object' && typeof v.type === 'string') out.push(v)
    } else if (value !== null && typeof value === 'object' && typeof value.type === 'string') {
      out.push(value)
    }
  }
  return out
}

// Hoisted `var` and function declarations, gathered from anywhere inside a
// function body regardless of block nesting.
function collectHoisted (node, scope) {
  for (const child of childNodes(node)) {
    const t = child.type
    if (t === 'VariableDeclaration' && child.kind === 'var') {
      for (const d of child.declarations) {
        const names = []
        bindPattern(d.id, names)
        for (const n of names) scope.add(n)
      }
    } else if (t === 'FunctionDeclaration') {
      if (child.id) scope.add(child.id.name)
      continue
    }
    if (FUNCTION_SCOPE.has(t)) continue
    collectHoisted(child, scope)
  }
}

const failures = []

function walk (node, scopes, file) {
  const t = node.type
  let pushed = false

  if (FUNCTION_SCOPE.has(t) || BLOCK_SCOPE.has(t)) {
    const scope = new Set()
    const isFn = FUNCTION_SCOPE.has(t)
    if (isFn) {
      // Parameters, the function's own name, and `arguments`.
      const names = []
      for (const p of node.params ?? []) bindPattern(p, names)
      for (const n of names) scope.add(n)
      if (node.id) scope.add(node.id.name)
      scope.add('arguments')
      scope.add('this')
      collectHoisted(node.body ?? node, scope)
    }
    if (t === 'CatchClause' && node.param) {
      const names = []
      bindPattern(node.param, names)
      for (const n of names) scope.add(n)
    }
    // Lexical declarations directly in this scope's statement list.
    const body = node.body ?? node
    const statements = Array.isArray(body) ? body : (body.body ?? [])
    for (const st of Array.isArray(statements) ? statements : []) {
      if (st.type === 'VariableDeclaration' && st.kind !== 'var') {
        for (const d of st.declarations) {
          const names = []
          bindPattern(d.id, names)
          for (const n of names) scope.add(n)
        }
      } else if (st.type === 'ClassDeclaration' && st.id) {
        scope.add(st.id.name)
      } else if (st.type === 'FunctionDeclaration' && st.id) {
        scope.add(st.id.name)
      } else if (st.type === 'ImportDeclaration') {
        for (const s of st.specifiers) scope.add(s.local.name)
      }
    }
    // for-loop heads bind in the loop's own scope.
    if (node.init?.type === 'VariableDeclaration' || node.left?.type === 'VariableDeclaration') {
      const decl = node.init?.type === 'VariableDeclaration' ? node.init : node.left
      for (const d of decl.declarations) {
        const names = []
        bindPattern(d.id, names)
        for (const n of names) scope.add(n)
      }
    }
    scopes.push(scope)
    pushed = true
  }

  // The check itself: a bare `name = ...` whose name is in no enclosing scope.
  if (t === 'AssignmentExpression' && node.left.type === 'Identifier') {
    const name = node.left.name
    const known = GLOBALS.has(name) || scopes.some(s => s.has(name))
    if (!known) failures.push({ file, line: node.left.loc?.start.line ?? 0, name })
  }
  if (t === 'UpdateExpression' && node.argument.type === 'Identifier') {
    const name = node.argument.name
    const known = GLOBALS.has(name) || scopes.some(s => s.has(name))
    if (!known) failures.push({ file, line: node.argument.loc?.start.line ?? 0, name })
  }

  for (const child of childNodes(node)) walk(child, scopes, file)
  if (pushed) scopes.pop()
}

for (const file of readdirSync(clientDir).filter(n => n.endsWith('.js')).sort()) {
  const src = readFileSync(join(clientDir, file), 'utf8')
  const ast = babelParse(src, file, false)
  const program = ast.program ?? ast
  const top = new Set()
  collectHoisted(program, top)
  for (const st of program.body) {
    if (st.type === 'VariableDeclaration') {
      for (const d of st.declarations) {
        const names = []
        bindPattern(d.id, names)
        for (const n of names) top.add(n)
      }
    } else if ((st.type === 'FunctionDeclaration' || st.type === 'ClassDeclaration') && st.id) {
      top.add(st.id.name)
    } else if (st.type === 'ImportDeclaration') {
      for (const s of st.specifiers) top.add(s.local.name)
    } else if (st.type === 'ExportNamedDeclaration' && st.declaration) {
      const d = st.declaration
      if (d.type === 'VariableDeclaration') {
        for (const v of d.declarations) {
          const names = []
          bindPattern(v.id, names)
          for (const n of names) top.add(n)
        }
      } else if (d.id) top.add(d.id.name)
    }
  }
  walk(program, [top], file)
}

for (const f of failures) {
  console.log(`FAIL  ${f.file}:${f.line} assigns to '${f.name}', which is not in scope there`)
}

if (failures.length === 0) {
  console.log('PASS  every assignment in client/*.js targets a name that is in scope')
  process.exit(0)
}

console.log(`\n${failures.length} out-of-scope assignment(s).`)
console.log('In a module (always strict) this throws ReferenceError at runtime rather than')
console.log('creating a global. Declare the name, or remove the line if it belongs elsewhere.')
process.exit(1)
