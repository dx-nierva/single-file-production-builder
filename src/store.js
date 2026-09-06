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

/** Keys owned by feature 1. Later features add their own. */
export function createInitialState() {
  return {
    uploadStatus: 'idle',
    uploadedFiles: new Map(),
    rootName: null,
    errorMessage: null,
  }
}
