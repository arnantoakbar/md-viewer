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
};

const PREF_KEY = 'mdviewer-prefs';


/* ═══════════════════════════════════════════════════════════
   DOM REFERENCES
═══════════════════════════════════════════════════════════ */
const dom = {};

function cacheDom() {
  const ids = [
    'landing', 'app',
    'btn-open-folder', 'btn-open-new', 'btn-toggle-panel',
    'btn-up', 'btn-view-rendered', 'btn-view-code',
    'btn-save', 'btn-fullscreen', 'icon-fullscreen',
    'panel-left', 'resize-handle', 'panel-right',
    'file-list', 'file-list-empty', 'current-dir-name',
    'breadcrumb',
    'preview-pane', 'preview-empty', 'code-pane', 'code-editor', 'code-highlight', 'line-numbers',
    'file-name-display', 'dirty-indicator',
    'api-unsupported', 'toast-container',
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

  if (!('showDirectoryPicker' in window)) {
    dom.apiUnsupported.classList.remove('hidden');
    dom.btnOpenFolder.disabled = true;
    dom.btnOpenFolder.title = 'File System Access API not supported in this browser';
  }

  wireEvents();
  initResizeHandle();
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

    state.rootDirHandle    = handle;
    state.currentDirHandle = handle;
    state.dirStack         = [{ handle, name: handle.name }];
    state.currentFileHandle = null;
    state.isDirty           = false;

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

  if (allEntries.length === 0) {
    dom.fileListEmpty.classList.remove('hidden');
  } else {
    const fragment = document.createDocumentFragment();
    allEntries.forEach(({ name, handle }) => {
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

  el.addEventListener('click', () => {
    if (handle.kind === 'directory') {
      enterDirectory(handle, name);
    } else {
      openFile(handle, name, el);
    }
  });

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
  state.currentFileHandle = null;
  state.isDirty = false;
  dom.fileNameDisplay.textContent = 'No file open';
  dom.dirtyIndicator.classList.add('hidden');
  dom.btnSave.classList.add('hidden');
  dom.previewEmpty.classList.remove('hidden');
  dom.previewPane.innerHTML = '';
  dom.previewPane.appendChild(dom.previewEmpty);
  dom.codeEditor.value = '';
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
    dom.dirtyIndicator.classList.add('hidden');
    dom.btnSave.classList.add('hidden');
    dom.codeEditor.value = content;
    dom.lineNumbers._count = null; // force rebuild on next updateLineNumbers()

    renderMarkdown(content);
    setView(state.currentView);
    updateLineNumbers();
    updateCodeHighlight();

  } catch (err) {
    showToast('Could not read file: ' + err.message, 'error');
  }
}

function renderMarkdown(content) {
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

  // DOMPurify: allow class attrs so highlight.js styling is preserved
  const safeHtml = DOMPurify.sanitize(rawHtml, {
    ADD_ATTR: ['class'],
    ALLOW_DATA_ATTR: false,
  });

  dom.previewPane.innerHTML = safeHtml;

  // Syntax highlight code blocks and stamp language label on <pre>
  dom.previewPane.querySelectorAll('pre code').forEach(block => {
    try { hljs.highlightElement(block); } catch (_) {}
    const lang = [...block.classList]
      .find(c => c.startsWith('language-'))
      ?.replace('language-', '') ?? 'code';
    block.closest('pre').dataset.lang = lang;
  });

  // Stamp each block with its source line so scroll sync can find it
  annotateRenderedBlocks(content);

  dom.previewPane.scrollTop = 0;
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
function setView(view) {
  if (view === state.currentView && state.currentFileHandle) {
    // Same view — just ensure line numbers are up to date
    if (view === 'code') updateLineNumbers();
    return;
  }

  // Capture scroll position from the CURRENTLY VISIBLE pane before switching
  const syncLine = state.currentFileHandle
    ? (state.currentView === 'rendered' ? getRenderedScrollLine() : getCodeScrollLine())
    : 1;

  state.currentView = view;
  const isRendered = view === 'rendered';

  dom.previewPane.classList.toggle('hidden', !isRendered);
  dom.codePane.classList.toggle('hidden',    isRendered);
  dom.btnViewRendered.classList.toggle('active',  isRendered);
  dom.btnViewCode.classList.toggle('active',     !isRendered);

  if (state.currentFileHandle) {
    if (isRendered) {
      // Re-render from textarea so unsaved edits appear live
      renderMarkdown(dom.codeEditor.value);
      // Scroll after the browser has laid out the new content
      requestAnimationFrame(() => scrollPreviewToLine(syncLine));
    } else {
      updateLineNumbers();
      requestAnimationFrame(() => scrollCodeToLine(syncLine));
    }
  }

  savePreferences();
}


/* ═══════════════════════════════════════════════════════════
   EDITOR & SAVE
═══════════════════════════════════════════════════════════ */
function onEditorInput() {
  if (!state.currentFileHandle) return;
  if (!state.isDirty) {
    state.isDirty = true;
    dom.dirtyIndicator.classList.remove('hidden');
    dom.btnSave.classList.remove('hidden');
  }
  updateLineNumbers();
  updateCodeHighlight();
}

async function saveFile() {
  if (!state.currentFileHandle) return;
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
      renderMarkdown(content);
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
      currentView:      state.currentView,
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

  // Apply view (but don't render — no file loaded yet)
  dom.btnViewRendered.classList.toggle('active', state.currentView === 'rendered');
  dom.btnViewCode.classList.toggle('active', state.currentView === 'code');
  dom.previewPane.classList.toggle('hidden', state.currentView !== 'rendered');
  dom.codePane.classList.toggle('hidden', state.currentView !== 'code');
}


/* ═══════════════════════════════════════════════════════════
   KEYBOARD SHORTCUTS
═══════════════════════════════════════════════════════════ */
function wireKeyboard() {
  document.addEventListener('keydown', e => {
    const meta = e.ctrlKey || e.metaKey;

    // Save: Ctrl/Cmd + S
    if (meta && e.key === 's') {
      e.preventDefault();
      saveFile();
      return;
    }

    // Toggle panel: Ctrl/Cmd + B
    if (meta && e.key === 'b') {
      e.preventDefault();
      if (dom.app.classList.contains('hidden')) return;
      togglePanel();
      return;
    }

    // Fullscreen: F11
    if (e.key === 'F11') {
      e.preventDefault();
      if (dom.app.classList.contains('hidden')) return;
      toggleFullscreen();
      return;
    }

    // Exit fullscreen: Escape
    if (e.key === 'Escape' && state.isFullscreen) {
      toggleFullscreen();
      return;
    }
  });
}


/* ═══════════════════════════════════════════════════════════
   EVENT WIRING
═══════════════════════════════════════════════════════════ */
function wireEvents() {
  dom.btnOpenFolder.addEventListener('click', openFolder);
  dom.btnOpenNew.addEventListener('click', openFolder);
  dom.btnTogglePanel.addEventListener('click', togglePanel);
  dom.btnUp.addEventListener('click', goUp);
  dom.btnViewRendered.addEventListener('click', () => setView('rendered'));
  dom.btnViewCode.addEventListener('click', () => setView('code'));
  dom.btnSave.addEventListener('click', saveFile);
  dom.btnFullscreen.addEventListener('click', toggleFullscreen);
  dom.codeEditor.addEventListener('input',   onEditorInput);
  dom.codeEditor.addEventListener('scroll',  () => {
    dom.lineNumbers.scrollTop = dom.codeEditor.scrollTop;
    syncHighlightScroll();
  });
  dom.codeEditor.addEventListener('click',   updateLineNumbers);
  dom.codeEditor.addEventListener('keyup',   updateLineNumbers);
}
