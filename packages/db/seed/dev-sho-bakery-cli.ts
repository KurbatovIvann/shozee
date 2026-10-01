import { loadServerConfig } from "@showzy/config";

import { createDbClient } from "../src/client.js";
import {
  devShoBakeryCompany,
  devShoBakeryProductionRefusal,
  seedDevShoBakery,
} from "./dev-sho-bakery.js";

if (process.env["NODE_ENV"] === "production") {
  console.error(devShoBakeryProductionRefusal);
  process.exit(1);
}

const config = loadServerConfig(process.env);
const client = createDbClient({ databaseUrl: config.database.url, max: 2 });

try {
  const seeded = await seedDevShoBakery(client.db);
  console.log(
    [
      `company ${devShoBakeryCompany.name} (${seeded.companyId})`,
      `products ${String(seeded.productCount)}, variants ${String(seeded.variantCount)}, customers ${String(seeded.customerCount)}`,
      `sign in with ${seeded.ownerEmail}${seeded.ownerPhone === null ? "" : ` or ${seeded.ownerPhone}`}`,
      "the dev OTP transport sends nothing: read the code from the verification table",
    ].join("\n"),
  );
} finally {
  await client.pool.end();
}
