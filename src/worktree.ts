/**
 * The worktree a session's directory sits in, read from git's own files.
 *
 * The session list groups workspace → worktree → session. The harness has no
 * worktree concept — a `Workspace` is one title over one path — so the middle
 * level is derived here from the only durable account of it there is: the
 * repository on disk.
 *
 * Read rather than shelled out. `git rev-parse` per session would be one
 * process spawn per row on a list that repaints whenever any log grows, and the
 * `.git` entry answers the question in a few hundred bytes. Nothing here runs
 * git, so a box without git installed lists exactly as one with it.
 *
 * What is derived is the working tree's own **root directory** — the thing a
 * reader means by "worktree", the thing `git worktree list` names, and the
 * thing the sessions under a heading actually sit in. The branch is
 * deliberately not read: it is a property *of* a checkout rather than its
 * identity, it renames itself under a reader who switches branches, and two
 * worktrees sharing a branch are still two different places.
 *
 * Two directory shapes have to work, because both are real on this box:
 *
 * 1. **The session sits inside a worktree.** Walk up to the nearest `.git`.
 * 2. **The session sits in a directory that *holds* worktrees** — a project
 *    folder with a bare repo and a checkout per branch beside it, which is how
 *    every real workspace here is laid out and where every session actually
 *    runs. Walking up finds nothing (the container is not itself a checkout),
 *    so the worktrees are found by looking one level *down* instead.
 *
 * The second case is the one the screen depends on: with 344 of this box's
 * sessions sitting at such a container, an upward-only search reported "no
 * repository" for all of them and the middle level never appeared.
 * @module
 */

import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

/** How long one directory's answer is reused before git is read again. */
const TTL_MS = 30_000

/** Directories whose answers are kept; a box with more checkouts than this re-reads the oldest. */
const CACHE_MAX = 500

/** Ancestor directories walked looking for a repository before giving up. */
const MAX_DEPTH = 40

/**
 * One directory's checkout, as the session list groups by it.
 *
 * `null` where the directory is in no repository at all, which is a real
 * answer — those sessions hang directly under their workspace rather than
 * under an invented heading.
 */
export interface Checkout {
  /**
   * The working tree's own root directory.
   *
   * The whole of a checkout's identity here, and deliberately the only field:
   * a linked worktree has its own root, so this separates the checkouts of one
   * repository without needing to know which repository that is. Nothing on
   * the session list asks a question that the shared object store would answer.
   */
  readonly root: string
}

/** One cached answer and when it was taken. */
interface Entry {
  readonly at: number
  readonly checkout: Checkout | null
}

const cache = new Map<string, Entry>()

/**
 * The checkout a directory belongs to.
 *
 * Cached per directory for {@link TTL_MS}, so a list repainting on every log
 * append does not re-read git for rows that did not move. Never throws: a
 * directory that cannot be read is simply in no repository, because a broken
 * checkout must not be able to take the session list down with it.
 * @param dir - an absolute directory, normally a session's cwd.
 * @returns the checkout, or null when the directory is in no repository.
 */
export async function checkoutOf(dir: string): Promise<Checkout | null> {
  if (dir === '' || !isAbsolute(dir)) return null
  const key = dir.replace(/\/+$/, '') || '/'
  const now = Date.now()
  const hit = cache.get(key)
  if (hit !== undefined && now - hit.at < TTL_MS) return hit.checkout
  let checkout: Checkout | null
  try {
    checkout = await read(key)
  } catch {
    // A directory that cannot be read is in no repository as far as the list is
    // concerned. Propagating would lose every row in the listing, not just this one.
    checkout = null
  }
  cache.set(key, { at: now, checkout })
  // Cheapest possible bound: Map iterates in insertion order, so the oldest
  // inserted key is the first one out.
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next()
    if (oldest.done === true) break
    cache.delete(oldest.value)
  }
  return checkout
}

/** Worktrees found inside one container, cached the same way single answers are. */
const inside = new Map<string, { at: number; checkouts: readonly Checkout[] }>()

/**
 * The worktrees a directory *contains*, one level down.
 *
 * The project-folder shape: a bare repository and a checkout per branch sitting
 * beside each other, with the session's cwd on the folder itself. Every real
 * workspace on this box is laid out this way, so this is the path that actually
 * produces the middle level of the hierarchy.
 *
 * Only one level deep, deliberately. A recursive scan of a project folder would
 * walk into `node_modules` and every checkout's own subdirectories on a listing
 * that repaints whenever any log grows, to find nothing a reader would call a
 * worktree. Sibling checkouts are the pattern being served, and they are
 * always exactly one level down.
 * @param dir - the container directory, normally a session's cwd.
 * @returns each child that is a working tree, name-sorted; empty when none are.
 */
export async function worktreesIn(dir: string): Promise<readonly Checkout[]> {
  if (dir === '' || !isAbsolute(dir)) return []
  const key = dir.replace(/\/+$/, '') || '/'
  const now = Date.now()
  const hit = inside.get(key)
  if (hit !== undefined && now - hit.at < TTL_MS) return hit.checkouts
  let checkouts: readonly Checkout[] = []
  try {
    const entries = await readdir(key, { withFileTypes: true })
    const found: Checkout[] = []
    await Promise.all(entries.map(async entry => {
      // A dotfile directory is never a project checkout a reader is working in,
      // and skipping them keeps `.git`, `.cache` and friends out of the scan.
      if (!entry.isDirectory() || entry.name.startsWith('.')) return
      const child = join(key, entry.name)
      if (await exists(join(child, '.git'))) found.push({ root: child })
    }))
    checkouts = found.sort((left, right) => left.root.localeCompare(right.root))
  } catch {
    // An unreadable directory simply holds no worktrees, for the same reason a
    // failed read above yields no checkout: one bad path must not blank the list.
    checkouts = []
  }
  inside.set(key, { at: now, checkouts })
  while (inside.size > CACHE_MAX) {
    const oldest = inside.keys().next()
    if (oldest.done === true) break
    inside.delete(oldest.value)
  }
  return checkouts
}

/**
 * Walk up from a directory to the working tree that contains it.
 * @param from - the directory to start at.
 * @returns the checkout, or null when no `.git` is found before the filesystem root.
 */
async function read(from: string): Promise<Checkout | null> {
  let dir = from
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    // A `.git` entry of either kind marks a working tree's root: a directory in
    // the ordinary case, a `gitdir:` file in a linked worktree or a submodule.
    // Which one it is does not matter here — the root is the directory holding
    // it either way, and that is the whole of what this module reports.
    if (await exists(join(dir, '.git'))) return { root: dir }
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
  return null
}

/**
 * Whether anything sits at a path.
 * @param path - the candidate `.git`.
 * @returns true when it exists, false when it does not or cannot be read.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * How a checkout is labelled on the session list.
 *
 * The working tree's own directory name, because the worktree is the thing
 * being named — the same thing {@link identify} groups by. Labelling by branch
 * instead would put a name on the heading that does not match what the heading
 * *is*: two worktrees on one branch would read as two identical headings, and a
 * heading would rename itself when someone checked out a different branch in
 * that directory, while the sessions under it had not moved at all.
 *
 * The main checkout of a repository is therefore named after the repository's
 * own directory, and each linked worktree after its own — which is exactly how
 * `git worktree list` names them, and how the directories appear on disk.
 * @param checkout - the checkout to name.
 * @returns the heading text.
 */
export function label(checkout: Checkout): string {
  return basename(checkout.root)
}

/**
 * The stable id a worktree heading sorts and anchors by.
 *
 * The full root path, where {@link label} shows only its last segment: two
 * checkouts in different places may share a directory name, and they must not
 * share a heading. Prefixed so it cannot collide with a workspace id.
 * @param checkout - the checkout to identify.
 * @returns an id unique to this working tree.
 */
export function identify(checkout: Checkout): string {
  return `wt:${checkout.root}`
}
