(function () {
  const STORAGE_KEY = 'url-builder:pattern';
  const $ = (id) => document.getElementById(id);
  const patternEl = $('pattern');
  const errorEl = $('error');
  const rowsEl = $('rows');
  const copyBtn = $('copy');
  const fetchBtn = $('fetch');
  const cancelBtn = $('cancel');
  const generateBtn = $('generate');
  const counterEl = $('counter');

  let urls = [];
  let controller = null; // set while a fetch run is in progress

  patternEl.value = localStorage.getItem(STORAGE_KEY) || '';

  function render() {
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
    copyBtn.disabled = fetchBtn.disabled = urls.length === 0;
    counterEl.textContent = '';
  }

  function setRunning(running) {
    generateBtn.disabled = running;
    fetchBtn.disabled = running || urls.length === 0;
    cancelBtn.disabled = !running;
  }

  function handleEvent(ev, progress) {
    const tr = $('row-' + ev.index);
    if (!tr) return;
    if (ev.type === 'start') {
      tr.classList.add('active');
    } else if (ev.type === 'done') {
      tr.classList.remove('active');
      tr.classList.toggle('error', !!ev.error);
      tr.querySelector('.title').textContent = ev.title || '';
      tr.querySelector('.status').textContent = ev.error ? ev.error : String(ev.status);
      progress.done++;
      counterEl.textContent = `${progress.done}/${urls.length}`;
    }
  }

  async function onFetch() {
    if (controller || urls.length === 0) return;
    render(); // reset Title/Status from any previous run
    controller = new AbortController();
    setRunning(true);
    errorEl.textContent = '';
    const progress = { done: 0 };
    counterEl.textContent = `0/${urls.length}`;
    try {
      const res = await fetch('/api/titles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
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
          if (line) handleEvent(JSON.parse(line), progress);
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') errorEl.textContent = 'Fetch failed: ' + err.message;
    } finally {
      // Clear any in-flight highlight left by cancel or a dropped stream.
      rowsEl.querySelectorAll('tr.active').forEach((tr) => tr.classList.remove('active'));
      controller = null;
      setRunning(false);
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
    urls = result.urls;
    render();
  }

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(urls.join('\n'));
      copyBtn.textContent = 'Copied!';
    } catch (e) {
      copyBtn.textContent = 'Copy failed';
    }
    setTimeout(() => (copyBtn.textContent = 'Copy all URLs'), 1200);
  }

  $('generate').addEventListener('click', onGenerate);
  patternEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') onGenerate(); });
  copyBtn.addEventListener('click', onCopy);
  fetchBtn.addEventListener('click', onFetch);
  cancelBtn.addEventListener('click', onCancel);
})();
