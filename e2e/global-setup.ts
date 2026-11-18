import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { cleanup, seed } from "./support/seed.ts";

/** Seeds a uniquely named owner and its agenda; the returned function is the global teardown. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const state = await seed();
  process.env.E2E_STATE = JSON.stringify(state);

  return async () => {
    try {
      // Both owners are removed even when the first cleanup fails.
      await cleanup({ email: state.email, businessName: state.businessName }).finally(() =>
        cleanup({ email: state.ownerB.email, businessName: state.ownerB.businessName }),
      );
    } finally {
      rmSync(dirname(state.storageStatePath), { recursive: true, force: true });
    }
  };
}
