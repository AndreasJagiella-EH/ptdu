# PRD: ptdu (pnpm-transitive-deps-updater)

## Overview

**ptdu** is a CLI tool that resolves transitive dependency vulnerabilities in pnpm-managed projects by walking the dependency tree, finding updatable packages in each chain, and applying temporary overrides to force pnpm to pull in patched versions.

## Problem Statement

When a transitive dependency has a known vulnerability (e.g. `qs@6.13.0`), updating it is non-trivial in pnpm projects. The vulnerable package is pulled in through a chain of intermediate dependencies, and each link in that chain may or may not have a newer version that pulls in a fixed transitive dep. Manually tracing the tree with `pnpm why`, checking version ranges, looking up available versions, and applying overrides is tedious and error-prone.

## Solution

A single command:

```
ptdu qs@6.13.0
```

that automates the entire process: trace the dependency tree, find the first link in each branch that can be bumped to resolve the vulnerability, apply a temporary pnpm override, install, then clean up.

---

## User Personas

| Persona | Description |
|---------|-------------|
| **Application Developer** | Maintains a pnpm workspace/monorepo. Receives vulnerability alerts (Dependabot, Snyk, audits) and needs to remediate transitive deps quickly. |
| **CI/Security Engineer** | Wants to script vulnerability remediation in CI pipelines. |

---

## Functional Requirements

### FR-1: CLI Interface

| Aspect | Detail |
|--------|--------|
| **Binary name** | `ptdu` |
| **Invocation** | `ptdu <package>@<version>` |
| **Language** | TypeScript, compiled to a standalone Node.js CLI |
| **Distribution** | Published to npm; installable globally via `pnpm add -g ptdu` or `npm i -g ptdu` |

#### Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `<package>@<version>` | Yes | The vulnerable package name and exact version to remediate (e.g. `qs@6.13.0`). |

#### Options / Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--dry-run` | `false` | Print what overrides would be applied without modifying any files or running install. |
| `--cwd <path>` | `.` | Working directory (must contain a pnpm project). |
| `--recursive` / `-r` | `false` | Run in all workspace packages (passes `-r` to pnpm commands). |
| `--verbose` / `-v` | `false` | Print detailed debug output (pnpm commands, version lookups, tree traversal). |
| `--help` / `-h` | — | Show usage information. |
| `--version` | — | Print ptdu version. |

### FR-2: Dependency Tree Discovery

1. Run `pnpm why <package>@<version> --json` in the target project directory.
2. Parse the JSON output into an internal tree structure.
3. Handle deduped nodes (nodes with `"deduped": true`) by resolving them to their canonical entry in the tree — do not traverse deduped branches again.
4. If `pnpm why` returns an empty result (package not found in the lockfile), exit with a clear error message.

### FR-3: Tree Traversal — Leaf-to-Root, Per Branch

The tree from `pnpm why` is rooted at the vulnerable package and its leaves are the top-level workspace packages (those with a `depField` property like `"devDependencies"`).

**Traversal strategy:**

For each unique branch from the vulnerable package up to a workspace root:

1. **Start at the leaves** (top-level workspace packages) and walk **down** toward the vulnerable package.
2. At each intermediate dependency in the chain (excluding the workspace root and the vulnerable package itself):
   a. Look up the **version range** the parent uses to depend on this package (via `pnpm info <parent>@<parentVersion> dependencies --json`).
   b. Query the registry for available versions matching that range (`pnpm view <package>@<range> version --json`).
   c. If a **newer version** exists (compared to the currently installed version), this is the **resolution point** — stop traversal on this branch.
   d. If no newer version exists, continue walking down to the next dependency in the chain.
3. If no intermediate dependency has a newer version available, report that the branch cannot be auto-resolved and suggest manual intervention.

### FR-4: Override Application

For each resolution point found in FR-3:

1. Determine the override target: `<package>: <latest-matching-version>`.
2. Detect the project's pnpm configuration format:
   - If `pnpm-workspace.yaml` exists → add overrides under `overrides` key in `pnpm-workspace.yaml`.
   - Otherwise → add overrides under `pnpm.overrides` in `package.json`.
3. Write the override entry. If an `overrides` section already exists, merge into it (do not clobber existing overrides).
4. Run `pnpm install` (respecting `--recursive` if set).
5. **Verify** the vulnerable package version is no longer present by re-running `pnpm why <package>@<version> --json` and checking the relevant branch is resolved.
6. Remove the override entry that was added (restore original state of overrides section; if overrides section was created by ptdu, remove it entirely).
7. Run `pnpm install` again to confirm the lockfile is stable without the override (pnpm should now have the bumped version cached/resolved).

> **Note:** Steps 6–7 ensure the override is temporary. The intent is that once pnpm has resolved the newer transitive version, the lockfile retains it even without the override. If after removing the override and reinstalling the vulnerable version reappears, ptdu should warn the user and suggest keeping the override permanently (with a `--keep-overrides` flag in future iterations).

### FR-5: Output & Reporting

| Scenario | Output |
|----------|--------|
| Resolution found | `✔ <branch-path>: upgraded <pkg> from <old> → <new>` |
| No resolution available | `✘ <branch-path>: no newer version of <pkg> satisfies <range>` |
| Dry-run | `[dry-run] Would override <pkg>@<new> (currently <old>) via <parent>@<parentVersion> requiring <range>` |
| Verification failure | `⚠ <pkg>@<vulnerableVersion> still present after override removal — consider using a permanent override` |

All output should use colored terminal output (e.g. via `picocolors` or `chalk`) with graceful fallback for non-TTY environments.

### FR-6: Error Handling

| Error Condition | Behavior |
|-----------------|----------|
| `pnpm` not found in PATH | Exit with error: "pnpm is required but not found in PATH" |
| Not a pnpm project (no `pnpm-lock.yaml`) | Exit with error: "No pnpm-lock.yaml found — are you in a pnpm project?" |
| Invalid `<package>@<version>` format | Exit with error showing expected format |
| `pnpm why` returns empty / package not in tree | Exit with message: "<package>@<version> not found in dependency tree" |
| Network errors during registry lookups | Retry once; on second failure, exit with error |
| `pnpm install` fails | Rollback override changes, exit with error and install output |

---

## Non-Functional Requirements

### NFR-1: Performance

- Registry lookups (`pnpm view`, `pnpm info`) should be parallelized where possible (multiple branches can be analyzed concurrently).
- The tool should cache `pnpm info` results within a single run to avoid redundant registry calls for the same package@version.

### NFR-2: Safety

- **Never modify `node_modules` directly.** All changes go through `pnpm install`.
- **Atomic file modifications:** Back up `pnpm-workspace.yaml` / `package.json` before modification. Restore on any failure.
- **No data loss:** The tool must not remove or alter existing overrides that it did not create.

### NFR-3: Compatibility

- Node.js >= 18.
- pnpm >= 8 (supports `pnpm why --json` and `pnpm-workspace.yaml` overrides).
- Works on Linux, macOS, and Windows.

### NFR-4: Installability

- Published as a single npm package with a `bin` entry.
- Zero native dependencies — pure JavaScript/TypeScript compiled output.
- `pnpm add -g ptdu` / `npm i -g ptdu` / `npx ptdu` should all work.

---

## Technical Architecture

```
ptdu
├── src/
│   ├── cli.ts              # Entry point — argument parsing (e.g. via commander/yargs)
│   ├── tree.ts             # Parse pnpm-why JSON, build internal tree, extract branches
│   ├── resolver.ts         # For each branch: check version ranges, query registry
│   ├── override.ts         # Read/write overrides in pnpm-workspace.yaml or package.json
│   ├── pnpm.ts             # Wrapper around pnpm shell commands (why, install, info, view)
│   ├── logger.ts           # Colored output, verbosity levels
│   └── types.ts            # Shared TypeScript types/interfaces
├── package.json
├── tsconfig.json
└── README.md
```

### Key Data Structures

```typescript
interface DependencyNode {
  name: string;
  version: string;
  peersSuffixHash?: string;
  deduped?: boolean;
  depField?: string; // present on workspace root nodes
  dependents?: DependencyNode[];
}

interface Branch {
  /** Ordered from vulnerable package → workspace root */
  chain: BranchLink[];
}

interface BranchLink {
  name: string;
  version: string;
  /** The semver range the parent specifies for this package */
  parentRange?: string;
  /** Available versions matching parentRange */
  availableVersions?: string[];
  /** The latest available version (if newer than current) */
  upgradeVersion?: string | null;
}

interface Override {
  package: string;
  version: string;
}
```

### Algorithm Pseudocode

```
input: vulnerablePackage, vulnerableVersion

tree = pnpm_why(vulnerablePackage, vulnerableVersion)
branches = extract_branches(tree)  // each branch = path from vuln pkg to workspace root

overrides = []

for each branch in branches:
    // Walk from leaf (workspace root side) toward the vulnerable package
    for i = len(branch) - 2 down to 1:   // skip workspace root and vuln pkg itself
        node = branch[i]
        parent = branch[i + 1]
        range = get_parent_range(parent.name, parent.version, node.name)
        available = get_available_versions(node.name, range)
        latest = max(available)
        if latest > node.version:
            overrides.append({ package: node.name, version: latest })
            break  // this branch is resolved
    else:
        warn("No resolution found for branch: ...")

if overrides is empty:
    exit("No updatable dependencies found")

apply_overrides(overrides)
pnpm_install()
verify_resolution(vulnerablePackage, vulnerableVersion)
remove_overrides(overrides)
pnpm_install()
```

---

## Example Walkthrough

Given: `ptdu qs@6.13.0`

**Step 1 — Discover tree:** `pnpm why qs@6.13.0 --json` returns the tree with branches like:

```
qs@6.13.0 → body-parser@1.20.3 → express@4.21.2 → @nx/module-federation@22.5.4 → @netilion2/source (workspace root)
```

**Step 2 — Analyze branch (leaf-to-root):**

- `@nx/module-federation@22.5.4` depends on `express@^4.21.2`
- Available versions for `express@^4.21.2`: `[4.21.2, 4.22.0, 4.22.1]`
- Latest: `4.22.1` > installed `4.21.2` → **resolution found**

**Step 3 — Apply override:**

```yaml
# pnpm-workspace.yaml
overrides:
  express: "4.22.1"
```

**Step 4 — Install, verify, clean up:**

```bash
pnpm install          # applies override, updates express → 4.22.1
# verify qs@6.13.0 is gone (express@4.22.1 may use qs@6.14.x)
# remove override
pnpm install          # lockfile should retain express@4.22.1
```

---

## MVP Scope (v1.0)

| In Scope | Out of Scope (Future) |
|----------|-----------------------|
| Single vulnerable package input | Multiple packages in one invocation |
| Automatic override + install + cleanup cycle | `--keep-overrides` flag to persist overrides |
| `--dry-run` mode | Interactive mode (prompt user per branch) |
| Colored terminal output | HTML/JSON report export |
| pnpm workspace.yaml and package.json override support | yarn/npm support |
| Basic retry on network failure | Offline mode / local cache |

---

## Success Metrics

- **Correctness:** After running `ptdu <pkg>@<version>`, `pnpm why <pkg>@<version>` returns an empty result (vulnerable version is no longer in the tree).
- **Safety:** No unintended modifications to package.json or pnpm-workspace.yaml persist after the tool completes.
- **Usability:** A developer unfamiliar with the tool can resolve a transitive vulnerability in under 60 seconds using only the `--help` output.

---

## Open Questions

1. **Override persistence:** Should the default behavior be to keep overrides if removing them causes the vulnerability to reappear? Or should it always clean up and just warn?
2. **Multiple vulnerable versions:** If `pnpm why qs` returns multiple versions (e.g. `6.13.0` and `6.11.0`), should the tool handle all of them or require the user to specify each?
3. **Peer dependency conflicts:** If bumping an intermediate dependency causes peer dependency warnings/errors during `pnpm install`, should the tool automatically roll back, or prompt the user?
4. **Monorepo behavior:** In a monorepo, should the tool analyze and fix all workspace packages or only the current one by default?
