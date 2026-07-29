# Route Atlas

Route Atlas is a local Next.js App Router visualizer. It scans routes, layouts, pages, route handlers, components, imports, navigation links, data calls, metadata, and dynamic params, then renders them as an interactive graph.

## Use In Any Next.js Project

From a Next.js App Router project:

```bash
npx route-atlas
```

Open the printed local URL. By default, the visualizer runs on `127.0.0.1:3133` and scans the directory where you ran the command.

The npm CLI serves Route Atlas from its bundled production build, so it does not start your target app or show Next.js development tooling.

You can also point it at another project:

```bash
npx route-atlas ./some-next-app
npx route-atlas ./some-next-app --port 4000
```

## Export Scan JSON

```bash
npx route-atlas scan ./some-next-app --out route-atlas.scan.json
```

Without `--out`, the scan JSON is printed to stdout.

## Local Development

```bash
pnpm install
pnpm dev
```

Development mode is only for working on Route Atlas itself. The app scans its own repo unless `PAGE_VISUALS_TARGET_ROOT` is set:

```bash
PAGE_VISUALS_TARGET_ROOT=/absolute/path/to/next-app pnpm dev --port 3133
```

## Current Limitations

- App Router is the primary target.
- Pages Router support is not implemented yet.
- The tool is local-only: no accounts, cloud storage, GitHub auth, or database.
- Static analysis is intentionally honest: exact relationships are marked static, and guessed relationships are marked inferred.

## Documentation

- [Usage Guide](./docs/usage.md)
- [Publishing Guide](./docs/publishing.md)
- [Project Architecture](./docs/architecture.md)
- [CLI and API Reference](./docs/cli-and-api.md)
- [Development Guide](./docs/development.md)
