/**
 * Finds the entry document and resolves the references inside it against the
 * uploaded files.
 *
 * Everything here except the single DOMParser call is free of the DOM, so the
 * resolution rules stay testable in the fast node environment.
 *
 * The resolution rule is a locked contract: feature 4 inlines against these
 * results, so a change here changes what ends up in the compiled output.
 */

/** Any scheme, so http:, https:, data: and blob: all classify as external. */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/**
 * The entry document, or null when it cannot be determined without guessing.
 *
 * Feature 1 strips the dropped folder from every key, so a normal project puts
 * its entry at exactly `index.html`.
 */
export function findEntry(files) {
  if (files.has('index.html')) return 'index.html'

  const documents = [...files.values()].filter(
    (entry) => entry.type === 'text/html',
  )

  return documents.length === 1 ? documents[0].path : null
}

/**
 * Resolve one authored href against the entry's directory.
 *
 * Returns the `uploadedFiles` key it points at, or null when it points outside
 * the upload. `external` marks a reference that can never be inlined from the
 * dropped files, which is different from one that is simply absent.
 */
export function resolveHref(rawHref, entryPath) {
  const href = String(rawHref ?? '').trim()
  if (href === '') return { resolvedPath: null, external: false }

  if (SCHEME.test(href) || href.startsWith('//')) {
    return { resolvedPath: null, external: true }
  }

  const withoutFragment = href.split('#')[0]
  const withoutQuery = withoutFragment.split('?')[0]
  const decoded = decodePath(withoutQuery)
  if (decoded === '') return { resolvedPath: null, external: false }

  // A leading slash means the upload root, so it starts from no directory.
  const segments = decoded.startsWith('/') ? [] : directoryOf(entryPath)

  for (const part of decoded.split('/')) {
    if (part === '' || part === '.') continue

    if (part === '..') {
      // Climbing above the upload root leaves the project entirely.
      if (segments.length === 0) return { resolvedPath: null, external: false }
      segments.pop()
      continue
    }

    segments.push(part)
  }

  const resolvedPath = segments.join('/')
  return { resolvedPath: resolvedPath === '' ? null : resolvedPath, external: false }
}

/** A malformed escape is authored text, not a reason to abort the analysis. */
function decodePath(path) {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

function directoryOf(entryPath) {
  const parts = String(entryPath ?? '').split('/')
  parts.pop()
  return parts.filter((part) => part !== '')
}

/**
 * The stylesheet and script references in one parsed document, in document
 * order. Feature 4 inlines in this order, so it must not be sorted.
 *
 * Inline `<style>` and inline `<script>` are not references: they are already
 * part of the document and there is nothing to fetch or inline for them.
 */
export function extractReferences(doc) {
  const references = []

  for (const node of doc.querySelectorAll('link, script')) {
    const isLink = node.tagName.toLowerCase() === 'link'

    if (isLink) {
      // rel is a token list: "preload stylesheet" is still a stylesheet.
      const rel = (node.getAttribute('rel') ?? '').toLowerCase().split(/\s+/)
      if (!rel.includes('stylesheet')) continue
    }

    const rawHref = node.getAttribute(isLink ? 'href' : 'src')
    if (rawHref === null || rawHref.trim() === '') continue

    references.push({ kind: isLink ? 'stylesheet' : 'script', rawHref })
  }

  return references
}

/**
 * Find the entry and classify everything it references.
 *
 * parseFromString builds an inert document: no script runs, no event handler
 * fires and no subresource is fetched. That is why the entry is parsed rather
 * than pattern-matched, and why an uploaded file cannot act during analysis.
 */
export function analyze(files) {
  const entryPath = findEntry(files)
  if (entryPath === null) return { entryPath: null, references: [] }

  const entry = files.get(entryPath)
  const doc = new DOMParser().parseFromString(entry.content ?? '', 'text/html')

  const references = extractReferences(doc).map((reference) => {
    const { resolvedPath, external } = resolveHref(reference.rawHref, entryPath)

    return {
      ...reference,
      resolvedPath,
      status: classify(resolvedPath, external, files),
    }
  })

  return { entryPath, references }
}

/**
 * External is not the same as missing: the target exists, it just cannot be
 * inlined from the dropped files.
 */
function classify(resolvedPath, external, files) {
  if (external) return 'external'
  return resolvedPath !== null && files.has(resolvedPath) ? 'matched' : 'missing'
}
