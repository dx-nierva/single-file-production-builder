import { describe, it, expect } from 'vitest'
import { findEntry, resolveHref } from './references.js'

function project(...paths) {
  const files = new Map()
  for (const path of paths) {
    const type = path.endsWith('.html')
      ? 'text/html'
      : path.endsWith('.css')
        ? 'text/css'
        : 'application/octet-stream'
    files.set(path, { path, name: path.split('/').pop(), type, size: 1, content: '' })
  }
  return files
}

describe('findEntry', () => {
  it('prefers index.html at the root', () => {
    expect(findEntry(project('index.html', 'about.html'))).toBe('index.html')
  })

  it('accepts a single html file under another name', () => {
    expect(findEntry(project('pages/home.html'))).toBe('pages/home.html')
  })

  it('refuses to guess between several html files', () => {
    expect(findEntry(project('a.html', 'b.html'))).toBeNull()
  })

  it('returns null when the upload has no html at all', () => {
    expect(findEntry(project('css/main.css'))).toBeNull()
    expect(findEntry(project())).toBeNull()
  })
})

describe('resolveHref, from an entry at the root', () => {
  const from = 'index.html'
  const resolved = (href) => resolveHref(href, from).resolvedPath
  const isExternal = (href) => resolveHref(href, from).external

  it('resolves a plain relative path', () => {
    expect(resolved('css/main.css')).toBe('css/main.css')
  })

  it('drops a leading ./', () => {
    expect(resolved('./css/main.css')).toBe('css/main.css')
  })

  it('treats a leading / as the upload root', () => {
    expect(resolved('/css/main.css')).toBe('css/main.css')
  })

  it('strips a query string', () => {
    expect(resolved('css/main.css?v=2')).toBe('css/main.css')
  })

  it('strips a fragment', () => {
    expect(resolved('css/main.css#top')).toBe('css/main.css')
  })

  it('strips a fragment that itself contains a question mark', () => {
    expect(resolved('css/main.css#a?b')).toBe('css/main.css')
  })

  it('percent-decodes so the key matches the real filename', () => {
    expect(resolved('my%20styles.css')).toBe('my styles.css')
  })

  it('keeps a malformed escape rather than throwing', () => {
    expect(resolved('bad%E0%A4.css')).toBe('bad%E0%A4.css')
  })

  it('resolves a path that points outside the upload to null', () => {
    expect(resolved('../outside.css')).toBeNull()
    expect(isExternal('../outside.css')).toBe(false)
  })

  it('collapses redundant separators and dot segments', () => {
    expect(resolved('css//./main.css')).toBe('css/main.css')
  })
})

describe('resolveHref, from an entry inside a folder', () => {
  const from = 'pages/index.html'
  const resolved = (href) => resolveHref(href, from).resolvedPath

  it('resolves relative to the entry directory', () => {
    expect(resolved('a.css')).toBe('pages/a.css')
  })

  it('climbs out of the entry directory with ..', () => {
    expect(resolved('../css/main.css')).toBe('css/main.css')
  })

  it('still treats a leading / as the upload root', () => {
    expect(resolved('/css/main.css')).toBe('css/main.css')
  })

  it('refuses to climb above the upload root', () => {
    expect(resolved('../../escape.css')).toBeNull()
  })
})

describe('resolveHref, external references', () => {
  const external = (href) => resolveHref(href, 'index.html')

  it('marks an absolute url external and unresolvable', () => {
    expect(external('https://cdn.example.com/a.css')).toEqual({
      resolvedPath: null,
      external: true,
    })
  })

  it('marks a protocol-relative url external', () => {
    expect(external('//cdn.example.com/a.css').external).toBe(true)
  })

  it('marks a data uri external', () => {
    expect(external('data:text/css,body{}').external).toBe(true)
  })

  it('does not mistake a filename containing a colon for a scheme', () => {
    expect(external('css/main:2.css')).toEqual({
      resolvedPath: 'css/main:2.css',
      external: false,
    })
  })

  it('ignores an empty or whitespace-only href', () => {
    expect(external('')).toEqual({ resolvedPath: null, external: false })
    expect(external('   ')).toEqual({ resolvedPath: null, external: false })
  })
})
