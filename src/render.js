/**
 * Owns every DOM write. The shell is built once by mount(), then update()
 * reconciles it against state. Building once keeps event listeners attached
 * across state changes, so nothing has to rebind after a render.
 *
 * User-controlled values (folder names, file paths, error text) are only ever
 * written with textContent. They must never reach the template literal below.
 */

import { formatSize } from './files.js'

const SHELL = `
<div class="shell">
  <header class="masthead">
    <div class="brand">
      <div class="brand-mark">sf</div>
      <div>
        <h1 class="brand-name">Single File Builder</h1>
        <p class="brand-sub">Compile a project into one portable index.html</p>
      </div>
    </div>
  </header>

  <p class="sr-only" role="status" aria-live="polite" data-status></p>

  <section class="card" data-error-card hidden>
    <div class="notice notice-error">
      <div>
        <p class="notice-title">Upload failed</p>
        <p class="notice-body" data-error-text></p>
      </div>
    </div>
  </section>

  <section class="card" aria-label="Add a project">
    <div class="dropzone" data-dropzone>
      <div class="dropzone-icon" aria-hidden="true">&#8613;</div>
      <p class="dropzone-title" data-drop-title></p>
      <p class="dropzone-hint" data-drop-hint></p>
      <div class="btn-row btn-row-center" data-drop-actions>
        <button class="btn btn-ghost" type="button" data-pick-files>Browse files</button>
        <button class="btn btn-ghost" type="button" data-pick-folder>Browse folder</button>
      </div>
      <p class="dropzone-formats">.html &middot; .css &middot; .js</p>
    </div>
    <input type="file" multiple hidden data-input-files>
    <input type="file" webkitdirectory hidden data-input-folder>
  </section>

  <div class="row-2">
    <section class="card">
      <div class="card-head">
        <h2 class="card-title">Files</h2>
        <span class="card-meta" data-file-count></span>
      </div>
      <hr class="empty-rule">
      <ul class="filelist" data-file-list hidden></ul>
      <p class="empty" data-file-empty>Uploaded files will be listed here</p>
    </section>

    <section class="card">
      <div class="card-head">
        <h2 class="card-title">Result</h2>
        <span class="card-meta">not compiled</span>
      </div>
      <hr class="empty-rule">
      <p class="empty">Size and reference stats appear after compiling</p>
    </section>
  </div>

  <section class="card">
    <div class="btn-row">
      <button class="btn btn-primary" type="button" disabled data-compile>
        Compile to single file
      </button>
      <span class="card-meta" data-compile-hint>Add files to enable</span>
    </div>
  </section>
</div>
`

const DROP_COPY = {
  idle: {
    title: 'Drop your project folder here',
    hint: 'Nothing leaves your browser. Everything compiles locally.',
  },
  reading: {
    title: 'Reading files',
    hint: 'Walking the folder. This can take a moment on large projects.',
  },
  success: {
    title: 'Project loaded',
    hint: 'Drop another folder to replace it.',
  },
  error: {
    title: 'Drop your project folder here',
    hint: 'Nothing was loaded. Try again.',
  },
}

export function mount(root) {
  root.innerHTML = SHELL
}

export function update(root, state) {
  const { uploadStatus, uploadedFiles, rootName, errorMessage } = state
  const copy = DROP_COPY[uploadStatus] ?? DROP_COPY.idle
  const count = uploadedFiles.size
  const isReading = uploadStatus === 'reading'

  // A failed upload keeps whatever was already loaded, so the drop zone has to
  // keep naming that project rather than reverting to the empty invitation.
  const keptFiles = uploadStatus === 'error' && count > 0
  const showsProject = uploadStatus === 'success' || keptFiles

  // rootName and errorMessage come from the user's filesystem, so they are set
  // as text, never interpolated into markup.
  root.querySelector('[data-drop-title]').textContent =
    showsProject && rootName ? `${rootName}/` : copy.title
  root.querySelector('[data-drop-hint]').textContent = keptFiles
    ? 'The project you had loaded is unchanged.'
    : copy.hint

  const dropzone = root.querySelector('[data-dropzone]')
  dropzone.classList.toggle('is-busy', isReading)
  dropzone.setAttribute('aria-busy', String(isReading))
  root.querySelector('[data-drop-actions]').hidden = isReading

  const errorCard = root.querySelector('[data-error-card]')
  errorCard.hidden = uploadStatus !== 'error'
  root.querySelector('[data-error-text]').textContent = errorMessage ?? ''

  root.querySelector('[data-file-count]').textContent = describeCount(
    count,
    totalBytes(uploadedFiles),
  )

  const list = root.querySelector('[data-file-list]')
  renderFileList(list, uploadedFiles)
  list.hidden = count === 0
  root.querySelector('[data-file-empty]').hidden = count > 0

  // The button stays disabled until feature 4 gives it something to compile,
  // so the empty-state hint would be misleading once files are loaded.
  root.querySelector('[data-compile-hint]').hidden = count > 0

  announce(root, state, count)
}

/** Drag feedback is transient, so it is not stored in state. */
export function setDragActive(root, isActive) {
  root.querySelector('[data-dropzone]').classList.toggle('is-active', isActive)
}

/**
 * One polite live region carries every status change, so a screen reader user
 * hears the outcome of a drop they cannot see.
 */
function announce(root, state, count) {
  const { uploadStatus, rootName, errorMessage } = state
  const region = root.querySelector('[data-status]')

  if (uploadStatus === 'reading') {
    region.textContent = 'Reading files'
    return
  }

  if (uploadStatus === 'error') {
    region.textContent = `Upload failed. ${errorMessage ?? ''}`.trim()
    return
  }

  if (uploadStatus === 'success') {
    const noun = count === 1 ? '1 file' : `${count} files`
    region.textContent = rootName
      ? `${noun} loaded from ${rootName}`
      : `${noun} loaded`
    return
  }

  region.textContent = ''
}

function describeCount(count, bytes) {
  if (count === 0) return '0 files'
  const label = count === 1 ? '1 file' : `${count} files`
  return `${label} · ${formatSize(bytes)}`
}

function totalBytes(uploadedFiles) {
  let total = 0
  for (const entry of uploadedFiles.values()) {
    total += entry.size
  }
  return total
}

function renderFileList(list, uploadedFiles) {
  list.replaceChildren()
  for (const entry of uploadedFiles.values()) {
    const row = document.createElement('li')
    row.className = 'filerow'
    row.append(
      cell('filerow-path', entry.path),
      cell('filerow-type', entry.type),
      cell('filerow-size', formatSize(entry.size)),
    )
    list.append(row)
  }
}

/** Every ingested value reaches the DOM through here, as text. */
function cell(className, text) {
  const span = document.createElement('span')
  span.className = className
  span.textContent = text
  return span
}
