const STORAGE_KEY = 'single-file-builder:theme'

export function readTheme() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'dark' || stored === 'light') return stored
  } catch {
    // Storage can throw when blocked (private browsing, disabled cookies);
    // fall back to the OS preference for this session.
  }
  return systemPreference()
}

export function writeTheme(theme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // Best-effort only. The choice still applies for this session via the
    // in-memory store; only cross-session persistence is lost.
  }
}

function systemPreference() {
  if (typeof window.matchMedia !== 'function') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
