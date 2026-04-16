import pc from "picocolors";

let verboseEnabled = false;

export function setVerbose(enabled: boolean): void {
  verboseEnabled = enabled;
}

export function info(msg: string): void {
  console.log(msg);
}

export function success(msg: string): void {
  console.log(pc.green(`✔ ${msg}`));
}

export function warn(msg: string): void {
  console.log(pc.yellow(`⚠ ${msg}`));
}

export function error(msg: string): void {
  console.error(pc.red(`✘ ${msg}`));
}

export function verbose(msg: string): void {
  if (verboseEnabled) {
    console.log(pc.dim(`  [verbose] ${msg}`));
  }
}

export function dryRun(msg: string): void {
  console.log(pc.cyan(`[dry-run] ${msg}`));
}
