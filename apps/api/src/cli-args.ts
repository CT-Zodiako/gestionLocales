/** Reads `--name value` pairs; flags without a value are stored as "". */
export function parseArgs(argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg || !arg.startsWith("--")) continue;

    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      values[arg.slice(2)] = "";
      continue;
    }

    values[arg.slice(2)] = next;
    index += 1;
  }
  return values;
}
