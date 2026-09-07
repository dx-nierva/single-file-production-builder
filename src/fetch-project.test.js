// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fetchProject } from './fetch-project.js'

function okResponse({ contentType = 'text/html', text = '' } = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => text,
  }
}

function failResponse(status) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    text: async () => '',
  }
}

function abortableFetch() {
  return vi.fn((url, options) => {
    const signal = options?.signal
    return new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })
  })
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('fetchProject', () => {
  it('rejects with the invalid-URL message and never calls fetch', async () => {
    await expect(fetchProject('not a url')).rejects.toThrow('valid URL')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects with the unreachable/CORS message when the entry fetch rejects', async () => {
    fetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(fetchProject('https://example.com/')).rejects.toThrow(
      'cross-origin requests',
    )
  })

  it('rejects with the HTTP status message when the entry responds with a bad status', async () => {
    fetch.mockResolvedValue(failResponse(404))
    await expect(fetchProject('https://example.com/')).rejects.toThrow('HTTP 404')
  })

  it("rejects with the non-HTML message when the entry response isn't HTML", async () => {
    fetch.mockResolvedValue(okResponse({ contentType: 'application/json' }))
    await expect(fetchProject('https://example.com/')).rejects.toThrow(
      "didn't return an HTML page",
    )
  })

  it('rejects with the timeout message when the entry fetch is aborted', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', abortableFetch())

    const promise = fetchProject('https://example.com/')
    const assertion = expect(promise).rejects.toThrow('took too long')
    await vi.advanceTimersByTimeAsync(15000)
    await assertion
  })

  it('returns only the entry when it references nothing', async () => {
    fetch.mockResolvedValue(okResponse({ text: '<html><body>hi</body></html>' }))

    const { files } = await fetchProject('https://example.com/')
    expect([...files.keys()]) .toEqual(['index.html'])
  })

  it('fetches a relative stylesheet and script and includes both', async () => {
    const html =
      '<html><head><link rel="stylesheet" href="style.css"></head>' +
      '<body><script src="app.js"></script></body></html>'

    fetch.mockImplementation((url) => {
      if (String(url).endsWith('style.css')) {
        return Promise.resolve(okResponse({ contentType: 'text/css', text: 'body{}' }))
      }
      if (String(url).endsWith('app.js')) {
        return Promise.resolve(
          okResponse({ contentType: 'text/javascript', text: 'console.log(1)' }),
        )
      }
      return Promise.resolve(okResponse({ text: html }))
    })

    const { files } = await fetchProject('https://example.com/')
    expect([...files.keys()].sort()).toEqual(['app.js', 'index.html', 'style.css'])
    expect(files.get('style.css')).toMatchObject({ type: 'text/css', content: 'body{}' })
    expect(files.get('app.js')).toMatchObject({
      type: 'text/javascript',
      content: 'console.log(1)',
    })
  })

  it('never fetches a reference resolveHref classifies external', async () => {
    const html = '<html><head><script src="https://cdn.example.com/lib.js"></script></head></html>'
    fetch.mockResolvedValue(okResponse({ text: html }))

    const { files } = await fetchProject('https://example.com/')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(files.has('lib.js')).toBe(false)
  })

  it('leaves out an asset whose own fetch rejects, without failing the whole call', async () => {
    const html = '<html><head><script src="broken.js"></script></head></html>'
    fetch.mockImplementation((url) => {
      if (String(url).endsWith('broken.js')) return Promise.reject(new TypeError('fail'))
      return Promise.resolve(okResponse({ text: html }))
    })

    const { files } = await fetchProject('https://example.com/')
    expect(files.has('broken.js')).toBe(false)
  })

  it('fetches a path referenced twice only once', async () => {
    const html =
      '<html><head><script src="a.js"></script><script src="./a.js"></script></head></html>'
    let assetCalls = 0
    fetch.mockImplementation((url) => {
      if (String(url).endsWith('a.js')) {
        assetCalls += 1
        return Promise.resolve(okResponse({ contentType: 'text/javascript', text: 'x' }))
      }
      return Promise.resolve(okResponse({ text: html }))
    })

    const { files } = await fetchProject('https://example.com/')
    expect(assetCalls).toBe(1)
    expect([...files.keys()].sort()).toEqual(['a.js', 'index.html'])
  })

  it('sets rootName to the parsed URL hostname', async () => {
    fetch.mockResolvedValue(okResponse({ text: '<html></html>' }))
    const { rootName } = await fetchProject('https://pk-kampanart.github.io/prox-demo/')
    expect(rootName).toBe('pk-kampanart.github.io')
  })
})
