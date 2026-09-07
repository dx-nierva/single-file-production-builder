// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readTheme, writeTheme } from './theme.js'

const STORAGE_KEY = 'single-file-builder:theme'

function mockMatchMedia(matches) {
  window.matchMedia = vi.fn().mockReturnValue({ matches })
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  delete window.matchMedia
})

describe('readTheme', () => {
  it('returns a stored dark value', () => {
    localStorage.setItem(STORAGE_KEY, 'dark')
    expect(readTheme()).toBe('dark')
  })

  it('returns a stored light value', () => {
    localStorage.setItem(STORAGE_KEY, 'light')
    expect(readTheme()).toBe('light')
  })

  it('ignores a stored value that is neither dark nor light', () => {
    localStorage.setItem(STORAGE_KEY, 'sepia')
    mockMatchMedia(false)
    expect(readTheme()).toBe('light')
  })

  it('falls back to the OS preference when nothing is stored and it prefers dark', () => {
    mockMatchMedia(true)
    expect(readTheme()).toBe('dark')
  })

  it('falls back to the OS preference when nothing is stored and it prefers light', () => {
    mockMatchMedia(false)
    expect(readTheme()).toBe('light')
  })

  it('returns light when matchMedia is not a function and nothing is stored', () => {
    delete window.matchMedia
    expect(readTheme()).toBe('light')
  })

  it('falls back to the OS-preference resolution when localStorage.getItem throws', () => {
    mockMatchMedia(true)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readTheme()).toBe('dark')
  })
})

describe('writeTheme', () => {
  it('persists dark under the exact storage key', () => {
    writeTheme('dark')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark')
  })

  it('persists light under the exact storage key', () => {
    writeTheme('light')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light')
  })

  it('does not throw when localStorage.setItem throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => writeTheme('dark')).not.toThrow()
  })
})
