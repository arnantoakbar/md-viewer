/* ═══════════════════════════════════════════════════════════
   INLINE RENDERED EDITOR — TEST SUITE

   Covers every editing path through the contenteditable preview
   pane: round-trip fidelity, inline/block format toggles, format
   composition, block escape, lists, code blocks, the slash menu,
   markdown shortcuts, paste, and split view.

   Run from the browser console with a file open:
       runEditorTests()
   Returns { passed, failed, total, failures }.
═══════════════════════════════════════════════════════════ */

async function runEditorTests() {
  const R = [];
  const ok   = (name, pass, detail = '') => R.push({ name, pass, detail });
  const sel  = () => window.getSelection();
  const md   = () => dom.codeEditor.value.trim();
  const html = () => dom.previewPane.innerHTML;

  // ── helpers ────────────────────────────────────────────────
  const load = async (source) => {
    dom.codeEditor.value = source;
    await renderMarkdown(source);
    setView('rendered');
    dom.previewPane.focus();
  };
  const selectAll = (q) => {
    const el = dom.previewPane.querySelector(q);
    if (!el) return null;
    const r = document.createRange(); r.selectNodeContents(el);
    const s = sel(); s.removeAllRanges(); s.addRange(r);
    return el;
  };
  const caret = (q, offset) => {
    const el = dom.previewPane.querySelector(q);
    if (!el) return null;
    const node = el.firstChild || el;
    const r = document.createRange();
    r.setStart(node, Math.min(offset, node.nodeType === 3 ? node.textContent.length : node.childNodes.length));
    r.collapse(true);
    const s = sel(); s.removeAllRanges(); s.addRange(r);
    return el;
  };
  const caretEnd = (q) => {
    const el = dom.previewPane.querySelector(q);
    const node = el.lastChild || el;
    const r = document.createRange();
    r.setStart(node, node.nodeType === 3 ? node.textContent.length : node.childNodes.length);
    r.collapse(true);
    const s = sel(); s.removeAllRanges(); s.addRange(r);
    return el;
  };
  const enter = (opts = {}) => {
    const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...opts });
    dom.previewPane.dispatchEvent(e);
    if (!e.defaultPrevented) document.execCommand('insertParagraph');
    _flushPreviewSync();
  };

  /* ── 1. ROUND-TRIP FIDELITY ──────────────────────────────
     Rendering markdown and converting the DOM back must be lossless. */
  const roundTrips = {
    'h1/h2/h3':        '# One\n\n## Two\n\n### Three\n',
    'bold':            'A **bold** word.\n',
    'italic':          'A *slanted* word.\n',
    'strikethrough':   'A ~~struck~~ word.\n',
    'inline code':     'Run `npm test` now.\n',
    'highlight':       'A ==marked== word.\n',
    'superscript':     'E = mc^2^ here.\n',
    'subscript':       'Water is H~2~O.\n',
    'blockquote':      '> A quoted line.\n',
    'bullet list':     '- alpha\n- beta\n',
    'numbered list':   '1. first\n2. second\n',
    'fenced code':     '```js\nconst a = 1;\nconst b = 2;\n```\n',
    'link':            'Read [the docs](https://example.com).\n',
    'image':           '![alt text](img.png)\n',
    'divider':         'Above\n\n---\n\nBelow\n',
    'table':           '| A | B |\n| --- | --- |\n| 1 | 2 |\n',
    'nested emphasis': 'A **bold with *italic* inside** here.\n',
    'multi paragraph': 'One.\n\nTwo.\n\nThree.\n',
    'code in heading': '### Head `code` tail\n',
    'quote with bold': '> Quoted **bold** text.\n',
  };
  for (const [name, source] of Object.entries(roundTrips)) {
    await renderMarkdown(source);
    const back = domToMarkdown(dom.previewPane).trim();
    ok(`round-trip: ${name}`, back === source.trim(),
       back === source.trim() ? '' : `want ${JSON.stringify(source.trim())} got ${JSON.stringify(back)}`);
  }

  /* ── 2. INLINE FORMAT TOGGLE ON → OFF ────────────────────
     Every inline format must apply and then fully remove itself. */
  const inline = [
    ['bold',          '**plain words**'],
    ['italic',        '*plain words*'],
    ['strikethrough', '~~plain words~~'],
    ['code',          '`plain words`'],
    ['highlight',     '==plain words=='],
    ['sub',           '~plain words~'],
    ['sup',           '^plain words^'],
  ];
  for (const [fmt, expected] of inline) {
    await load('plain words\n');
    selectAll('p');
    applyFormat(fmt);
    const applied = md();
    // re-select the produced wrapper and toggle off
    const wrapper = dom.previewPane.querySelector('p > *');
    if (wrapper) selectAll('p > *');
    applyFormat(fmt);
    ok(`inline ${fmt}: apply`, applied === expected, `got ${JSON.stringify(applied)}`);
    ok(`inline ${fmt}: remove`, md() === 'plain words', `got ${JSON.stringify(md())}`);
  }

  /* ── 3. BLOCK FORMAT TOGGLE ON → OFF ─────────────────────*/
  const blocks = [['h1', '# text'], ['h2', '## text'], ['h3', '### text'], ['blockquote', '> text']];
  for (const [fmt, expected] of blocks) {
    await load('text\n');
    caret('p', 0);
    applyFormat(fmt);
    const applied = md();
    const el = dom.previewPane.querySelector(fmt === 'blockquote' ? 'blockquote' : fmt);
    if (el) selectAll(fmt === 'blockquote' ? 'blockquote' : fmt);
    applyFormat(fmt);
    ok(`block ${fmt}: apply`, applied === expected, `got ${JSON.stringify(applied)}`);
    ok(`block ${fmt}: remove`, md() === 'text', `got ${JSON.stringify(md())}`);
  }

  /* ── 4. FORMAT COMPOSITION ───────────────────────────────
     Applying a second format must not destroy the first. */
  await load('compose me\n');
  selectAll('p'); applyFormat('bold');
  selectAll('p > b, p > strong'); applyFormat('highlight');
  ok('compose: bold + highlight', md() === '**==compose me==**', `got ${JSON.stringify(md())}`);
  selectAll('mark'); applyFormat('highlight');
  ok('compose: remove highlight keeps bold', md() === '**compose me**', `got ${JSON.stringify(md())}`);

  await load('stack\n');
  selectAll('p');            applyFormat('bold');
  selectAll('p > b, p > strong'); applyFormat('sup');
  selectAll('sup');          applyFormat('highlight');
  ok('compose: bold + sup + highlight', md() === '**^==stack==^**', `got ${JSON.stringify(md())}`);

  await load('### Heading text\n');
  selectAll('h3'); applyFormat('code');
  const act = _detectActiveFormats(sel().getRangeAt(0));
  ok('compose: code inside h3 keeps both', md() === '### `Heading text`', `got ${JSON.stringify(md())}`);
  ok('compose: toolbar reports code AND h3', act.has('code') && act.has('h3'), [...act].join(','));

  await load('### Heading text\n');
  selectAll('h3'); applyFormat('sup');
  ok('compose: sup inside h3', md() === '### ^Heading text^', `got ${JSON.stringify(md())}`);

  await load('### Heading text\n');
  selectAll('h3'); applyFormat('sub');
  ok('compose: sub inside h3', md() === '### ~Heading text~', `got ${JSON.stringify(md())}`);

  /* ── 5. CODE BLOCK ───────────────────────────────────────*/
  await load('```js\nconst a = 1;\n```\n');
  selectAll('pre code'); applyFormat('fenced');
  ok('code block: toggles off', !dom.previewPane.querySelector('pre'), html());
  ok('code block: text survives unwrap', md().includes('const a = 1;'), md());

  await load('plain line\n');
  selectAll('p'); applyFormat('fenced');
  ok('code block: toggles on', !!dom.previewPane.querySelector('pre'), html());

  await load('```js\nline one\n```\n');
  ok('code block: is editable', dom.previewPane.querySelector('pre').isContentEditable);
  {
    const code = dom.previewPane.querySelector('pre code');
    const t = code.firstChild;
    const r = document.createRange(); r.setStart(t, 'line one'.length); r.collapse(true);
    const s = sel(); s.removeAllRanges(); s.addRange(r);
    document.execCommand('insertLineBreak');
    document.execCommand('insertText', false, 'line two');
    _flushPreviewSync();
    ok('code block: multi-line edit keeps newline', /line one\nline two/.test(dom.codeEditor.value), JSON.stringify(dom.codeEditor.value));
  }

  /* ── 6. ESCAPING QUOTES AND LISTS ────────────────────────*/
  // Enter must NOT leave the quote — it keeps adding lines to the same one.
  // ArrowDown is the way out (covered in group 15).
  await load('> Quoted line.\n');
  caretEnd('blockquote p, blockquote');
  enter();
  enter();
  ok('escape: Enter keeps the caret inside the quote',
     !!_findInPreview(sel().anchorNode, 'blockquote'), html());

  await load('> Quoted line.\n');
  caret('blockquote p, blockquote', 3);
  enter({ ctrlKey: true });
  ok('escape: Ctrl+Enter leaves a quote mid-text',
     !_findInPreview(sel().anchorNode, 'blockquote'), html());

  await load('- one\n- two\n');
  {
    const li = dom.previewPane.querySelectorAll('li')[1];
    const r = document.createRange(); r.setStart(li.firstChild, 1); r.collapse(true);
    const s = sel(); s.removeAllRanges(); s.addRange(r);
    enter({ ctrlKey: true });
    ok('escape: Ctrl+Enter leaves a list mid-item',
       !_findInPreview(sel().anchorNode, 'ul'), html());
  }

  await load('- one\n- two\n');
  {
    const li = dom.previewPane.querySelectorAll('li')[1];
    const r = document.createRange(); r.setStart(li.firstChild, 1); r.collapse(true);
    const s = sel(); s.removeAllRanges(); s.addRange(r);
    enter();
    ok('list: Enter mid-item splits it', md() === '- one\n- t\n- wo', md());
  }

  /* ── 7. LIST CREATED BELOW EXISTING TEXT ─────────────────
     The paragraph above must not be swallowed into the list. */
  for (const [fmt, marker] of [['ul', '-'], ['ol', '1.']]) {
    await load('Normal text.\n');
    caretEnd('p');
    enter();                       // new empty block below
    applyFormat(fmt);
    _flushPreviewSync();
    ok(`list ${fmt}: below text keeps paragraph intact`,
       md().startsWith('Normal text.') && md().includes(marker), md());
    ok(`list ${fmt}: no <ul> nested inside <p>`,
       !/<p[^>]*>\s*<(ul|ol)/i.test(html()), html());
  }

  /* ── 8. SLASH MENU ───────────────────────────────────────*/
  const openSlash = async (query = '') => {
    await load('# Doc\n\nBody text.\n');
    const p = document.createElement('p');
    p.textContent = '/' + query;
    dom.previewPane.appendChild(p);
    const r = document.createRange();
    r.setStart(p.firstChild, query.length + 1); r.collapse(true);
    const s = sel(); s.removeAllRanges(); s.addRange(r);
    _updateSlashMenu();
  };
  await openSlash();
  ok('slash: opens with all commands',
     !dom.slashMenu.classList.contains('hidden') && dom.slashMenuList.querySelectorAll('.slash-item').length === 9);
  await openSlash('quo');
  ok('slash: filters to Quote',
     dom.slashMenuList.querySelectorAll('.slash-item').length === 1);
  await openSlash('zzzz');
  ok('slash: shows empty state',
     !dom.slashMenuEmpty.classList.contains('hidden'));

  const slashExpect = {
    h1: '#', h2: '##', h3: '###', ul: '-', ol: '1.',
    blockquote: '>', fenced: '```', hr: '---',
  };
  for (const [cmd, marker] of Object.entries(slashExpect)) {
    await openSlash();
    const items = _slashMatches('');
    _slashIndex = items.findIndex(c => c.fmt === cmd);
    _slashMenuKeydown({ key: 'Enter' });
    _flushPreviewSync();
    ok(`slash: ${cmd} inserts ${marker}`, md().includes(marker), md());
    ok(`slash: ${cmd} preserves the document above`,
       md().startsWith('# Doc') && md().includes('Body text.'), md());
  }
  await openSlash();
  _slashMenuKeydown({ key: 'Escape' });
  ok('slash: Escape dismisses', dom.slashMenu.classList.contains('hidden'));

  /* ── 9. MARKDOWN SHORTCUTS ───────────────────────────────*/
  for (const [marker, tag] of [['#','h1'], ['##','h2'], ['###','h3'], ['>','blockquote'], ['-','ul'], ['1.','ol']]) {
    dom.previewPane.innerHTML = `<p>${marker}</p>`;
    caret('p', marker.length);
    const consumed = _tryMarkdownShortcut();
    ok(`shortcut: "${marker} " → ${tag}`,
       consumed && dom.previewPane.firstElementChild.tagName.toLowerCase() === tag,
       dom.previewPane.innerHTML);
  }
  dom.previewPane.innerHTML = '<p>text #</p>';
  caret('p', 6);
  ok('shortcut: marker mid-sentence is ignored', !_tryMarkdownShortcut());

  /* ── 10. PASTE ───────────────────────────────────────────*/
  await load('start\n');
  caretEnd('p');
  {
    const dt = new DataTransfer();
    dt.setData('text/plain', ' PLAIN');
    dt.setData('text/html', '<b style="color:red" class="x">RICH</b>');
    const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    dom.previewPane.dispatchEvent(e);
    ok('paste: inserts plain text', dom.previewPane.textContent.includes('PLAIN'));
    ok('paste: strips inline styles', !/style=/i.test(html()), html());
  }

  /* ── 11. TYPING STABILITY ────────────────────────────────*/
  dom.previewPane.innerHTML = '<p>hello world</p>';
  caret('p', 5);
  document.execCommand('insertParagraph');
  ok('typing: Enter splits into two paragraphs',
     dom.previewPane.querySelectorAll('p').length === 2, html());

  await load('one\n');
  dom.previewPane.innerHTML = '<p>one</p><div>two</div><p>three</p>';
  ok('typing: contenteditable <div> becomes a paragraph break',
     domToMarkdown(dom.previewPane).trim() === 'one\n\ntwo\n\nthree',
     JSON.stringify(domToMarkdown(dom.previewPane)));

  /* ── 12. SPLIT VIEW ──────────────────────────────────────*/
  await load('# Title\n\nBody.\n');
  setView('split');
  await new Promise(r => setTimeout(r, 150));
  {
    const pw = dom.previewPane.getBoundingClientRect().width;
    const cw = dom.codePane.getBoundingClientRect().width;
    ok('split: panes are even', Math.abs(pw - cw) <= 8, `${Math.round(pw)}/${Math.round(cw)}`);
    ok('split: prose gutter stays sane',
       parseFloat(getComputedStyle(dom.previewPane).paddingLeft) < 40,
       getComputedStyle(dom.previewPane).paddingLeft);

    dom.previewPane.querySelector('p').textContent = 'Edited live';
    _flushPreviewSync();
    ok('split: edits reach the code pane', dom.codeEditor.value.includes('Edited live'));

    // A double-click must not steal focus, or the format toolbar vanishes.
    // Focus the pane first: a synthetic MouseEvent does not move focus itself.
    dom.previewPane.focus();
    selectAll('p');
    dom.previewPane.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 200, clientY: 200 }));
    ok('split: dblclick keeps focus in the preview',
       document.activeElement !== dom.codeEditor, document.activeElement?.id || '');
    ok('split: dblclick keeps the selection alive',
       !!window.getSelection().toString(), 'selection lost');
  }
  setView('rendered');

  /* ── 13. TOOLBAR STATE DETECTION ─────────────────────────*/
  await load('A **bold** word.\n');
  selectAll('strong, b');
  ok('toolbar: detects bold', _detectActiveFormats(sel().getRangeAt(0)).has('bold'));
  await load('> Quoted.\n');
  selectAll('blockquote p, blockquote');
  {
    const a = _detectActiveFormats(sel().getRangeAt(0));
    ok('toolbar: detects blockquote', a.has('blockquote'));
    ok('toolbar: quote is NOT reported italic (styling only)', !a.has('italic'), [...a].join(','));
  }

  /* ── 14. LIST STARTED UNDER AN EXISTING SENTENCE ─────────
     Enter then bullet must make a NEW empty item, never convert
     the sentence above it. */
  for (const [fmt, marker] of [['ul', '-'], ['ol', '1.']]) {
    await load('A sentence.\n');
    caretEnd('p');
    document.execCommand('insertParagraph');
    applyFormat(fmt);
    _flushPreviewSync();
    ok(`list ${fmt}: sentence above stays a paragraph`,
       md().startsWith('A sentence.') && md().includes(marker) && !md().startsWith(marker), md());
    ok(`list ${fmt}: valid markup, no <ul> inside <p>`,
       !/<p[^>]*>\s*<(ul|ol)/i.test(html()), html());
  }

  // Converting a sentence directly is still allowed and must stay valid markup
  await load('Convert me.\n');
  selectAll('p'); applyFormat('ul'); _flushPreviewSync();
  ok('list: direct convert produces valid markup',
     md() === '- Convert me.' && !/<p[^>]*>\s*<ul/i.test(html()), md() + ' | ' + html());
  applyFormat('ul'); _flushPreviewSync();
  ok('list: converting back removes the list', md() === 'Convert me.', md());

  /* ── 15. QUOTE CONTINUES ON ENTER, ARROWDOWN ESCAPES ─────*/
  await load('> First line.\n');
  caretEnd('blockquote p, blockquote');
  enter();
  document.execCommand('insertText', false, 'Second line.');
  _flushPreviewSync();
  ok('quote: Enter keeps writing in the SAME quote',
     dom.previewPane.querySelectorAll('blockquote').length === 1, html());
  ok('quote: serializes without a quote-breaking blank run',
     !/>\s*\n>\s*\n>/.test(dom.codeEditor.value) && md().includes('Second line.'),
     JSON.stringify(dom.codeEditor.value));
  {
    // the markdown must re-render as one quote, not two
    const reHtml = DOMPurify.sanitize(marked.parse(dom.codeEditor.value));
    const probe = document.createElement('div'); probe.innerHTML = reHtml;
    ok('quote: round-trips back to a single blockquote',
       probe.querySelectorAll('blockquote').length === 1, reHtml);
  }

  await load('> Quoted.\n');
  caretEnd('blockquote p, blockquote');
  {
    const e = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    dom.previewPane.dispatchEvent(e);
    ok('quote: ArrowDown at the end escapes it', e.defaultPrevented &&
       !_findInPreview(sel().anchorNode, 'blockquote'), html());
  }

  await load('```js\nconst a = 1;\n```\n');
  {
    const code = dom.previewPane.querySelector('pre code');
    _caretIn(code, true);
    const e = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    dom.previewPane.dispatchEvent(e);
    ok('code block: ArrowDown at the end escapes it', e.defaultPrevented &&
       !_findInPreview(sel().anchorNode, 'pre'), html());
  }

  /* ── 16. CODE BLOCK TEXT IS READABLE ─────────────────────*/
  await load('Plain.\n');
  selectAll('p'); applyFormat('fenced');
  {
    const pre = dom.previewPane.querySelector('pre');
    const parse = c => c.match(/[\d.]+/g).map(Number);
    const srgb = v => { v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4); };
    const L = c => { const [r,g,b] = parse(c); return 0.2126*srgb(r)+0.7152*srgb(g)+0.0722*srgb(b); };
    const contrast = (a,b) => (Math.max(L(a),L(b))+0.05)/(Math.min(L(a),L(b))+0.05);
    // text dropped straight into <pre> used to inherit charcoal and vanish
    ok('code block: <pre> itself carries readable text colour',
       contrast(getComputedStyle(pre).color, getComputedStyle(pre).backgroundColor) >= 4.5,
       getComputedStyle(pre).color + ' on ' + getComputedStyle(pre).backgroundColor);
    ok('code block: <code> is readable too',
       contrast(getComputedStyle(pre.querySelector('code')).color, getComputedStyle(pre).backgroundColor) >= 4.5);
  }

  /* ── 17. AUTOFORMAT UNDO ON BACKSPACE ────────────────────*/
  for (const [marker, tag] of [['#','h1'], ['##','h2'], ['-','ul'], ['1.','ol'], ['>','blockquote']]) {
    dom.previewPane.innerHTML = `<p>${marker}</p>`;
    caret('p', marker.length);
    _tryMarkdownShortcut();
    const became = dom.previewPane.firstElementChild.tagName.toLowerCase() === tag;
    const e = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
    dom.previewPane.dispatchEvent(e);
    _flushPreviewSync();
    ok(`autoformat "${marker}": applies then Backspace reverts it`,
       became && e.defaultPrevented && dom.previewPane.firstElementChild.tagName.toLowerCase() === 'p'
       && dom.previewPane.textContent.trim().startsWith(marker),
       `became=${became} now=${html()}`);
  }
  // Typing something else must commit the autoformat
  dom.previewPane.innerHTML = '<p>#</p>';
  caret('p', 1);
  _tryMarkdownShortcut();
  dom.previewPane.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
  {
    const e = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
    dom.previewPane.dispatchEvent(e);
    ok('autoformat: a later Backspace does NOT revert it',
       !e.defaultPrevented && dom.previewPane.firstElementChild.tagName.toLowerCase() === 'h1', html());
  }

  /* ── 18. CLEAR FORMATTING ────────────────────────────────*/
  await load('Some **bold** and *italic* text.\n');
  {
    const r = document.createRange();
    r.selectNodeContents(dom.previewPane.querySelector('p'));
    const s2 = sel(); s2.removeAllRanges(); s2.addRange(r);
    applyFormat('clear');
    _flushPreviewSync();
    ok('clear: strips every inline mark', md() === 'Some bold and italic text.', md());
  }
  await load('A ==marked== and `code` run.\n');
  {
    const r = document.createRange();
    r.selectNodeContents(dom.previewPane.querySelector('p'));
    const s2 = sel(); s2.removeAllRanges(); s2.addRange(r);
    applyFormat('clear');
    _flushPreviewSync();
    ok('clear: strips non-standard wrappers too', md() === 'A marked and code run.', md());
  }

  /* ── 19. SLASH MENU KEEPS THE ACTIVE ROW IN VIEW ─────────*/
  await openSlash();
  {
    const listEl = dom.slashMenuList;
    for (let i = 0; i < 8; i++) _slashMenuKeydown({ key: 'ArrowDown' });
    const active = listEl.querySelector('.slash-item.active');
    const lr = listEl.getBoundingClientRect(), ar = active.getBoundingClientRect();
    ok('slash: arrow navigation scrolls the active row into view',
       ar.top >= lr.top - 1 && ar.bottom <= lr.bottom + 1,
       `item ${Math.round(ar.top)}-${Math.round(ar.bottom)} vs list ${Math.round(lr.top)}-${Math.round(lr.bottom)}`);
  }
  _closeSlashMenu();

  const failures = R.filter(r => !r.pass);
  return {
    passed: R.length - failures.length,
    failed: failures.length,
    total: R.length,
    failures,
  };
}

if (typeof window !== 'undefined') window.runEditorTests = runEditorTests;
