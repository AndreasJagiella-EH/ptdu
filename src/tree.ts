import type { PnpmWhyNode, Branch, BranchLink } from "./types.js";

/**
 * Extract all unique branches from the pnpm-why tree.
 * Each branch is a path from the vulnerable package (root of the tree)
 * up to a workspace root (node with depField).
 *
 * The pnpm-why tree structure:
 * - Root = vulnerable package
 * - .dependents = packages that depend on this package (i.e. going UP the tree)
 * - Leaves = workspace root packages (have depField property)
 */
export function extractBranches(whyNodes: PnpmWhyNode[]): Branch[] {
  const branches: Branch[] = [];

  for (const root of whyNodes) {
    const currentPath: BranchLink[] = [
      { name: root.name, version: root.version },
    ];
    collectBranches(root, currentPath, branches);
  }

  return deduplicateBranches(branches);
}

function collectBranches(
  node: PnpmWhyNode,
  currentPath: BranchLink[],
  branches: Branch[],
): void {
  if (!node.dependents || node.dependents.length === 0) {
    // This node is a leaf (shouldn't normally happen at non-workspace nodes)
    return;
  }

  for (const dependent of node.dependents) {
    // Skip deduped nodes — they're handled by their canonical entry
    if (dependent.deduped) continue;

    const link: BranchLink = {
      name: dependent.name,
      version: dependent.version,
      isWorkspaceRoot: !!dependent.depField,
    };

    const newPath = [...currentPath, link];

    if (dependent.depField) {
      // Reached a workspace root — this is a complete branch
      branches.push({ chain: newPath });
    } else {
      // Keep traversing
      collectBranches(dependent, newPath, branches);
    }
  }
}

/**
 * Deduplicate branches that have the same chain signature.
 */
function deduplicateBranches(branches: Branch[]): Branch[] {
  const seen = new Set<string>();
  const unique: Branch[] = [];

  for (const branch of branches) {
    const key = branch.chain.map((l) => `${l.name}@${l.version}`).join(" → ");
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(branch);
    }
  }

  return unique;
}

/**
 * Format a branch chain as a human-readable string.
 */
export function formatBranch(branch: Branch): string {
  return branch.chain.map((l) => `${l.name}@${l.version}`).join(" → ");
}
