import * as semver from "semver";
import { pnpmInfoDeps, pnpmViewVersions } from "./pnpm.js";
import * as logger from "./logger.js";
import { formatBranch } from "./tree.js";
import type { Branch, BranchResult, Override } from "./types.js";

/** Cache for pnpm info dependencies lookups */
const depsCache = new Map<string, Record<string, string>>();

/** Cache for pnpm view versions lookups */
const versionsCache = new Map<string, string[]>();

/** Clear all caches (call after pnpm install changes the dep tree) */
export function clearCaches(): void {
  depsCache.clear();
  versionsCache.clear();
}

async function getCachedDeps(
  pkg: string,
  version: string,
  cwd: string,
): Promise<Record<string, string>> {
  const key = `${pkg}@${version}`;
  if (depsCache.has(key)) return depsCache.get(key)!;
  const deps = await pnpmInfoDeps(pkg, version, cwd);
  depsCache.set(key, deps);
  return deps;
}

async function getCachedVersions(
  pkg: string,
  range: string,
  cwd: string,
): Promise<string[]> {
  const key = `${pkg}@${range}`;
  if (versionsCache.has(key)) return versionsCache.get(key)!;
  const versions = await pnpmViewVersions(pkg, range, cwd);
  versionsCache.set(key, versions);
  return versions;
}

/**
 * Analyze a single branch to find the first link (from workspace root toward
 * the vulnerable package) where a newer version is available within the
 * parent's version range.
 *
 * Branch chain order: [vulnPkg, intermediate1, intermediate2, ..., workspaceRoot]
 * We walk from the workspace-root side (last-1) down toward the vulnerable package (index 1).
 * We skip index 0 (the vulnerable package itself) and the last index (workspace root).
 */
export async function analyzeBranch(
  branch: Branch,
  cwd: string,
  triedOverrides: Set<string> = new Set(),
): Promise<BranchResult> {
  const { chain } = branch;
  const branchStr = formatBranch(branch);

  // Need at least 3 nodes: vulnPkg → intermediate → workspaceRoot
  if (chain.length < 3) {
    // Direct dependency — the workspace root directly depends on the vulnerable package
    const vulnPkg = chain[0];
    const wsRoot = chain[chain.length - 1];

    logger.verbose(
      `Branch "${branchStr}": direct dependency, checking for newer versions of ${vulnPkg.name}`,
    );

    const deps = await getCachedDeps(wsRoot.name, wsRoot.version, cwd);
    const range = deps[vulnPkg.name];
    if (!range) {
      return {
        branch,
        override: null,
        message: `Could not determine version range for ${vulnPkg.name} in ${wsRoot.name}@${wsRoot.version}`,
      };
    }

    const available = await getCachedVersions(vulnPkg.name, range, cwd);
    const newer = available
      .filter((v) => semver.gt(v, vulnPkg.version))
      .filter((v) => !triedOverrides.has(`${vulnPkg.name}@${v}`));
    if (newer.length > 0) {
      const latest = newer[newer.length - 1];
      return {
        branch,
        override: { package: vulnPkg.name, version: latest },
        message: `${branchStr}: upgrade ${vulnPkg.name} from ${vulnPkg.version} → ${latest}`,
      };
    }

    return {
      branch,
      override: null,
      message: `${branchStr}: no newer version of ${vulnPkg.name} satisfies ${range}`,
    };
  }

  // Walk from the workspace-root side toward the vulnerable package
  for (let i = chain.length - 2; i >= 1; i--) {
    const node = chain[i];
    const parent = chain[i + 1];

    logger.verbose(
      `Checking if ${parent.name}@${parent.version} can get a newer ${node.name}`,
    );

    const deps = await getCachedDeps(parent.name, parent.version, cwd);
    const range = deps[node.name];

    if (!range) {
      logger.verbose(
        `Could not find ${node.name} in dependencies of ${parent.name}@${parent.version}`,
      );
      continue;
    }

    logger.verbose(
      `${parent.name}@${parent.version} requires ${node.name}@${range}`,
    );

    const available = await getCachedVersions(node.name, range, cwd);
    const newer = available
      .filter((v) => semver.gt(v, node.version))
      .filter((v) => !triedOverrides.has(`${node.name}@${v}`));

    if (newer.length > 0) {
      const latest = newer[newer.length - 1];
      logger.verbose(
        `Found newer version: ${node.name}@${latest} (current: ${node.version})`,
      );
      return {
        branch,
        override: { package: node.name, version: latest },
        message: `${branchStr}: upgrade ${node.name} from ${node.version} → ${latest}`,
      };
    }

    logger.verbose(`No newer version of ${node.name} satisfies ${range}`);
  }

  // Also check the vulnerable package itself
  const vulnPkg = chain[0];
  const vulnParent = chain[1];
  const deps = await getCachedDeps(vulnParent.name, vulnParent.version, cwd);
  const range = deps[vulnPkg.name];

  if (range) {
    const available = await getCachedVersions(vulnPkg.name, range, cwd);
    const newer = available
      .filter((v) => semver.gt(v, vulnPkg.version))
      .filter((v) => !triedOverrides.has(`${vulnPkg.name}@${v}`));
    if (newer.length > 0) {
      const latest = newer[newer.length - 1];
      return {
        branch,
        override: { package: vulnPkg.name, version: latest },
        message: `${branchStr}: upgrade ${vulnPkg.name} from ${vulnPkg.version} → ${latest}`,
      };
    }
  }

  return {
    branch,
    override: null,
    message: `${branchStr}: no updatable dependency found in this chain`,
  };
}
