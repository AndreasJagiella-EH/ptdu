/** Node in the pnpm-why dependency tree */
export interface PnpmWhyNode {
  name: string;
  version: string;
  path?: string;
  peersSuffixHash?: string;
  deduped?: boolean;
  depField?: string;
  dependents?: PnpmWhyNode[];
}

/** A single link in a dependency chain (from vulnerable pkg toward workspace root) */
export interface BranchLink {
  name: string;
  version: string;
  /** The semver range the parent uses to depend on this package */
  parentRange?: string;
  /** Available versions matching parentRange from the registry */
  availableVersions?: string[];
  /** The latest available version if newer than current, else null */
  upgradeVersion?: string | null;
  /** Whether this is the workspace root node */
  isWorkspaceRoot?: boolean;
}

/** A full branch from vulnerable package to a workspace root */
export interface Branch {
  /** Ordered: index 0 = vulnerable package, last = workspace root */
  chain: BranchLink[];
}

/** An override to apply */
export interface Override {
  package: string;
  version: string;
}

/** Result of analyzing a single branch */
export interface BranchResult {
  branch: Branch;
  override: Override | null;
  message: string;
}

export interface PtduOptions {
  cwd: string;
  dryRun: boolean;
  recursive: boolean;
  verbose: boolean;
}

/** A finding from pnpm audit */
export interface AuditFinding {
  version: string;
  paths: string[];
}

/** A single advisory from pnpm audit --json */
export interface AuditAdvisory {
  id: number;
  module_name: string;
  severity: string;
  findings: AuditFinding[];
  vulnerable_versions: string;
  patched_versions: string;
  title: string;
  recommendation: string;
}

/** The top-level pnpm audit --json output */
export interface AuditOutput {
  advisories: Record<string, AuditAdvisory>;
  metadata?: {
    vulnerabilities: Record<string, number>;
    dependencies: number;
    totalDependencies: number;
  };
}
