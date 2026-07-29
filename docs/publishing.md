# Publishing Guide

This project publishes to npm as `route-atlas`.

## One-Time Prerequisites

```bash
npm login
npm whoami
```

Confirm the logged-in account is correct.

Check that the package name/version is available:

```bash
npm view route-atlas version
```

For the first publish, npm should return `404 Not Found`. For later publishes, it should show the latest published version.

## Release Checklist

Run these before publishing:

```bash
pnpm test
pnpm lint
pnpm build
npm pack --dry-run
```

The build currently succeeds with a Turbopack filesystem tracing warning. That warning is expected because Route Atlas intentionally scans arbitrary local project paths.

## Publish Version `0.1.0`

If npm asks for an OTP interactively:

```bash
npm publish --access public
```

If you already have a fresh OTP:

```bash
npm publish --access public --otp 123456
```

Replace `123456` with the current npm authenticator code.

## After Publishing

Verify the package:

```bash
npm view route-atlas version
npx route-atlas --version
npx route-atlas --help
```

Test the CLI from another Next.js App Router project:

```bash
cd /path/to/next-app
npx route-atlas
```

## Future Versions

For updates:

```bash
npm version patch
git push
git push --tags
npm publish --access public
```

Use `minor` for meaningful new features and `major` for breaking CLI/API changes.
