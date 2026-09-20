/**
 * Direct log reads, in this process.
 *
 * The list fold needs each session's whole log — the title and opening prompt
 * live at the head, the last line lives at the tail, and the worktree tally
 * needs every tool call in between. Asking the harness for that over the wire
 * measured **135 MB and 49 s of harness CPU** for 90 sessions, which is the very
 * starvation this process exists to remove.
 *
 * So the logs are read here instead, from the harness's own files in its
 * documented layout (`<root>/<workspace>/<session>/session.jsonl.zstd`).
 *
 * The one subtlety is the container: the log is a sequence of **concatenated
 * Zstandard frames** (the backend packs chunk runs, so it can append and recover
 * batches without re-compressing). Two consequences, both verified here:
 *
 * - A single one-shot `zstdDecompressSync` returns only the FIRST frame — a
 *   194-byte header record where the whole log was expected.
 * - Node's streaming decoder also stops at the first frame boundary, so it is
 *   equally wrong for this format.
 *
 * The frames are therefore located by walking each frame's own header (magic,
 * descriptor, optional fields, then block headers) and each is inflated on its
 * own — the same approach the persistence backend takes. A torn final frame,
 * normal for a session being written, ends the read instead of failing it.
 *
 * Measured on this box: a 749 KB log decompresses in tens of milliseconds.
 *
 * @module
 */

import { readFileSync, readdirSync, existsSync, openSync, readSync, closeSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { zstdDecompressSync, inflateRawSync } from 'node:zlib'
import { join } from 'node:path'
import { createRequire } from 'node:module'

/**
 * One log's `session` record, folded to the header shape the plugin consumes.
 *
 * Carries `origin` and `delegationDepth` as well as the identity fields, because
 * the listing filters subagent rows out and this is the only place on the disk
 * path that sees them: a header rebuilt as `{ id, createdAt, cwd }` throws the
 * discriminator away before any later stage could read it, and no amount of
 * care downstream can recover a field that was never copied.
 *
 * Both are copied only when present, so an ordinary session's header stays
 * exactly the three fields it always was rather than gaining two `undefined`s
 * that would read as "unknown" instead of "not a subagent".
 * @param record - the session header record, plain or wrapped in `data`.
 * @param id - the id to fall back to when the record names none.
 * @returns the header the rest of the GUI reads.
 */
function headerOf (record, id) {
  const origin = record.origin ?? record.data?.origin
  const depth = record.delegationDepth ?? record.data?.delegationDepth
  // Read by the listing's ancestor walk: a hidden child's pending question is
  // carried onto its parent's row, so the link has to survive this copy.
  const parent = record.parentSession ?? record.data?.parentSession
  return {
    id: record.id ?? record.data?.id ?? id,
    createdAt: record.createdAt ?? record.data?.createdAt ?? Date.now(),
    cwd: record.cwd ?? record.data?.cwd ?? '',
    ...(typeof parent === 'string' ? { parentSession: parent } : {}),
    ...(origin === 'subagent' ? { origin } : {}),
    ...(typeof depth === 'number' ? { delegationDepth: depth } : {}),
  }
}

/**
 * The harness's own storage-record decoder.
 *
 * A stored line is not necessarily one event: the backend packs each run of
 * consecutive `assistant/chunk` deltas into a single row (`text-chunks`,
 * `reasoning-chunks`, `tool-call-chunks`), because a streaming turn would
 * otherwise store hundreds of near-identical lines whose envelopes dwarf their
 * payloads. Measured on a real log: 3561 stored records expand to 9374 events.
 *
 * Expanding those rows is the harness's format to own, so its decoder is used
 * rather than a second implementation that could drift from it. Verified
 * against the wire: this reader and `session.history` agree exactly on both the
 * event count and the chunk count for the same session.
 */
const HARNESS_MODULES = process.env.DSH_HARNESS_MODULES ?? '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules'
const decodeStorageRecord = (() => {
  try {
    const req = createRequire(join(HARNESS_MODULES, 'dsh-session-persistence-jsonl', 'lib', 'index.js'))
    return req('@deepseek-ai/dsh-session').decodeStorageRecord
  } catch {
    return undefined
  }
})()

const ZSTD_NAME = 'session.jsonl.zstd'
const PLAIN_NAME = 'session.jsonl'
/** `readUInt32LE` of a Zstandard frame's magic number. */
const ZSTD_MAGIC = 0xfd2fb528
/** `readUInt32LE` of a ZIP local file header, for the export fallback. */
const ZIP_LOCAL = 0x04034b50

/**
 * Bytes read when only a log's header is wanted.
 *
 * The header is the log's first record, and a packed log's first Zstandard
 * frame holds exactly that one line (a measured 749 KB log's first frame is 194
 * bytes). 64 KB is far more than any header needs and still covers a log whose
 * first frame packed several early records together.
 */
const HEAD_BYTES = 65_536

/**
 * Read at most {@link HEAD_BYTES} from the front of a file.
 *
 * `readFileSync` would pull the whole log in to reach its first line: across
 * this box's 174 logs that is 52.7 MB read to extract 33 KB of headers, with
 * the largest single log at 2.5 MB. The header sits at offset 0, so the rest of
 * those bytes are read, allocated and thrown away.
 * @param path - the log file.
 * @returns its leading bytes, which may be the whole file when it is short.
 */
function readHead (path) {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(HEAD_BYTES)
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0)
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

/**
 * Locate every complete Zstandard frame in a concatenated container.
 *
 * Walks the real frame structure rather than searching for the magic bytes,
 * because a magic can occur inside compressed data and splitting there would
 * silently truncate the log.
 * @param buffer - the file's bytes.
 * @returns each frame's `[start, end)`, and where a torn trailing frame began.
 */
export function scanFrames (buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, torn: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    if (offset >= buffer.length) return { frames, torn: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const fcsFlag = (descriptor >> 6) & 3
    const singleSegment = (descriptor >> 5) & 1
    const checksum = (descriptor >> 2) & 1
    const dictFlag = descriptor & 3
    if (singleSegment === 0) {
      if (offset >= buffer.length) return { frames, torn: start }
      offset += 1 // window descriptor
    }
    offset += [0, 1, 2, 4][dictFlag]
    offset += fcsFlag === 0 ? (singleSegment === 1 ? 1 : 0) : [0, 2, 4, 8][fcsFlag]
    if (offset > buffer.length) return { frames, torn: start }
    // Blocks: 3-byte header, then raw / one byte / compressed block payload.
    for (;;) {
      if (offset + 3 > buffer.length) return { frames, torn: start }
      const header = buffer.readUInt8(offset) | (buffer.readUInt8(offset + 1) << 8) | (buffer.readUInt8(offset + 2) << 16)
      offset += 3
      const last = header & 1
      const type = (header >> 1) & 3
      const size = header >> 3
      if (type === 0 || type === 2) offset += size
      else if (type === 1) offset += 1
      else return { frames, torn: start } // reserved block type
      if (offset > buffer.length) return { frames, torn: start }
      if (last === 1) break
    }
    if (checksum === 1) offset += 4
    if (offset > buffer.length) return { frames, torn: start }
    frames.push([start, offset])
  }
  return { frames, torn: undefined }
}

/**
 * Inflate a concatenated-frame log.
 * @param buffer - the file's bytes.
 * @returns the decompressed text, missing only a torn trailing frame.
 */
export function inflateLog (buffer) {
  const { frames } = scanFrames(buffer)
  if (frames.length === 0) {
    // Not a frame container: a plain or single-frame file still deserves a try.
    try {
      return zstdDecompressSync(buffer).toString('utf8')
    } catch {
      return ''
    }
  }
  const parts = []
  for (const [start, end] of frames) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)))
    } catch {
      // One bad frame costs its own batch, never the frames around it.
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

/**
 * Pull the single `session.jsonl` entry out of an export zip.
 *
 * A fallback for a log this process cannot reach on disk, so the GUI still shows
 * a transcript rather than an error.
 * @param buffer - the zip's bytes.
 * @returns the entry's text, or undefined when it holds none.
 */
export function inflateZipEntry (buffer) {
  for (let i = 0; i + 30 <= buffer.length; i++) {
    if (buffer.readUInt32LE(i) !== ZIP_LOCAL) continue
    const method = buffer.readUInt16LE(i + 8)
    const compSize = buffer.readUInt32LE(i + 18)
    const nameLen = buffer.readUInt16LE(i + 26)
    const extraLen = buffer.readUInt16LE(i + 28)
    const dataStart = i + 30 + nameLen + extraLen
    const data = buffer.subarray(dataStart, dataStart + compSize)
    try {
      if (method === 0) return data.toString('utf8')
      // Method 8 is deflate, which the export uses.
      return inflateRawSync(data).toString('utf8')
    } catch {
      return undefined
    }
  }
  return undefined
}

/** One session's log, read once and held for the life of the process. */
export class LogStore {
  #root
  #index
  #faults = new Map()
  /**
   * Parsed headers, kept for the life of the process.
   *
   * A session's header is its log's **first** record, written once when the
   * session is created and never rewritten, so a parsed one can never go stale —
   * unlike the events after it, which is why {@link LogStore.read} stays
   * uncached. Without this the listing re-opened and re-decoded all 174 logs'
   * first frames on every refresh (163 ms measured) to re-derive bytes that
   * cannot have changed.
   *
   * Survives {@link LogStore.rescan}, which only invalidates *which sessions
   * exist* — a fact about directories, not about the contents of a header.
   */
  #headers = new Map()

  /**
   * @param root - the directory holding one subdirectory per workspace.
   */
  constructor (root) {
    this.#root = root
  }

  /** The store root this reader was built for. */
  get root () {
    return this.#root
  }

  #build () {
    const index = new Map()
    let workspaces
    try {
      workspaces = readdirSync(this.#root, { withFileTypes: true })
    } catch {
      workspaces = []
    }
    for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue
      let sessions
      try {
        sessions = readdirSync(join(this.#root, workspace.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const session of sessions) {
        if (!session.isDirectory()) continue
        const dir = join(this.#root, workspace.name, session.name)
        if (existsSync(join(dir, ZSTD_NAME))) index.set(session.name, { dir, workspace: workspace.name, zstd: true })
        else if (existsSync(join(dir, PLAIN_NAME))) index.set(session.name, { dir, workspace: workspace.name, zstd: false })
      }
    }
    this.#index = index
    return index
  }

  /** Every session id the store holds a log for. */
  ids () {
    return [...(this.#index ?? this.#build()).keys()]
  }

  /** Whether the store holds a log for one id. */
  has (id) {
    return (this.#index ?? this.#build()).has(id)
  }

  /**
   * Parse one log's text into its header and events.
   *
   * Each stored line is expanded through the harness's decoder first, so a
   * packed chunk run becomes the events it stands for. Without that step the
   * event count is wrong (3561 instead of 9374 on a measured log) and, worse,
   * the assistant text is missing entirely — which is exactly what made the
   * first draft of this reader title every session "New session".
   * @param text - the decompressed log.
   * @param id - the session the log belongs to.
   * @returns the header and the events in file order.
   */
  #parse (text, id) {
    let header
    const events = []
    for (const line of text.split('\n')) {
      if (line === '') continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (header === undefined && record?.type === 'session' && typeof record.seq !== 'number') {
        header = record
        continue
      }
      // A decoder failure on one row costs that row, never the log around it.
      let expanded = record
      if (decodeStorageRecord !== undefined) {
        try {
          expanded = decodeStorageRecord(record)
        } catch {
          expanded = record
        }
      }
      if (expanded === undefined || expanded === null) continue
      for (const item of Array.isArray(expanded) ? expanded : [expanded]) {
        if (item?.type === 'session' && header === undefined) {
          header = item
          continue
        }
        if (typeof item?.seq === 'number') events.push(item)
      }
    }
    // A log is read in seq order, and a packed row can cover a run whose `time`
    // ordering is only implied; sorting keeps folds that assume monotonic seqs
    // correct rather than merely usually correct.
    events.sort((left, right) => left.seq - right.seq)
    const headerValue = header === undefined ? undefined : headerOf(header, id)
    return { header: headerValue, events }
  }

  /**
   * Read one session's header alone, decoding only its first frame.
   *
   * The backend writes the `session` header as the log's own first record, and a
   * packed log's first Zstandard frame holds exactly that one line (verified: a
   * 749 KB log's first frame is a 194-byte header record). So the listing's
   * header fill costs one frame instead of a whole transcript — the difference
   * between ~2 ms and ~100 ms per session, which across a cold 90-session
   * listing is the difference between a fast page and a ten-second one.
   * @param id - the session to read.
   * @returns its header, or undefined when the log is absent or unreadable.
   */
  header (id) {
    const cached = this.#headers.get(id)
    if (cached !== undefined) return cached
    const entry = (this.#index ?? this.#build()).get(id)
    if (entry === undefined) return undefined
    let raw
    try {
      raw = readHead(join(entry.dir, entry.zstd ? ZSTD_NAME : PLAIN_NAME))
    } catch {
      return undefined
    }
    if (!entry.zstd) {
      const first = raw.toString('utf8').split('\n', 1)[0]
      const header = this.#headerFrom(first, id)
      if (header !== undefined) this.#headers.set(id, header)
      return header
    }
    const { frames } = scanFrames(raw)
    for (const [start, end] of frames) {
      let text
      try {
        text = zstdDecompressSync(raw.subarray(start, end)).toString('utf8')
      } catch {
        continue
      }
      const header = this.#headerFrom(text.split('\n', 1)[0], id)
      if (header !== undefined) {
        this.#headers.set(id, header)
        return header
      }
    }
    return undefined
  }

  /**
   * Parse a header record.
   * @param line - the log's first line.
   * @param id - the session it belongs to.
   * @returns the header, or undefined when the line is not a session header.
   */
  #headerFrom (line, id) {
    if (line === undefined || line === '') return undefined
    let record
    try {
      record = JSON.parse(line)
    } catch {
      return undefined
    }
    if (record?.type !== 'session') return undefined
    return headerOf(record, id)
  }

  /**
   * Read one session's whole log from disk.
   *
   * Asynchronous on purpose, even though the decode itself is CPU-bound: the
   * corpus folds many sessions in one batch, and a synchronous read of each
   * would hold this process's event loop for the whole batch — measured at ~5s
   * on a cold 90-session listing, which the reader must not spend, since the
   * page it is filling is being served from the same loop.
   *
   * Deliberately uncached: a session being written grows between calls, and a
   * stale transcript is worse than a slow one.
   * @param id - the session to read.
   * @returns its header and events; empty for an unknown or unreadable log,
   *   because one bad session must not cost the listing it shares with ninety.
   */
  async read (id) {
    const entry = (this.#index ?? this.#build()).get(id)
    if (entry === undefined) return { header: undefined, events: [] }
    let text
    try {
      const raw = await readFile(join(entry.dir, entry.zstd ? ZSTD_NAME : PLAIN_NAME))
      text = entry.zstd ? inflateLog(raw) : raw.toString('utf8')
    } catch (error) {
      this.#faults.set(id, String(error))
      return { header: undefined, events: [] }
    }
    return this.#parse(text, id)
  }

  /** Reads that failed, for a caller that wants to report them. */
  faults () {
    return [...this.#faults]
  }

  /** Whether the harness's packed-row decoder resolved; without it, reads are partial. */
  get faithful () {
    return decodeStorageRecord !== undefined
  }

  /** Re-scan the store, so session directories made since the last scan resolve. */
  rescan () {
    this.#index = undefined
  }
}
