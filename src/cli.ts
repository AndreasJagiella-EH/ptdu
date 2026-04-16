#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import * as logger from "./logger.js";
import { setVerbose } from "./logger.js";
import { pnpmWhy, pnpmInstall, pnpmAudit } from "./pnpm.js";
import { extractBranches, formatBranch } from "./tree.js";
import { analyzeBranch, clearCaches } from "./resolver.js";
import { applyOverrides, removeOverrides, rollback } from "./override.js";
import type { Override, PtduOptions, AuditOutput } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getVersion(): string {
  // Walk up to find package.json
  for (const dir of [__dirname, join(__dirname, "..")]) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      return pkg.version ?? "0.0.0";
    }
  }
  return "0.0.0";
}

function parsePackageArg(arg: string): { name: string; version: string } {
  // Handle scoped packages like @scope/pkg@1.0.0
  const atIdx = arg.lastIndexOf("@");
  if (atIdx <= 0) {
    logger.error(
      `Invalid package argument: "${arg}". Expected format: <package>@<version> (e.g. qs@6.13.0)`,
    );
    process.exit(1);
  }
  return {
    name: arg.slice(0, atIdx),
    version: arg.slice(atIdx + 1),
  };
}

async function run(packageArg: string, opts: PtduOptions): Promise<void> {
  const { cwd, dryRun, recursive, verbose } = opts;
  const resolvedCwd = resolve(cwd);

  setVerbose(verbose);

  // Validate pnpm project
  if (!existsSync(join(resolvedCwd, "pnpm-lock.yaml"))) {
    logger.error("No pnpm-lock.yaml found — are you in a pnpm project?");
    process.exit(1);
  }

  const { name: pkgName, version: pkgVersion } = parsePackageArg(packageArg);

  logger.info(`\nAnalyzing dependency tree for ${pkgName}@${pkgVersion}...\n`);

  // Iterative loop: discover tree → find override → apply → remove → re-discover
  const triedOverrides = new Set<string>(); // "pkg@version" keys to avoid retrying
  const MAX_ITERATIONS = 20;
  let resolved = false;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    // (Re-)discover the dependency tree
    const whyNodes = await pnpmWhy(pkgName, pkgVersion, resolvedCwd, recursive);
    if (!whyNodes.length) {
      resolved = true;
      break;
    }

    const branches = extractBranches(whyNodes);
    if (!branches.length) {
      logger.error(
        `Could not extract any dependency branches for ${pkgName}@${pkgVersion}`,
      );
      break;
    }

    if (iteration === 0) {
      logger.info(`Found ${branches.length} dependency branch(es):\n`);
      for (const branch of branches) {
        logger.info(`  ${formatBranch(branch)}`);
      }
    } else {
      logger.info(
        `\nRe-analyzed tree: ${branches.length} branch(es) remaining`,
      );
    }

    // Find the first actionable override across all current branches
    let foundOverride: Override | null = null;
    let foundMessage = "";

    for (const branch of branches) {
      const result = await analyzeBranch(branch, resolvedCwd, triedOverrides);
      if (result.override) {
        const key = `${result.override.package}@${result.override.version}`;
        if (!triedOverrides.has(key)) {
          foundOverride = result.override;
          foundMessage = result.message;
          break;
        }
      }
    }

    if (!foundOverride) {
      logger.warn(
        "\nNo more updatable dependencies found across remaining branches.",
      );
      break;
    }

    const overrideKey = `${foundOverride.package}@${foundOverride.version}`;
    triedOverrides.add(overrideKey);

    if (dryRun) {
      logger.dryRun(
        `Would override ${foundOverride.package}@${foundOverride.version}`,
      );
      continue;
    }

    logger.success(`\n${foundMessage}`);

    // Apply single override → install → remove override → install
    // The lockfile retains the newer resolved version after override removal
    logger.info(
      `Applying override: ${foundOverride.package} → ${foundOverride.version}`,
    );
    try {
      await applyOverrides([foundOverride], resolvedCwd);
      await pnpmInstall(resolvedCwd, recursive);
    } catch (err) {
      await rollback();
      logger.error(
        `pnpm install failed after applying override. Changes rolled back.\n${err}`,
      );
      continue;
    }

    // Remove the override immediately — the lockfile should retain the bumped version
    logger.info(`Removing override: ${foundOverride.package}`);
    try {
      await removeOverrides();
      await pnpmInstall(resolvedCwd, recursive);
    } catch (err) {
      logger.error(`pnpm install failed after removing override.\n${err}`);
      process.exit(1);
    }

    // Clear resolver caches — the installed tree has changed
    clearCaches();
  }

  if (dryRun) {
    logger.info("\nDry run complete — no changes made.");
    return;
  }

  if (resolved) {
    logger.success(
      `\nDone! ${pkgName}@${pkgVersion} has been successfully resolved.`,
    );
  } else {
    logger.error(
      `\nCould not fully resolve ${pkgName}@${pkgVersion}. Manual intervention may be required.`,
    );
    process.exit(1);
  }
}

/**
 * Extract unique package@version targets from pnpm audit output.
 */
function extractAuditTargets(
  audit: AuditOutput,
): { name: string; version: string }[] {
  const seen = new Set<string>();
  const targets: { name: string; version: string }[] = [];

  for (const advisory of Object.values(audit.advisories)) {
    for (const finding of advisory.findings) {
      const key = `${advisory.module_name}@${finding.version}`;
      if (!seen.has(key)) {
        seen.add(key);
        targets.push({
          name: advisory.module_name,
          version: finding.version,
        });
      }
    }
  }

  return targets;
}

async function runAudit(opts: PtduOptions): Promise<void> {
  const resolvedCwd = resolve(opts.cwd);

  setVerbose(opts.verbose);

  if (!existsSync(join(resolvedCwd, "pnpm-lock.yaml"))) {
    logger.error("No pnpm-lock.yaml found — are you in a pnpm project?");
    process.exit(1);
  }

  logger.info("\nRunning pnpm audit...\n");
  const audit = await pnpmAudit(resolvedCwd, opts.recursive);

  const targets = extractAuditTargets(audit);
  if (targets.length === 0) {
    logger.success("No vulnerable dependencies found!");
    return;
  }

  logger.info(`Found ${targets.length} vulnerable package(s) to process:\n`);
  for (const t of targets) {
    logger.info(`  • ${t.name}@${t.version}`);
  }
  logger.info("");

  let successCount = 0;
  let failCount = 0;

  for (const target of targets) {
    const packageArg = `${target.name}@${target.version}`;
    logger.info(`\n${"─".repeat(60)}`);
    logger.info(`Processing: ${packageArg}`);
    logger.info(`${"─".repeat(60)}`);
    try {
      await run(packageArg, opts);
      successCount++;
    } catch (err) {
      logger.error(`Failed to resolve ${packageArg}: ${err}`);
      failCount++;
    }
  }

  logger.info(`\n${"═".repeat(60)}`);
  logger.info("Audit summary:");
  if (successCount > 0) {
    logger.success(`  ${successCount} package(s) resolved`);
  }
  if (failCount > 0) {
    logger.error(`  ${failCount} package(s) failed`);
  }
}

const program = new Command();

program
  .name("ptdu")
  .description(
    "Update transitive dependencies in pnpm projects to resolve vulnerabilities",
  )
  .version(getVersion())
  .argument(
    "[package@version]",
    "Vulnerable package (e.g. qs@6.13.0). Not needed with --audit.",
  )
  .option(
    "--audit",
    "Run pnpm audit and process all vulnerable dependencies",
    false,
  )
  .option("--dry-run", "Print what would be done without making changes", false)
  .option("--cwd <path>", "Working directory", ".")
  .option("-r, --recursive", "Run in all workspace packages", false)
  .option("-v, --verbose", "Print detailed debug output", false)
  .action(async (packageArg: string | undefined, options) => {
    try {
      const opts: PtduOptions = {
        cwd: options.cwd,
        dryRun: options.dryRun,
        recursive: options.recursive,
        verbose: options.verbose,
      };

      if (options.audit) {
        await runAudit(opts);
      } else if (packageArg) {
        await run(packageArg, opts);
      } else {
        logger.error(
          "Please provide a <package@version> argument or use --audit.",
        );
        process.exit(1);
      }
    } catch (err) {
      logger.error(`Unexpected error: ${err}`);
      process.exit(1);
    }
  });

program.parse();
