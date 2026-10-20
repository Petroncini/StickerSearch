# StickerSearch

A Firefox extension that adds semantic search to the WhatsApp Web sticker panel. You type "crying cat" or "thumbs up" and it finds the sticker by what it looks like, even if the sticker has no name or tags.

It runs [CLIP](https://huggingface.co/Xenova/clip-vit-base-patch32) locally through [transformers.js](https://github.com/huggingface/transformers.js), so your stickers never leave your machine. The only network traffic is a one-time download of the model (about 150 MB) from Hugging Face, which is cached afterwards.

## How it works

The content script watches web.whatsapp.com for the sticker grid. Each sticker image it sees is drawn onto a 224x224 canvas, hashed so it can be recognised across sessions (WhatsApp's `blob:` URLs change on every reload), and sent to the background page. The background page runs the CLIP image encoder on it and stores the embedding plus a small thumbnail in IndexedDB.

When you search, the query is embedded with CLIP's text encoder as "a sticker of {query}" and ranked by cosine similarity against every stored sticker. Clicking a result finds the matching live element in WhatsApp's panel (scrolling it into view if the list virtualised it away) and clicks it, which sends the sticker.

## Install for development

```sh
npm install
npm run start      # vendors the runtime and launches Firefox with the extension loaded
```

Or load it by hand: run `npm run build`, open `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on" and pick `extension/manifest.json`. Temporary add-ons are removed when Firefox restarts; for a permanent install, sign it as an unlisted add-on with `web-ext sign` (needs an AMO API key), or use Firefox Developer Edition with `xpinstall.signatures.required` set to `false` and install the `.zip` from `npm run package`.

## Using it

Open the sticker tab in WhatsApp Web and a search bar appears above the grid. Stickers get indexed as they scroll into view; click "Index all" once to make the extension scroll through the whole panel for you. Search with arrow keys and Enter, or click a result. The toolbar popup shows model status and the index size, and can clear the index.

## Known limits

The text encoder is English-only CLIP, so English queries work much better than Portuguese ones. Stickers with text in them match on that text only roughly. Animated stickers are indexed by their first frame.

Detection of the sticker grid is heuristic, since WhatsApp's DOM classes are obfuscated. If WhatsApp changes its layout and the bar stops appearing or picks up the wrong images, the selectors and size limits to adjust are the constants at the top of `extension/content.js`.
