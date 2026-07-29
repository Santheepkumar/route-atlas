# Usage Guide

## Run In The Current Project

From a Next.js App Router project:

```bash
npx route-atlas
```

Route Atlas starts a local visualizer, prints a URL, and scans the current working directory.

Default URL:

```text
http://127.0.0.1:3133
```

## Run Against Another Project

```bash
npx route-atlas /absolute/path/to/next-app
```

or:

```bash
npx route-atlas ../some-next-app
```

## Change The Port

```bash
npx route-atlas . --port 4000
```

## Export A Scan JSON File

```bash
npx route-atlas scan . --out route-atlas.scan.json
```

Without `--out`, the JSON is printed to stdout:

```bash
npx route-atlas scan .
```

## What It Shows

- Routes and nested route segments.
- Pages, layouts, templates, loading states, error states, not-found files, defaults, and route handlers.
- Dynamic, catch-all, optional catch-all, route group, parallel slot, and intercepted route signals.
- Imports, component usage, `next/link`, anchor links, router navigation, `fetch()` calls, metadata, server actions, and route params.

## Recommended Workflow

1. Run `npx route-atlas` from the project root.
2. Start with the default **Route Story** view.
3. Select a route to reveal its local component/data relationships.
4. Use **All** mode only when you want the full deep graph.
5. Export JSON when you want to archive, diff, or inspect the scan elsewhere.
