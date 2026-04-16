import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as logger from "./logger.js";
import type { PnpmWhyNode } from "./types.js";

const execFileAsync = promisify(execFile);

async function runPnpm(args: string[], cwd: string): Promise<string> {
  logger.verbose(`pnpm ${args.join(" ")}`);
  const { stdout } = await execFileAsync("pnpm", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * Run `pnpm why <pkg>@<version> --json` and return parsed tree.
 */
export async function pnpmWhy(
  pkg: string,
  version: string,
  cwd: string,
  recursive: boolean,
): Promise<PnpmWhyNode[]> {
  const args = ["why", `${pkg}@${version}`, "--json"];
  if (recursive) args.push("-r");
  const output = await runPnpm(args, cwd);
  if (!output) return [];
  try {
    const parsed = JSON.parse(output);
    // pnpm why --json may return an array or an object depending on context
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/**
 * Get the dependencies of a specific package version.
 * Returns a record of { dependencyName: versionRange }
 */
export async function pnpmInfoDeps(
  pkg: string,
  version: string,
  cwd: string,
): Promise<Record<string, string>> {
  try {
    const output = await runPnpm(
      ["info", `${pkg}@${version}`, "dependencies", "--json"],
      cwd,
    );
    if (!output) return {};
    const parsed = JSON.parse(output);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

/**
 * Get available versions of a package matching a semver range.
 * Uses `pnpm view <pkg>@<range> version --json`
 */
export async function pnpmViewVersions(
  pkg: string,
  range: string,
  cwd: string,
): Promise<string[]> {
  try {
    const output = await runPnpm(
      ["view", `${pkg}@${range}`, "version", "--json"],
      cwd,
    );
    if (!output) return [];
    const parsed = JSON.parse(output);
    // Could be a single string or array of strings
    if (typeof parsed === "string") return [parsed];
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    return [];
  }
}

/**
 * Run pnpm install.
 */
export async function pnpmInstall(
  cwd: string,
  recursive: boolean,
): Promise<void> {
  const args = ["install"];
  if (recursive) args.push("-r");
  logger.info("Running pnpm install...");
  const output = await runPnpm(args, cwd);
  if (output) logger.verbose(output);
}
