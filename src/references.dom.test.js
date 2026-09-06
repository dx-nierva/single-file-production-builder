// @vitest-environment jsdom
//
// Only this file needs a DOM. The other suites stay in the node environment,
// which is why there is no vitest.config.js pinning one environment globally.

import { describe, it, expect } from 'vitest'
import { extractReferences, analyze } from './references.js'

function parse(html) {
  return new DOMParser().parseFromString(html, 'text/html')
}

function project(entries) {
  const files = new Map()
  for (const [path, { type, content = '' }] of Object.entries(entries)) {
    files.set(path, {
      path,
      name: path.split('/').pop(),
      type,
      size: content.length,
      content,
    })
  }
  return files
}

describe('extractReferences', () => {
  it('finds stylesheets and scripts in document order', () => {
    const doc = parse(`
      <link rel="stylesheet" href="css/reset.css">
      <script src="js/head.js"></script>
      <link rel="stylesheet" href="css/main.css">
      <script src="js/app.js"></script>
    `)

    expect(extractReferences(doc)).toEqual([
      { kind: 'stylesheet', rawHref: 'css/reset.css' },
      { kind: 'script', rawHref: 'js/head.js' },
      { kind: 'stylesheet', rawHref: 'css/main.css' },
      { kind: 'script', rawHref: 'js/app.js' },
    ])
  })

  it('accepts a multi-token rel', () => {
    const doc = parse('<link rel="preload stylesheet" href="a.css">')
    expect(extractReferences(doc)).toEqual([
      { kind: 'stylesheet', rawHref: 'a.css' },
    ])
  })

  it('accepts an uppercase rel', () => {
    const doc = parse('<link rel="StyleSheet" href="a.css">')
    expect(extractReferences(doc)).toHaveLength(1)
  })

  it('ignores links that are not stylesheets', () => {
    const doc = parse(`
      <link rel="icon" href="favicon.svg">
      <link rel="preconnect" href="https://fonts.example.com">
    `)
    expect(extractReferences(doc)).toEqual([])
  })

  it('counts a module script', () => {
    const doc = parse('<script type="module" src="js/main.js"></script>')
    expect(extractReferences(doc)).toEqual([
      { kind: 'script', rawHref: 'js/main.js' },
    ])
  })

  it('ignores inline style and inline script', () => {
    const doc = parse(`
      <style>body { margin: 0 }</style>
      <script>console.log('inline')</script>
    `)
    expect(extractReferences(doc)).toEqual([])
  })

  it('skips a link with no href and a script with an empty src', () => {
    const doc = parse(`
      <link rel="stylesheet">
      <script src="   "></script>
      <link rel="stylesheet" href="real.css">
    `)
    expect(extractReferences(doc)).toEqual([
      { kind: 'stylesheet', rawHref: 'real.css' },
    ])
  })

  it('keeps the href exactly as authored', () => {
    const doc = parse('<link rel="stylesheet" href="./css/main.css?v=2#x">')
    expect(extractReferences(doc)[0].rawHref).toBe('./css/main.css?v=2#x')
  })

  it('does not execute anything in the parsed document', () => {
    globalThis.__parsedSideEffect = false
    parse('<script>globalThis.__parsedSideEffect = true</script><img src=x onerror="globalThis.__parsedSideEffect = true">')
    expect(globalThis.__parsedSideEffect).toBe(false)
    delete globalThis.__parsedSideEffect
  })
})

describe('analyze', () => {
  const entryHtml = `
    <!doctype html>
    <html>
      <head>
        <link rel="stylesheet" href="css/main.css">
        <link rel="stylesheet" href="css/theme.css">
        <link rel="stylesheet" href="https://cdn.example.com/reset.css">
        <link rel="icon" href="favicon.svg">
      </head>
      <body>
        <script src="js/app.js"></script>
        <script>console.log('inline')</script>
      </body>
    </html>
  `

  const files = () =>
    project({
      'index.html': { type: 'text/html', content: entryHtml },
      'css/main.css': { type: 'text/css', content: 'body{}' },
      'js/app.js': { type: 'text/javascript', content: 'start()' },
      'favicon.svg': { type: 'image/svg+xml' },
    })

  it('classifies matched, missing and external together', () => {
    const { entryPath, references } = analyze(files())

    expect(entryPath).toBe('index.html')
    expect(references).toEqual([
      {
        kind: 'stylesheet',
        rawHref: 'css/main.css',
        resolvedPath: 'css/main.css',
        status: 'matched',
      },
      {
        kind: 'stylesheet',
        rawHref: 'css/theme.css',
        resolvedPath: 'css/theme.css',
        status: 'missing',
      },
      {
        kind: 'stylesheet',
        rawHref: 'https://cdn.example.com/reset.css',
        resolvedPath: null,
        status: 'external',
      },
      {
        kind: 'script',
        rawHref: 'js/app.js',
        resolvedPath: 'js/app.js',
        status: 'matched',
      },
    ])
  })

  it('resolves relative to an entry inside a folder', () => {
    const files = project({
      'pages/index.html': {
        type: 'text/html',
        content: '<link rel="stylesheet" href="../css/main.css">',
      },
      'css/main.css': { type: 'text/css', content: 'body{}' },
    })

    const { entryPath, references } = analyze(files)

    expect(entryPath).toBe('pages/index.html')
    expect(references[0]).toMatchObject({
      resolvedPath: 'css/main.css',
      status: 'matched',
    })
  })

  it('returns no entry and no references when detection is ambiguous', () => {
    const files = project({
      'a.html': { type: 'text/html', content: '<link rel="stylesheet" href="a.css">' },
      'b.html': { type: 'text/html', content: '' },
    })

    expect(analyze(files)).toEqual({ entryPath: null, references: [] })
  })

  it('handles an entry with no references at all', () => {
    const files = project({
      'index.html': { type: 'text/html', content: '<h1>self contained</h1>' },
    })

    expect(analyze(files)).toEqual({ entryPath: 'index.html', references: [] })
  })
})
