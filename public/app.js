(function () {
  const STORAGE_KEY = 'url-builder:pattern';
  const CR_COUNT = 30;
  const $ = (id) => document.getElementById(id);
  const patternEl = $('pattern');
  const errorEl = $('error');
  const rowsEl = $('rows');
  const copyBtn = $('copy');
  const crBtn = $('cr30');
  const fetchBtn = $('fetch');
  const cancelBtn = $('cancel');
  const generateBtn = $('generate');
  const counterEl = $('counter');
  const filterEl = $('filter');
  const shownEl = $('shown');

  let controller = null; // set while a fetch run is in progress

  patternEl.value = localStorage.getItem(STORAGE_KEY) || '';

  // The table is the source of truth: removed rows are gone, and each row keeps
  // the # it was generated with.
  const liveRows = () => Array.from(rowsEl.children);
  const rowUrl = (tr) => tr.querySelector('.url').textContent;

  function updateButtons() {
    const empty = rowsEl.children.length === 0;
    const running = controller !== null;
    generateBtn.disabled = running;
    copyBtn.disabled = empty;
    crBtn.disabled = empty || running;
    fetchBtn.disabled = empty || running;
    cancelBtn.disabled = !running;
    filterEl.disabled = empty;
  }

  function render(urls) {
    const frag = document.createDocumentFragment();
    urls.forEach((url, i) => {
      const tr = document.createElement('tr');
      tr.id = 'row-' + i;
      for (const [cls, text] of [['num', i + 1], ['url', url], ['title', ''], ['status', '']]) {
        const td = document.createElement('td');
        td.className = cls;
        td.textContent = text;
        tr.appendChild(td);
      }
      frag.appendChild(tr);
    });
    rowsEl.replaceChildren(frag);
    counterEl.textContent = '';
    filterEl.value = '';
    shownEl.textContent = '';
    updateButtons();
  }

  // Clears Title/Status/highlights from a previous run, and the filter.
  function resetResults() {
    for (const tr of liveRows()) {
      tr.className = '';
      tr.hidden = false;
      tr.querySelector('.title').textContent = '';
      tr.querySelector('.status').textContent = '';
    }
    filterEl.value = '';
    shownEl.textContent = '';
    counterEl.textContent = '';
  }

  // Hide rows whose title doesn't contain the filter text (case-insensitive).
  // Only visibility changes: the # column keeps each row's original number.
  function applyFilter() {
    const needle = filterEl.value.trim().toLowerCase();
    const rows = liveRows();
    let shown = 0;
    for (const tr of rows) {
      const ok = !needle || tr.querySelector('.title').textContent.toLowerCase().includes(needle);
      tr.hidden = !ok;
      if (ok) shown++;
    }
    shownEl.textContent = needle ? `${shown}/${rows.length} shown` : '';
  }

  function handleEvent(ev, fetchRows, progress) {
    const tr = fetchRows[ev.index]; // index into the list of URLs sent
    if (!tr) return;
    if (ev.type === 'start') {
      tr.classList.add('active');
    } else if (ev.type === 'done') {
      tr.classList.remove('active');
      tr.classList.toggle('error', !!ev.error);
      tr.querySelector('.title').textContent = ev.title || '';
      tr.querySelector('.status').textContent = ev.error ? ev.error : String(ev.status);
      if (filterEl.value.trim()) applyFilter(); // new title may match (or not)
      progress.done++;
      counterEl.textContent = `${progress.done}/${fetchRows.length}`;
    }
  }

  async function onFetch() {
    const fetchRows = liveRows();
    if (controller || fetchRows.length === 0) return;
    resetResults();
    controller = new AbortController();
    updateButtons();
    errorEl.textContent = '';
    const progress = { done: 0 };
    counterEl.textContent = `0/${fetchRows.length}`;
    try {
      const res = await fetch('/api/titles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: fetchRows.map(rowUrl) }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Server error ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) handleEvent(JSON.parse(line), fetchRows, progress);
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') errorEl.textContent = 'Fetch failed: ' + err.message;
    } finally {
      // Clear any in-flight highlight left by cancel or a dropped stream.
      rowsEl.querySelectorAll('tr.active').forEach((tr) => tr.classList.remove('active'));
      controller = null;
      updateButtons();
    }
  }

  function onCancel() {
    if (controller) controller.abort();
  }

  function onGenerate() {
    const pattern = patternEl.value;
    localStorage.setItem(STORAGE_KEY, pattern);
    const result = UrlGenerator.generate(pattern);
    errorEl.textContent = result.error || '';
    if (result.error) return;
    render(result.urls);
  }

  function flash(btn, text, label) {
    btn.textContent = text;
    setTimeout(() => (btn.textContent = label), 1200);
  }

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(liveRows().map(rowUrl).join('\n'));
      flash(copyBtn, 'Copied!', 'Copy all URLs');
    } catch (e) {
      flash(copyBtn, 'Copy failed', 'Copy all URLs');
    }
  }

  // "CR 30": Copy the first 30 visible rows' URLs, then Remove those rows.
  // Rows are only removed once the copy succeeded, so nothing is lost on failure.
  async function onCr() {
    if (controller) return;
    const batch = liveRows().filter((tr) => !tr.hidden).slice(0, CR_COUNT);
    if (batch.length === 0) return;
    try {
      await navigator.clipboard.writeText(batch.map(rowUrl).join('\n'));
    } catch (e) {
      flash(crBtn, 'Copy failed', 'CR 30');
      return;
    }
    batch.forEach((tr) => tr.remove());
    if (filterEl.value.trim()) applyFilter();
    updateButtons();
    flash(crBtn, `Copied ${batch.length}`, 'CR 30');
  }

  generateBtn.addEventListener('click', onGenerate);
  patternEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') onGenerate(); });
  copyBtn.addEventListener('click', onCopy);
  crBtn.addEventListener('click', onCr);
  fetchBtn.addEventListener('click', onFetch);
  filterEl.addEventListener('input', applyFilter);
  cancelBtn.addEventListener('click', onCancel);
})();
