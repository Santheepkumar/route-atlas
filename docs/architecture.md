# Project Architecture

Route Atlas has four main pieces: CLI, scanner, scan API, and visualizer UI.

## CLI

Entry point:

```text
bin/route-atlas.mjs
```

The CLI:

- Parses commands and flags using Node built-ins.
- Resolves and validates the target project path.
- Finds an available local port.
- Starts the bundled standalone production server from `.next/standalone/server.js`.
- Passes the target project through `PAGE_VISUALS_TARGET_ROOT`.
- Supports JSON-only scans by starting the API briefly, reading `/api/scan`, writing JSON, and shutting down.

## Scanner

Core files:

```text
src/lib/visualizer/scanner.ts
src/lib/visualizer/route-utils.ts
src/lib/visualizer/types.ts
```

The scanner:

- Finds `src/app` or `app`.
- Walks source and asset files while ignoring `.git`, `.next`, `node_modules`, build output, and coverage output.
- Converts App Router folders into URL patterns.
- Uses `ts-morph` to analyze imports, JSX, links, exports, runtime signals, metadata, params, server actions, and `fetch()` calls.
- Returns a normalized `ScanGraph`.

## API

Entry point:

```text
src/app/api/scan/route.ts
```

The API:

- Reads `PAGE_VISUALS_TARGET_ROOT`.
- Runs the scanner against that target.
- Returns `ScanGraph` JSON.
- Returns a safe error payload when scanning fails.

## Visualizer UI

Entry point:

```text
src/components/visualizer/VisualizerApp.tsx
```

The UI:

- Fetches `/api/scan`.
- Derives visible graph modes from the full scan graph.
- Uses React Flow for interaction.
- Uses ELK for graph layout.
- Renders custom IDE-style route, file, component, data, metadata, and external nodes.
- Starts in **Route Story** mode to avoid noisy large-project graphs.

## Data Flow

```text
route-atlas CLI
  -> validates target project
  -> starts bundled standalone production server
  -> sets PAGE_VISUALS_TARGET_ROOT
  -> browser loads UI
  -> UI calls GET /api/scan
  -> scanner returns ScanGraph
  -> UI renders graph
```
