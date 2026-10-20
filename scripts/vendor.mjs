// Copies the transformers.js bundle and the ONNX Runtime WASM files into the extension,
// because Firefox extensions can't load scripts or WASM from a CDN.
import { cpSync, mkdirSync } from 'node:fs';
const src = 'node_modules/@huggingface/transformers/dist/';
const dst = 'extension/vendor/';
mkdirSync(dst, { recursive: true });
for (const f of ['transformers.min.js', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
  cpSync(src + f, dst + f);
  console.log('vendored', f);
}
