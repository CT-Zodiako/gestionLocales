import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Runs `docker compose <args>` at the repo root and returns stdout. `env` is added to the process env. */
export function compose(args: string[], options: { input?: string; env?: Record<string, string> } = {}): string {
  return execFileSync("docker", ["compose", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    input: options.input,
    env: { ...process.env, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
}
