'use strict';

/* ═══════════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════════ */
const state = {
  rootDirHandle:     null,
  currentDirHandle:  null,
  dirStack:          [],   // [{ handle, name }]
  currentFileHandle: null,
  isDirty:           false,
  currentView:       'rendered',
  isPanelCollapsed:  false,
  isFullscreen:      false,
  panelWidth:        280,
  isResizing:        false,
  isInlineEditing:   false,   // true while the inline markdown editor is active
  // Search
  searchActive:      false,
  searchQuery:       '',
  searchGenId:       0,    // incremented on each new search to cancel stale runs
  searchOpenResult:  null, // the result object last opened from search (path used on exit)
  // In-file match navigation
  matchNav: {
    active: false,
    marks:  [],   // all mark.search-match elements in current file
    index:  0,    // currently focused match (0-based)
  },
};

const PREF_KEY = 'mdviewer-prefs';

// Tracks the file/folder pending soft-delete (during the 3 s undo window)
let _pendingDelete = null; // { name, handle, kind, dirHandle, listItemEl, timer }

// Drag-and-drop state
let _dragState   = null; // { handle, name, kind, srcDirHandle, listItemEl }
let _pendingMove = null; // { handle, name, kind, srcDirHandle, destDirHandle, destDirName, listItemEl }

// Live edit split-view
let _liveEditDivider  = null; // the drag handle element between preview and code pane
let _liveEditCodeW    = null; // code-pane width in split view (px); null = CSS 50% default
let _liveRenderTimer  = null; // debounce timer for real-time re-render

// Double-Enter fix: tracks last markdown content that was passed to renderMarkdown,
// so _onPreviewInput can skip re-render when only whitespace changed (e.g. trailing empty paragraph)
let _lastRenderedMarkdown = '';

// Custom undo stack (browser native undo is destroyed on each innerHTML re-render)
let _undoStack = []; // array of markdown strings
let _undoIndex = -1; // pointer into _undoStack; -1 = empty
let _previewSyncTimer = null; // debounce handle for DOM → markdown sync


/* ═══════════════════════════════════════════════════════════
   DOM REFERENCES
═══════════════════════════════════════════════════════════ */
const dom = {};

function cacheDom() {
  const ids = [
    'landing', 'app',
    'btn-open-folder', 'btn-open-new', 'btn-toggle-panel',
    'btn-up', 'btn-view-rendered', 'btn-view-code',
    'btn-new-file', 'btn-new-folder', 'btn-duplicate', 'btn-edit-inline',
    'btn-view-split',
    'btn-save', 'btn-export-pdf', 'btn-fullscreen', 'icon-fullscreen',
    'format-toolbar',
    'slash-menu', 'slash-menu-list', 'slash-menu-empty',
    'panel-left', 'resize-handle', 'panel-right', 'content-area', 'preview-toolbar',
    'file-list', 'file-list-empty', 'current-dir-name',
    'breadcrumb',
    'preview-pane', 'preview-empty', 'code-pane', 'code-editor', 'code-highlight', 'line-numbers',
    'file-name-display', 'dirty-indicator',
    'api-unsupported', 'toast-container',
    'delete-modal', 'delete-modal-filename', 'btn-delete-cancel', 'btn-delete-confirm',
    'file-panel-toolbar',
    'btn-help', 'shortcuts-modal', 'btn-shortcuts-close',
    'move-modal', 'move-modal-source', 'move-modal-dest', 'btn-move-cancel', 'btn-move-confirm',
    // Search
    'search-bar', 'search-input', 'btn-search-clear', 'search-results', 'search-status',
    // Match navigator
    'match-nav', 'btn-match-prev', 'btn-match-next', 'btn-match-close',
    'match-nav-label', 'match-nav-query',
  ];
  ids.forEach(id => {
    const key = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    dom[key] = document.getElementById(id);
  });
}


/* ═══════════════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════════════ */
function init() {
  cacheDom();
  loadPreferences();
  _applyOsShortcutLabels();
  _registerMarkedExtensions();

  if (!('showDirectoryPicker' in window)) {
    dom.apiUnsupported.classList.remove('hidden');
    dom.btnOpenFolder.disabled = true;
    dom.btnOpenFolder.title = 'File System Access API not supported in this browser';
  }

  // Initialise Mermaid with Flavida-themed neutral palette
  mermaid.initialize({
    startOnLoad: false,
    theme: 'neutral',
    themeVariables: {
      primaryColor:       '#FFF0E0',
      primaryBorderColor: '#E8391D',
      primaryTextColor:   '#111111',
      lineColor:          '#E8391D',
      secondaryColor:     '#FFF8F0',
      tertiaryColor:      '#FFF8F0',
      edgeLabelBackground:'#FFF8F0',
      fontFamily:         'DM Sans, sans-serif',
    },
    flowchart:  { curve: 'basis' },
    securityLevel: 'loose',
  });

  wireEvents();
  initResizeHandle();
  initInlineEditor();
  initTooltips();
  wireKeyboard();
}

document.addEventListener('DOMContentLoaded', init);


/* ═══════════════════════════════════════════════════════════
   FOLDER PICKER
═══════════════════════════════════════════════════════════ */
async function openFolder() {
  if (!('showDirectoryPicker' in window)) {
    showToast('File System Access API is not supported in this browser. Please use Chrome or Edge 86+.', 'error', 5000);
    return;
  }

  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });

    state.rootDirHandle     = handle;
    state.currentDirHandle  = handle;
    state.dirStack          = [{ handle, name: handle.name }];
    state.currentFileHandle = null;
    state.isDirty           = false;
    state.currentView       = 'rendered'; // always start in rendered view on folder open

    showApp();
    await loadDirectory(handle);

  } catch (err) {
    if (err.name === 'AbortError') return; // user cancelled — silent
    showToast('Could not open folder: ' + err.message, 'error');
  }
}

function showApp() {
  dom.landing.classList.add('hidden');
  dom.app.classList.remove('hidden');
  dom.btnHelp.classList.remove('hidden');
  applyPreferences();
}


/* ═══════════════════════════════════════════════════════════
   DIRECTORY NAVIGATION
═══════════════════════════════════════════════════════════ */
async function loadDirectory(dirHandle) {
  dom.fileList.innerHTML = '';
  dom.fileListEmpty.classList.add('hidden');

  const dirs  = [];
  const files = [];

  try {
    for await (const [name, handle] of dirHandle.entries()) {
      // Skip hidden files/dirs (starting with .)
      if (name.startsWith('.')) continue;

      if (handle.kind === 'directory') {
        dirs.push({ name, handle });
      } else if (name.toLowerCase().endsWith('.md') || name.toLowerCase().endsWith('.markdown')) {
        files.push({ name, handle });
      }
      // All other file types are silently ignored
    }
  } catch (err) {
    showToast('Could not read directory: ' + err.message, 'error');
    return;
  }

  // Sort alphabetically, case-insensitive
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  dirs.sort((a, b) => collator.compare(a.name, b.name));
  files.sort((a, b) => collator.compare(a.name, b.name));

  const allEntries = [...dirs, ...files];

  // Filter out any entry that has a pending delete in this directory —
  // keeps the list consistent even when the user navigates away and back.
  const pendingDeleteName = (_pendingDelete && _pendingDelete.dirHandle === dirHandle)
    ? _pendingDelete.name : null;

  const visibleEntries = pendingDeleteName
    ? allEntries.filter(({ name }) => name !== pendingDeleteName)
    : allEntries;

  if (visibleEntries.length === 0) {
    dom.fileListEmpty.classList.remove('hidden');
  } else {
    const fragment = document.createDocumentFragment();
    visibleEntries.forEach(({ name, handle }) => {
      fragment.appendChild(createFileItem(name, handle));
    });
    dom.fileList.appendChild(fragment);
  }

  dom.currentDirName.textContent = dirHandle.name;
  dom.btnUp.disabled = state.dirStack.length <= 1;
  renderBreadcrumb();
}

function createFileItem(name, handle) {
  const el = document.createElement('button');
  el.className = 'file-item';
  el.dataset.kind = handle.kind;
  el.setAttribute('role', 'listitem');
  el.type = 'button';

  const icon = document.createElement('span');
  icon.className = 'file-item-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = handle.kind === 'directory' ? '📁' : '📄';

  const label = document.createElement('span');
  label.className = 'file-item-label';
  label.textContent = name;
  label.title = name;

  el.append(icon, label);

  // Delete button (files and folders) — visible on hover via CSS
  const delBtn = document.createElement('span');
  delBtn.className = 'file-item-delete';
  delBtn.setAttribute('role', 'button');
  delBtn.setAttribute('aria-label', `Delete ${name}`);
  delBtn.setAttribute('title', handle.kind === 'directory' ? 'Delete folder' : 'Delete file');
  delBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
    <path d="M10 11v6"/><path d="M14 11v6"/>
  </svg>`;
  delBtn.addEventListener('click', e => {
    e.stopPropagation();
    requestDeleteFile(name, handle, el);
  });
  el.appendChild(delBtn);

  // For directories, delay navigation 300 ms so a double-click can cancel it
  // and start a rename instead (otherwise dblclick fires AFTER two navigations).
  let _navTimer = null;

  el.addEventListener('click', () => {
    // Ignore clicks while a rename input is active on this item
    if (el.dataset.renaming) return;
    if (handle.kind === 'directory') {
      clearTimeout(_navTimer);
      _navTimer = setTimeout(() => { enterDirectory(handle, name); }, 300);
    } else {
      openFile(handle, name, el);
    }
  });

  // Double-click → rename (for both files and folders)
  el.addEventListener('dblclick', e => {
    e.stopPropagation();
    clearTimeout(_navTimer); // cancel pending directory navigation
    if (el.dataset.renaming) return;
    startRename(handle, state.currentDirHandle, el, name);
  });

  // ── Drag and drop ───────────────────────────────────────
  el.draggable = true;

  el.addEventListener('dragstart', e => {
    _dragState = { handle, name, kind: handle.kind, srcDirHandle: state.currentDirHandle, listItemEl: el };
    requestAnimationFrame(() => el.classList.add('dragging'));
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', name); // required for Firefox
  });

  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    dom.fileList.querySelectorAll('.drag-over').forEach(t => t.classList.remove('drag-over'));
    _dragState = null;
  });

  // Folder items are drop targets
  if (handle.kind === 'directory') {
    el.addEventListener('dragover', e => {
      if (!_dragState || _dragState.name === name) return; // can't drop onto itself
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', e => {
      if (!el.contains(e.relatedTarget)) el.classList.remove('drag-over');
    });
    el.addEventListener('drop', e => {
      e.preventDefault();
      el.classList.remove('drag-over');
      if (!_dragState || _dragState.name === name) return;
      const ds = _dragState;
      _dragState = null;
      requestMoveEntry(ds, handle, name);
    });
  }

  return el;
}

async function enterDirectory(handle, name) {
  if (await confirmIfDirty()) return;
  state.dirStack.push({ handle, name });
  state.currentDirHandle = handle;
  clearActiveFile();
  await loadDirectory(handle);
}

async function goUp() {
  if (state.dirStack.length <= 1) return;
  if (await confirmIfDirty()) return;

  state.dirStack.pop();
  const { handle } = state.dirStack[state.dirStack.length - 1];
  state.currentDirHandle = handle;
  clearActiveFile();
  await loadDirectory(handle);
}

async function navigateToBreadcrumb(depth) {
  if (depth >= state.dirStack.length - 1) return;
  if (await confirmIfDirty()) return;

  state.dirStack = state.dirStack.slice(0, depth + 1);
  const { handle } = state.dirStack[state.dirStack.length - 1];
  state.currentDirHandle = handle;
  clearActiveFile();
  await loadDirectory(handle);
}

function clearActiveFile() {
  // Exit split view if active — skip re-render since we're clearing the file
  if (state.currentView === 'split') _exitInlineEditMode(false);

  state.currentFileHandle = null;
  state.isDirty = false;
  dom.fileNameDisplay.textContent = 'No file open';
  delete dom.fileNameDisplay.dataset.renameable;
  dom.dirtyIndicator.classList.add('hidden');
  dom.btnSave.classList.add('hidden');
  dom.btnDuplicate.classList.add('hidden');
  dom.btnEditInline.classList.add('hidden');
  dom.btnExportPdf.classList.add('hidden');

  // Reset rendered pane to empty state (not editable when no file open)
  dom.previewPane.contentEditable = 'false';
  dom.previewEmpty.classList.remove('hidden');
  dom.previewPane.innerHTML = '';
  dom.previewPane.appendChild(dom.previewEmpty);

  // Clear code editor content AND the syntax-highlight overlay that renders
  // behind the transparent textarea — without this, the highlight div keeps
  // the previous file's coloured content visible when switching to Code view.
  dom.codeEditor.value = '';
  dom.codeHighlight.innerHTML = '';
  dom.lineNumbers.innerHTML = '';
  dom.lineNumbers._count    = null;
  dom.lineNumbers._activeLine = null;

  // Reset undo history
  _undoStack = [];
  _undoIndex = -1;
  _lastRenderedMarkdown = '';

  // Disable view toggle while nothing is open (re-enabled in openFile)
  dom.btnViewRendered.disabled = true;
  dom.btnViewSplit.disabled    = true;
  dom.btnViewCode.disabled     = true;
}


/* ═══════════════════════════════════════════════════════════
   FILE MANAGEMENT — CREATE / DUPLICATE / RENAME
═══════════════════════════════════════════════════════════ */

// Split "my notes (2).md" → { base: "my notes", ext: ".md" }
function _splitName(fullName) {
  const dot = fullName.lastIndexOf('.');
  if (dot <= 0) return { base: fullName, ext: '' };
  return { base: fullName.slice(0, dot), ext: fullName.slice(dot) };
}

// Return the first unused name: try base+ext, then "base (2)+ext", etc.
async function _getAvailableName(dirHandle, base, ext) {
  const existing = new Set();
  try {
    for await (const [name] of dirHandle.entries()) existing.add(name.toLowerCase());
  } catch (_) {}
  if (!existing.has((base + ext).toLowerCase())) return base + ext;
  let i = 2;
  while (existing.has(`${base} (${i})${ext}`.toLowerCase())) i++;
  return `${base} (${i})${ext}`;
}

async function createNewFile() {
  if (!state.currentDirHandle) return;
  const name = await _getAvailableName(state.currentDirHandle, 'untitled', '.md');
  try {
    const handle = await state.currentDirHandle.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write('');
    await writable.close();

    await loadDirectory(state.currentDirHandle);

    // Find and activate the new item, then start rename immediately
    const item = [...dom.fileList.querySelectorAll('.file-item')]
      .find(el => el.querySelector('.file-item-label')?.textContent === name);
    if (item) {
      // Mark active + update state so toolbar rename works
      dom.fileList.querySelectorAll('.file-item').forEach(e => e.classList.remove('active'));
      item.classList.add('active');
      state.currentFileHandle = handle;
      state.isDirty = false;
      dom.fileNameDisplay.textContent = name;
      dom.fileNameDisplay.dataset.renameable = '1';
      dom.dirtyIndicator.classList.add('hidden');
      dom.btnSave.classList.add('hidden');
      dom.btnDuplicate.classList.remove('hidden');
      dom.btnExportPdf.classList.remove('hidden');
      dom.btnViewRendered.disabled = false;
      dom.btnViewSplit.disabled    = false;
      dom.btnViewCode.disabled     = false;
      dom.btnEditInline.classList.remove('hidden');
      dom.codeEditor.value = '';
      _undoStack = [''];
      _undoIndex = 0;
      await renderMarkdown('');
      setView('rendered', false); // stay in rendered view; don't persist
      updateLineNumbers();
      updateCodeHighlight();
      // Preview pane is now contenteditable — focus it so user can start typing immediately
      dom.previewPane.focus();
    }
  } catch (err) {
    showToast('Could not create file: ' + err.message, 'error');
  }
}

async function createNewFolder() {
  if (!state.currentDirHandle) return;
  const name = await _getAvailableName(state.currentDirHandle, 'untitled folder', '');
  try {
    const handle = await state.currentDirHandle.getDirectoryHandle(name, { create: true });

    await loadDirectory(state.currentDirHandle);

    // Find the new folder item and immediately start rename
    const item = [...dom.fileList.querySelectorAll('.file-item')]
      .find(el => el.dataset.kind === 'directory' && el.querySelector('.file-item-label')?.textContent === name);
    if (item) {
      startRename(handle, state.currentDirHandle, item, name);
    }
  } catch (err) {
    showToast('Could not create folder: ' + err.message, 'error');
  }
}

async function duplicateFile() {
  if (!state.currentFileHandle || !state.currentDirHandle) return;
  const origName = dom.fileNameDisplay.textContent;
  const { base, ext } = _splitName(origName);
  // Strip any existing counter before generating the new name
  const cleanBase = base.replace(/ \(\d+\)$/, '');
  const newName = await _getAvailableName(state.currentDirHandle, cleanBase, ext);

  try {
    const content = dom.codeEditor.value; // use live editor content
    const handle  = await state.currentDirHandle.getFileHandle(newName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();

    showToast(`Duplicated as "${newName}"`, 'success');
    await loadDirectory(state.currentDirHandle);

    const item = [...dom.fileList.querySelectorAll('.file-item')]
      .find(el => el.querySelector('.file-item-label')?.textContent === newName);
    if (item) {
      await openFile(handle, newName, item);
      setView('code', false); // duplicated file → start in code view without persisting
    }
  } catch (err) {
    showToast('Could not duplicate: ' + err.message, 'error');
  }
}

// ── Inline rename ─────────────────────────────────────────

// Start inline rename on a left-panel file item.
function startRename(handle, dirHandle, listItemEl, currentName) {
  // Don't start a second rename if one is already in progress
  if (listItemEl.dataset.renaming) return;
  // For directories, use the full name as base (no extension splitting)
  const { base, ext } = handle.kind === 'directory'
    ? { base: currentName, ext: '' }
    : _splitName(currentName);
  const label = listItemEl.querySelector('.file-item-label');
  if (!label) return;

  // Mark the item as renaming so click/dblclick handlers are blocked
  listItemEl.dataset.renaming = '1';

  let committed = false;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'file-item-rename';
  input.value = base;
  label.replaceWith(input);
  input.focus();
  input.select();

  // Prevent mouse and keyboard events from bubbling to the parent <button>,
  // which would otherwise trigger navigation or re-open the file.
  input.addEventListener('click',     e => e.stopPropagation());
  input.addEventListener('mousedown', e => e.stopPropagation());
  input.addEventListener('keyup',     e => e.stopPropagation());

  const cleanup = () => {
    delete listItemEl.dataset.renaming;
  };

  const commit = async () => {
    if (committed) return;
    committed = true;
    cleanup();
    const newBase = input.value.trim();
    const newName = (newBase || base) + ext;
    input.replaceWith(label);
    label.textContent = currentName; // restore temporarily; _commitRename reloads
    if (newName !== currentName) {
      await _commitRename(handle, dirHandle, currentName, newName);
    }
  };
  const cancel = () => {
    if (committed) return;
    committed = true;
    cleanup();
    input.replaceWith(label);
    label.textContent = currentName;
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    e.stopPropagation(); // block app shortcuts while typing
  });
  input.addEventListener('blur', commit);
}

// Start inline rename from the toolbar filename.
function startToolbarRename() {
  if (!state.currentFileHandle || !state.currentDirHandle) return;
  const currentName = dom.fileNameDisplay.textContent;
  if (!currentName || currentName === 'No file open') return;
  // Don't start if already renaming
  if (dom.fileNameDisplay.parentElement.querySelector('.file-name-rename')) return;

  const { base, ext } = _splitName(currentName);
  let committed = false;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'file-name-rename';
  input.value = base;
  dom.fileNameDisplay.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    if (committed) return;
    committed = true;
    const newBase = input.value.trim();
    const newName = (newBase || base) + ext;
    input.replaceWith(dom.fileNameDisplay);
    dom.fileNameDisplay.textContent = currentName; // restore temporarily
    if (newName !== currentName) {
      await _commitRename(state.currentFileHandle, state.currentDirHandle, currentName, newName);
    }
  };
  const cancel = () => {
    if (committed) return;
    committed = true;
    input.replaceWith(dom.fileNameDisplay);
    dom.fileNameDisplay.textContent = currentName;
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    e.stopPropagation();
  });
  input.addEventListener('blur', commit);
}

// Rename a file or folder: copy to new name, remove old.
async function _commitRename(handle, dirHandle, oldName, newName) {
  if (!newName || /[/\\]/.test(newName)) {
    showToast('Invalid name', 'error');
    await loadDirectory(dirHandle);
    return;
  }
  if (newName === oldName) return;

  // Check for collision (entry with newName already exists)
  try {
    if (handle.kind === 'file') await dirHandle.getFileHandle(newName);
    else await dirHandle.getDirectoryHandle(newName);
    showToast(`"${newName}" already exists`, 'warning');
    await loadDirectory(dirHandle);
    return;
  } catch (_) { /* name is available */ }

  try {
    if (handle.kind === 'file') {
      // Use live editor content if this is the currently open file
      const isOpen = state.currentFileHandle === handle;
      const content = isOpen
        ? dom.codeEditor.value
        : await (await handle.getFile()).text();

      const newHandle = await dirHandle.getFileHandle(newName, { create: true });
      const writable  = await newHandle.createWritable();
      await writable.write(content);
      await writable.close();
      await dirHandle.removeEntry(oldName);

      if (isOpen) {
        state.currentFileHandle = newHandle;
        dom.fileNameDisplay.textContent = newName;
      }
    } else {
      // Directory rename: deep-copy under new name, then remove old
      await _copyDirRecursive(handle, newName, dirHandle);
      await dirHandle.removeEntry(oldName, { recursive: true });

      // If this directory (or a descendant) is in the navigation stack,
      // truncate the stack to just before it so navigation resets cleanly
      const stackIdx = state.dirStack.findIndex(e => e.handle === handle);
      if (stackIdx !== -1) {
        state.dirStack = state.dirStack.slice(0, stackIdx);
        state.currentDirHandle = state.dirStack[state.dirStack.length - 1].handle;
        clearActiveFile();
      }
    }

    showToast(`Renamed to "${newName}"`, 'success');
    await loadDirectory(dirHandle);

    // Re-mark the renamed file item as active (files only)
    if (handle.kind === 'file') {
      const item = [...dom.fileList.querySelectorAll('.file-item')]
        .find(el => el.querySelector('.file-item-label')?.textContent === newName);
      if (item) item.classList.add('active');
    }

  } catch (err) {
    showToast('Rename failed: ' + err.message, 'error');
    await loadDirectory(dirHandle);
  }
}


/* ═══════════════════════════════════════════════════════════
   FILE DELETION — confirm modal + undo toast
═══════════════════════════════════════════════════════════ */

function requestDeleteFile(name, handle, listItemEl) {
  // If another pending delete exists, execute it immediately first
  if (_pendingDelete) _executePendingDelete();

  _pendingDelete = { name, handle, kind: handle.kind, dirHandle: state.currentDirHandle, listItemEl, timer: null };

  // Update modal title and description based on kind
  const isDir = handle.kind === 'directory';
  document.getElementById('delete-modal-title').textContent = isDir ? 'Delete folder?' : 'Delete file?';
  const suffixEl = document.getElementById('delete-modal-suffix');
  if (suffixEl) suffixEl.textContent = isDir ? ' and all its contents will be permanently deleted.' : ' will be permanently deleted.';

  dom.deleteModalFilename.textContent = name;
  dom.deleteModal.classList.remove('hidden');
  // Focus the cancel button by default (safer)
  requestAnimationFrame(() => dom.btnDeleteCancel.focus());
}

function _closeDeleteModal() {
  dom.deleteModal.classList.add('hidden');
}

function openHelp() {
  dom.shortcutsModal.classList.remove('hidden');
  requestAnimationFrame(() => dom.btnShortcutsClose.focus());
}

function closeHelp() {
  dom.shortcutsModal.classList.add('hidden');
}

function _startSoftDelete() {
  _closeDeleteModal();
  const { name, dirHandle, listItemEl } = _pendingDelete;

  // Hide from the current DOM view immediately
  listItemEl.style.display = 'none';

  // Show undo toast with 3 s countdown
  const DELAY = 3000;
  showUndoToast(`"${name}" deleted`, DELAY, () => {
    // UNDO pressed — clear the pending delete and reload to restore the item
    _pendingDelete = null;
    if (state.currentDirHandle === dirHandle) {
      loadDirectory(dirHandle); // fire-and-forget: shows the item again
    }
  });

  // Schedule actual deletion
  _pendingDelete.timer = setTimeout(async () => {
    if (!_pendingDelete) return; // already undone
    await _executePendingDelete();
  }, DELAY);
}

async function _executePendingDelete() {
  if (!_pendingDelete) return;
  const { name, handle, kind, dirHandle, listItemEl } = _pendingDelete;
  _pendingDelete = null;

  // listItemEl.style.display is 'none' when the item is hidden (not undone).
  // It may be a detached element if the user navigated away, but its style is
  // still 'none' — that's how we know the undo window expired without undo.
  if (listItemEl.style.display === 'none') {
    try {
      await dirHandle.removeEntry(name, { recursive: kind === 'directory' });
    } catch (err) {
      listItemEl.style.display = '';
      showToast(`Could not delete "${name}": ${err.message}`, 'error');
      return;
    }

    // Clear the preview only if the deleted file is still the active one
    if (state.currentFileHandle === handle) {
      clearActiveFile();
    }

    // Reload the directory to remove any stale DOM nodes
    // (covers navigate-away-and-back case; no-op if user is elsewhere)
    if (state.currentDirHandle === dirHandle) {
      await loadDirectory(dirHandle);
    }
  }
}

/* ═══════════════════════════════════════════════════════════
   DRAG-AND-DROP MOVE — confirm modal + undo toast
═══════════════════════════════════════════════════════════ */

function requestMoveEntry(dragInfo, destDirHandle, destDirName) {
  _pendingMove = {
    handle:       dragInfo.handle,
    name:         dragInfo.name,
    kind:         dragInfo.kind,
    srcDirHandle: dragInfo.srcDirHandle,
    destDirHandle,
    destDirName,
    listItemEl:   dragInfo.listItemEl,
  };

  dom.moveModalSource.textContent = dragInfo.name;
  dom.moveModalDest.textContent   = destDirName;
  dom.moveModal.classList.remove('hidden');
  requestAnimationFrame(() => dom.btnMoveCancel.focus());
}

function _closeMoveModal() {
  dom.moveModal.classList.add('hidden');
}

async function _startSoftMove() {
  _closeMoveModal();
  if (!_pendingMove) return;
  await _executePendingMove();
}

async function _executePendingMove() {
  if (!_pendingMove) return;
  const { handle, name, kind, srcDirHandle, destDirHandle, destDirName, listItemEl } = _pendingMove;
  _pendingMove = null;

  try {
    // Check for name collision at destination
    try {
      if (kind === 'file') await destDirHandle.getFileHandle(name);
      else                 await destDirHandle.getDirectoryHandle(name);
      // Name exists — abort with a clear message so user knows to rename first
      showToast(`Can't move: "${destDirName}" already contains an item named "${name}". Rename one of them first.`, 'warning', 5000);
      return;
    } catch (_) { /* name is free — proceed */ }

    if (kind === 'file') {
      const content   = await (await handle.getFile()).arrayBuffer();
      const newHandle = await destDirHandle.getFileHandle(name, { create: true });
      const writable  = await newHandle.createWritable();
      await writable.write(content);
      await writable.close();
      await srcDirHandle.removeEntry(name);
    } else {
      await _copyDirRecursive(handle, name, destDirHandle);
      await srcDirHandle.removeEntry(name, { recursive: true });
    }

    listItemEl.remove();
    if (dom.fileList.querySelectorAll('.file-item').length === 0) {
      dom.fileListEmpty.classList.remove('hidden');
    }
    if (state.currentFileHandle === handle) {
      clearActiveFile();
    }
    showToast(`"${name}" moved to "${destDirName}"`, 'success');

  } catch (err) {
    listItemEl.style.opacity = ''; listItemEl.style.pointerEvents = ''; listItemEl.draggable = true;
    showToast(`Could not move "${name}": ${err.message}`, 'error');
  }
}

// Recursively copy all contents of srcDirHandle into a new sub-folder under destParentHandle.
async function _copyDirRecursive(srcDirHandle, name, destParentHandle) {
  const newDir = await destParentHandle.getDirectoryHandle(name, { create: true });
  for await (const [entryName, entryHandle] of srcDirHandle.entries()) {
    if (entryHandle.kind === 'file') {
      const content = await (await entryHandle.getFile()).arrayBuffer();
      const fh = await newDir.getFileHandle(entryName, { create: true });
      const wr = await fh.createWritable();
      await wr.write(content);
      await wr.close();
    } else {
      await _copyDirRecursive(entryHandle, entryName, newDir);
    }
  }
}


function showUndoToast(message, delay, onUndo) {
  const toast = document.createElement('div');
  toast.className = 'toast warning';
  toast.setAttribute('role', 'status');

  const row = document.createElement('div');
  row.className = 'toast-undo-row';

  const text = document.createElement('span');
  text.textContent = message;

  const undoBtn = document.createElement('button');
  undoBtn.className = 'toast-undo-btn';
  // Show the keyboard shortcut hint inside the button label
  const isMac = /Mac|iPhone|iPad/i.test(navigator.userAgent);
  const kbdShortcut = isMac ? '⌘Z' : 'Ctrl+Z';
  const undoKbd = document.createElement('kbd');
  undoKbd.className = 'toast-kbd';
  undoKbd.textContent = kbdShortcut;
  undoBtn.append('Undo ', undoKbd);
  undoBtn.addEventListener('click', () => {
    // Clear the pending delete timer
    clearTimeout(_pendingDelete?.timer);
    onUndo();
    hide();
  });

  row.append(text, undoBtn);

  const progress = document.createElement('div');
  progress.className = 'toast-progress';
  progress.style.animationDuration = delay + 'ms';

  toast.append(row, progress);
  dom.toastContainer.appendChild(toast);

  toast.getBoundingClientRect(); // force reflow
  toast.classList.add('show');

  const hide = () => {
    toast.classList.remove('show');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  };

  setTimeout(hide, delay + 300);
}


/* ═══════════════════════════════════════════════════════════
   FILE LOADING & RENDERING
═══════════════════════════════════════════════════════════ */
async function openFile(handle, name, listItemEl) {
  if (await confirmIfDirty()) return;

  // Update active state in file list
  dom.fileList.querySelectorAll('.file-item').forEach(el => el.classList.remove('active'));
  listItemEl.classList.add('active');

  try {
    const file    = await handle.getFile();
    const content = await file.text();

    state.currentFileHandle = handle;
    state.isDirty = false;

    dom.fileNameDisplay.textContent = name;
    dom.fileNameDisplay.dataset.renameable = '1';
    dom.dirtyIndicator.classList.add('hidden');
    dom.btnSave.classList.add('hidden');
    dom.btnDuplicate.classList.remove('hidden');
    dom.btnExportPdf.classList.remove('hidden');
    dom.btnViewRendered.disabled = false;
    dom.btnViewSplit.disabled    = false;
    dom.btnViewCode.disabled     = false;
    dom.btnEditInline.classList.remove('hidden');
    dom.codeEditor.value = content;
    dom.lineNumbers._count = null; // force rebuild on next updateLineNumbers()

    // Seed the undo stack with the file's initial content
    _undoStack = [content];
    _undoIndex = 0;

    await renderMarkdown(content);
    setView('rendered'); // always open existing files in rendered view
    updateLineNumbers();
    updateCodeHighlight();

  } catch (err) {
    showToast('Could not read file: ' + err.message, 'error');
  }
}

async function renderMarkdown(content, { preserveScroll = false } = {}) {
  marked.setOptions({
    breaks: true,
    gfm: true,
  });

  let rawHtml;
  try {
    rawHtml = marked.parse(content);
  } catch (e) {
    rawHtml = '<p style="color:var(--color-flame)">Error parsing Markdown: ' + escapeHtml(e.message) + '</p>';
  }

  // DOMPurify: allow class attrs (highlight.js) and the extra tags from our marked extensions
  const safeHtml = DOMPurify.sanitize(rawHtml, {
    ADD_ATTR:  ['class'],
    ADD_TAGS:  ['mark', 'sup', 'sub'],
    ALLOW_DATA_ATTR: false,
  });

  dom.previewPane.innerHTML = safeHtml;

  // Syntax highlight non-mermaid code blocks and stamp language label on <pre>
  dom.previewPane.querySelectorAll('pre code').forEach(block => {
    if (block.classList.contains('language-mermaid')) return; // handled below
    try { hljs.highlightElement(block); } catch (_) {}
    const lang = [...block.classList]
      .find(c => c.startsWith('language-'))
      ?.replace('language-', '') ?? 'code';
    block.closest('pre').dataset.lang = lang;
  });

  // Render Mermaid diagrams (store original source for domToMarkdown round-trip)
  await renderMermaidBlocks();

  // Stamp each block with its source line so scroll sync can find it
  annotateRenderedBlocks(content);

  // Apply contenteditable state and mark non-editable islands (code blocks, mermaid)
  _setupEditablePane();

  // Track the last markdown that was actually rendered (used by _onPreviewInput to
  // skip pointless re-renders when content didn't meaningfully change, e.g. after Enter)
  _lastRenderedMarkdown = content;

  if (!preserveScroll) dom.previewPane.scrollTop = 0;
}

async function renderMermaidBlocks() {
  const blocks = dom.previewPane.querySelectorAll('pre code.language-mermaid');
  let idx = 0;
  for (const block of blocks) {
    const definition = block.textContent.trim();
    const pre = block.closest('pre');
    try {
      const id = 'mermaid-' + Date.now() + '-' + (idx++);
      const { svg } = await mermaid.render(id, definition);
      const wrapper = document.createElement('div');
      wrapper.className = 'mermaid-diagram';
      wrapper.innerHTML = svg;
      wrapper.dataset.mermaidSource = definition; // stored for domToMarkdown round-trip
      pre.replaceWith(wrapper);
    } catch (err) {
      const errDiv = document.createElement('div');
      errDiv.className = 'mermaid-error';
      errDiv.textContent = 'Mermaid diagram error: ' + (err.message || err);
      pre.replaceWith(errDiv);
    }
  }
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}


/* ═══════════════════════════════════════════════════════════
   MARKDOWN SYNTAX HIGHLIGHTING (code editor overlay)
═══════════════════════════════════════════════════════════ */

// Highlight inline markdown patterns within a single already-HTML-escaped line.
function applyInlineSyntax(s) {
  // 1. Inline code — process first so backtick content is protected
  s = s.replace(/`([^`\n]+)`/g, (_, c) =>
    `<span class="sy-code-tick">\`</span><span class="sy-code">${c}</span><span class="sy-code-tick">\`</span>`
  );
  // 2. Links [text](url)
  s = s.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (_, t, u) =>
    `<span class="sy-mark">[</span><span class="sy-link-text">${t}</span><span class="sy-mark">](</span><span class="sy-link-url">${u}</span><span class="sy-mark">)</span>`
  );
  // 3. Bold **text** or __text__
  s = s.replace(/(\*\*|__)([^*_\n]+?)\1/g, (_, m, t) =>
    `<span class="sy-mark">${m}</span><span class="sy-bold">${t}</span><span class="sy-mark">${m}</span>`
  );
  // 4. Italic *text* (not **)
  s = s.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, (_, t) =>
    `<span class="sy-mark">*</span><span class="sy-italic">${t}</span><span class="sy-mark">*</span>`
  );
  return s;
}

// Convert raw markdown source into syntax-coloured HTML for the overlay.
function applyMarkdownSyntax(text) {
  const lines = text.split('\n');
  let inFence = false;
  const out = [];

  for (const line of lines) {
    // HTML-escape the line first so angle brackets etc. are safe
    let s = line
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // ── Fenced code block toggle (``` or ~~~) ──
    if (/^(`{3,}|~{3,})/.test(s)) {
      inFence = !inFence;
      out.push(`<span class="sy-fence">${s}</span>`);
      continue;
    }
    if (inFence) {
      out.push(`<span class="sy-fence-body">${s}</span>`);
      continue;
    }

    // ── Headings ──
    const hm = s.match(/^(#{1,6})([ \t].+)?$/);
    if (hm) {
      const cls = `sy-h${hm[1].length}`;
      const body = hm[2] ? applyInlineSyntax(hm[2]) : '';
      out.push(`<span class="${cls}"><span class="sy-hmark">${hm[1]}</span>${body}</span>`);
      continue;
    }

    // ── Horizontal rule ──
    if (/^([-*_][ \t]*){3,}$/.test(s.trim())) {
      out.push(`<span class="sy-hr">${s}</span>`);
      continue;
    }

    // ── Blockquote ──
    if (s.startsWith('&gt;')) {
      // &gt; is 4 chars; keep it coloured, apply inline to the rest
      out.push(`<span class="sy-bq">&gt;</span>${applyInlineSyntax(s.slice(4))}`);
      continue;
    }

    // ── List items (- * + and 1. 2.) ──
    const lm = s.match(/^(\s*)([-*+]|\d+[.)]) (.*)/);
    if (lm) {
      out.push(`${lm[1]}<span class="sy-list">${lm[2]}</span> ${applyInlineSyntax(lm[3])}`);
      continue;
    }

    // ── Plain text / paragraph ──
    out.push(applyInlineSyntax(s));
  }

  return out.join('\n');
}

function syncHighlightScroll() {
  dom.codeHighlight.scrollTop  = dom.codeEditor.scrollTop;
  dom.codeHighlight.scrollLeft = dom.codeEditor.scrollLeft;
}

function updateCodeHighlight() {
  dom.codeHighlight.innerHTML = applyMarkdownSyntax(dom.codeEditor.value);
  syncHighlightScroll();
}


/* ═══════════════════════════════════════════════════════════
   SCROLL SYNC & LINE ANNOTATION
═══════════════════════════════════════════════════════════ */

// Stamp each top-level rendered block with its source line number.
// Uses marked's own lexer so the token order is guaranteed to match
// the rendered element order.
function annotateRenderedBlocks(source) {
  let tokens;
  try { tokens = marked.lexer(source); } catch (_) { return; }

  const lineNums = [];
  let line = 1;
  for (const token of tokens) {
    const newlines = (token.raw.match(/\n/g) || []).length;
    // 'space' and 'def' tokens don't produce a rendered element
    if (token.type !== 'space' && token.type !== 'def') {
      lineNums.push(line);
    }
    line += newlines;
  }

  // Direct children of previewPane (skip the empty-state placeholder)
  const blocks = [...dom.previewPane.children].filter(el => el.id !== 'preview-empty');
  blocks.forEach((el, i) => {
    if (lineNums[i] !== undefined) el.dataset.sourceLine = lineNums[i];
  });
}

// Returns the source line that is at (or just above) the top of the rendered pane.
function getRenderedScrollLine() {
  const pane = dom.previewPane;
  const paneTop = pane.getBoundingClientRect().top;
  const blocks = pane.querySelectorAll('[data-source-line]');
  let best = 1;
  for (const block of blocks) {
    const relTop = block.getBoundingClientRect().top - paneTop;
    if (relTop <= 24) {          // 24 px tolerance (header + padding)
      best = parseInt(block.dataset.sourceLine, 10);
    } else {
      break;
    }
  }
  return best;
}

// Returns the source line visible at the top of the code editor.
function getCodeScrollLine() {
  const lh = parseFloat(getComputedStyle(dom.codeEditor).lineHeight);
  const pt = parseFloat(getComputedStyle(dom.codeEditor).paddingTop);
  return Math.max(1, Math.floor((dom.codeEditor.scrollTop - pt) / lh) + 1);
}

// Scrolls the code editor so that `lineNum` is near the top.
function scrollCodeToLine(lineNum) {
  const lh = parseFloat(getComputedStyle(dom.codeEditor).lineHeight);
  const pt = parseFloat(getComputedStyle(dom.codeEditor).paddingTop);
  dom.codeEditor.scrollTop = pt + (lineNum - 1) * lh;
}

// Scrolls the rendered pane to bring the block closest to `lineNum` into view.
function scrollPreviewToLine(lineNum) {
  const pane = dom.previewPane;
  const blocks = [...pane.querySelectorAll('[data-source-line]')];
  if (!blocks.length) return;

  // Find the last block whose source line is ≤ lineNum
  let target = blocks[0];
  for (const block of blocks) {
    if (parseInt(block.dataset.sourceLine, 10) <= lineNum) target = block;
    else break;
  }

  const paneRect  = pane.getBoundingClientRect();
  const blockTop  = target.getBoundingClientRect().top - paneRect.top + pane.scrollTop;
  pane.scrollTop  = Math.max(0, blockTop - 20);
}

/* ───────────────────────────────────────────────────────────
   LINE NUMBERS
─────────────────────────────────────────────────────────── */
function updateLineNumbers() {
  const content   = dom.codeEditor.value;
  const lineCount = content ? content.split('\n').length : 1;

  // Highlight the line the cursor is on
  const cursorLine = content
    ? content.substring(0, dom.codeEditor.selectionStart).split('\n').length
    : 1;

  // Only rebuild DOM when line count changes (avoids jitter while typing)
  if (dom.lineNumbers._count !== lineCount) {
    let html = '';
    for (let i = 1; i <= lineCount; i++) html += `<span>${i}</span>`;
    dom.lineNumbers.innerHTML = html;
    dom.lineNumbers._count = lineCount;
  }

  // Update current-line highlight
  const spans = dom.lineNumbers.children;
  if (dom.lineNumbers._activeLine !== cursorLine) {
    if (dom.lineNumbers._activeLine) {
      const prev = spans[dom.lineNumbers._activeLine - 1];
      if (prev) prev.classList.remove('current-line');
    }
    const curr = spans[cursorLine - 1];
    if (curr) curr.classList.add('current-line');
    dom.lineNumbers._activeLine = cursorLine;
  }

  // Keep gutter scroll in sync with the editor
  dom.lineNumbers.scrollTop = dom.codeEditor.scrollTop;
}


/* ═══════════════════════════════════════════════════════════
   VIEW TOGGLE
═══════════════════════════════════════════════════════════ */
function setView(view, save = true) {
  const prev = state.currentView;

  // Pending contenteditable edits must land before anything reads codeEditor.value
  _flushPreviewSync();

  // Nothing to do if already in this exact view
  if (view === prev && state.currentFileHandle) {
    if (view === 'code') updateLineNumbers();
    return;
  }

  // Capture scroll position from the currently visible pane before switching
  const syncLine = state.currentFileHandle
    ? (prev === 'rendered' || prev === 'split' ? getRenderedScrollLine() : getCodeScrollLine())
    : 1;

  // ── Tear down split-view state when leaving it ──────────────────────────
  if (prev === 'split') {
    state.isInlineEditing = false;
    clearTimeout(_liveRenderTimer);
    dom.contentArea.classList.remove('live-edit-mode');
    dom.btnEditInline.classList.remove('edit-active');
    // codePane / previewPane visibility is set correctly below
  }

  state.currentView = view;

  const isRendered = view === 'rendered';
  const isSplit    = view === 'split';
  const isCode     = view === 'code';

  // ── Pane visibility ─────────────────────────────────────────────────────
  if (isSplit) {
    dom.previewPane.classList.remove('hidden');
    dom.codePane.classList.remove('hidden');
  } else {
    dom.previewPane.classList.toggle('hidden', !isRendered);
    dom.codePane.classList.toggle('hidden',    !isCode);
  }

  // ── Toggle button active state ───────────────────────────────────────────
  dom.btnViewRendered.classList.toggle('active', isRendered);
  dom.btnViewSplit.classList.toggle('active',    isSplit);
  dom.btnViewCode.classList.toggle('active',     isCode);

  // ── ContentEditable (preview is editable in rendered + split) ───────────
  if (state.currentFileHandle) {
    dom.previewPane.contentEditable = (isRendered || isSplit) ? 'true' : 'false';
  }

  // ── Enter split-view ─────────────────────────────────────────────────────
  if (isSplit) {
    state.isInlineEditing = true;
    if (_liveEditCodeW) dom.contentArea.style.setProperty('--live-code-w', _liveEditCodeW + 'px');
    dom.contentArea.classList.add('live-edit-mode');
    dom.btnEditInline.classList.add('edit-active');

    // Create the drag divider once
    if (!_liveEditDivider) {
      _liveEditDivider = document.createElement('div');
      _liveEditDivider.className = 'live-edit-divider';
      dom.previewPane.insertAdjacentElement('afterend', _liveEditDivider);
      _initLiveEditResize();
    }

    if (state.currentFileHandle) {
      updateLineNumbers();
      updateCodeHighlight(); // was skipped while the code pane was hidden
      // Re-render so the preview is fresh after any code-view edits
      if (prev === 'code') {
        renderMarkdown(dom.codeEditor.value);
      }
      // Deliberately no focus() call: stealing focus into the code editor
      // collapsed any selection in the rendered pane and dismissed the
      // format toolbar the moment split view opened.
    }
    if (save) savePreferences();
    return;
  }

  // ── Content sync for rendered / code ────────────────────────────────────
  if (state.currentFileHandle) {
    if (isRendered) {
      renderMarkdown(dom.codeEditor.value).then(() => scrollPreviewToLine(syncLine));
    } else {
      updateLineNumbers();
      updateCodeHighlight(); // was skipped while the code pane was hidden
      requestAnimationFrame(() => scrollCodeToLine(syncLine));
    }
  }

  if (save) savePreferences();
}


/* ═══════════════════════════════════════════════════════════
   EDITOR & SAVE
═══════════════════════════════════════════════════════════ */

function _markDirty() {
  if (!state.isDirty) {
    state.isDirty = true;
    dom.dirtyIndicator.classList.remove('hidden');
    dom.btnSave.classList.remove('hidden');
  }
}

function onEditorInput() {
  if (!state.currentFileHandle) return;
  _markDirty();
  updateLineNumbers();
  updateCodeHighlight();

  // Live preview: re-render markdown while the split-view edit mode is active
  if (state.currentView === 'split') {
    clearTimeout(_liveRenderTimer);
    _liveRenderTimer = setTimeout(() => {
      renderMarkdown(dom.codeEditor.value);
    }, 250);
  }
}

// Export the current file as a PDF via the browser's native print-to-PDF.
// Reuses the exact same preview-pane DOM + CSS the user sees, so the
// output matches the viewer's theme/styles exactly (see @media print in style.css).
async function exportToPDF() {
  if (!state.currentFileHandle) return;
  _flushPreviewSync();

  // preview-pane only re-renders live in 'rendered'/'split' views; in 'code'
  // view it can be stale, so refresh it from the editor before printing.
  if (state.currentView === 'code') {
    await renderMarkdown(dom.codeEditor.value, { preserveScroll: true });
  }

  const baseName = state.currentFileHandle.name.replace(/\.md$/i, '');
  const originalTitle = document.title;
  document.title = baseName; // browsers suggest document.title as the PDF filename

  const restoreTitle = () => {
    document.title = originalTitle;
    window.removeEventListener('afterprint', restoreTitle);
  };
  window.addEventListener('afterprint', restoreTitle);

  window.print();
}

async function saveFile() {
  if (!state.currentFileHandle) return;
  _flushPreviewSync(); // land any debounced contenteditable edits before writing
  if (!state.isDirty) {
    showToast('No unsaved changes', 'info', 2000);
    return;
  }

  const content = dom.codeEditor.value;

  try {
    // createWritable() triggers the browser write-permission prompt if needed
    const writable = await state.currentFileHandle.createWritable();
    await writable.write(content);
    await writable.close();

    state.isDirty = false;
    dom.dirtyIndicator.classList.add('hidden');
    dom.btnSave.classList.add('hidden');

    if (state.currentView === 'rendered') {
      await renderMarkdown(content);
    }

    showToast('File saved', 'success');

  } catch (err) {
    if (err.name === 'AbortError') {
      showToast('Save cancelled — write permission was denied', 'warning');
      return;
    }
    showToast('Save failed: ' + err.message, 'error');
  }
}

async function confirmIfDirty() {
  if (!state.isDirty) return false;
  const ok = window.confirm('You have unsaved changes. Continue without saving?');
  return !ok; // return true = cancel navigation
}


/* ═══════════════════════════════════════════════════════════
   PANEL UI — COLLAPSE, FULLSCREEN, RESIZE
═══════════════════════════════════════════════════════════ */
function setPanelWidth(outerW, innerW) {
  dom.panelLeft.style.width = outerW + 'px';
  dom.panelLeft.querySelector('.panel-left-inner').style.width = innerW + 'px';
}

function togglePanel() {
  state.isPanelCollapsed = !state.isPanelCollapsed;
  dom.panelLeft.classList.toggle('collapsed', state.isPanelCollapsed);
  // Must set inline width — inline styles beat class rules, so the class alone won't shrink
  // a panel that already has an inline width set by applyPreferences() or the resize handler.
  setPanelWidth(state.isPanelCollapsed ? 0 : state.panelWidth, state.panelWidth);
  savePreferences();
}

function toggleFullscreen() {
  state.isFullscreen = !state.isFullscreen;
  dom.panelRight.classList.toggle('fullscreen', state.isFullscreen);

  // Swap icon between expand and compress
  const expand = `<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>`;
  const compress = `<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/>`;

  dom.iconFullscreen.innerHTML = state.isFullscreen ? compress : expand;
  dom.btnFullscreen.title = state.isFullscreen
    ? 'Exit fullscreen (Esc)'
    : 'Toggle fullscreen (F11)';
}

function initResizeHandle() {
  const handle = dom.resizeHandle;
  let startX, startWidth;

  handle.addEventListener('mousedown', e => {
    if (state.isPanelCollapsed) return;
    state.isResizing = true;
    startX = e.clientX;
    startWidth = dom.panelLeft.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!state.isResizing) return;
    const MIN = 180, MAX = 500;
    const newW = Math.min(MAX, Math.max(MIN, startWidth + (e.clientX - startX)));
    state.panelWidth = newW;
    setPanelWidth(newW, newW);
  });

  document.addEventListener('mouseup', () => {
    if (!state.isResizing) return;
    state.isResizing = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    savePreferences();
  });
}


/* ═══════════════════════════════════════════════════════════
   SEARCH
═══════════════════════════════════════════════════════════ */
let _searchTimer = null;

function onSearchInput() {
  const q = dom.searchInput.value.trim();
  dom.btnSearchClear.classList.toggle('hidden', q.length === 0);

  clearTimeout(_searchTimer);

  if (!q) {
    exitSearch();
    return;
  }

  // Show "Searching…" immediately so the user gets instant feedback
  dom.fileList.classList.add('hidden');
  dom.fileListEmpty.classList.add('hidden');
  dom.searchResults.classList.remove('hidden');
  dom.searchStatus.textContent = 'Searching…';
  dom.searchStatus.className = 'search-status searching';
  // Clear stale result cards
  [...dom.searchResults.children]
    .filter(el => el !== dom.searchStatus)
    .forEach(el => el.remove());

  _searchTimer = setTimeout(() => performSearch(q), 280);
}

async function performSearch(query) {
  if (!state.rootDirHandle) return;

  const gen = ++state.searchGenId;
  state.searchActive = true;
  state.searchQuery = query;

  const results = await _searchDir(query.toLowerCase(), state.rootDirHandle, '', gen);
  if (state.searchGenId !== gen) return; // a newer search superseded this one

  // Remove stale cards before rendering new ones
  [...dom.searchResults.children]
    .filter(el => el !== dom.searchStatus)
    .forEach(el => el.remove());

  if (results.length === 0) {
    dom.searchStatus.textContent = `No results for "${query}"`;
    dom.searchStatus.className = 'search-status no-results';
    return;
  }

  dom.searchStatus.textContent =
    `${results.length} file${results.length !== 1 ? 's' : ''} matched`;
  dom.searchStatus.className = 'search-status has-results';

  const frag = document.createDocumentFragment();
  results.forEach((result, idx) => {
    result.idx = idx;
    frag.appendChild(_createSearchCard(result, query));
  });
  dom.searchResults.appendChild(frag);
}

async function _searchDir(q, dirHandle, pathPrefix, gen) {
  const results = [];
  try {
    for await (const [name, handle] of dirHandle.entries()) {
      if (state.searchGenId !== gen) return results; // cancelled
      if (name.startsWith('.')) continue;

      if (handle.kind === 'directory') {
        const sub = await _searchDir(
          q, handle,
          pathPrefix ? `${pathPrefix}/${name}` : name,
          gen
        );
        results.push(...sub);
      } else if (_isMdFile(name)) {
        try {
          const file    = await handle.getFile();
          const content = await file.text();
          const snippets = _extractSnippets(content, q);
          if (snippets.length > 0) {
            results.push({ handle, name, path: pathPrefix, snippets });
          }
        } catch (_) { /* skip unreadable files */ }
      }
    }
  } catch (_) {}
  return results;
}

function _isMdFile(name) {
  const n = name.toLowerCase();
  return n.endsWith('.md') || n.endsWith('.markdown');
}

function _extractSnippets(content, q) {
  const lines = content.split('\n');
  const snippets = [];
  for (let i = 0; i < lines.length && snippets.length < 3; i++) {
    const idx = lines[i].toLowerCase().indexOf(q);
    if (idx !== -1) {
      snippets.push({ line: i + 1, text: lines[i], matchStart: idx, matchEnd: idx + q.length });
    }
  }
  return snippets;
}

function _createSearchCard(result, query) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'search-card';
  card.setAttribute('role', 'listitem');
  card.dataset.idx = result.idx;

  // Header: icon + filename
  const header = document.createElement('div');
  header.className = 'search-card-header';

  const icon = document.createElement('span');
  icon.className = 'search-card-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '📄';

  const nameEl = document.createElement('span');
  nameEl.className = 'search-card-name';
  nameEl.textContent = result.name;
  nameEl.title = result.name;

  header.append(icon, nameEl);
  card.appendChild(header);

  // Subfolder path (if nested)
  if (result.path) {
    const pathEl = document.createElement('div');
    pathEl.className = 'search-card-path';
    pathEl.textContent = result.path;
    card.appendChild(pathEl);
  }

  // Up to 2 context snippets
  result.snippets.slice(0, 2).forEach(snippet => {
    const s   = document.createElement('div');
    s.className = 'search-card-snippet';

    const raw         = snippet.text.trim();
    const lowerRaw    = raw.toLowerCase();
    const qIdx        = lowerRaw.indexOf(query.toLowerCase());

    if (qIdx === -1) {
      s.textContent = raw.slice(0, 80);
    } else {
      const before = raw.slice(0, qIdx);
      const match  = raw.slice(qIdx, qIdx + query.length);
      const after  = raw.slice(qIdx + query.length);
      const bTrim  = before.length > 40 ? '…' + before.slice(-40) : before;
      const aTrim  = after.length  > 40 ? after.slice(0, 40) + '…' : after;

      const mark = document.createElement('mark');
      mark.className = 'search-match';
      mark.textContent = match;
      s.append(document.createTextNode(bTrim), mark, document.createTextNode(aTrim));
    }
    card.appendChild(s);
  });

  card.addEventListener('click', () => openFileFromSearch(result, query));
  return card;
}

async function openFileFromSearch(result, query) {
  if (await confirmIfDirty()) return;

  // Highlight active card and scroll it into view within the results panel
  dom.searchResults.querySelectorAll('.search-card').forEach(c => c.classList.remove('active'));
  const activeCard = dom.searchResults.querySelector(`[data-idx="${result.idx}"]`);
  if (activeCard) activeCard.classList.add('active');

  try {
    const file    = await result.handle.getFile();
    const content = await file.text();

    state.currentFileHandle = result.handle;
    state.isDirty = false;
    state.searchOpenResult = result; // remember where this file lives for exitSearch()

    dom.fileNameDisplay.textContent = result.name;
    dom.dirtyIndicator.classList.add('hidden');
    dom.btnSave.classList.add('hidden');
    dom.btnExportPdf.classList.remove('hidden');
    dom.btnViewRendered.disabled = false;
    dom.btnViewSplit.disabled    = false;
    dom.btnViewCode.disabled     = false;
    dom.btnEditInline.classList.remove('hidden');
    dom.codeEditor.value = content;
    dom.lineNumbers._count = null;
    _undoStack = [content];
    _undoIndex = 0;

    await renderMarkdown(content);
    setView('rendered');
    updateLineNumbers();
    updateCodeHighlight();

    // Highlight all keyword matches then start the match navigator
    _highlightMatches(query);
    initMatchNav(query);

  } catch (err) {
    showToast('Could not open file: ' + err.message, 'error');
  }
}

function _highlightMatches(query) {
  if (!query) return;
  const q = query.toLowerCase();

  // Walk every text node in the preview pane
  const walker = document.createTreeWalker(dom.previewPane, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const tag = node.parentElement?.tagName?.toLowerCase();
      // Skip content inside script/style/existing marks
      if (tag === 'script' || tag === 'style' || tag === 'mark') {
        return NodeFilter.FILTER_REJECT;
      }
      return node.textContent.toLowerCase().includes(q)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    },
  });

  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) textNodes.push(node);

  textNodes.forEach(tn => {
    const text  = tn.textContent;
    const lower = text.toLowerCase();
    const frag  = document.createDocumentFragment();
    let i = 0;
    while (i < text.length) {
      const j = lower.indexOf(q, i);
      if (j === -1) { frag.appendChild(document.createTextNode(text.slice(i))); break; }
      if (j > i)      frag.appendChild(document.createTextNode(text.slice(i, j)));
      const mark = document.createElement('mark');
      mark.className = 'search-match';
      mark.textContent = text.slice(j, j + q.length);
      frag.appendChild(mark);
      i = j + q.length;
    }
    tn.parentNode.replaceChild(frag, tn);
  });

  // Scroll to first match in the preview pane
  const first = dom.previewPane.querySelector('mark.search-match');
  if (first) {
    requestAnimationFrame(() => first.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }
}

/* ── Match navigator ─────────────────────────────────────── */

function initMatchNav(query) {
  const marks = [...dom.previewPane.querySelectorAll('mark.search-match')];
  if (marks.length === 0) { closeMatchNav(); return; }

  state.matchNav.active = true;
  state.matchNav.marks  = marks;
  state.matchNav.index  = -1; // _goToMatch will set to 0

  dom.matchNavQuery.textContent = `"${query}"`;
  dom.matchNav.classList.remove('hidden');

  _goToMatch(0);
}

function _goToMatch(idx) {
  const { marks } = state.matchNav;
  if (!marks.length) return;

  // Remove current highlight from previous match
  marks.forEach(m => m.classList.remove('current'));

  // Wrap around
  idx = ((idx % marks.length) + marks.length) % marks.length;
  state.matchNav.index = idx;

  marks[idx].classList.add('current');
  dom.matchNavLabel.textContent = `${idx + 1} / ${marks.length}`;

  marks[idx].scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function matchNavNext() {
  if (!state.matchNav.active) return;
  _goToMatch(state.matchNav.index + 1);
}

function matchNavPrev() {
  if (!state.matchNav.active) return;
  _goToMatch(state.matchNav.index - 1);
}

function closeMatchNav() {
  state.matchNav.active = false;
  state.matchNav.marks.forEach(m => m.classList.remove('current'));
  state.matchNav.marks  = [];
  state.matchNav.index  = 0;
  dom.matchNav.classList.add('hidden');
}

/* ─────────────────────────────────────────────────────────── */

async function exitSearch() {
  state.searchActive = false;
  state.searchQuery  = '';
  state.searchGenId++;          // cancel any in-flight search

  dom.searchInput.value = '';
  dom.btnSearchClear.classList.add('hidden');
  dom.searchResults.classList.add('hidden');

  // Always unhide the file list first — loadDirectory populates it but
  // doesn't remove the .hidden class that search activation added.
  dom.fileList.classList.remove('hidden');

  // If a file was opened from search, navigate the directory panel to that
  // file's location so the left panel matches what's being previewed.
  const openedResult = state.searchOpenResult;
  state.searchOpenResult = null;

  if (openedResult && state.rootDirHandle) {
    await _navigateToDir(openedResult);
  } else {
    // No search result was opened — restore the existing directory view.
    // loadDirectory was already called when the folder was picked, so just
    // make sure the empty-state visibility is correct.
    if (dom.fileList.children.length === 0) {
      dom.fileListEmpty.classList.remove('hidden');
    }
  }

  // Strip search highlights from the rendered preview WITHOUT re-rendering
  // (re-rendering would reset scroll position to the top).
  _removeSearchHighlights();
}

// Remove <mark class="search-match"> wrappers in-place, preserving scroll position.
function _removeSearchHighlights() {
  closeMatchNav();
  dom.previewPane.querySelectorAll('mark.search-match').forEach(mark => {
    mark.replaceWith(document.createTextNode(mark.textContent));
  });
  // Merge any split text nodes left behind
  dom.previewPane.normalize();
}

// Traverse from rootDirHandle down through result.path segments,
// rebuild dirStack, then reload the directory listing and mark the file active.
async function _navigateToDir(result) {
  const segments = result.path ? result.path.split('/').filter(Boolean) : [];

  // Reset stack to root
  state.dirStack         = [{ handle: state.rootDirHandle, name: state.rootDirHandle.name }];
  state.currentDirHandle = state.rootDirHandle;
  let handle = state.rootDirHandle;

  for (const seg of segments) {
    try {
      const sub = await handle.getDirectoryHandle(seg);
      state.dirStack.push({ handle: sub, name: seg });
      state.currentDirHandle = sub;
      handle = sub;
    } catch (_) {
      break; // path segment not found — stop where we are
    }
  }

  await loadDirectory(handle);

  // Highlight the active file in the newly loaded list
  dom.fileList.querySelectorAll('.file-item').forEach(item => {
    const label = item.querySelector('.file-item-label');
    if (label?.textContent === result.name) item.classList.add('active');
  });
}


/* ═══════════════════════════════════════════════════════════
   BREADCRUMB
═══════════════════════════════════════════════════════════ */
function renderBreadcrumb() {
  dom.breadcrumb.innerHTML = '';

  state.dirStack.forEach(({ name }, index) => {
    if (index > 0) {
      const sep = document.createElement('span');
      sep.className = 'breadcrumb-separator';
      sep.textContent = '/';
      sep.setAttribute('aria-hidden', 'true');
      dom.breadcrumb.appendChild(sep);
    }

    const seg = document.createElement('button');
    seg.className = 'breadcrumb-segment';
    seg.textContent = name;
    seg.title = name;
    seg.type = 'button';

    const isLast = index === state.dirStack.length - 1;
    if (isLast) {
      seg.classList.add('current');
      seg.setAttribute('aria-current', 'page');
    } else {
      seg.addEventListener('click', () => navigateToBreadcrumb(index));
    }

    dom.breadcrumb.appendChild(seg);
  });
}


/* ═══════════════════════════════════════════════════════════
   TOAST SYSTEM
═══════════════════════════════════════════════════════════ */
function showToast(message, type = 'info', duration = 3500) {
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = message;
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');

  dom.toastContainer.appendChild(toast);

  // Force reflow before adding .show so the enter transition plays
  toast.getBoundingClientRect();
  toast.classList.add('show');

  const hide = () => {
    toast.classList.remove('show');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  };

  const timer = setTimeout(hide, duration);

  // Click to dismiss early
  toast.addEventListener('click', () => {
    clearTimeout(timer);
    hide();
  });
}


/* ═══════════════════════════════════════════════════════════
   LOCAL STORAGE PREFERENCES
═══════════════════════════════════════════════════════════ */
function savePreferences() {
  try {
    const prefs = {
      panelWidth:       state.panelWidth,
      // 'split' can't be restored after page reload (no file handle) — save as 'rendered'
      currentView:      state.currentView === 'split' ? 'rendered' : state.currentView,
      isPanelCollapsed: state.isPanelCollapsed,
    };
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch (_) {}
}

function loadPreferences() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return;
    const prefs = JSON.parse(raw);

    if (typeof prefs.panelWidth === 'number' && prefs.panelWidth >= 180 && prefs.panelWidth <= 500) {
      state.panelWidth = prefs.panelWidth;
    }
    // 'split' can't be meaningfully restored (no file handle after reload), so default to 'rendered'
    if (prefs.currentView === 'rendered' || prefs.currentView === 'code') {
      state.currentView = prefs.currentView;
    }
    if (typeof prefs.isPanelCollapsed === 'boolean') {
      state.isPanelCollapsed = prefs.isPanelCollapsed;
    }
  } catch (_) {}
}

function applyPreferences() {
  // Apply panel width + collapse state together so inline style is always consistent
  dom.panelLeft.classList.toggle('collapsed', state.isPanelCollapsed);
  setPanelWidth(state.isPanelCollapsed ? 0 : state.panelWidth, state.panelWidth);

  // Apply view (but don't render — no file loaded yet; split is impossible without a file)
  const v = state.currentView;
  dom.btnViewRendered.classList.toggle('active', v === 'rendered');
  dom.btnViewSplit.classList.toggle('active',    v === 'split');
  dom.btnViewCode.classList.toggle('active',     v === 'code');
  dom.previewPane.classList.toggle('hidden', v !== 'rendered');
  dom.codePane.classList.toggle('hidden',    v !== 'code');

  // No file is open yet — disable the view toggle until a file is selected
  dom.btnViewRendered.disabled = true;
  dom.btnViewSplit.disabled    = true;
  dom.btnViewCode.disabled     = true;
}


/* ═══════════════════════════════════════════════════════════
   KEYBOARD SHORTCUTS
═══════════════════════════════════════════════════════════ */
function wireKeyboard() {
  document.addEventListener('keydown', e => {
    const meta = e.ctrlKey || e.metaKey;
    const appVisible = !dom.app.classList.contains('hidden');

    // Save: Ctrl/Cmd + S
    if (meta && e.key === 's') {
      e.preventDefault();
      saveFile();
      return;
    }

    // Export as PDF: Ctrl/Cmd + P (only when a file is open, otherwise let the
    // browser print the page as normal)
    if (meta && e.key === 'p' && state.currentFileHandle) {
      e.preventDefault();
      exportToPDF();
      return;
    }

    // Undo pending delete: Ctrl/Cmd + Z (skip when inline editor is focused — let browser undo text)
    if (meta && e.key === 'z' && _pendingDelete && !dom.previewPane.contains(document.activeElement)) {
      e.preventDefault();
      const undoBtn = dom.toastContainer.querySelector('.toast-undo-btn');
      if (undoBtn) undoBtn.click();
      return;
    }

    // Show shortcuts help: ? (when not typing in an input)
    if (e.key === '?' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
      if (!appVisible) return;
      openHelp();
      return;
    }

    // Focus search: Ctrl/Cmd + F
    if (meta && e.key === 'f') {
      e.preventDefault();
      if (!appVisible) return;
      // Expand panel if collapsed so the input is visible
      if (state.isPanelCollapsed) togglePanel();
      dom.searchInput.focus();
      dom.searchInput.select();
      return;
    }

    // Enter confirms the visible action modal (delete or move)
    if (e.key === 'Enter' && !e.shiftKey) {
      if (!dom.deleteModal.classList.contains('hidden')) {
        e.preventDefault();
        if (_pendingDelete) _startSoftDelete();
        return;
      }
      if (!dom.moveModal.classList.contains('hidden')) {
        e.preventDefault();
        if (_pendingMove) _startSoftMove();
        return;
      }
    }

    // Match navigation (only when nav bar is active and focus is not in an editor).
    // previewPane.contains() covers the pane itself — it IS the activeElement when
    // the contenteditable has focus. Without it, Enter and the arrow keys jumped
    // between search matches instead of editing text.
    const inEditor = document.activeElement === dom.codeEditor ||
                     dom.previewPane.contains(document.activeElement);
    if (state.matchNav.active && !inEditor) {
      // Enter / Shift+Enter — next / prev match
      if (e.key === 'Enter') {
        e.preventDefault();
        e.shiftKey ? matchNavPrev() : matchNavNext();
        return;
      }
      // Arrow keys — next / prev (only when search input is NOT focused, to keep typing free)
      if (document.activeElement !== dom.searchInput) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          e.preventDefault(); matchNavNext(); return;
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
          e.preventDefault(); matchNavPrev(); return;
        }
      }
    }

    // Toggle split view: Ctrl/Cmd + E
    if (meta && e.key === 'e') {
      e.preventDefault();
      if (!appVisible || !state.currentFileHandle) return;
      toggleInlineEdit(); // toggles between split ↔ rendered (or code → split)
      return;
    }

    // Toggle panel: Ctrl/Cmd + B
    if (meta && e.key === 'b') {
      e.preventDefault();
      if (!appVisible) return;
      togglePanel();
      return;
    }

    // Fullscreen: F11
    if (e.key === 'F11') {
      e.preventDefault();
      if (!appVisible) return;
      toggleFullscreen();
      return;
    }

    // Escape: close shortcuts → inline edit → close move modal → close delete modal → close match nav → exit search → exit fullscreen
    if (e.key === 'Escape') {
      if (!dom.shortcutsModal.classList.contains('hidden')) {
        closeHelp();
        return;
      }
      if (state.currentView === 'split') {
        setView('rendered');
        return;
      }
      if (!dom.moveModal.classList.contains('hidden')) {
        _pendingMove = null;
        _closeMoveModal();
        return;
      }
      if (!dom.deleteModal.classList.contains('hidden')) {
        _pendingDelete = null;
        _closeDeleteModal();
        return;
      }
      if (state.matchNav.active && !state.searchActive) {
        closeMatchNav();
        return;
      }
      if (state.searchActive) {
        exitSearch();
        dom.searchInput.blur();
        return;
      }
      if (state.isFullscreen) {
        toggleFullscreen();
        return;
      }
    }
  });
}


/* ═══════════════════════════════════════════════════════════
   OS-AWARE KEYBOARD LABELS
═══════════════════════════════════════════════════════════ */
function _applyOsShortcutLabels() {
  const isMac = /Mac|iPhone|iPad/i.test(navigator.userAgent);
  // Update search bar placeholder
  dom.searchInput.placeholder = isMac ? 'Search files… (⌘F)' : 'Search files… (Ctrl+F)';
  // Replace every "Ctrl" <kbd> in the shortcuts modal with ⌘ on Mac
  dom.shortcutsModal.querySelectorAll('kbd').forEach(kbd => {
    if (kbd.textContent.trim() === 'Ctrl') kbd.textContent = isMac ? '⌘' : 'Ctrl';
  });
}


/* ═══════════════════════════════════════════════════════════
   MARKED EXTENSIONS — highlight ==…==, subscript ~…~, superscript ^…^
═══════════════════════════════════════════════════════════ */
function _registerMarkedExtensions() {
  marked.use({
    extensions: [
      // ==highlighted text==
      {
        name: 'mdHighlight',
        level: 'inline',
        start(src) { return src.indexOf('=='); },
        tokenizer(src) {
          const m = src.match(/^==([^=\n]+)==/);
          if (m) return { type: 'mdHighlight', raw: m[0], text: m[1] };
        },
        renderer(token) {
          return `<mark class="md-highlight">${token.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</mark>`;
        },
      },
      // ^superscript^
      {
        name: 'mdSuperscript',
        level: 'inline',
        start(src) { return src.indexOf('^'); },
        tokenizer(src) {
          const m = src.match(/^\^([^\^\n]+)\^/);
          if (m) return { type: 'mdSuperscript', raw: m[0], text: m[1] };
        },
        renderer(token) {
          return `<sup>${token.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</sup>`;
        },
      },
      // ~subscript~ (only single ~, not ~~strikethrough~~)
      {
        name: 'mdSubscript',
        level: 'inline',
        start(src) { return src.indexOf('~'); },
        tokenizer(src) {
          // Must be single ~, not double ~~ at start
          if (src.startsWith('~~')) return;
          const m = src.match(/^~([^~\n]+)~/);
          if (m) return { type: 'mdSubscript', raw: m[0], text: m[1] };
        },
        renderer(token) {
          return `<sub>${token.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</sub>`;
        },
      },
    ],
  });

  // Allow <mark>, <sup>, <sub> through DOMPurify
  DOMPurify.addHook('afterSanitizeAttributes', node => {
    // no-op — these tags are allowed by DOMPurify by default
  });
}


/* ═══════════════════════════════════════════════════════════
   DOM → MARKDOWN CONVERSION
   Used to derive the markdown source from the rendered HTML
   when the user types directly in the contenteditable preview.
═══════════════════════════════════════════════════════════ */

// Text of an editable code block. Typing Enter inside one produces <br> or
// <div>, and textContent renders both as nothing — so multi-line edits were
// silently flattened onto a single line.
function _preText(el) {
  let out = '';
  for (const n of el.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) out += n.textContent;
    else if (n.nodeName === 'BR') out += '\n';
    else {
      if (/^(DIV|P)$/.test(n.nodeName) && out && !out.endsWith('\n')) out += '\n';
      out += _preText(n);
    }
  }
  return out;
}

function domToMarkdown(el) {
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toLowerCase();
    const ch  = () => [...node.childNodes].map(walk).join('');

    // Non-editable islands carry their original source in data attributes
    if (node.classList.contains('mermaid-diagram')) {
      return '\n```mermaid\n' + (node.dataset.mermaidSource || '').trim() + '\n```\n\n';
    }
    if (node.classList.contains('mermaid-error')) return '';

    switch (tag) {
      case 'h1': return '\n# '      + ch().trim() + '\n\n';
      case 'h2': return '\n## '     + ch().trim() + '\n\n';
      case 'h3': return '\n### '    + ch().trim() + '\n\n';
      case 'h4': return '\n#### '   + ch().trim() + '\n\n';
      case 'h5': return '\n##### '  + ch().trim() + '\n\n';
      case 'h6': return '\n###### ' + ch().trim() + '\n\n';
      case 'p': {
        const c = ch().trim();
        return c ? '\n' + c + '\n\n' : '\n\n';
      }
      case 'strong': case 'b':                   return '**' + ch() + '**';
      case 'em':     case 'i':                   return '*'  + ch() + '*';
      case 's': case 'del': case 'strike':        return '~~' + ch() + '~~';
      case 'u':                                   return ch(); // underline has no markdown equiv
      case 'mark':               return '==' + ch() + '==';
      case 'sub':                return '~'  + ch() + '~';
      case 'sup':                return '^'  + ch() + '^';
      case 'code': {
        if (node.closest('pre')) return node.textContent; // inside pre: raw text only
        return '`' + node.textContent + '`';
      }
      case 'pre': {
        const code = node.querySelector('code');
        const raw  = _preText(code || node);
        const lang = (code?.className?.match(/language-(\w+)/)?.[1] ?? '').replace('language-','');
        return '\n```' + lang + '\n' + raw.trimEnd() + '\n```\n\n';
      }
      case 'blockquote': {
        const inner = ch().trim();
        return '\n' + inner.split('\n').map(l => '> ' + l).join('\n') + '\n\n';
      }
      case 'ul': {
        const items = [...node.children].filter(c => c.tagName.toLowerCase() === 'li');
        return '\n' + items.map(li =>
          '- ' + [...li.childNodes].map(walk).join('').trim()
        ).join('\n') + '\n\n';
      }
      case 'ol': {
        const items = [...node.children].filter(c => c.tagName.toLowerCase() === 'li');
        return '\n' + items.map((li, i) =>
          (i + 1) + '. ' + [...li.childNodes].map(walk).join('').trim()
        ).join('\n') + '\n\n';
      }
      case 'li':  return ch(); // handled by ul/ol
      case 'hr':  return '\n---\n\n';
      case 'br':  return '\n';
      // contenteditable drops <div> wrappers in on Enter and on paste. Treat
      // them as blocks — falling through to default() swallowed the line break
      // entirely and collapsed separate paragraphs into one.
      case 'div': return node === el ? ch() : '\n' + ch().trim() + '\n\n';
      case 'a': {
        const href  = node.getAttribute('href') || '';
        const title = node.getAttribute('title');
        return '[' + ch() + '](' + href + (title ? ` "${title}"` : '') + ')';
      }
      case 'img': return '![' + (node.alt || '') + '](' + (node.getAttribute('src') || '') + ')';
      case 'table': {
        const rows = [...node.querySelectorAll('tr')];
        if (!rows.length) return '';
        const hdrs = [...rows[0].querySelectorAll('th,td')].map(
          c => [...c.childNodes].map(walk).join('').trim()
        );
        const sep  = hdrs.map(() => '---');
        const body = rows.slice(1).map(r =>
          [...r.querySelectorAll('td')].map(c => [...c.childNodes].map(walk).join('').trim())
        );
        const toRow = cells => '| ' + cells.join(' | ') + ' |';
        return '\n' + [toRow(hdrs), toRow(sep), ...body.map(toRow)].join('\n') + '\n\n';
      }
      default: return ch();
    }
  }
  return walk(el).replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').trim() + '\n';
}


/* ═══════════════════════════════════════════════════════════
   CURSOR SAVE / RESTORE (for after live re-render)
═══════════════════════════════════════════════════════════ */

// Return the plain text content from the cursor to the end of `el`.
// Used as an anchor to restore cursor position after innerHTML is replaced.
function _saveCursorAfter(el) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  try {
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer)) return null;
    const after = document.createRange();
    after.setStart(range.startContainer, range.startOffset);
    after.setEnd(el, el.childNodes.length);
    return after.toString();
  } catch (_) { return null; }
}

// Restore cursor to the position where `textAfter` starts in the new DOM content.
// Collapses whitespace for comparison so structural newlines don't throw off the offset.
function _restoreCursorAfter(el, textAfter) {
  if (textAfter === null) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes  = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const fullText = nodes.map(n => n.textContent).join('');

  const norm = s => s.replace(/[\n\r\s]+/g, ' ');
  const nFull  = norm(fullText);
  const nAfter = norm(textAfter);

  let targetPos;
  if (!nAfter.trim()) {
    targetPos = fullText.length;
  } else {
    const nTarget = nFull.length - nAfter.length;
    if (nTarget < 0) { targetPos = fullText.length; }
    else {
      // Map the normalised offset back to actual text position
      let nPos = 0, aPos = 0;
      for (let i = 0; i < fullText.length; i++) {
        if (nPos >= nTarget) break;
        nPos += norm(fullText[i]).length;
        aPos = i + 1;
      }
      targetPos = aPos;
    }
  }

  let rem = targetPos;
  for (const node of nodes) {
    if (rem <= node.textContent.length) {
      try {
        const r = document.createRange();
        r.setStart(node, rem);
        r.collapse(true);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
      } catch (_) {}
      return;
    }
    rem -= node.textContent.length;
  }
  // Fallback: end of content
  const last = nodes[nodes.length - 1];
  if (last) {
    try {
      const r = document.createRange();
      r.setStart(last, last.textContent.length);
      r.collapse(true);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(r);
    } catch (_) {}
  }
}


/* ═══════════════════════════════════════════════════════════
   PREVIEW PANE INPUT HANDLER
   Called whenever the user types in the contenteditable preview.
═══════════════════════════════════════════════════════════ */

function _onPreviewInput() {
  if (!state.currentFileHandle) return;
  // The DOM is the source of truth while typing — never re-render here, that
  // is what caused cursor jumps and double-Enter. Only the dirty dot is
  // immediate; the markdown sync is debounced because domToMarkdown walks the
  // whole document and re-highlighting the source is O(document) per keystroke.
  _markDirty();
  _updateSlashMenu(); // immediate: the menu tracks the caret, not the debounce
  clearTimeout(_previewSyncTimer);
  // In split view the code pane is on screen, so the user is watching it —
  // sync almost immediately. Alone in rendered view nobody sees it; stay lazy.
  const delay = state.currentView === 'split' ? 50 : 200;
  _previewSyncTimer = setTimeout(_flushPreviewSync, delay);
}

// DOM → markdown → code editor. Debounced while typing, so anything that READS
// codeEditor.value (save, export, view switch) must flush first or it sees
// content that is up to 200ms stale.
function _flushPreviewSync() {
  clearTimeout(_previewSyncTimer);
  _previewSyncTimer = null;
  if (!state.currentFileHandle) return;
  dom.codeEditor.value = domToMarkdown(dom.previewPane);
  // Gutter + syntax layer are invisible in rendered view — refreshed by setView
  // when the code pane comes back.
  if (!dom.codePane.classList.contains('hidden')) {
    updateLineNumbers();
    updateCodeHighlight();
  }
}

// Apply contenteditable state and mark non-editable islands.
// Called at the end of renderMarkdown when a file is open in rendered or split view.
function _setupEditablePane() {
  const editable = !!(state.currentFileHandle &&
    (state.currentView === 'rendered' || state.currentView === 'split'));
  dom.previewPane.contentEditable = editable ? 'true' : 'false';
  if (!editable) return;
  // Mermaid output is generated SVG — editing it by hand is meaningless and the
  // source round-trips from data-mermaid-source. Code blocks stay editable:
  // locking them made it impossible to place a caret inside one, which is why
  // the code-block button could never toggle itself off.
  dom.previewPane.querySelectorAll('.mermaid-diagram, .mermaid-error').forEach(el => {
    el.contentEditable = 'false';
  });
}


/* ═══════════════════════════════════════════════════════════
   SPLIT-VIEW TOGGLE (⌘E)
═══════════════════════════════════════════════════════════ */

// Styled tooltips for icon-only controls. Hijacks [title] so the browser's
// slow, unstyled native tooltip never appears, and mirrors the text into
// aria-label so screen readers keep the same description.
function initTooltips() {
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);

  let showTimer = null;
  const hide = () => { clearTimeout(showTimer); tip.classList.remove('tip-show'); };

  document.addEventListener('mouseover', e => {
    const el = e.target.closest('[title], [data-tip]');
    if (!el) return;

    // Move title → data-tip once, so the native bubble never fires again
    const native = el.getAttribute('title');
    if (native) {
      el.dataset.tip = native;
      if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', native);
      el.removeAttribute('title');
    }
    const text = el.dataset.tip;
    if (!text) return;

    clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      tip.textContent = text;
      tip.classList.add('tip-show');
      const r = el.getBoundingClientRect();
      const t = tip.getBoundingClientRect();
      let top = r.bottom + 8;
      if (top + t.height > window.innerHeight - 8) top = r.top - t.height - 8;
      tip.style.top  = Math.max(8, top) + 'px';
      tip.style.left = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2),
                                window.innerWidth - t.width - 8) + 'px';
    }, 180);
  });

  document.addEventListener('mouseout', e => {
    if (e.target.closest('[data-tip]')) hide();
  });
  document.addEventListener('mousedown', hide);
  window.addEventListener('blur', hide);
}

function initInlineEditor() {
  // Enter must split into <p>, not Chrome's default <div> — <div> has no
  // markdown equivalent and used to swallow the paragraph break outright.
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (_) {}
  // Force tag-based output (<b>, not <span style="font-weight:bold">) — inline
  // styles have no markdown equivalent and domToMarkdown would drop them.
  try { document.execCommand('styleWithCSS', false, false); } catch (_) {}

  // Paste as plain text. Rich HTML from a webpage carries inline styles and
  // classes that domToMarkdown can't represent, so it round-trips to garbage.
  dom.previewPane.addEventListener('paste', e => {
    if (!state.currentFileHandle) return;
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  });

  // Format toolbar: use mousedown (not click) so selection isn't lost before we apply the format
  dom.formatToolbar.addEventListener('mousedown', e => {
    const btn = e.target.closest('.fmt-btn');
    if (!btn) return;
    e.preventDefault(); // prevent losing the active selection
    applyFormat(btn.dataset.format);
  });

  // Show / hide format toolbar when selection changes
  document.addEventListener('selectionchange', _onSelectionChange);

  // Hide format toolbar when preview pane scrolls
  dom.previewPane.addEventListener('scroll', () => hideFormatToolbar(), { passive: true });

  // Live input: user types in the contenteditable preview → sync to code editor + debounce render
  dom.previewPane.addEventListener('input', _onPreviewInput);

  // Click in rendered preview while split view is open → sync code editor to that line
  dom.previewPane.addEventListener('click', e => {
    if (!state.currentFileHandle || state.currentView !== 'split') return;
    if (e.target.closest('a, button, .mermaid-diagram, pre, #preview-empty')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // selection drag, not a simple click
    _syncCodeEditorToClick(e.clientX, e.clientY);
  });

  // Keyboard shortcuts inside the contenteditable preview pane
  // Slash menu: click to choose. mousedown so the caret/selection survives.
  dom.slashMenu.addEventListener('mousedown', e => {
    const btn = e.target.closest('.slash-item');
    if (!btn) return;
    e.preventDefault();
    _runSlashCommand(btn.dataset.fmt);
  });

  // Close the menu on an outside click or when the pane scrolls away
  document.addEventListener('mousedown', e => {
    if (_slash && !dom.slashMenu.contains(e.target)) _closeSlashMenu();
  });
  dom.previewPane.addEventListener('scroll', () => _slash && _closeSlashMenu(), { passive: true });

  dom.previewPane.addEventListener('keydown', e => {
    if (!state.currentFileHandle) return;
    const meta = e.ctrlKey || e.metaKey;

    // Slash menu owns the arrows/Enter/Tab/Escape while it is open
    if (_slashMenuKeydown(e)) { e.preventDefault(); return; }

    // Escaping a quote or list.
    //   Ctrl/Cmd+Enter — always break out, even with text right of the caret.
    //   Enter          — break out of an empty line inside a quote (the browser
    //                    already does this for an empty list item, but it keeps
    //                    nesting empty paragraphs inside a blockquote forever).
    if (e.key === 'Enter') {
      const sel   = window.getSelection();
      const start = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
      if (start) {
        const block    = _getContainingBlock(start);
        const isEmpty  = block && !block.textContent.trim();
        const inQuote  = !!_findInPreview(start, 'blockquote');
        if ((meta || (inQuote && isEmpty)) && _escapeBlock()) {
          e.preventDefault();
          return;
        }
      }
    }

    // Tab → insert a real tab character instead of moving focus
    if (e.key === 'Tab') {
      e.preventDefault();
      document.execCommand('insertText', false, '\t');
      return;
    }

    // Medium-style shortcut: "## " at the start of a block becomes a heading
    if (e.key === ' ' && _tryMarkdownShortcut()) {
      e.preventDefault();
      return;
    }

  });

  // Double-click in split view → scroll code editor to the clicked source line
  dom.previewPane.addEventListener('dblclick', e => {
    if (!state.currentFileHandle || state.currentView !== 'split') return;
    if (e.target.closest('a, .mermaid-diagram, pre, #preview-empty')) return;
    // Deliberately no codeEditor.focus() here: moving focus out of the pane
    // collapses the selection, which dismissed the format toolbar on every
    // double-click in split view.
    _syncCodeEditorToClick(e.clientX, e.clientY);
  });
}

function toggleInlineEdit() {
  if (state.currentView === 'split') {
    setView('rendered');
  } else if (state.currentFileHandle) {
    setView('split');
  }
}

// Toggle the side-by-side split view (⌘E or edit button).
// Delegates to setView so all state is managed in one place.
function _enterInlineEditMode(clickX, clickY) {
  if (!state.currentFileHandle) return;
  setView('split');
  if (clickX !== undefined && clickY !== undefined) {
    _syncCodeEditorToClick(clickX, clickY);
  }
}

// Initialise the horizontal resize handle between preview (left) and code pane (right).
function _initLiveEditResize() {
  let startX, startW;
  _liveEditDivider.addEventListener('mousedown', e => {
    e.preventDefault();
    startX = e.clientX;
    startW = dom.codePane.offsetWidth;
    _liveEditDivider.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const onMove = mv => {
      const delta  = startX - mv.clientX; // drag left → wider code pane
      const panelW = dom.contentArea.offsetWidth;
      // Leave the preview its 320px prose floor + the 5px divider, so dragging
      // can never squeeze the rendered pane below a readable measure.
      const maxW   = Math.max(240, panelW - 320 - 5);
      const newW   = Math.min(Math.max(240, startW + delta), maxW);
      _liveEditCodeW = newW;
      dom.contentArea.style.setProperty('--live-code-w', newW + 'px');
    };
    const onUp = () => {
      _liveEditDivider.classList.remove('dragging');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// Scroll the code editor so the line nearest the clicked rendered element is visible.
function _syncCodeEditorToClick(x, y) {
  requestAnimationFrame(() => {
    const el = document.elementFromPoint(x, y);
    if (!el) return;
    const block = el.closest('[data-source-line]');
    if (!block) return;
    const lineIdx = parseInt(block.dataset.sourceLine, 10) - 1; // 0-based
    if (isNaN(lineIdx) || lineIdx < 0) return;

    const lines = dom.codeEditor.value.split('\n');
    if (lineIdx >= lines.length) return;

    // Move caret to the start of that line
    const charOffset = lines.slice(0, lineIdx).reduce((acc, l) => acc + l.length + 1, 0);
    dom.codeEditor.setSelectionRange(charOffset, charOffset);

    // Scroll so the target line is vertically centred in the textarea
    const lineH = 13 * 1.75; // matches font-size × line-height in .code-editor
    dom.codeEditor.scrollTop = Math.max(0, lineIdx * lineH - dom.codePane.offsetHeight / 2);
  });
}

function _exitInlineEditMode(doRender = true) {
  if (state.currentView !== 'split') return;

  if (doRender) {
    // setView('rendered') handles the full teardown + re-render
    setView('rendered');
  } else {
    // Lightweight teardown without re-render (used when clearing the active file)
    state.isInlineEditing = false;
    state.currentView = 'rendered';
    clearTimeout(_liveRenderTimer);
    dom.contentArea.classList.remove('live-edit-mode');
    dom.codePane.classList.add('hidden');
    dom.previewPane.classList.remove('hidden');
    dom.btnEditInline.classList.remove('edit-active');
    dom.btnViewRendered.classList.add('active');
    dom.btnViewSplit.classList.remove('active');
  }
}

/* ═══════════════════════════════════════════════════════════
   CUSTOM UNDO / REDO
   Browser-native undo is destroyed on every innerHTML re-render.
   We maintain our own markdown snapshot stack instead.
═══════════════════════════════════════════════════════════ */

// Push a markdown snapshot onto the undo stack (truncates any redo future).
function _pushUndo(markdown) {
  // Don't record duplicates
  if (_undoStack[_undoIndex] === markdown) return;
  // Truncate redo history beyond current position
  _undoStack = _undoStack.slice(0, _undoIndex + 1);
  _undoStack.push(markdown);
  // Cap stack at 200 entries
  if (_undoStack.length > 200) { _undoStack.shift(); } else { _undoIndex++; }
}

// Restore the previous snapshot.
function _undo() {
  if (_undoIndex <= 0) return; // nothing left to undo
  _undoIndex--;
  _applyUndoSnapshot(_undoStack[_undoIndex]);
}

// Re-apply a snapshot that was undone.
function _redo() {
  if (_undoIndex >= _undoStack.length - 1) return;
  _undoIndex++;
  _applyUndoSnapshot(_undoStack[_undoIndex]);
}

function _applyUndoSnapshot(markdown) {
  dom.codeEditor.value = markdown;
  _markDirty();
  updateLineNumbers();
  updateCodeHighlight();
  const scrollTop = dom.previewPane.scrollTop;
  renderMarkdown(markdown, { preserveScroll: true }).then(() => {
    dom.previewPane.scrollTop = scrollTop;
    if (state.currentView === 'rendered' || state.currentView === 'split') {
      dom.previewPane.focus();
    }
  });
}


// Extract plain-text markdown from the inline editor, normalising special whitespace.
function _getInlineContent(editEl) {
  return (editEl.innerText || editEl.textContent)
    .replace(/\u00A0/g, ' ')
    .replace(/\u2028/g, '\n')
    .replace(/\u2029/g, '\n');
}

// Place caret at charOffset within a contenteditable element.
function _placeCursorAt(el, charOffset) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let rem = charOffset;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (rem <= node.textContent.length) {
      try {
        const r = document.createRange();
        r.setStart(node, rem);
        r.collapse(true);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
      } catch (_) {}
      return;
    }
    rem -= node.textContent.length;
  }
  // Fallback: end of element
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(r);
}

// Character offset of (targetNode, targetOffset) within a contenteditable.
function _getCharOffset(el, targetNode, targetOffset) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let pos = 0;
  while (walker.nextNode()) {
    if (walker.currentNode === targetNode) return pos + targetOffset;
    pos += walker.currentNode.textContent.length;
  }
  return pos;
}


/* ═══════════════════════════════════════════════════════════
   FLOATING FORMAT TOOLBAR
═══════════════════════════════════════════════════════════ */

function _onSelectionChange() {
  const sel = window.getSelection();

  if (!sel || sel.isCollapsed || !sel.toString().trim()) {
    hideFormatToolbar();
    return;
  }
  if (!sel.rangeCount) { hideFormatToolbar(); return; }

  const range = sel.getRangeAt(0);
  const ancestor = range.commonAncestorContainer;

  // Only show over selections inside the preview pane
  if (!dom.previewPane.contains(ancestor)) {
    hideFormatToolbar();
    return;
  }

  // Get the bounding rect of the selection for positioning
  const rects = range.getClientRects();
  if (!rects.length) { hideFormatToolbar(); return; }

  // Find the topmost rect (first line of selection)
  let topRect = rects[0];
  for (const r of rects) {
    if (r.top < topRect.top) topRect = r;
  }

  showFormatToolbar(topRect);
}

function showFormatToolbar(selectionRect) {
  const tb = dom.formatToolbar;
  tb.classList.remove('hidden');

  // Detect and highlight which formats are already active on the selection
  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    const active = _detectActiveFormats(sel.getRangeAt(0));
    tb.querySelectorAll('.fmt-btn').forEach(btn => {
      btn.classList.toggle('fmt-active', active.has(btn.dataset.format));
    });
  }

  // Position: measure toolbar after it's visible
  const tbRect = tb.getBoundingClientRect();
  const tbW = tbRect.width || 400;
  const tbH = tbRect.height || 36;
  const GAP = 10;

  let top  = selectionRect.top - tbH - GAP;
  let left = selectionRect.left + selectionRect.width / 2;

  if (top < 8) top = selectionRect.bottom + GAP;

  const margin = 8;
  left = Math.min(window.innerWidth - tbW / 2 - margin, Math.max(tbW / 2 + margin, left));

  tb.style.top  = top + 'px';
  tb.style.left = left + 'px';
}

// Detect which formats are currently active for the given selection range.
// Walks up the rendered DOM from the selection anchor — works in both plain rendered view
// and live-edit split view (where the preview pane still shows rendered HTML).
function _detectActiveFormats(range) {
  const active = new Set();

  let el = range.startContainer.nodeType === Node.TEXT_NODE
    ? range.startContainer.parentElement
    : range.startContainer;

  while (el && el !== dom.previewPane) {
    const tag = el.tagName?.toLowerCase();
    if (tag === 'strong' || tag === 'b')            active.add('bold');
    if (tag === 'em'     || tag === 'i')            active.add('italic');
    if (tag === 's' || tag === 'del' || tag === 'strike') active.add('strikethrough');
    if (tag === 'blockquote')                        active.add('blockquote');
    if (tag === 'code' && !el.closest('pre'))        active.add('code');
    if (tag === 'pre')                               active.add('fenced');
    if (tag === 'h1')                                active.add('h1');
    if (tag === 'h2')                                active.add('h2');
    if (tag === 'h3')                                active.add('h3');
    if (tag === 'mark')                              active.add('highlight');
    if (tag === 'sub')                               active.add('sub');
    if (tag === 'sup')                               active.add('sup');
    if (tag === 'li') {
      if (el.closest('ul')) active.add('ul');
      if (el.closest('ol')) active.add('ol');
    }
    el = el.parentElement;
  }

  return active;
}

function hideFormatToolbar() {
  dom.formatToolbar.classList.add('hidden');
}


/* ── Format application ──────────────────────────────────── */

function getFormatMarkers(format) {
  const map = {
    h1:            { prefix: '# ',   suffix: '',    block: true  },
    h2:            { prefix: '## ',  suffix: '',    block: true  },
    h3:            { prefix: '### ', suffix: '',    block: true  },
    bold:          { prefix: '**',   suffix: '**',  block: false },
    italic:        { prefix: '*',    suffix: '*',   block: false },
    strikethrough: { prefix: '~~',   suffix: '~~',  block: false },
    blockquote:    { prefix: '> ',   suffix: '',    block: true  },
    code:          { prefix: '`',    suffix: '`',   block: false },
    fenced:        { prefix: '```\n',suffix: '\n```',block: false },
    ul:            { prefix: '- ',   suffix: '',    block: true  },
    ol:            { prefix: '1. ',  suffix: '',    block: true  },
    highlight:     { prefix: '==',   suffix: '==',  block: false },
    sub:           { prefix: '~',    suffix: '~',   block: false },
    sup:           { prefix: '^',    suffix: '^',   block: false },
  };
  return map[format] || { prefix: '', suffix: '', block: false };
}

// ── Format dispatcher ─────────────────────────────────────────────────────────
// All formatting in rendered/split mode goes through execCommand or direct DOM
// manipulation, then syncs DOM → markdown → code editor.
// This approach is reliable because:
//   • It works at the cursor position — no "find text in source" guessing
//   • execCommand auto-detects existing formatting and toggles it off
//   • No re-render means no cursor jump
function applyFormat(format) {
  _applyFormatToRenderedMode(format);
  hideFormatToolbar();
}

// Block formats act on whichever block holds the caret, so they do not need a
// selection. Inline formats have nothing to wrap without one.
const _BLOCK_FORMATS = new Set(['h1', 'h2', 'h3', 'blockquote', 'ul', 'ol', 'fenced']);

function _applyFormatToRenderedMode(format) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  if (!_BLOCK_FORMATS.has(format) && !sel.toString().trim()) return;

  // Keep focus (and selection) on the preview pane — the format buttons use
  // mousedown + preventDefault so focus never actually left.
  switch (format) {
    // ── Inline: native execCommand handles toggle automatically ──
    case 'bold':          document.execCommand('bold');         break;
    case 'italic':        document.execCommand('italic');       break;
    case 'strikethrough': document.execCommand('strikeThrough'); break;

    // ── Block: headings ──
    case 'h1': _toggleHeading('h1'); break;
    case 'h2': _toggleHeading('h2'); break;
    case 'h3': _toggleHeading('h3'); break;

    // ── Block: blockquote ──
    case 'blockquote': _toggleBlockquoteDom(); break;

    // ── Block: lists ──
    case 'ul': _toggleList('ul'); break;
    case 'ol': _toggleList('ol'); break;

    // ── Inline: no execCommand equivalent — use insertHTML toggle ──
    case 'code':      _toggleInlineElement('code');  break;
    case 'highlight': _toggleInlineElement('mark');  break;
    case 'sub':       _toggleInlineElement('sub');   break;
    case 'sup':       _toggleInlineElement('sup');   break;

    // ── Block: fenced code ──
    case 'fenced': _toggleFencedCode(); break;
  }

  // Sync the (now-modified) DOM back to the markdown code editor
  _syncDomToCodeEditor();
}

// ── Format helpers ────────────────────────────────────────────────────────────

// Sync DOM → markdown → code editor (no re-render of the preview)
function _syncDomToCodeEditor() {
  _markDirty();
  _flushPreviewSync();
  _pushUndo(dom.codeEditor.value);
}

/* ═══════════════════════════════════════════════════════════
   SLASH COMMAND MENU
   Type "/" in the rendered editor to insert or convert a block,
   so structure never requires a trip to the code view.
═══════════════════════════════════════════════════════════ */

const _ICON = {
  // feather-style, matching the format toolbar: 24-box, 2.5 stroke, round caps
  text:    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="14" y2="17"/></svg>',
  quote:   '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>',
  ul:      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1" fill="currentColor" stroke="none"/></svg>',
  ol:      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4" stroke-width="2"/><path d="M4 10h2" stroke-width="2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" stroke-width="2"/></svg>',
  code:    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  divider: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="3" y1="12" x2="21" y2="12"/></svg>',
};

const _SLASH_COMMANDS = [
  { fmt: 'p',          label: 'Text',          hint: 'Plain paragraph',  icon: _ICON.text,    keys: 'text paragraph plain body' },
  { fmt: 'h1',         label: 'Heading 1',     hint: 'Large title',      icon: 'H1',          keys: 'heading title h1 large' },
  { fmt: 'h2',         label: 'Heading 2',     hint: 'Section title',    icon: 'H2',          keys: 'heading subtitle h2 section' },
  { fmt: 'h3',         label: 'Heading 3',     hint: 'Sub-section',      icon: 'H3',          keys: 'heading h3 subsection' },
  { fmt: 'ul',         label: 'Bulleted list', hint: 'Unordered list',   icon: _ICON.ul,      keys: 'bullet list unordered ul item' },
  { fmt: 'ol',         label: 'Numbered list', hint: 'Ordered list',     icon: _ICON.ol,      keys: 'number list ordered ol steps' },
  { fmt: 'blockquote', label: 'Quote',         hint: 'Callout or cite',  icon: _ICON.quote,   keys: 'quote blockquote callout cite' },
  { fmt: 'fenced',     label: 'Code block',    hint: 'Fenced code',      icon: _ICON.code,    keys: 'code block fenced snippet pre' },
  { fmt: 'hr',         label: 'Divider',       hint: 'Horizontal rule',  icon: _ICON.divider, keys: 'divider rule separator hr line' },
];

// null when closed; otherwise the text node + offsets of the live "/query"
let _slash = null;
let _slashIndex = 0;

function _slashMatches(query) {
  if (!query) return _SLASH_COMMANDS;
  const q = query.toLowerCase();
  return _SLASH_COMMANDS.filter(c => c.keys.includes(q) || c.label.toLowerCase().includes(q));
}

// Called on every input. Opens, filters, or closes the menu based on whether the
// caret still sits just after a "/query" token.
function _updateSlashMenu() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return _closeSlashMenu();

  const range = sel.getRangeAt(0);
  const node  = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return _closeSlashMenu();
  if (_findInPreview(node, 'pre')) return _closeSlashMenu(); // literal "/" in code

  // "/" must open a token: at block start, or after whitespace
  const before = node.textContent.slice(0, range.startOffset);
  const m = before.match(/(?:^|\s)\/([A-Za-z0-9]*)$/);
  if (!m) return _closeSlashMenu();

  _slash = { node, start: range.startOffset - m[1].length - 1, end: range.startOffset, query: m[1] };
  _slashIndex = 0;
  _renderSlashMenu();
}

function _renderSlashMenu() {
  const items = _slashMatches(_slash.query);
  _slashIndex = Math.min(_slashIndex, Math.max(0, items.length - 1));

  dom.slashMenuList.innerHTML = items.map((c, i) => `
    <button type="button" class="slash-item${i === _slashIndex ? ' active' : ''}"
            role="option" aria-selected="${i === _slashIndex}" data-fmt="${c.fmt}">
      <span class="slash-item-icon">${c.icon}</span>
      <span><span class="slash-item-label">${c.label}</span>
      <span class="slash-item-hint">${c.hint}</span></span>
    </button>`).join('');

  dom.slashMenuEmpty.classList.toggle('hidden', items.length > 0);
  dom.slashMenu.classList.remove('hidden');
  _positionSlashMenu();
}

function _positionSlashMenu() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  let rect = sel.getRangeAt(0).getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) {
    const block = _getContainingBlock(sel.getRangeAt(0).startContainer);
    if (block) rect = block.getBoundingClientRect();
  }
  if (!rect) return;

  const menu = dom.slashMenu.getBoundingClientRect();
  const GAP  = 8;
  // Flip above the caret when the menu would run off the bottom
  let top = rect.bottom + GAP;
  if (top + menu.height > window.innerHeight - 8) top = Math.max(8, rect.top - menu.height - GAP);
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - menu.width - 8);

  dom.slashMenu.style.top  = top + 'px';
  dom.slashMenu.style.left = left + 'px';
}

function _closeSlashMenu() {
  _slash = null;
  dom.slashMenu.classList.add('hidden');
}

// Remove the typed "/query", then apply the chosen block format.
function _runSlashCommand(fmt) {
  if (!_slash) return;
  const { node, start, end } = _slash;
  _closeSlashMenu();

  try { node.deleteData(start, end - start); } catch (_) { return; }

  const block = _getContainingBlock(node);
  const r = document.createRange();
  if (block && !block.textContent) {
    // Deleting the token emptied the block. An empty text node has no rendered
    // caret position, so Chrome relocates the selection into the PREVIOUS block
    // and formats that one instead — a <br> gives the caret somewhere to live.
    block.innerHTML = '<br>';
    r.setStart(block, 0);
  } else {
    r.setStart(node, start);
  }
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(r);
  if (fmt === 'hr') {
    const hr = document.createElement('hr');
    const p  = document.createElement('p');
    p.appendChild(document.createElement('br'));
    block ? block.replaceWith(hr, p) : dom.previewPane.appendChild(hr);
    _selectContents(p);
  } else if (fmt === 'p') {
    document.execCommand('formatBlock', false, 'p');
  } else if (fmt === 'ul' || fmt === 'ol') {
    _toggleList(fmt);
  } else if (fmt === 'fenced') {
    _toggleFencedCode();
  } else {
    document.execCommand('formatBlock', false, fmt);
  }

  dom.previewPane.focus();
  _syncDomToCodeEditor();
}

// Arrow / Enter / Escape while the menu is open. Returns true if consumed.
function _slashMenuKeydown(e) {
  if (!_slash) return false;
  const items = _slashMatches(_slash.query);

  if (e.key === 'Escape') { _closeSlashMenu(); return true; }
  if (!items.length) return false;

  if (e.key === 'ArrowDown') { _slashIndex = (_slashIndex + 1) % items.length;             _renderSlashMenu(); return true; }
  if (e.key === 'ArrowUp')   { _slashIndex = (_slashIndex - 1 + items.length) % items.length; _renderSlashMenu(); return true; }
  if (e.key === 'Enter' || e.key === 'Tab') { _runSlashCommand(items[_slashIndex].fmt); return true; }
  return false;
}

// Markdown prefixes that convert the current block when followed by a space.
const _MD_PREFIX = {
  '#': 'h1', '##': 'h2', '###': 'h3',
  '>': 'blockquote', '-': 'ul', '*': 'ul', '1.': 'ol',
};

// Medium-style autoformat. Returns true if the space was consumed applying a
// format, false to let it type normally.
function _tryMarkdownShortcut() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;

  const range = sel.getRangeAt(0);
  const block = _getContainingBlock(range.startContainer);
  if (!block || block.closest('pre')) return false;

  // Text between the block start and the caret — the candidate marker
  const probe = document.createRange();
  probe.selectNodeContents(block);
  try { probe.setEnd(range.startContainer, range.startOffset); } catch (_) { return false; }

  const fmt = _MD_PREFIX[probe.toString()];
  if (!fmt || block.tagName.toLowerCase() === fmt) return false;

  probe.deleteContents(); // drop the marker chars, caret stays at block start
  if (fmt === 'ul')      document.execCommand('insertUnorderedList');
  else if (fmt === 'ol') document.execCommand('insertOrderedList');
  else                   document.execCommand('formatBlock', false, fmt);

  _syncDomToCodeEditor();
  return true;
}

// Walk up from `node` to find the first ancestor matching `selector`
// that is still inside the preview pane.
function _findInPreview(node, selector) {
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && el !== dom.previewPane) {
    if (el.matches && el.matches(selector)) return el;
    el = el.parentElement;
  }
  return null;
}

// Return the nearest block-level ancestor of `node` inside the preview pane.
function _getContainingBlock(node) {
  return _findInPreview(node, 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,div');
}

// Toggle H1/H2/H3: if already that level, revert to <p>; otherwise apply.
function _toggleHeading(level) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const block = _getContainingBlock(sel.getRangeAt(0).startContainer);
  const current = block?.tagName?.toLowerCase();
  document.execCommand('formatBlock', false, current === level ? 'p' : level);
}

// Toggle blockquote: unwrap if inside one, wrap if not.
function _toggleBlockquoteDom() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const bq = _findInPreview(sel.getRangeAt(0).startContainer, 'blockquote');
  if (bq) {
    // Unwrap — lift children out of the blockquote
    const frag = document.createDocumentFragment();
    while (bq.firstChild) frag.appendChild(bq.firstChild);
    bq.replaceWith(frag);
  } else {
    document.execCommand('formatBlock', false, 'blockquote');
  }
}

// Toggle an inline wrapper element (code, mark, sub, sup).
// If the selection's ancestor IS already that element: remove the wrapper.
// Otherwise: wrap selection in that element via insertHTML.
// Unwrap `el`, lifting its children into its place. Keeps nested formatting.
function _unwrap(el) {
  const frag = document.createDocumentFragment();
  while (el.firstChild) frag.appendChild(el.firstChild);
  el.replaceWith(frag);
}

// Select `node`'s full contents so the caret lands sensibly after a transform.
function _selectContents(node) {
  const r = document.createRange();
  r.selectNodeContents(node);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

// Turn the current block into a list, or unwrap it.
//
// execCommand('insertUnorderedList') on an empty <p> produces <p><ul><li>…
// — an invalid nest that made the *previous* paragraph look like the first
// bullet once it round-tripped. Build the list directly in that case.
function _toggleList(type) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const start    = sel.getRangeAt(0).startContainer;
  const existing = _findInPreview(start, 'ul,ol');
  const block    = _getContainingBlock(start);

  if (!existing && block && !block.textContent.trim()) {
    const list = document.createElement(type);
    const li   = document.createElement('li');
    li.appendChild(document.createElement('br'));
    list.appendChild(li);
    block.replaceWith(list);
    const r = document.createRange();
    r.setStart(li, 0); r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
    return;
  }
  document.execCommand(type === 'ul' ? 'insertUnorderedList' : 'insertOrderedList');
}

// Leave the enclosing list or quote and start a plain paragraph after it.
// Enter alone only escapes an empty item; Ctrl/Cmd+Enter escapes from anywhere,
// which is the only way out when there is still text to the right of the caret.
function _escapeBlock() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return false;
  const start     = sel.getRangeAt(0).startContainer;
  const container = _findInPreview(start, 'blockquote,ul,ol');
  if (!container) return false;

  const block = _getContainingBlock(start);
  const p = document.createElement('p');
  p.appendChild(document.createElement('br'));
  container.insertAdjacentElement('afterend', p);

  // Drop whatever empty shell we were sitting in
  if (block && block !== container && !block.textContent.trim()) block.remove();
  if (!container.textContent.trim()) container.remove();

  const r = document.createRange();
  r.setStart(p, 0); r.collapse(true);
  sel.removeAllRanges(); sel.addRange(r);
  dom.previewPane.focus();
  _syncDomToCodeEditor();
  return true;
}

// Toggle an inline wrapper (code, mark, sub, sup).
//
// The old version rebuilt the selection from range.toString() via insertHTML,
// which threw away every nested element — applying <mark> over bold text
// silently deleted the <strong>. extractContents() moves the real nodes, so
// formats compose instead of overwriting each other.
function _toggleInlineElement(tag) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const existing = _findInPreview(range.commonAncestorContainer, tag);

  if (existing) {
    _unwrap(existing);          // toggle OFF, nested markup survives
    return;
  }
  if (range.collapsed) return;

  const el = document.createElement(tag);
  try {
    el.appendChild(range.extractContents()); // moves nodes, preserves nesting
    range.insertNode(el);
  } catch (_) {
    return; // range spanned block boundaries — leave the document untouched
  }
  _selectContents(el);
}

// Toggle a fenced code block. Inside one → back to a paragraph; otherwise wrap
// the selection. Previously this only ever inserted, so pressing the button on
// an existing code block nested another one inside it.
function _toggleFencedCode() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;

  const pre = _findInPreview(sel.getRangeAt(0).commonAncestorContainer, 'pre');
  if (pre) {
    // Toggle OFF: each source line becomes its own paragraph
    const lines = pre.textContent.replace(/\n+$/, '').split('\n');
    const frag  = document.createDocumentFragment();
    for (const line of lines.length ? lines : ['']) {
      const p = document.createElement('p');
      p.textContent = line;
      if (!line) p.appendChild(document.createElement('br')); // keep it selectable
      frag.appendChild(p);
    }
    const first = frag.firstChild;
    pre.replaceWith(frag);
    if (first) _selectContents(first);
    return;
  }

  // Toggle ON: pull the selected blocks' text into one code block
  const range = sel.getRangeAt(0);
  const text  = range.toString() || '';
  const preEl = document.createElement('pre');
  const code  = document.createElement('code');
  code.textContent = text;
  preEl.appendChild(code);

  const block = _getContainingBlock(range.startContainer);
  if (range.collapsed && block) block.replaceWith(preEl); // empty block → code block
  else { range.deleteContents(); range.insertNode(preEl); }
  _selectContents(code);
}

// Find the source line range [startLine, endLine] (0-based) for the current selection.
// Uses data-source-line stamps placed by annotateRenderedBlocks().
function _getSelectionSourceLines(range) {
  // Walk up from a node to find the direct child of previewPane with data-source-line
  function findSourceBlock(node) {
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el && el.parentElement !== dom.previewPane) {
      el = el.parentElement;
    }
    return (el && el !== dom.previewPane && el.dataset?.sourceLine) ? el : null;
  }

  const startBlock = findSourceBlock(range.startContainer);
  const endBlock   = findSourceBlock(range.endContainer) || startBlock;
  if (!startBlock) return null;

  const startLine = parseInt(startBlock.dataset.sourceLine, 10) - 1; // 0-based

  // End line: last line of the endBlock = (next sibling's start line - 2), or last line
  const totalLines = dom.codeEditor.value.split('\n').length;
  let endLine;
  const nextSib = endBlock?.nextElementSibling;
  if (nextSib?.dataset?.sourceLine) {
    endLine = parseInt(nextSib.dataset.sourceLine, 10) - 2;
  } else {
    endLine = totalLines - 1;
  }

  return { startLine, endLine: Math.max(startLine, endLine) };
}

// Toggle a block-level prefix (e.g. '# ', '> ', '- ') on lines[startLine..endLine].
function _toggleBlockFormat(lines, prefix, startLine, endLine) {
  const allHave = lines
    .slice(startLine, endLine + 1)
    .every(l => l.startsWith(prefix));

  for (let i = startLine; i <= Math.min(endLine, lines.length - 1); i++) {
    lines[i] = allHave
      ? lines[i].slice(prefix.length)
      : prefix + lines[i];
  }
}

// Find `selectedText` in `source` and wrap/unwrap it with prefix/suffix.
// Returns null if the selected text can't be found in source.
//
// Toggle-off: checks ALL occurrences of selectedText for DIRECT adjacency with
// the format markers (i.e. the prefix sits immediately before the text and the
// suffix immediately after). This avoids accidentally consuming markers that
// belong to earlier/later spans when the source has repeated words.
//
// Single-char delimiters (*italic*) are disambiguated from doubled ones (**bold**)
// by confirming the outer character is not the same.
function _applyInlineFormat(source, selectedText, prefix, suffix) {
  if (!selectedText || !prefix) return null;

  // Try every occurrence — pick the first that is directly wrapped
  let searchFrom = 0;
  while (searchFrom <= source.length) {
    const idx = source.indexOf(selectedText, searchFrom);
    if (idx === -1) break;
    const end = idx + selectedText.length;

    const preStart = idx - prefix.length;
    const sufEnd   = end + suffix.length;

    if (preStart >= 0 && sufEnd <= source.length) {
      const pre = source.slice(preStart, idx);
      const suf = source.slice(end, sufEnd);

      if (pre === prefix && suf === suffix) {
        let valid = true;
        // Single-char marker: confirm it's not part of a doubled one (**bold**, ~~strike~~)
        if (prefix.length === 1) {
          const ch     = prefix[0];
          const before = preStart > 0           ? source[preStart - 1] : '';
          const after  = sufEnd   < source.length ? source[sufEnd]       : '';
          valid = (before !== ch && after !== ch);
        }
        if (valid) {
          // Toggle OFF — remove the immediately surrounding markers
          return source.slice(0, preStart) + selectedText + source.slice(sufEnd);
        }
      }
    }

    searchFrom = idx + 1;
  }

  // No directly-wrapped occurrence found → Toggle ON at the first occurrence
  const firstIdx = source.indexOf(selectedText);
  if (firstIdx === -1) return null;
  const firstEnd = firstIdx + selectedText.length;
  return source.slice(0, firstIdx) + prefix + selectedText + suffix + source.slice(firstEnd);
}


/* ═══════════════════════════════════════════════════════════
   EVENT WIRING
═══════════════════════════════════════════════════════════ */
function wireEvents() {
  dom.btnOpenFolder.addEventListener('click', openFolder);
  dom.btnOpenNew.addEventListener('click', openFolder);
  dom.btnTogglePanel.addEventListener('click', togglePanel);
  dom.btnUp.addEventListener('click', goUp);
  dom.btnNewFile.addEventListener('click', createNewFile);
  dom.btnNewFolder.addEventListener('click', createNewFolder);

  // Panel toolbar (folder name area) as drag-drop target — drops move item to parent directory
  dom.filePanelToolbar.addEventListener('dragover', e => {
    if (!_dragState || state.dirStack.length <= 1) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    dom.filePanelToolbar.classList.add('drag-over');
  });
  dom.filePanelToolbar.addEventListener('dragleave', e => {
    if (!dom.filePanelToolbar.contains(e.relatedTarget)) dom.filePanelToolbar.classList.remove('drag-over');
  });
  dom.filePanelToolbar.addEventListener('drop', e => {
    e.preventDefault();
    dom.filePanelToolbar.classList.remove('drag-over');
    if (!_dragState || state.dirStack.length <= 1) return;
    const parent = state.dirStack[state.dirStack.length - 2];
    const ds = _dragState;
    _dragState = null;
    requestMoveEntry(ds, parent.handle, parent.name);
  });
  dom.btnEditInline.addEventListener('click', toggleInlineEdit);
  dom.btnDuplicate.addEventListener('click', duplicateFile);
  dom.btnViewRendered.addEventListener('click', () => setView('rendered'));
  dom.btnViewSplit.addEventListener('click', () => setView('split'));
  dom.btnViewCode.addEventListener('click', () => setView('code'));
  dom.btnSave.addEventListener('click', saveFile);
  dom.btnExportPdf.addEventListener('click', exportToPDF);
  dom.btnFullscreen.addEventListener('click', toggleFullscreen);

  // Double-click toolbar filename → rename
  dom.fileNameDisplay.addEventListener('dblclick', startToolbarRename);
  dom.codeEditor.addEventListener('input',   onEditorInput);
  dom.codeEditor.addEventListener('scroll',  () => {
    dom.lineNumbers.scrollTop = dom.codeEditor.scrollTop;
    syncHighlightScroll();
  });
  dom.codeEditor.addEventListener('click',   updateLineNumbers);
  dom.codeEditor.addEventListener('keyup',   updateLineNumbers);

  // Search
  dom.searchInput.addEventListener('input', onSearchInput);
  dom.btnSearchClear.addEventListener('click', () => {
    exitSearch();
    dom.searchInput.focus();
  });

  // Match navigator
  dom.btnMatchPrev.addEventListener('click', matchNavPrev);
  dom.btnMatchNext.addEventListener('click', matchNavNext);
  dom.btnMatchClose.addEventListener('click', closeMatchNav);

  // Move modal
  dom.btnMoveCancel.addEventListener('click', () => { _pendingMove = null; _closeMoveModal(); });
  dom.btnMoveConfirm.addEventListener('click', () => { if (_pendingMove) _startSoftMove(); });
  dom.moveModal.addEventListener('click', e => {
    if (e.target === dom.moveModal) { _pendingMove = null; _closeMoveModal(); }
  });

  // Help / shortcuts modal
  dom.btnHelp.addEventListener('click', openHelp);
  dom.btnShortcutsClose.addEventListener('click', closeHelp);
  dom.shortcutsModal.addEventListener('click', e => {
    if (e.target === dom.shortcutsModal) closeHelp();
  });

  // Delete modal
  dom.btnDeleteCancel.addEventListener('click', () => {
    _pendingDelete = null;
    _closeDeleteModal();
  });
  dom.btnDeleteConfirm.addEventListener('click', () => {
    if (_pendingDelete) _startSoftDelete();
  });
  // Click the backdrop to cancel
  dom.deleteModal.addEventListener('click', e => {
    if (e.target === dom.deleteModal) {
      _pendingDelete = null;
      _closeDeleteModal();
    }
  });
}
