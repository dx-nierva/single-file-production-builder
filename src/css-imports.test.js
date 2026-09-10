import { describe, it, expect } from 'vitest'
import { resolveCssImports } from './css-imports.js'

function filesFrom(entries) {
  const files = new Map()
  for (const [path, content] of Object.entries(entries)) {
    files.set(path, { path, name: path, type: 'text/css', size: content.length, content })
  }
  return files
}

describe('resolveCssImports', () => {
  it('returns a stylesheet with no @import unchanged, with no events', () => {
    const files = filesFrom({ 'a.css': 'body { color: red; }' })
    const result = resolveCssImports('a.css', files)
    expect(result.code).toBe('body { color: red; }')
    expect(result.events).toEqual([])
  })

  it('inlines a single matched nested import in place', () => {
    const files = filesFrom({
      'a.css': '@import url("b.css");\nbody { color: red; }',
      'b.css': '.b { color: blue; }',
    })
    const result = resolveCssImports('a.css', files)
    expect(result.code).toBe('.b { color: blue; }\nbody { color: red; }')
    expect(result.events).toEqual([{ status: 'matched', target: 'b.css', size: 19 }])
  })

  it('inlines a bare-string @import ("x.css";) the same as url()', () => {
    const files = filesFrom({
      'a.css': '@import "b.css";',
      'b.css': '.b {}',
    })
    const result = resolveCssImports('a.css', files)
    expect(result.code).toBe('.b {}')
    expect(result.events).toEqual([{ status: 'matched', target: 'b.css', size: 5 }])
  })

  it('resolves a two-level chain in document order', () => {
    const files = filesFrom({
      'a.css': '@import url("b.css");',
      'b.css': '@import url("c.css");\n.b {}',
      'c.css': '.c {}',
    })
    const result = resolveCssImports('a.css', files)
    expect(result.code).toBe('.c {}\n.b {}')
    expect(result.events).toEqual([
      { status: 'matched', target: 'b.css', size: files.get('b.css').size },
      { status: 'matched', target: 'c.css', size: files.get('c.css').size },
    ])
  })

  it('removes a missing target statement and reports it', () => {
    const files = filesFrom({ 'a.css': '@import url("gone.css");\nbody {}' })
    const result = resolveCssImports('a.css', files)
    expect(result.code).toBe('\nbody {}')
    expect(result.events).toEqual([{ status: 'missing', target: 'gone.css' }])
  })

  it('leaves an absolute-URL external import exactly as authored', () => {
    const files = filesFrom({
      'a.css': '@import url("https://fonts.googleapis.com/css2?family=Inter");\nbody {}',
    })
    const result = resolveCssImports('a.css', files)
    expect(result.code).toBe('@import url("https://fonts.googleapis.com/css2?family=Inter");\nbody {}')
    expect(result.events).toEqual([
      { status: 'external', target: 'https://fonts.googleapis.com/css2?family=Inter' },
    ])
  })

  it('leaves a protocol-relative external import exactly as authored', () => {
    const files = filesFrom({ 'a.css': '@import url("//example.com/x.css");' })
    const result = resolveCssImports('a.css', files)
    expect(result.code).toBe('@import url("//example.com/x.css");')
    expect(result.events).toEqual([{ status: 'external', target: '//example.com/x.css' }])
  })

  it('breaks a direct cycle instead of recursing forever', () => {
    const files = filesFrom({
      'a.css': '@import url("b.css");\n.a {}',
      'b.css': '@import url("a.css");\n.b {}',
    })
    const result = resolveCssImports('a.css', files)
    expect(result.code).toBe('\n.b {}\n.a {}')
    expect(result.events).toEqual([
      { status: 'matched', target: 'b.css', size: files.get('b.css').size },
      { status: 'circular', target: 'a.css' },
    ])
  })

  it('breaks a self-import instead of recursing forever', () => {
    const files = filesFrom({ 'a.css': '@import url("a.css");\n.a {}' })
    const result = resolveCssImports('a.css', files)
    expect(result.code).toBe('\n.a {}')
    expect(result.events).toEqual([{ status: 'circular', target: 'a.css' }])
  })

  it('inlines a diamond dependency twice, not as a cycle', () => {
    const files = filesFrom({
      'a.css': '@import url("b.css");@import url("c.css");',
      'b.css': '@import url("d.css");.b{}',
      'c.css': '@import url("d.css");.c{}',
      'd.css': '.d{}',
    })
    const result = resolveCssImports('a.css', files)
    expect(result.code).toBe('.d{}.b{}.d{}.c{}')
    expect(result.events.map((e) => e.status)).toEqual(['matched', 'matched', 'matched', 'matched'])
    expect(result.events.filter((e) => e.status === 'circular')).toEqual([])
  })

  it('leaves a media-qualified @import completely untouched, with no event', () => {
    const files = filesFrom({
      'a.css': '@import url("print.css") print;\nbody {}',
      'print.css': '.p {}',
    })
    const result = resolveCssImports('a.css', files)
    expect(result.code).toBe('@import url("print.css") print;\nbody {}')
    expect(result.events).toEqual([])
  })

  it('leaves a layer()-qualified @import completely untouched', () => {
    const files = filesFrom({ 'a.css': '@import url("x.css") layer(base);' })
    const result = resolveCssImports('a.css', files)
    expect(result.code).toBe('@import url("x.css") layer(base);')
    expect(result.events).toEqual([])
  })

  it('does not treat an @import-shaped string literal as a real statement', () => {
    const files = filesFrom({ 'a.css': '.a::before { content: "@import fake.css;"; }' })
    const result = resolveCssImports('a.css', files)
    expect(result.code).toBe('.a::before { content: "@import fake.css;"; }')
    expect(result.events).toEqual([])
  })

  it('does not treat an @import-shaped comment as a real statement', () => {
    const files = filesFrom({ 'a.css': '/* @import fake.css; */\nbody {}' })
    const result = resolveCssImports('a.css', files)
    expect(result.code).toBe('/* @import fake.css; */\nbody {}')
    expect(result.events).toEqual([])
  })

  it('leaves an @import with no closing ; before EOF untouched', () => {
    const files = filesFrom({ 'a.css': 'body {}\n@import url("b.css")' })
    const result = resolveCssImports('a.css', files)
    expect(result.code).toBe('body {}\n@import url("b.css")')
    expect(result.events).toEqual([])
  })

  it('leaves an unterminated string untouched rather than guessing', () => {
    const files = filesFrom({ 'a.css': 'body { content: "unterminated' })
    const result = resolveCssImports('a.css', files)
    expect(result.code).toBe('body { content: "unterminated')
    expect(result.events).toEqual([])
  })
})
