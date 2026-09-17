import { readTheme } from './theme.js'

/**
 * Minimal state container. The whole app is a function of this state: nothing
 * outside render.js touches the DOM, and nothing outside here mutates state.
 */
export function createStore(initialState) {
  let state = initialState
  const subscribers = new Set()

  return {
    getState() {
      return state
    },

    setState(patch) {
      state = { ...state, ...patch }
      for (const subscriber of subscribers) {
        subscriber(state)
      }
    },

    subscribe(subscriber) {
      subscribers.add(subscriber)
      return () => subscribers.delete(subscriber)
    },
  }
}

/** Later features add their own keys. */
export function createInitialState() {
  return {
    // feature 1: the upload
    uploadStatus: 'idle',
    uploadedFiles: new Map(),
    rootName: null,
    errorMessage: null,
    readProgress: null,

    // feature 2: what the entry document points at
    entryPath: null,
    references: [],

    // feature 4: the compiled result
    compiledOutput: null,

    // feature 5: how the compile went
    stats: null,
    log: [],

    // feature 7: the persisted display theme
    theme: readTheme(),
  }
}
