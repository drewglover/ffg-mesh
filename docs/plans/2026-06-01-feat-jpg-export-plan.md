---
title: "feat: JPG export of gradient canvas"
type: feat
date: 2026-06-01
---

## Goal

Let users download a JPG snapshot of the rendered mesh gradient directly from the editor, at a configurable resolution.

## Background

The editor already has an Export modal for copying the JS config. JPG export is a separate, complementary action — it captures the visual output rather than the configuration. The gradient renders on a `<canvas>` element via `MeshGradient`, so a snapshot can be taken with `canvas.toDataURL('image/jpeg', quality)`.

## Approach

### 1. Locate the canvas element

`MeshGradient` in `mesh-gradient.js` owns the canvas. Check how it's exposed (property on the instance, or query the DOM) so `editor.html` can get a reference to it.

Quick check needed:
- Does `MeshGradient` expose `.canvas` or similar on the instance?
- Or is the canvas appended to a known container that can be queried?

### 2. Add a resolution/quality picker UI

A small inline form inside a new "Export JPG" modal (or extend the existing export modal with a second tab):

| Field | Default | Notes |
|-------|---------|-------|
| Width (px) | 1920 | Free-type or preset dropdown (1280 / 1920 / 2560 / 3840) |
| Height (px) | 1080 | Locked-ratio toggle optional |
| Quality (0–1) | 0.92 | Slider |

### 3. Snapshot logic

```js
async function exportJpg(width, height, quality) {
  // 1. Create an offscreen canvas at the requested size
  const offscreen = document.createElement('canvas');
  offscreen.width  = width;
  offscreen.height = height;

  // 2. Re-render the gradient into it (need a temporary MeshGradient instance,
  //    or resize the existing canvas, snapshot, then restore — pick one).
  //    Option A: resize + snapshot + restore (simpler, one flash of resize)
  //    Option B: offscreen MeshGradient instance (cleaner, no resize flash)

  // 3. toDataURL → anchor download
  const url = offscreen.toDataURL('image/jpeg', quality);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = 'gradient.jpg';
  a.click();
}
```

**Preferred: Option B (offscreen instance)** — avoids any visible resize flash and keeps the live canvas undisturbed.

Dependency: `MeshGradient` must accept a canvas element as an option, or accept `width`/`height` overrides. Check `mesh-gradient.js` constructor signature; if it auto-creates its canvas, a small addition may be needed to accept an externally-provided canvas.

### 4. Wire up the button

Add an **"Export JPG"** button to the panel footer (alongside the existing Export / Import buttons). Clicking it opens the resolution modal. Clicking "Download" runs the snapshot.

```
[ Export ]  [ Import ]  [ Export JPG ]  [ Copy share link ]  [ Reset ]
```

### 5. Error handling

- If `toDataURL` is blocked (tainted canvas from cross-origin resources): catch and show a friendly error. Current gradient is self-contained so this is unlikely, but guard it.
- If `MeshGradient` constructor changes are needed, keep them backward-compatible (new options are optional).

---

## Files to touch

| File | Change |
|------|--------|
| `mesh-gradient.js` | Possibly: accept externally-provided canvas element in constructor options (only if Option B needs it) |
| `editor.html` | Add button, modal HTML, CSS, `exportJpg()` function, `bindJpgExport()` wiring |

---

## Acceptance criteria

- [ ] "Export JPG" button is visible in the footer
- [ ] Clicking it opens a modal with width, height, and quality controls
- [ ] Clicking "Download" triggers a `.jpg` file download
- [ ] Downloaded image matches what is visible on screen (colors, vertex positions)
- [ ] Resolution controls produce images at the specified dimensions (not just screen resolution)
- [ ] No visible flash or disruption to the live gradient during export
- [ ] Works in Chrome and Firefox (Safari if canvas CORS permits)

---

## Open questions

1. Does `MeshGradient` expose its canvas, or will we need to add that?
2. Should the offscreen render match the current animation frame (paused), or always render a static frame?
3. Any preference on preset sizes vs. free-entry width/height?
