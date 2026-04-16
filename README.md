# ptdu — pnpm Transitive Deps Updater

CLI tool that resolves transitive dependency vulnerabilities in pnpm projects by automatically tracing the dependency tree, finding updatable intermediate packages, and applying temporary overrides.

## Install

```bash
npm i -g ptdu
# or
pnpm add -g ptdu
```

## Usage

```bash
ptdu <package>@<version> [options]
ptdu --audit [options]
```

### Example

```bash
# Fix vulnerable qs@6.13.0 pulled in transitively
ptdu qs@6.13.0

# Preview what would change without modifying anything
ptdu qs@6.13.0 --dry-run

# Run with verbose output
ptdu qs@6.13.0 --verbose

# Specify a different working directory
ptdu qs@6.13.0 --cwd /path/to/project

# Run across all workspace packages
ptdu qs@6.13.0 --recursive

# Audit mode: run pnpm audit and fix all vulnerable transitive deps
ptdu --audit

# Audit mode with dry run
ptdu --audit --dry-run
```

### Options

| Flag              | Description                                                   |
| ----------------- | ------------------------------------------------------------- |
| `--audit`         | Run `pnpm audit` and process all vulnerable dependencies      |
| `--dry-run`       | Print what overrides would be applied without modifying files |
| `--cwd <path>`    | Working directory (default: `.`)                              |
| `-r, --recursive` | Run in all workspace packages                                 |
| `-v, --verbose`   | Print detailed debug output                                   |
| `-V, --version`   | Print version                                                 |
| `-h, --help`      | Show help                                                     |

## How It Works

1. **Discover** — Runs `pnpm why <pkg>@<version> --json` to get the full dependency tree
2. **Extract branches** — Parses the tree into individual chains from the vulnerable package to each workspace root
3. **Analyze** — For each branch, walks from the workspace root toward the vulnerable package, checking if a newer version of each intermediate dependency is available within its parent's semver range
4. **Override** — Applies temporary overrides in `pnpm-workspace.yaml` (or `package.json`) for the first resolvable package in each branch
5. **Install & verify** — Runs `pnpm install`, verifies the vulnerable version is gone
6. **Clean up** — Removes the temporary overrides and runs `pnpm install` again to confirm the fix persists

## Requirements

- Node.js >= 18
- pnpm >= 8

## License

MIT
