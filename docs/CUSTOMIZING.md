# Customizing the block page

The block page is `extension/block/` — plain HTML/CSS/JS, no build step, no
framework. Edit it like any static page and re-publish the extension.

## Rules of the road

1. **No external resources.** No CDN fonts, scripts, or images. The block page
   often renders when the network is unavailable or untrusted; everything must
   ship inside the extension. Inline SVG/base64 images are fine, or add image
   files to the extension and reference them relatively.
2. **Keep the query-param contract.** The service worker opens
   `block.html?d=<domain>&c=<category>`. Read them however you like.
3. **Branding without code changes:** `schoolName`, `supportContact`, and
   `blockMessage` come from the Google Admin managed policy, so districts using
   your published build can rebrand without forking.

## Useful runtime data

Anything available to extension pages works here:

```js
// Policy/branding + list status
chrome.runtime.sendMessage({ type: "status" }, (res) => { ... });

// Lifetime stats (e.g., "this device has blocked N attempts")
chrome.storage.local.get(["stats"], ({ stats }) => { ... });
```

## Ideas

- Category-specific messaging (study resources on a `gambling` block, digital
  citizenship link on `adult`).
- A "request a review" mailto: link that pre-fills the blocked domain.
- District logo + colors (add the image file to `extension/block/`).
