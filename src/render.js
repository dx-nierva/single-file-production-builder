/**
 * Owns every DOM write. The shell is built once by mount(), then update()
 * reconciles it against state. Building once keeps event listeners attached
 * across state changes, so nothing has to rebind after a render.
 *
 * User-controlled values (folder names, file paths, authored hrefs, error text)
 * are only ever written with textContent. They must never reach the template
 * literal below.
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

  <section class="card" data-warning-card hidden>
    <div class="notice notice-warn">
      <div>
        <p class="notice-title">No entry document</p>
        <p class="notice-body">
          Nothing in this upload is named <code>index.html</code>, and there is
          more than one HTML file or none at all, so there is no document to
          compile from. Add the folder that holds your entry page.
        </p>
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

  <section class="card">
    <div class="card-head">
      <h2 class="card-title">Files</h2>
      <span class="card-meta" data-file-count></span>
    </div>
    <hr class="empty-rule">
    <ul class="filelist" data-file-list hidden></ul>
    <p class="empty" data-file-empty>Uploaded files will be listed here</p>
  </section>

  <div class="row-2">
    <section class="card">
      <div class="card-head">
        <h2 class="card-title">References</h2>
        <span class="card-meta" data-reference-count></span>
      </div>
      <hr class="empty-rule">
      <ul class="filelist" data-reference-list hidden></ul>
      <p class="empty" data-reference-empty></p>
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

const STATUS_BADGE = {
  matched: 'badge-ok',
  missing: 'badge-warn',
  external: 'badge-muted',
}

export function mount(root) {
  root.innerHTML = SHELL
}

export function update(root, state) {
  const { uploadStatus, uploadedFiles, rootName, errorMessage, references } = state
  const copy = DROP_COPY[uploadStatus] ?? DROP_COPY.idle
  const count = uploadedFiles.size
  const isReading = uploadStatus === 'reading'

  // A failed upload keeps whatever was already loaded, so the drop zone has to
  // keep naming that project rather than reverting to the empty invitation.
  const keptFiles = uploadStatus === 'error' && count > 0
  const showsProject = uploadStatus === 'success' || keptFiles

  // rootName, errorMessage and every path or href come from the user's files,
  // so they are set as text, never interpolated into markup.
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

  const fileList = root.querySelector('[data-file-list]')
  renderFileList(fileList, state)
  fileList.hidden = count === 0
  root.querySelector('[data-file-empty]').hidden = count > 0

  renderReferences(root, state)

  // Only meaningful once the upload has settled: mid-read there is no analysis
  // yet, and the drop zone is already saying so.
  root.querySelector('[data-warning-card]').hidden = !(
    count > 0 &&
    state.entryPath === null &&
    !isReading
  )

  // The button is disabled until feature 4 can compile, so the caption has to
  // explain the state rather than disappear and leave a bare dead button.
  root.querySelector('[data-compile-hint]').textContent =
    count === 0 ? 'Add files to enable' : capitalize(referenceSummary(state))

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
    const from = rootName ? ` from ${rootName}` : ''
    region.textContent = `${noun} loaded${from}, ${referenceSummary(state)}`
    return
  }

  region.textContent = ''
}

/**
 * One phrase describing the analysis, shared by the compile caption and the
 * live region so they can never disagree.
 */
function referenceSummary(state) {
  const { entryPath, references } = state

  if (entryPath === null) return 'no entry index.html found'
  if (references.length === 0) return 'no references to inline'

  const matched = references.filter((r) => r.status === 'matched').length
  return `${matched} of ${references.length} references resolved`
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1)
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

function renderFileList(list, state) {
  const { uploadedFiles, entryPath, references } = state

  const referenced = new Set(
    references.map((reference) => reference.resolvedPath).filter(Boolean),
  )

  list.replaceChildren()
  for (const entry of uploadedFiles.values()) {
    const isEntry = entry.path === entryPath
    // Without an entry nothing has been analysed, so nothing is known to be
    // unreferenced and badging every row would be noise.
    const unreferenced =
      entryPath !== null && !isEntry && !referenced.has(entry.path)

    const row = document.createElement('li')
    row.className = 'filerow'
    if (isEntry) row.classList.add('is-entry')
    if (unreferenced) row.classList.add('is-skipped')

    const path = cell('filerow-path', entry.path)
    if (isEntry) path.append(' ', badge('badge-entry', 'entry'))
    if (unreferenced) path.append(' ', badge('badge-warn', 'not referenced'))

    row.append(
      path,
      cell('filerow-type', entry.type),
      cell('filerow-size', formatSize(entry.size)),
    )
    list.append(row)
  }
}

function renderReferences(root, state) {
  const { uploadedFiles, entryPath, references } = state
  const list = root.querySelector('[data-reference-list]')

  list.replaceChildren()
  for (const reference of references) {
    const row = document.createElement('li')
    row.className = 'filerow'
    if (reference.status !== 'matched') row.classList.add('is-skipped')

    const status = document.createElement('span')
    status.className = 'filerow-size'
    status.append(badge(STATUS_BADGE[reference.status], reference.status))

    row.append(
      cell('filerow-path', reference.rawHref),
      cell('filerow-type', reference.kind),
      status,
    )
    list.append(row)
  }

  list.hidden = references.length === 0
  root.querySelector('[data-reference-count]').textContent =
    references.length === 0 ? '' : describeReferences(references)

  const empty = root.querySelector('[data-reference-empty]')
  empty.hidden = references.length > 0
  empty.textContent = describeNoReferences(uploadedFiles.size, entryPath)
}

function describeReferences(references) {
  const matched = references.filter((r) => r.status === 'matched').length
  return `${matched} of ${references.length} resolved`
}

function describeNoReferences(fileCount, entryPath) {
  if (fileCount === 0) return 'Detected from the entry document after an upload'
  if (entryPath === null) return 'No entry document found'
  return 'The entry document references no stylesheets or scripts'
}

/** Every ingested value reaches the DOM through here, as text. */
function cell(className, text) {
  const span = document.createElement('span')
  span.className = className
  span.textContent = text
  return span
}

function badge(className, text) {
  const span = document.createElement('span')
  span.className = `badge ${className}`
  span.textContent = text
  return span
}
