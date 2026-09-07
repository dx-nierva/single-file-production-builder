/**
 * Comment and whitespace removal for the stylesheets and scripts feature 4
 * inlines. Correctness first: a corruption here becomes a broken compiled page
 * there, so anything the scanner cannot read confidently is returned untouched.
 *
 * Pure text rewriting, no DOM, no dependency, and the source is never evaluated.
 * Every pass walks the input once with an index rather than running a regular
 * expression across the whole file, because this processes uploaded text of
 * unknown size.
 */

const DELIMITERS = new Set(['{', '}', ';', ','])

/** Returned when the scanner runs out of input inside a construct. */
function unchanged(source, warning) {
  return { code: source, warning }
}

function isWhitespace(char) {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f'
}

/**
 * Index just past the closing quote, or -1 when the string never closes.
 * A raw line terminator ends it rather than continuing it, in both languages
 * this module handles, so CSS and JS strings share this one reader.
 */
function readString(source, start) {
  const quote = source[start]

  for (let i = start + 1; i < source.length; i += 1) {
    const char = source[i]
    if (char === '\\') {
      i += 1
      continue
    }
    if (char === quote) return i + 1
    if (char === '\n' || char === '\r') return -1
  }

  return -1
}

/**
 * Index just past the `)` of a url() token. The contents are opaque: an
 * unquoted URL may hold `/*`, spaces or anything else that would confuse the
 * ordinary scanner.
 */
function readUrl(source, start) {
  let i = start + 4 // past "url("

  while (i < source.length) {
    const char = source[i]

    if (char === '"' || char === "'") {
      const end = readString(source, i)
      if (end === -1) return -1
      i = end
      continue
    }

    if (char === ')') return i + 1
    i += 1
  }

  return -1
}

/** True when `url(` starts here and is not the tail of a longer identifier. */
function startsUrl(source, i) {
  if (source.slice(i, i + 4).toLowerCase() !== 'url(') return false

  const before = source[i - 1]
  return before === undefined || !/[A-Za-z0-9_-]/.test(before)
}

export function minifyCss(source) {
  let out = ''
  let pendingSpace = false
  let i = 0

  // A verbatim region always ends with a quote, `)` or `/`, never with a bare
  // delimiter, so inspecting the last emitted character is safe here.
  const endsWithDelimiter = () => out !== '' && DELIMITERS.has(out[out.length - 1])

  const flushSpace = (nextChar) => {
    if (!pendingSpace) return
    pendingSpace = false
    if (out === '' || endsWithDelimiter() || DELIMITERS.has(nextChar)) return
    out += ' '
  }

  while (i < source.length) {
    const char = source[i]

    if (isWhitespace(char)) {
      pendingSpace = true
      i += 1
      continue
    }

    if (char === '"' || char === "'") {
      const end = readString(source, i)
      if (end === -1) return unchanged(source, 'unterminated string')
      flushSpace(char)
      out += source.slice(i, end)
      i = end
      continue
    }

    if (startsUrl(source, i)) {
      const end = readUrl(source, i)
      if (end === -1) return unchanged(source, 'unterminated url()')
      flushSpace(char)
      out += source.slice(i, end)
      i = end
      continue
    }

    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end === -1) return unchanged(source, 'unterminated block comment')

      // A bang comment usually carries licence text that has to survive into
      // the shared output.
      if (source[i + 2] === '!') {
        flushSpace(char)
        out += source.slice(i, end + 2)
      }

      i = end + 2
      continue
    }

    flushSpace(char)
    out += char
    i += 1
  }

  return { code: out, warning: null }
}

/* ------------------------------------------------------------------ script */

/** After these, a `/` opens a regular expression rather than dividing. */
const REGEX_AFTER_PUNCTUATION = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';',
  '+', '-', '*', '%', '~', '^', '<', '>',
])

const REGEX_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
])

/** `if (x) /re/.test(s)` is a regex; `f(x) / 2` is a division. */
const CONTROL_KEYWORDS = new Set(['if', 'while', 'for', 'with'])

const IDENTIFIER_START = /[A-Za-z_$]/
const IDENTIFIER_PART = /[A-Za-z0-9_$]/
const NUMBER_PART = /[0-9A-Za-z_$.]/

/** Positive index past the literal, -1 on a newline first, -2 at end of input. */
function readRegex(source, start) {
  let inCharacterClass = false

  for (let i = start + 1; i < source.length; i += 1) {
    const char = source[i]

    if (char === '\\') {
      i += 1
      continue
    }
    // A regular expression cannot hold a raw line terminator, so a newline
    // means this slash was a division after all.
    if (char === '\n' || char === '\r') return -1

    if (inCharacterClass) {
      if (char === ']') inCharacterClass = false
      continue
    }
    if (char === '[') {
      inCharacterClass = true
      continue
    }

    if (char === '/') {
      let end = i + 1
      while (end < source.length && IDENTIFIER_PART.test(source[end])) end += 1
      return end
    }
  }

  return -2
}

/**
 * Index just past the closing backtick. The whole literal is opaque, including
 * its `${ }` expressions: minifying inside an interpolation buys almost nothing
 * and risks a great deal.
 *
 * Interpolations still have to be walked, because a brace, backtick or quote
 * inside one decides where the literal actually ends. That walk needs the same
 * regex-versus-division context as scanJs: a bare `/` tried against readRegex
 * with no token context can match a later, unrelated slash on the same line
 * (another division, a comment, a real regex) and consume everything up to and
 * past it, including the interpolation's own `}` and the template's closing
 * backtick, before the newline check ever has a chance to save it.
 */
function readTemplate(source, start) {
  let depth = 0
  let lastToken = null
  let lastParenWasControl = false
  const parenStack = []

  for (let i = start + 1; i < source.length; i += 1) {
    const char = source[i]

    if (char === '\\') {
      i += 1
      continue
    }

    if (depth === 0) {
      if (char === '`') return i + 1
      if (char === '$' && source[i + 1] === '{') {
        depth = 1
        i += 1
        // A fresh expression context: the same starting point expectsRegex
        // uses for the top of a script.
        lastToken = null
        lastParenWasControl = false
        parenStack.length = 0
      }
      continue
    }

    if (char === '{') {
      depth += 1
      lastToken = char
      continue
    }
    if (char === '}') {
      depth -= 1
      lastToken = char
      continue
    }

    if (char === '`') {
      const end = readTemplate(source, i)
      if (end === -1) return -1
      i = end - 1
      lastToken = char
      continue
    }

    if (char === '"' || char === "'") {
      const end = readString(source, i)
      if (end === -1) return -1
      i = end - 1
      lastToken = char
      continue
    }

    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end === -1) return -1
      i = end + 1
      continue
    }

    if (char === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i + 2)
      i = end === -1 ? source.length : end
      continue
    }

    if (char === '/' && expectsRegex(lastToken, lastParenWasControl)) {
      const end = readRegex(source, i)
      if (end > 0) {
        i = end - 1
        lastToken = '/'
        continue
      }
      // -1 (newline first) or -2 (end of input): not a regex after all, fall
      // through and let it join the ordinary characters below as a division.
    }

    if (IDENTIFIER_START.test(char)) {
      let end = i + 1
      while (end < source.length && IDENTIFIER_PART.test(source[end])) end += 1
      lastToken = source.slice(i, end)
      i = end - 1
      continue
    }

    if (char >= '0' && char <= '9') {
      let end = i + 1
      while (end < source.length && NUMBER_PART.test(source[end])) end += 1
      lastToken = source.slice(i, end)
      i = end - 1
      continue
    }

    if (char === '(') {
      parenStack.push(CONTROL_KEYWORDS.has(identifierBefore(source, i)))
    } else if (char === ')') {
      lastParenWasControl = parenStack.length > 0 ? parenStack.pop() : false
    }

    lastToken = char
  }

  return -1
}

/** The identifier immediately before an opening parenthesis, if any. */
function identifierBefore(source, parenIndex) {
  let i = parenIndex - 1
  while (i >= 0 && isWhitespace(source[i])) i -= 1

  const end = i + 1
  while (i >= 0 && IDENTIFIER_PART.test(source[i])) i -= 1

  return source.slice(i + 1, end)
}

function expectsRegex(lastToken, lastParenWasControl) {
  if (lastToken === null) return true
  if (lastToken === '}') return true
  if (lastToken === ')') return lastParenWasControl
  if (lastToken.length === 1 && REGEX_AFTER_PUNCTUATION.has(lastToken)) return true
  return REGEX_AFTER_KEYWORD.has(lastToken)
}

/**
 * Classify every byte of a script as code, comment, or literal.
 *
 * Regions are contiguous and cover the whole source, so slicing them and
 * joining reproduces the input exactly. A region carries `unterminated: true`
 * when the scanner reached end of input while still inside it.
 */
export function scanJs(source) {
  const regions = []
  let codeStart = 0
  let i = 0
  let lastToken = null
  let lastParenWasControl = false
  const parenStack = []

  const pushRegion = (kind, start, end, unterminated) => {
    if (start > codeStart) {
      regions.push({ kind: 'code', start: codeStart, end: start })
    }
    const region = { kind, start, end }
    if (unterminated) region.unterminated = true
    regions.push(region)
    codeStart = end
  }

  while (i < source.length) {
    const char = source[i]

    if (isWhitespace(char)) {
      i += 1
      continue
    }

    // Comments are checked before the regex decision: `//` is never an empty
    // regular expression and `/*` is never one starting with a quantifier.
    if (char === '/' && source[i + 1] === '/') {
      const newline = source.indexOf('\n', i + 2)
      const end = newline === -1 ? source.length : newline
      pushRegion('line-comment', i, end, false)
      i = end
      continue
    }

    if (char === '/' && source[i + 1] === '*') {
      const closing = source.indexOf('*/', i + 2)
      if (closing === -1) {
        pushRegion('block-comment', i, source.length, true)
        return regions
      }
      pushRegion('block-comment', i, closing + 2, false)
      i = closing + 2
      continue
    }

    if (char === '"' || char === "'") {
      const end = readString(source, i)
      if (end === -1) {
        pushRegion('string', i, source.length, true)
        return regions
      }
      pushRegion('string', i, end, false)
      i = end
      lastToken = char
      continue
    }

    if (char === '`') {
      const end = readTemplate(source, i)
      if (end === -1) {
        pushRegion('template', i, source.length, true)
        return regions
      }
      pushRegion('template', i, end, false)
      i = end
      lastToken = '`'
      continue
    }

    if (char === '/' && expectsRegex(lastToken, lastParenWasControl)) {
      const end = readRegex(source, i)

      if (end === -2) {
        pushRegion('regex', i, source.length, true)
        return regions
      }

      if (end > 0) {
        pushRegion('regex', i, end, false)
        i = end
        lastToken = '/'
        continue
      }
      // -1 falls through: a newline arrived first, so this is a division.
    }

    if (IDENTIFIER_START.test(char)) {
      let end = i + 1
      while (end < source.length && IDENTIFIER_PART.test(source[end])) end += 1
      lastToken = source.slice(i, end)
      i = end
      continue
    }

    if (char >= '0' && char <= '9') {
      let end = i + 1
      while (end < source.length && NUMBER_PART.test(source[end])) end += 1
      lastToken = source.slice(i, end)
      i = end
      continue
    }

    if (char === '(') {
      parenStack.push(CONTROL_KEYWORDS.has(identifierBefore(source, i)))
    } else if (char === ')') {
      lastParenWasControl = parenStack.length > 0 ? parenStack.pop() : false
    }

    lastToken = char
    i += 1
  }

  if (source.length > codeStart) {
    regions.push({ kind: 'code', start: codeStart, end: source.length })
  }

  return regions
}

const UNTERMINATED_WARNING = {
  'block-comment': 'unterminated block comment',
  string: 'unterminated string',
  template: 'unterminated template literal',
  regex: 'unterminated regular expression',
}

/**
 * Comment and indentation removal built on scanJs. Newlines are never removed
 * and lines are never joined: doing that safely needs to know where automatic
 * semicolon insertion would change meaning, which needs a real parser.
 *
 * The whole pass is one state machine walking the regions in order:
 *   pendingSpace   - a horizontal-whitespace run (real or a single-line
 *                    comment's placeholder) waiting to collapse to one space
 *   atLineStart    - nothing real emitted yet since the last emitted newline
 *   lineHasContent - the current output line has real content, so its
 *                    terminating newline should survive; otherwise the line
 *                    was blank or comment-only and disappears completely
 */
export function minifyJs(source) {
  const regions = scanJs(source)
  const last = regions[regions.length - 1]
  if (last?.unterminated) {
    return unchanged(source, UNTERMINATED_WARNING[last.kind])
  }

  let out = ''
  let pendingSpace = false
  let atLineStart = true
  let lineHasContent = false

  /** A verbatim span: literals, and bang comments kept exactly as authored. */
  const emitVerbatim = (text) => {
    if (pendingSpace && !atLineStart) out += ' '
    pendingSpace = false
    out += text

    if (text.endsWith('\n')) {
      atLineStart = true
      lineHasContent = false
    } else if (text.length > 0) {
      atLineStart = false
      lineHasContent = true
    }
  }

  /**
   * A real newline, or a multi-line comment standing in for one. Only
   * emitted when the line it closes had real content, which is what makes a
   * blank or comment-only line vanish instead of leaving an empty line behind.
   */
  const handleNewline = () => {
    pendingSpace = false
    if (lineHasContent) out += '\n'
    atLineStart = true
    lineHasContent = false
  }

  for (const region of regions) {
    const { kind } = region

    if (kind === 'string' || kind === 'template' || kind === 'regex') {
      emitVerbatim(source.slice(region.start, region.end))
      continue
    }

    if (kind === 'line-comment') {
      // Always runs to end of line or end of input, so nothing on this line
      // can follow it; there is never a placeholder space to queue.
      continue
    }

    if (kind === 'block-comment') {
      const text = source.slice(region.start, region.end)

      if (text[2] === '!') {
        emitVerbatim(text)
        continue
      }

      if (text.includes('\n')) {
        // A multi-line comment is itself a line break for ASI purposes, so it
        // goes through the exact same blank-line gate as a real newline: one
        // alone on its own line disappears the same way a comment-only line
        // does anywhere else in this file.
        handleNewline()
      } else {
        pendingSpace = true
      }
      continue
    }

    // A code region: walk it a character at a time.
    const text = source.slice(region.start, region.end)
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i]

      if (char === '\n') {
        handleNewline()
        continue
      }

      if (isWhitespace(char)) {
        pendingSpace = true
        continue
      }

      if (pendingSpace && !atLineStart) out += ' '
      pendingSpace = false
      out += char
      atLineStart = false
      lineHasContent = true
    }
  }

  return { code: out, warning: null }
}

/**
 * Route by media type to the matching minifier. Only the two canonical types
 * from src/files.js are handled; every other type passes through unchanged,
 * since feature 4 calls this for every uploaded file regardless of kind.
 */
export function minifySource(source, type) {
  if (type === 'text/css') return minifyCss(source)
  if (type === 'text/javascript') return minifyJs(source)
  return { code: source, warning: null }
}
