// Background page: owns the CLIP model and the sticker index.
// The content script sends sticker pixels and search queries here.

import {
  env,
  AutoTokenizer,
  AutoProcessor,
  CLIPTextModelWithProjection,
  CLIPVisionModelWithProjection,
  RawImage,
} from './vendor/transformers.min.js';

const MODEL_ID = 'Xenova/clip-vit-base-patch32';
const DTYPE = 'q8';

env.allowLocalModels = false;
env.useBrowserCache = true; // model files are cached after the first download
env.backends.onnx.wasm.wasmPaths = browser.runtime.getURL('vendor/');
env.backends.onnx.wasm.numThreads = 1; // no SharedArrayBuffer in extension pages
env.backends.onnx.wasm.proxy = false;

// ---------- model loading ----------

const status = { state: 'idle', progress: 0, error: null };
const fileProgress = new Map();

function onProgress(p) {
  if (p.status === 'progress' && p.file) {
    fileProgress.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
    let loaded = 0, total = 0;
    for (const f of fileProgress.values()) { loaded += f.loaded; total += f.total; }
    status.progress = total ? loaded / total : 0;
  }
}

let modelPromise = null;
function loadModel() {
  if (!modelPromise) {
    status.state = 'loading';
    const opts = { dtype: DTYPE, progress_callback: onProgress };
    modelPromise = Promise.all([
      AutoTokenizer.from_pretrained(MODEL_ID, { progress_callback: onProgress }),
      AutoProcessor.from_pretrained(MODEL_ID, { progress_callback: onProgress }),
      CLIPTextModelWithProjection.from_pretrained(MODEL_ID, opts),
      CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, opts),
    ]).then(([tokenizer, processor, textModel, visionModel]) => {
      status.state = 'ready';
      status.progress = 1;
      return { tokenizer, processor, textModel, visionModel };
    }).catch((err) => {
      status.state = 'error';
      status.error = String(err && err.message || err);
      modelPromise = null;
      throw err;
    });
  }
  return modelPromise;
}

function normalize(vec) {
  let n = 0;
  for (let i = 0; i < vec.length; i++) n += vec[i] * vec[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
  return out;
}

async function embedImage(pixels, width, height) {
  const { processor, visionModel } = await loadModel();
  const image = new RawImage(new Uint8ClampedArray(pixels), width, height, 4);
  const inputs = await processor(image);
  const { image_embeds } = await visionModel(inputs);
  return normalize(image_embeds.data);
}

async function embedText(text) {
  const { tokenizer, textModel } = await loadModel();
  const inputs = tokenizer([text], { padding: true, truncation: true });
  const { text_embeds } = await textModel(inputs);
  return normalize(text_embeds.data);
}

// ---------- index storage (IndexedDB) ----------

const DB_NAME = 'wa-sticker-search';
const STORE = 'stickers';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'hash' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const dbPromise = openDb();

function tx(mode, fn) {
  return dbPromise.then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error);
  }));
}

// In-memory mirror of the index so searches don't hit IndexedDB.
const index = new Map(); // hash -> { hash, emb: Float32Array, thumb: string }
const indexReady = tx('readonly', (s) => s.getAll()).then((rows) => {
  for (const r of rows) index.set(r.hash, r);
});

// Embedding jobs run one at a time so the UI stays responsive.
let queue = Promise.resolve();
let pending = 0;

function enqueueSticker({ hash, pixels, width, height, thumb }) {
  if (index.has(hash)) return Promise.resolve(false);
  pending++;
  const job = queue.then(async () => {
    try {
      if (index.has(hash)) return false;
      const emb = await embedImage(pixels, width, height);
      const row = { hash, emb, thumb, addedAt: Date.now() };
      index.set(hash, row);
      await tx('readwrite', (s) => s.put(row));
      return true;
    } finally {
      pending--;
    }
  });
  queue = job.catch(() => {});
  return job;
}

async function search(query, limit = 24) {
  await indexReady;
  const q = query.trim();
  if (!q || index.size === 0) return [];
  // CLIP was trained on captions, so a caption-like prompt matches better than a bare word.
  const t = await embedText(`a sticker of ${q}`);
  const scored = [];
  for (const row of index.values()) {
    let s = 0;
    const e = row.emb;
    for (let i = 0; i < e.length; i++) s += e[i] * t[i];
    scored.push({ hash: row.hash, thumb: row.thumb, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ---------- messaging ----------

browser.runtime.onMessage.addListener((msg) => {
  switch (msg && msg.type) {
    case 'status':
      return indexReady.then(() => ({ ...status, indexed: index.size, pending }));
    case 'warmup':
      loadModel().catch(() => {});
      return Promise.resolve(true);
    case 'known':
      return indexReady.then(() => msg.hashes.filter((h) => index.has(h)));
    case 'addSticker':
      return enqueueSticker(msg);
    case 'search':
      return search(msg.query, msg.limit);
    case 'clear':
      index.clear();
      return tx('readwrite', (s) => s.clear()).then(() => true);
    default:
      return undefined;
  }
});
