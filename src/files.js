/**
 * Pure ingest logic. No DOM access, so this module stays testable the moment a
 * runner is configured.
 *
 * The path rule here is a locked contract: features 2, 4, 9, and 10 resolve
 * their references against these keys, so changing the shape later means
 * revisiting all of them.
 */

const KB = 1024
const MB = KB * KB
// Escaped rather than literal: a raw U+00A0 in source is invisible, and an
// editor or formatter could silently turn it back into a plain space.
const NBSP = '\u00a0'

const EXTENSION_TYPES = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  svg: 'image/svg+xml',
  md: 'text/markdown',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
}

/* Browsers disagree on the JavaScript media type, so collapse the variants onto
   the one canonical value the decode rule and later features expect. */
const TYPE_ALIASES = {
  'application/javascript': 'text/javascript',
  'application/x-javascript': 'text/javascript',
  'text/ecmascript': 'text/javascript',
  'application/ecmascript': 'text/javascript',
  'application/xhtml+xml': 'text/html',
}

const TEXT_TYPES = new Set(['text/html', 'text/css', 'text/javascript'])

/** Font MIME types with no shared "font/" or "image/" prefix to test for. */
const NAMED_ASSET_TYPES = new Set(['application/vnd.ms-fontobject'])

const FALLBACK_TYPE = 'application/octet-stream'

/** Base64 conversion in fixed-size chunks: a single spread over a large
    Uint8Array can overflow the call stack that String.fromCharCode(...) uses. */
const BASE64_CHUNK = 0x8000

/**
 * Clean one raw path into its relative form. Does not strip the common root
 * directory; that is a property of the whole upload and belongs to
 * buildFileEntries.
 */
export function normalizePath(rawPath) {
  return String(rawPath ?? '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\//, '')
}

/**
 * The single directory every uploaded path sits under, or null when the upload
 * has no single root. A loose file with no directory never counts as a root,
 * otherwise the file itself would be stripped away.
 */
export function findCommonRoot(paths) {
  if (paths.length === 0) return null

  const [first] = paths
  const slash = first.indexOf('/')
  if (slash <= 0) return null

  const candidate = first.slice(0, slash)
  const prefix = `${candidate}/`
  return paths.every((path) => path.startsWith(prefix)) ? candidate : null
}

export function inferType(fileType, path) {
  // A real HTTP Content-Type header (unlike the File API's bare type) can
  // carry parameters such as "; charset=utf-8" after the media type, which
  // must not defeat the alias lookup or TEXT_TYPES membership below.
  const declared = String(fileType ?? '').trim().toLowerCase().split(';')[0].trim()
  if (declared) {
    return TYPE_ALIASES[declared] ?? declared
  }

  const dot = path.lastIndexOf('.')
  const extension = dot > -1 ? path.slice(dot + 1).toLowerCase() : ''
  return EXTENSION_TYPES[extension] ?? FALLBACK_TYPE
}

export function isTextType(type) {
  return TEXT_TYPES.has(type)
}

/**
 * Whether `type` is an image or font we know how to embed as a data URI.
 * Feature 11's css-imports.js consults this before rewriting a matched
 * `url(...)` target; anything else matched through `url(...)` is left
 * untouched rather than guessed at.
 */
export function isAssetType(type) {
  return type.startsWith('image/') || type.startsWith('font/') || NAMED_ASSET_TYPES.has(type)
}

/** Uint8Array -> base64, chunked so a large file cannot overflow the stack. */
export function bytesToBase64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK))
  }
  return btoa(binary)
}

export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return `0${NBSP}B`
  if (bytes < KB) return `${Math.round(bytes)}${NBSP}B`

  // Rounding can push a value to the top of its unit (1048575 bytes is
  // "1024.0 KB"), so the rounded result decides the unit, not the raw bytes.
  const kb = (bytes / KB).toFixed(1)
  if (Number(kb) < KB) return `${kb}${NBSP}KB`

  return `${(bytes / MB).toFixed(1)}${NBSP}MB`
}

export function basename(path) {
  const slash = path.lastIndexOf('/')
  return slash > -1 ? path.slice(slash + 1) : path
}

/**
 * The suggested filename for a compiled download. Falls back to a generic
 * name when the upload had no single common root (a flat, mixed-top-level
 * file selection), which is the only time rootName is null.
 */
export function downloadName(rootName) {
  return rootName ? `${rootName}.html` : 'index.html'
}

/**
 * Build one FileEntry. `path` must already be normalized and root-stripped.
 * Text is decoded into `content`; a recognized image or font type is instead
 * base64-encoded into `base64` for feature 11's asset-embedding to use. A
 * binary type that is neither gets both fields `null`.
 */
export async function readFileEntry(file, path) {
  const type = inferType(file.type, path)
  const isAsset = isAssetType(type)

  return {
    path,
    name: basename(path),
    type,
    size: file.size,
    content: isTextType(type) ? await file.text() : null,
    base64: isAsset ? bytesToBase64(new Uint8Array(await file.arrayBuffer())) : null,
  }
}

/**
 * Turn raw {file, rawPath} pairs into the store's uploadedFiles map.
 *
 * Files are read one at a time rather than through Promise.all: a dropped
 * project can hold thousands of files, and reading them all concurrently would
 * hold every decoded string in memory at once.
 *
 * Entries are inserted in sorted order so the picker and the drop path always
 * produce an identically ordered map for the same folder.
 */
export async function buildFileEntries(inputs, onProgress = () => {}) {
  const normalized = inputs
    .map((input) => ({ file: input.file, path: normalizePath(input.rawPath) }))
    .filter((input) => input.path !== '')

  const rootName = findCommonRoot(normalized.map((input) => input.path))
  const stripLength = rootName ? rootName.length + 1 : 0

  const prepared = normalized
    .map((input) => ({ file: input.file, path: input.path.slice(stripLength) }))
    .filter((input) => input.path !== '')
    .sort((a, b) => {
      const byBase = a.path.localeCompare(b.path, undefined, {
        sensitivity: 'base',
      })
      // Case-only differences compare equal at base sensitivity, which would
      // leave their order down to whichever path produced the input. The tie
      // break keeps the picker and the drop walk listing a folder identically.
      return byBase !== 0 ? byBase : a.path.localeCompare(b.path)
    })

  const total = prepared.length
  // A fixed small interval alone would mean hundreds of reports for a huge
  // drop (working against the exact case progress reporting targets); a
  // fixed percentage alone would give zero visible reports for anything
  // smaller than it. This caps a huge upload at roughly 100 reports while
  // staying responsive for small and medium ones.
  const interval = Math.max(25, Math.floor(total / 100))

  const files = new Map()
  let done = 0
  for (const { file, path } of prepared) {
    // Last write wins on a duplicate path, which is what a Map gives us.
    files.set(path, await readFileEntry(file, path))
    done += 1
    if (done % interval === 0 || done === total) onProgress(done, total)
  }

  return { files, rootName }
}

/**
 * A new Map with `path` removed, or the exact same `files` reference when
 * `path` is absent - lets a caller skip its own presence check, and makes a
 * no-op removal a no-op re-render too. Never mutates `files`.
 */
export function removeFile(files, path) {
  if (!files.has(path)) return files
  const next = new Map(files)
  next.delete(path)
  return next
}
