// Content script for web.whatsapp.com.
// Finds sticker images in the sticker panel, sends their pixels to the
// background page to be embedded, and overlays a search bar on the panel.

(() => {
  'use strict';

  // ---- WhatsApp DOM heuristics (the only part likely to break when WA changes) ----
  // Sticker panel images are blob:/whatsapp.net <img>s rendered as squares
  // between ~40px and ~220px, outside the chat list, headers and message list.
  const EXCLUDE_ANCESTORS = '#pane-side, header, [role="application"], [role="row"], [data-wss-host]';
  const MIN_PX = 40, MAX_PX = 220;
  const MIN_VISIBLE_TO_SHOW_BAR = 4;

  const SIZE = 224;  // CLIP input size
  const THUMB = 72;  // thumbnail stored for result grid

  const srcToHash = new Map();   // img src -> content hash
  const hashToImg = new Map();   // content hash -> latest live <img>
  const known = new Set();       // hashes already in the index
  let workQueue = [];
  let working = false;

  const send = (msg) => browser.runtime.sendMessage(msg);

  // ---------- detection ----------

  function isStickerImg(img) {
    const src = img.currentSrc || img.src || '';
    if (!src || !(src.startsWith('blob:') || src.includes('whatsapp.net'))) return false;
    if (src.includes('pps.whatsapp.net')) return false; // profile pictures
    if (img.closest(EXCLUDE_ANCESTORS)) return false;
    const r = img.getBoundingClientRect();
    if (r.width < MIN_PX || r.width > MAX_PX || r.height < MIN_PX) return false;
    if (Math.abs(r.width - r.height) > r.width * 0.25) return false;
    return true;
  }

  function scrollParent(el) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 4) return p;
    }
    return null;
  }

  function visibleCandidates() {
    return Array.from(document.images).filter(isStickerImg);
  }

  // ---------- capture + hashing ----------

  function waitLoaded(img) {
    if (img.complete && img.naturalWidth) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => resolve(!!img.naturalWidth);
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
      setTimeout(done, 4000);
    });
  }

  // Two 32-bit FNV-1a hashes with different seeds -> 64-bit hex id.
  function hashPixels(data) {
    let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x9e3779b9;
    for (let i = 0; i < data.length; i += 2) {
      h1 ^= data[i]; h1 = Math.imul(h1, 0x01000193);
      h2 ^= data[i + 1]; h2 = Math.imul(h2, 0x01000193);
    }
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  }

  async function capture(img) {
    if (!(await waitLoaded(img))) return null;
    const w = img.naturalWidth, h = img.naturalHeight;

    const c = document.createElement('canvas');
    c.width = c.height = SIZE;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff'; // stickers are transparent; CLIP prefers an opaque background
    ctx.fillRect(0, 0, SIZE, SIZE);
    const s = Math.min(SIZE / w, SIZE / h);
    ctx.drawImage(img, (SIZE - w * s) / 2, (SIZE - h * s) / 2, w * s, h * s);
    const pixels = ctx.getImageData(0, 0, SIZE, SIZE).data;

    const t = document.createElement('canvas');
    t.width = t.height = THUMB;
    const tctx = t.getContext('2d');
    const ts = Math.min(THUMB / w, THUMB / h);
    tctx.drawImage(img, (THUMB - w * ts) / 2, (THUMB - h * ts) / 2, w * ts, h * ts);
    const thumb = t.toDataURL('image/webp', 0.85);

    return { hash: hashPixels(pixels), pixels, thumb };
  }

  async function processImg(img) {
    const src = img.currentSrc || img.src;
    let hash = srcToHash.get(src);
    if (hash) { hashToImg.set(hash, img); return; }

    let cap;
    try { cap = await capture(img); } catch (e) { return; } // tainted canvas etc.
    if (!cap) return;
    srcToHash.set(src, cap.hash);
    hashToImg.set(cap.hash, img);
    if (known.has(cap.hash)) return;

    const [isKnown] = await send({ type: 'known', hashes: [cap.hash] });
    if (isKnown) { known.add(cap.hash); return; }

    await send({ type: 'addSticker', hash: cap.hash, pixels: cap.pixels, width: SIZE, height: SIZE, thumb: cap.thumb });
    known.add(cap.hash);
  }

  async function drain() {
    if (working) return;
    working = true;
    try {
      while (workQueue.length) {
        const img = workQueue.shift();
        if (img.isConnected) {
          try { await processImg(img); } catch (e) { console.warn('[sticker-search]', e); }
        }
      }
    } finally {
      working = false;
    }
  }

  // ---------- scanning ----------

  let panel = null; // the sticker grid's scroll container

  function scan() {
    const imgs = visibleCandidates();
    if (imgs.length >= MIN_VISIBLE_TO_SHOW_BAR) {
      panel = scrollParent(imgs[0]) || imgs[0].parentElement;
      const queued = new Set(workQueue);
      for (const img of imgs) if (!queued.has(img)) workQueue.push(img);
      drain();
      ui.show(panel);
    } else {
      panel = null;
      ui.hide();
    }
  }

  let scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 250);
  }

  new MutationObserver(scheduleScan).observe(document.body, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['src'],
  });
  document.addEventListener('scroll', scheduleScan, true);
  window.addEventListener('resize', scheduleScan);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function idle() { while (working || workQueue.length) await sleep(100); }

  // Scroll the whole panel once so every sticker gets indexed.
  async function indexAll(onStep) {
    const p = panel;
    if (!p) return;
    p.scrollTop = 0;
    await sleep(400);
    let last = -1;
    while (p.scrollTop !== last) {
      scan();
      await idle();
      onStep && onStep();
      last = p.scrollTop;
      p.scrollTop += Math.max(80, p.clientHeight * 0.8);
      await sleep(500);
    }
    scan();
    await idle();
    p.scrollTop = 0;
  }

  // Find the live element for a sticker (scrolling the panel if it was virtualized away) and click it.
  async function sendSticker(hash) {
    let el = hashToImg.get(hash);
    if (!el || !el.isConnected || !panel || !panel.contains(el)) {
      el = null;
      const p = panel;
      if (!p) return false;
      p.scrollTop = 0;
      await sleep(300);
      let last = -1;
      while (!el && p.scrollTop !== last) {
        scan();
        await idle();
        const cand = hashToImg.get(hash);
        if (cand && cand.isConnected && p.contains(cand)) el = cand;
        last = p.scrollTop;
        if (!el) { p.scrollTop += Math.max(80, p.clientHeight * 0.8); await sleep(350); }
      }
    }
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    await sleep(80);
    const target = el.closest('[role="button"]') || el;
    const r = target.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, composed: true, button: 0,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      target.dispatchEvent(new Ctor(type, opts));
    }
    return true;
  }

  // ---------- UI ----------

  const ui = (() => {
    const host = document.createElement('div');
    host.setAttribute('data-wss-host', '');
    host.style.cssText = 'position:fixed;z-index:2147483000;display:none;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap { font: 14px/1.3 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
          --bg: #ffffff; --fg: #111b21; --muted: #667781; --line: #e9edef; --accent: #00a884; --hover: #f0f2f5; }
        .wrap.dark { --bg: #202c33; --fg: #e9edef; --muted: #8696a0; --line: #2a3942; --hover: #2a3942; }
        .bar { display: flex; gap: 8px; align-items: center; padding: 6px 8px;
          background: var(--bg); border-bottom: 1px solid var(--line); box-sizing: border-box; }
        input { flex: 1; min-width: 0; border: 0; outline: 0; background: var(--hover); color: var(--fg);
          border-radius: 8px; padding: 7px 10px; font: inherit; }
        input::placeholder { color: var(--muted); }
        .status { color: var(--muted); font-size: 12px; white-space: nowrap; }
        button { border: 0; background: transparent; color: var(--accent); font: inherit; font-size: 12px;
          cursor: pointer; padding: 4px 6px; border-radius: 6px; white-space: nowrap; }
        button:hover { background: var(--hover); }
        .results { display: none; background: var(--bg); overflow-y: auto; box-sizing: border-box;
          padding: 8px; grid-template-columns: repeat(auto-fill, minmax(76px, 1fr)); gap: 6px; align-content: start; }
        .results.on { display: grid; }
        .cell { aspect-ratio: 1; display: grid; place-items: center; border-radius: 8px; cursor: pointer; }
        .cell:hover, .cell.sel { background: var(--hover); outline: 2px solid var(--accent); }
        .cell img { max-width: 72px; max-height: 72px; }
        .empty { grid-column: 1 / -1; color: var(--muted); padding: 12px; text-align: center; }
      </style>
      <div class="wrap">
        <div class="bar">
          <input type="search" placeholder="Search stickers (e.g. crying cat, thumbs up)" spellcheck="false">
          <span class="status"></span>
          <button class="index" title="Scroll through the whole panel once and index every sticker">Index all</button>
        </div>
        <div class="results"></div>
      </div>`;

    const wrap = root.querySelector('.wrap');
    const input = root.querySelector('input');
    const statusEl = root.querySelector('.status');
    const results = root.querySelector('.results');
    const indexBtn = root.querySelector('.index');
    let anchor = null, selected = 0, items = [], searchSeq = 0, busy = false;

    // Keep WhatsApp from treating our keystrokes as composer input.
    for (const t of ['keydown', 'keyup', 'keypress', 'input', 'paste', 'beforeinput']) {
      host.addEventListener(t, (e) => e.stopPropagation());
    }

    function place() {
      if (!anchor || !anchor.isConnected) return;
      const r = anchor.getBoundingClientRect();
      const BAR = 46;
      // Sit just above the grid when there's room, so the first row of stickers stays visible.
      const top = r.top > BAR + 60 ? r.top - BAR : r.top;
      host.style.left = r.left + 'px';
      host.style.top = top + 'px';
      host.style.width = r.width + 'px';
      results.style.height = Math.max(120, r.bottom - top - BAR) + 'px';
      wrap.classList.toggle('dark', document.body.classList.contains('dark'));
    }

    function render() {
      results.innerHTML = '';
      if (!items.length) {
        const d = document.createElement('div');
        d.className = 'empty';
        d.textContent = known.size ? 'No matches yet.' : 'Nothing indexed yet. Click "Index all".';
        results.appendChild(d);
        return;
      }
      items.forEach((it, i) => {
        const cell = document.createElement('div');
        cell.className = 'cell' + (i === selected ? ' sel' : '');
        cell.title = `score ${it.score.toFixed(3)}`;
        const im = document.createElement('img');
        im.src = it.thumb;
        cell.appendChild(im);
        cell.addEventListener('click', () => pick(i));
        results.appendChild(cell);
      });
    }

    async function pick(i) {
      const it = items[i];
      if (!it) return;
      statusEl.textContent = 'Sending…';
      results.classList.remove('on');
      const ok = await sendSticker(it.hash);
      statusEl.textContent = ok ? '' : 'Could not find it in the panel';
      if (ok) { input.value = ''; items = []; }
    }

    let debounce = null;
    input.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(runSearch, 220);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { input.value = ''; results.classList.remove('on'); items = []; return; }
      if (!items.length) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { selected = Math.min(items.length - 1, selected + 1); render(); e.preventDefault(); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { selected = Math.max(0, selected - 1); render(); e.preventDefault(); }
      if (e.key === 'Enter') { pick(selected); e.preventDefault(); }
    });

    async function runSearch() {
      const q = input.value.trim();
      const seq = ++searchSeq;
      if (!q) { results.classList.remove('on'); items = []; return; }
      results.classList.add('on');
      const res = await send({ type: 'search', query: q, limit: 30 });
      if (seq !== searchSeq) return;
      items = res; selected = 0;
      render();
    }

    indexBtn.addEventListener('click', async () => {
      if (busy) return;
      busy = true; indexBtn.disabled = true;
      try { await indexAll(() => updateStatus()); } finally { busy = false; indexBtn.disabled = false; }
      if (input.value.trim()) runSearch();
    });

    async function updateStatus() {
      if (host.style.display === 'none') return;
      let s;
      try { s = await send({ type: 'status' }); } catch { return; }
      if (s.state === 'loading') statusEl.textContent = `Loading model ${Math.round(s.progress * 100)}%`;
      else if (s.state === 'error') statusEl.textContent = 'Model error (see popup)';
      else if (s.pending) statusEl.textContent = `Indexing… ${s.indexed} (+${s.pending})`;
      else statusEl.textContent = `${s.indexed} indexed`;
    }
    setInterval(updateStatus, 1000);

    return {
      show(el) {
        anchor = el;
        if (!host.isConnected) document.documentElement.appendChild(host);
        if (host.style.display === 'none') { host.style.display = 'block'; send({ type: 'warmup' }); updateStatus(); }
        place();
      },
      hide() {
        if (host.style.display === 'none') return;
        if (root.activeElement === input && input.value) return; // don't vanish mid-typing
        host.style.display = 'none';
        results.classList.remove('on');
      },
    };
  })();

  scan();
})();
