# Route Atlas Documentation

Route Atlas is a local visual map for Next.js App Router projects. It is designed to help developers answer: which pages exist, how routes nest, which layouts wrap them, where APIs live, and how pages connect to components, data calls, metadata, and navigation.

## Documents

- [Usage Guide](./usage.md): how to run Route Atlas in any project.
- [Publishing Guide](./publishing.md): release checklist and npm publish commands.
- [Project Architecture](./architecture.md): how the CLI, scanner, API, and UI fit together.
- [CLI and API Reference](./cli-and-api.md): commands, environment variables, and scan output.
- [Development Guide](./development.md): local setup, checks, known warnings, and future work.

## Current Scope

- App Router first: `app` and `src/app`.
- Local-only scanning.
- No accounts, cloud sync, or persisted database.
- Static analysis only; relationships marked as inferred are intentionally labeled that way.
