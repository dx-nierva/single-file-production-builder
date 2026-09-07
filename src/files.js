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

const FALLBACK_TYPE = 'application/octet-stream'

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
  const declared = String(fileType ?? '').trim().toLowerCase()
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
 * Only text is decoded; binary content waits for feature 10.
 */
export async function readFileEntry(file, path) {
  const type = inferType(file.type, path)

  return {
    path,
    name: basename(path),
    type,
    size: file.size,
    content: isTextType(type) ? await file.text() : null,
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
export async function buildFileEntries(inputs) {
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

  const files = new Map()
  for (const { file, path } of prepared) {
    // Last write wins on a duplicate path, which is what a Map gives us.
    files.set(path, await readFileEntry(file, path))
  }

  return { files, rootName }
}
