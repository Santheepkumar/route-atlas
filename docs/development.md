# Development Guide

## Local Setup

```bash
pnpm install
pnpm dev
```

Open:

```text
http://127.0.0.1:3000
```

To scan a different local project while developing:

```bash
PAGE_VISUALS_TARGET_ROOT=/absolute/path/to/next-app pnpm dev --port 3133
```

## Checks

```bash
pnpm test
pnpm lint
pnpm build
```

## CLI Smoke Tests

```bash
node bin/route-atlas.mjs --help
node bin/route-atlas.mjs --version
node bin/route-atlas.mjs scan . --out /tmp/route-atlas.scan.json --port 3134
```

## Package Dry Run

```bash
npm pack --dry-run
```

Review the tarball contents before publishing.

## Known Build Warning

`pnpm build` may print a Turbopack warning about filesystem tracing. Route Atlas intentionally scans arbitrary project paths, so the scanner necessarily uses dynamic filesystem operations. The build still completes successfully.

## Important Files

- `bin/route-atlas.mjs`: CLI entrypoint.
- `src/app/api/scan/route.ts`: scan API.
- `src/lib/visualizer/scanner.ts`: static analysis scanner.
- `src/lib/visualizer/route-utils.ts`: route parsing helpers.
- `src/components/visualizer/VisualizerApp.tsx`: graph UI.

## Future Work

- Pages Router support.
- Better monorepo/workspace detection.
- Saved scan comparison.
- Static export viewer for pre-generated JSON.
- More framework adapters beyond Next.js.
