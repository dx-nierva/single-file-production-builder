import { describe, it, expect } from 'vitest'
import { minifyCss, scanJs, minifyJs, minifySource } from './minify.js'

const css = (source) => minifyCss(source).code

describe('minifyCss', () => {
  it('collapses whitespace and trims it around delimiters', () => {
    expect(css('body {  margin: 0 ;  }')).toBe('body{margin: 0;}')
  })

  it('keeps a single space between values', () => {
    expect(css('a{padding:  1px   2px}')).toBe('a{padding: 1px 2px}')
  })

  it('trims around commas in selectors and values', () => {
    expect(css('@media screen , print { a , b { color: red } }')).toBe(
      '@media screen,print{a,b{color: red}}',
    )
  })

  // a :hover and a:hover select different elements, so the space is meaning.
  it('never removes the space before a colon', () => {
    expect(css('a :hover { color: red }')).toBe('a :hover{color: red}')
  })

  it('leaves combinators and parentheses alone', () => {
    expect(css('a > b { color: red }')).toBe('a > b{color: red}')
    expect(css('@media (min-width: 600px) { a{color:red} }')).toBe(
      '@media (min-width: 600px){a{color:red}}',
    )
  })

  it('removes block comments', () => {
    expect(css('/* drop */ a{}')).toBe('a{}')
    expect(css('a{/* inside */color:red}')).toBe('a{color:red}')
  })

  it('preserves a bang comment verbatim', () => {
    expect(css('/*! keep\n   me */ a{}')).toBe('/*! keep\n   me */ a{}')
  })

  it('does not treat // as a comment, because CSS has no line comments', () => {
    expect(css('a{background:url(//cdn.example.com/x.png)}')).toBe(
      'a{background:url(//cdn.example.com/x.png)}',
    )
  })

  it('leaves a comment sequence inside a string alone', () => {
    expect(css('.a{content:"/* not a comment */"}')).toBe(
      '.a{content:"/* not a comment */"}',
    )
  })

  it('leaves a delimiter inside a string alone', () => {
    expect(css(".a{content:'a , b ; c'}")).toBe(".a{content:'a , b ; c'}")
  })

  it('treats an unquoted url() as opaque', () => {
    expect(css('.b{background:url(img/a/*b.png)}')).toBe(
      '.b{background:url(img/a/*b.png)}',
    )
    expect(css('.c{background:url( spaced value.png )}')).toBe(
      '.c{background:url( spaced value.png )}',
    )
  })

  it('recognises URL( case-insensitively', () => {
    expect(css('.e{background:URL(x.png)}')).toBe('.e{background:URL(x.png)}')
    expect(css('.f{background:Url("x.png")}')).toBe('.f{background:Url("x.png")}')
  })

  it('handles a quoted url containing a closing parenthesis', () => {
    expect(css('.d{background:url("a)b.png")}')).toBe('.d{background:url("a)b.png")}')
  })

  it('does not mistake an identifier ending in url for a url token', () => {
    expect(css('a{x:blurl( 1 )}')).toBe('a{x:blurl( 1 )}')
  })

  it('escapes inside strings do not end them early', () => {
    expect(css(`.e{content:"a\\"b , c"}`)).toBe(`.e{content:"a\\"b , c"}`)
  })

  it('returns an empty string unchanged', () => {
    expect(minifyCss('')).toEqual({ code: '', warning: null })
  })

  describe('fail safe', () => {
    it('returns the original on an unterminated comment', () => {
      const source = 'a{color:red}/* oops'
      expect(minifyCss(source)).toEqual({
        code: source,
        warning: 'unterminated block comment',
      })
    })

    it('returns the original on an unterminated string', () => {
      const source = '.a{content:"oops}'
      expect(minifyCss(source)).toEqual({
        code: source,
        warning: 'unterminated string',
      })
    })

    it('returns the original on an unterminated url()', () => {
      const source = '.a{background:url(oops'
      expect(minifyCss(source)).toEqual({
        code: source,
        warning: 'unterminated url()',
      })
    })
  })
})

describe('scanJs', () => {
  /** [kind, text] for every region, which is easier to read than offsets. */
  const spans = (source) =>
    scanJs(source).map((r) => [r.kind, source.slice(r.start, r.end)])

  const kindsOf = (source) => scanJs(source).map((r) => r.kind)

  const reassembles = (source) =>
    scanJs(source)
      .map((r) => source.slice(r.start, r.end))
      .join('') === source

  it('covers the whole source with contiguous regions', () => {
    const source = [
      '// head',
      'const s = "a/b"',
      'const t = `x ${ y } z`',
      'const r = /a\\/b/g',
      '/* block */',
      'const d = a / b',
    ].join('\n')

    expect(reassembles(source)).toBe(true)
    expect(kindsOf(source)).toEqual([
      'line-comment',
      'code',
      'string',
      'code',
      'template',
      'code',
      'regex',
      'code',
      'block-comment',
      'code',
    ])
  })

  it('reassembles an empty source to nothing', () => {
    expect(scanJs('')).toEqual([])
  })

  describe('regex versus division', () => {
    const kindAfter = (prefix) => {
      const region = scanJs(`${prefix}/re/`).find((r) => r.kind === 'regex')
      return region ? 'regex' : 'division'
    }

    it('reads a regex at the start of input', () => {
      expect(kindAfter('')).toBe('regex')
    })

    it('reads a regex after punctuation that cannot end an expression', () => {
      for (const prefix of ['x = ', 'f(', 'a, ', '{ ', '[ ', '! ', 'a || ', 'a ? ']) {
        expect(kindAfter(prefix)).toBe('regex')
      }
    })

    it('reads a regex after a closing brace', () => {
      expect(kindAfter('function f() {} ')).toBe('regex')
    })

    it('reads a regex after a keyword', () => {
      for (const prefix of ['return ', 'typeof ', 'case ', 'throw ', 'new ']) {
        expect(kindAfter(prefix)).toBe('regex')
      }
    })

    it('reads a division after an identifier, number, or bracket', () => {
      expect(kindAfter('a ')).toBe('division')
      expect(kindAfter('1 ')).toBe('division')
      expect(kindAfter('arr[0] ')).toBe('division')
    })

    it('reads a division after a call, but a regex after if (...)', () => {
      expect(kindAfter('f(x) ')).toBe('division')
      expect(kindAfter('if (x) ')).toBe('regex')
      expect(kindAfter('while (x) ')).toBe('regex')
    })

    it('reads a division after a closing quote', () => {
      expect(kindAfter('"s" ')).toBe('division')
    })

    // The recovery rule: a regex cannot hold a raw line terminator.
    it('re-reads a candidate regex as division when a newline arrives first', () => {
      const source = 'const x = a\nconst y = b / c\nconst z = d / e'
      expect(kindsOf(source)).toEqual(['code'])
      expect(reassembles(source)).toBe(true)
    })

    // After `}` the scanner guesses regex, but this is object-literal division.
    // Only the newline rule saves it from swallowing the rest of the file.
    it('recovers when a regex guess after a brace was really a division', () => {
      const source = 'const half = ({ a: 4 }/2)\nconst x = 1'
      expect(kindsOf(source)).toEqual(['code'])
      expect(reassembles(source)).toBe(true)
    })

    it('keeps a division chain as plain code', () => {
      expect(kindsOf('const x = a / b / c')).toEqual(['code'])
    })
  })

  describe('literals', () => {
    it('keeps an escaped quote from ending a string', () => {
      expect(spans('const s = "a\\"b"')).toEqual([
        ['code', 'const s = '],
        ['string', '"a\\"b"'],
      ])
    })

    it('keeps an escaped backtick from ending a template', () => {
      expect(spans('const t = `a\\`b`')).toEqual([
        ['code', 'const t = '],
        ['template', '`a\\`b`'],
      ])
    })

    it('spans a template across newlines and interpolations', () => {
      const source = 'const t = `line\n  ${ a + b } end`'
      expect(spans(source)[1]).toEqual(['template', '`line\n  ${ a + b } end`'])
    })

    it('handles a template nested inside an interpolation', () => {
      const source = 'const t = `a ${ `b ${ c } d` } e`'
      expect(spans(source)[1][1]).toBe('`a ${ `b ${ c } d` } e`')
    })

    it('handles a brace inside a string inside an interpolation', () => {
      const source = 'const t = `a ${ f("}") } b`'
      expect(spans(source)[1][1]).toBe('`a ${ f("}") } b`')
    })

    it('handles a brace inside a regex inside an interpolation', () => {
      const source = 'const t = `a ${ s.replace(/}/g, "") } b`'
      expect(spans(source)[1][1]).toBe('`a ${ s.replace(/}/g, "") } b`')
    })

    // F-05: a division inside `${}` was tried as a candidate regex with no
    // token context, and a later unrelated slash on the same line let the
    // scan run straight past the interpolation's `}` and the closing
    // backtick, misreporting the whole template as unterminated.
    it('reads a division inside an interpolation, not a regex, even when a later slash on the same line could look like a closing delimiter', () => {
      const source = 'const t = `${a/b}` + c/d'
      expect(reassembles(source)).toBe(true)
      expect(kindsOf(source)).toEqual(['code', 'template', 'code'])
      expect(spans(source)[1][1]).toBe('`${a/b}`')
    })

    it('still reads a real regex inside an interpolation after an identifier boundary that would expect division', () => {
      // `.replace(` puts us right after `(`, where a regex is genuinely
      // expected, so this must keep working after the F-05 fix.
      const source = 'const t = `${x.replace(/a/, "b")}`'
      expect(spans(source)[1]).toEqual(['template', '`${x.replace(/a/, "b")}`'])
    })

    it('does not end a regex on a slash inside a character class', () => {
      expect(spans('const r = /[/]/g')).toEqual([
        ['code', 'const r = '],
        ['regex', '/[/]/g'],
      ])
    })

    it('keeps a comment sequence inside a regex', () => {
      expect(spans('const r = /a\\/\\/b/')).toEqual([
        ['code', 'const r = '],
        ['regex', '/a\\/\\/b/'],
      ])
    })

    it('keeps a quote inside a line comment from opening a string', () => {
      const source = "// it's fine\nconst a = 1"
      expect(kindsOf(source)).toEqual(['line-comment', 'code'])
      expect(reassembles(source)).toBe(true)
    })

    it('handles a line comment at end of input with no trailing newline', () => {
      expect(spans('const a = 1 // tail')).toEqual([
        ['code', 'const a = 1 '],
        ['line-comment', '// tail'],
      ])
    })
  })

  describe('unterminated constructs', () => {
    const lastRegion = (source) => scanJs(source).at(-1)

    it('marks an unterminated block comment', () => {
      expect(lastRegion('a = 1 /* oops')).toMatchObject({
        kind: 'block-comment',
        unterminated: true,
      })
    })

    it('marks an unterminated string', () => {
      expect(lastRegion('a = "oops')).toMatchObject({
        kind: 'string',
        unterminated: true,
      })
    })

    it('marks an unterminated template literal', () => {
      expect(lastRegion('a = `oops')).toMatchObject({
        kind: 'template',
        unterminated: true,
      })
    })

    it('marks an unterminated regular expression', () => {
      expect(lastRegion('a = /oops')).toMatchObject({
        kind: 'regex',
        unterminated: true,
      })
    })

    it('still covers the whole source when it gives up', () => {
      expect(reassembles('a = 1 /* oops')).toBe(true)
    })
  })
})

describe('minifyJs', () => {
  const js = (source) => minifyJs(source).code

  it('never removes newlines or joins lines', () => {
    expect(js('const a = 1\nconst b = 2')).toBe('const a = 1\nconst b = 2')
  })

  it('removes a comment-only line without leaving a blank line behind', () => {
    expect(js('function f() {\n    // hi\n    return 1\n}')).toBe(
      'function f() {\nreturn 1\n}',
    )
  })

  it('replaces a single-line block comment with one space', () => {
    expect(js('return/*x*/1')).toBe('return 1')
  })

  it('treats a multi-line block comment as its own line break', () => {
    expect(js('a = 1 /* x\ny */ b = 2')).toBe('a = 1\nb = 2')
  })

  it('keeps regex and comment-lookalike text inside it untouched', () => {
    expect(js('const re = /a\\/b/g   // t')).toBe('const re = /a\\/b/g')
  })

  it('leaves indentation inside a template literal untouched', () => {
    const source = 'const t = `\n    indented\n    lines\n`'
    expect(js(source)).toBe(source)
  })

  it('returns the original on an unterminated template literal', () => {
    expect(minifyJs('const t = `oops')).toEqual({
      code: 'const t = `oops',
      warning: 'unterminated template literal',
    })
  })

  it('collapses interior whitespace and trims each line', () => {
    const source = '  function   f( )  {\n    return    1  \n  }  '
    expect(js(source)).toBe('function f( ) {\nreturn 1\n}')
  })

  it('removes a leading and a trailing blank line', () => {
    expect(js('\n\nconst a = 1\n\n\n')).toBe('const a = 1\n')
  })

  it('removes several consecutive comment-only lines at once', () => {
    const source = 'const a = 1\n// one\n// two\n// three\nconst b = 2'
    expect(js(source)).toBe('const a = 1\nconst b = 2')
  })

  it('preserves a bang comment verbatim, including a line it owns alone', () => {
    const source = 'const a = 1\n/*! keep me */\nconst b = 2'
    expect(js(source)).toBe(source)
  })

  it('removes a line comment at end of input with no trailing newline', () => {
    expect(js('const a = 1 // tail')).toBe('const a = 1')
  })

  it('drops a line consisting only of a single-line block comment', () => {
    const source = 'const a = 1\n  /* only this */  \nconst b = 2'
    expect(js(source)).toBe('const a = 1\nconst b = 2')
  })

  it('keeps a string and a template on the same line as ordinary code', () => {
    expect(js('const s = "a" + `b ${c}`')).toBe('const s = "a" + `b ${c}`')
  })

  it('routes an unterminated string through the shared warning', () => {
    expect(minifyJs('const s = "oops').warning).toBe('unterminated string')
  })

  it('routes an unterminated regex through the shared warning', () => {
    expect(minifyJs('const r = /oops').warning).toBe('unterminated regular expression')
  })

  it('returns an empty script unchanged', () => {
    expect(minifyJs('')).toEqual({ code: '', warning: null })
  })

  describe('behavioural equivalence', () => {
    // The point of this feature: minifying must not change what the code
    // does. A realistic fixture is run through new Function before and after,
    // and the two results have to agree.
    const fixture = `
      // computes a greeting for each name
      function greet(names) {
        /* join with a comma, matching the sample data */
        const sep = ', '
        return names
          .map(function (n) { return \`Hi \${n.trim()}!\` /* trim first */ })
          .join(sep)
      }

      /*! Licence: do not remove this comment in distributed builds. */
      const pattern = /^[A-Za-z /]+$/
      const isName = (s) => pattern.test(s) && s.length / 2 > 1

      const input = ['  Ada  ', 'Grace']
      const result = greet(input.filter(isName))
      return result
    `

    it('produces the same value before and after minifying', () => {
      const before = new Function(fixture)()
      const after = new Function(minifyJs(fixture).code)()
      expect(after).toBe(before)
      expect(before).toBe('Hi Ada!, Hi Grace!')
    })

    it('actually shrinks the fixture', () => {
      const { code } = minifyJs(fixture)
      expect(code.length).toBeLessThan(fixture.length)
    })
  })
})

describe('minifySource', () => {
  it('routes text/css to minifyCss', () => {
    expect(minifySource('a {  color: red  }', 'text/css')).toEqual(
      minifyCss('a {  color: red  }'),
    )
  })

  it('routes text/javascript to minifyJs', () => {
    const source = 'const a = 1  // hi'
    expect(minifySource(source, 'text/javascript')).toEqual(minifyJs(source))
  })

  it('returns any other type unchanged', () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
    expect(minifySource(source, 'image/svg+xml')).toEqual({
      code: source,
      warning: null,
    })
    expect(minifySource('some binary-ish text', 'application/octet-stream')).toEqual({
      code: 'some binary-ish text',
      warning: null,
    })
  })

  it('passes an unresolved type through unchanged rather than guessing', () => {
    expect(minifySource('body{color:red}', 'text/plain')).toEqual({
      code: 'body{color:red}',
      warning: null,
    })
  })
})
