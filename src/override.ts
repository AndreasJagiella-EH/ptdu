import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import * as YAML from "yaml";
import * as logger from "./logger.js";
import type { Override } from "./types.js";

type ConfigFormat = "workspace-yaml" | "package-json";

interface ConfigState {
  format: ConfigFormat;
  filePath: string;
  originalContent: string;
}

let configState: ConfigState | null = null;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect which config file to use for overrides.
 */
async function detectConfigFormat(cwd: string): Promise<ConfigState> {
  // Check for pnpm-workspace.yaml first
  const workspaceYamlPath = join(cwd, "pnpm-workspace.yaml");
  if (await fileExists(workspaceYamlPath)) {
    const content = await readFile(workspaceYamlPath, "utf-8");
    return {
      format: "workspace-yaml",
      filePath: workspaceYamlPath,
      originalContent: content,
    };
  }

  // Fallback to package.json
  const packageJsonPath = join(cwd, "package.json");
  const content = await readFile(packageJsonPath, "utf-8");
  return {
    format: "package-json",
    filePath: packageJsonPath,
    originalContent: content,
  };
}

/**
 * Apply overrides to the config file.
 */
export async function applyOverrides(
  overrides: Override[],
  cwd: string,
): Promise<void> {
  configState = await detectConfigFormat(cwd);
  const { format, filePath } = configState;

  logger.verbose(`Using ${format} at ${filePath} for overrides`);

  if (format === "workspace-yaml") {
    await applyWorkspaceYamlOverrides(filePath, overrides);
  } else {
    await applyPackageJsonOverrides(filePath, overrides);
  }
}

async function applyWorkspaceYamlOverrides(
  filePath: string,
  overrides: Override[],
): Promise<void> {
  const content = await readFile(filePath, "utf-8");
  const doc = YAML.parseDocument(content);

  // Ensure overrides key exists
  if (!doc.has("overrides")) {
    doc.set("overrides", doc.createNode({}));
  }

  const overridesNode = doc.get("overrides", true) as YAML.YAMLMap;

  for (const override of overrides) {
    logger.info(`  Adding override: ${override.package} → ${override.version}`);
    if (overridesNode && typeof overridesNode.set === "function") {
      overridesNode.set(override.package, override.version);
    }
  }

  await writeFile(filePath, doc.toString(), "utf-8");
}

async function applyPackageJsonOverrides(
  filePath: string,
  overrides: Override[],
): Promise<void> {
  const content = await readFile(filePath, "utf-8");
  const pkg = JSON.parse(content);

  if (!pkg.pnpm) pkg.pnpm = {};
  if (!pkg.pnpm.overrides) pkg.pnpm.overrides = {};

  for (const override of overrides) {
    logger.info(`  Adding override: ${override.package} → ${override.version}`);
    pkg.pnpm.overrides[override.package] = override.version;
  }

  // Preserve formatting: detect indent
  const indent = content.match(/^(\s+)/m)?.[1] ?? "  ";
  await writeFile(filePath, JSON.stringify(pkg, null, indent) + "\n", "utf-8");
}

/**
 * Remove the overrides that were added and restore the original file.
 */
export async function removeOverrides(): Promise<void> {
  if (!configState) {
    logger.warn("No config state to restore");
    return;
  }

  logger.info("Removing temporary overrides...");
  await writeFile(configState.filePath, configState.originalContent, "utf-8");
  configState = null;
}

/**
 * Rollback: restore original config file on failure.
 */
export async function rollback(): Promise<void> {
  if (!configState) return;
  logger.warn("Rolling back config changes...");
  await writeFile(configState.filePath, configState.originalContent, "utf-8");
  configState = null;
}
