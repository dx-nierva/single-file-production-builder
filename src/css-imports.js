/**
 * Recursively resolves @import statements inside an already-matched
 * stylesheet, splicing each local target's own (recursively expanded)
 * content in place of the statement. Reuses minifyCss's own string/url()/
 * comment-aware character walk (via its exported helpers) so an
 * @import-shaped substring inside a string or comment is never mistaken
 * for a real statement, and resolveHref (feature 2) so path resolution
 * never diverges from every other reference in this app.
 */

import { readString, readUrl, startsUrl } from './minify.js'
import { resolveHref } from './references.js'

function isSpace(char) {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f'
}

function isImportKeywordAt(source, i) {
  if (source.slice(i, i + 7).toLowerCase() !== '@import') return false

  const before = source[i - 1]
  if (before !== undefined && /[A-Za-z0-9_-]/.test(before)) return false

  const after = source[i + 7]
  return after === undefined || isSpace(after) || after === '"' || after === "'"
}

function unwrapQuotes(inner) {
  const first = inner[0]
  const last = inner[inner.length - 1]
  if ((first === '"' || first === "'") && first === last) return inner.slice(1, -1)
  return inner
}

/**
 * Parses one @import statement starting at `start` (already confirmed to be
 * "@import" by isImportKeywordAt). Returns null for anything this cannot
 * read confidently - the caller then leaves the text untouched rather than
 * guess, matching minify.js's own rule.
 */
function parseImport(source, start) {
  let i = start + 7
  while (i < source.length && isSpace(source[i])) i += 1
  if (i >= source.length) return null

  let target

  if (startsUrl(source, i)) {
    const end = readUrl(source, i)
    if (end === -1) return null
    target = unwrapQuotes(source.slice(i + 4, end - 1).trim())
    i = end
  } else if (source[i] === '"' || source[i] === "'") {
    const end = readString(source, i)
    if (end === -1) return null
    target = source.slice(i + 1, end - 1)
    i = end
  } else {
    return null
  }

  const semi = source.indexOf(';', i)
  if (semi === -1) return null

  return { target, tail: source.slice(i, semi), end: semi + 1 }
}

export function resolveCssImports(path, files, seen = new Set()) {
  const source = files.get(path).content ?? ''
  const events = []

  seen.add(path)

  let out = ''
  let i = 0

  while (i < source.length) {
    const char = source[i]

    if (char === '"' || char === "'") {
      const end = readString(source, i)
      if (end === -1) {
        out += source.slice(i)
        break
      }
      out += source.slice(i, end)
      i = end
      continue
    }

    if (startsUrl(source, i)) {
      const end = readUrl(source, i)
      if (end === -1) {
        out += source.slice(i)
        break
      }
      out += source.slice(i, end)
      i = end
      continue
    }

    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end === -1) {
        out += source.slice(i)
        break
      }
      out += source.slice(i, end + 2)
      i = end + 2
      continue
    }

    if (isImportKeywordAt(source, i)) {
      const parsed = parseImport(source, i)

      if (parsed) {
        const { target, tail, end } = parsed

        // A media/supports()/layer()-qualified import is invisible to this
        // feature entirely - left as ordinary text, no event.
        if (tail.trim() !== '') {
          out += source.slice(i, end)
          i = end
          continue
        }

        const { resolvedPath, external } = resolveHref(target, path)

        if (external) {
          out += source.slice(i, end)
          events.push({ status: 'external', target })
          i = end
          continue
        }

        if (resolvedPath === null || !files.has(resolvedPath)) {
          events.push({ status: 'missing', target })
          i = end
          continue
        }

        if (seen.has(resolvedPath)) {
          events.push({ status: 'circular', target: resolvedPath })
          i = end
          continue
        }

        const nested = resolveCssImports(resolvedPath, files, seen)
        out += nested.code
        events.push({ status: 'matched', target: resolvedPath, size: files.get(resolvedPath).size })
        events.push(...nested.events)
        i = end
        continue
      }
    }

    out += char
    i += 1
  }

  seen.delete(path)
  return { code: out, events }
}
