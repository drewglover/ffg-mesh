# ffg-mesh

An animated mesh-gradient background with a visual editor.

- `index.html` — demo page using the gradient
- `editor.html` — interactive editor for tuning the mesh and exporting config
- `mesh-gradient.js` — the gradient renderer

## Local preview

These are static files, so any local web server works. From the repo root:

```bash
python3 -m http.server 8000
```

Then open:

- Demo: http://localhost:8000/index.html
- Editor: http://localhost:8000/editor.html

Prefer Node? Use `npx serve` instead:

```bash
npx serve .
```

> Opening the HTML files directly via `file://` may break module/asset loading — use a server.
