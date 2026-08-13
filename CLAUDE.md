# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Electron + React + TypeScript desktop app, Windows-only. Built with `electron-vite` (Vite-based tooling for Electron's main/preload/renderer processes). Currently a shell: a three-panel layout (PDF Editor, Spreadsheet, Live Link) with placeholder content — features are added incrementally.

## Commands

```
npm run dev         # hot-reload dev mode (opens the Electron window)
npm run build        # compile main/preload/renderer via electron-vite (outputs to out/)
npm run typecheck    # tsc --noEmit against tsconfig.node.json and tsconfig.web.json
npm run dist          # build + package via electron-builder (outputs .exe to release/)
```

There is no test suite yet. `npm run typecheck` is the fastest correctness check when editing TypeScript.

Requires Node.js (currently developed against the 24.x LTS line) and npm. No `engines` field is set.

## Architecture

Three separate TypeScript build targets, orchestrated by `electron.vite.config.ts` (not a plain `vite.config.ts` — the `electron-vite` CLI reads this instead):

- **`src/main/`** — the Electron main process (Node context). Entry: `src/main/index.ts`. Creates the single `BrowserWindow` and decides whether to load the Vite dev server (`process.env.ELECTRON_RENDERER_URL`, set automatically in dev mode) or the built `out/renderer/index.html` (production).
- **`src/preload/`** — the preload script (`src/preload/index.ts`), running with Node access but isolated from the renderer's `window` global. It is the *only* place allowed to bridge main↔renderer: it calls `contextBridge.exposeInMainWorld('api', ...)` to expose a typed surface, declared for the renderer in `src/preload/index.d.ts` (`declare global { interface Window { api: Api } }`). `contextIsolation` is on and `nodeIntegration` is off in `src/main/index.ts` — any new IPC must go through this bridge, not by relaxing those settings.
- **`src/renderer/`** — the React app. `index.html` is the Vite entry; `src/renderer/src/main.tsx` mounts `App.tsx`. The `@renderer` alias (configured in `electron.vite.config.ts`) points at `src/renderer/src`.

TypeScript config is split to match these targets and tied together by project references in the root `tsconfig.json` (which itself has no compiler options — it only references the other two):
- `tsconfig.node.json` — main + preload + `electron.vite.config.ts` itself.
- `tsconfig.web.json` — everything under `src/renderer/src`.

### UI layout

`App.tsx` renders a `Group` (horizontal orientation) from `react-resizable-panels`, containing three `Panel`s separated by `Separator`s, each wrapping the shared `LabeledPanel` component (`src/renderer/src/components/LabeledPanel.tsx`) that renders a header label plus body content (or a "coming soon" placeholder when no children are passed).

**Note the API surface**: the installed `react-resizable-panels` major version exports `Group` / `Panel` / `Separator` — not the `PanelGroup` / `Panel` / `PanelResizeHandle` names used by older versions of this library that appear in most existing tutorials/examples. Check `node_modules/react-resizable-panels/dist/react-resizable-panels.d.ts` if a prop or export seems missing.

### Packaging

`electron-builder.yml` targets Windows only, producing both an NSIS installer and a portable exe (both x64), output to `release/`. It packages whatever `npm run build` puts in `out/` (per the `files` list) — always run/rely on `build` before `electron-builder`, which is why `dist` chains them.

### Ignored/generated paths

`out/` (electron-vite build output), `release/` (electron-builder output), and `node_modules/` are gitignored — never expect them to be present without running the corresponding script first.
