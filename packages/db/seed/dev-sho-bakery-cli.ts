import { loadServerConfig } from "@showzy/config";

import { createDbClient } from "../src/client.js";
import {
  devShoBakeryCompany,
  devShoBakeryOwner,
  seedDevShoBakery,
} from "./dev-sho-bakery.js";

const config = loadServerConfig(process.env);

if (config.nodeEnv === "production") {
  console.error("dev-sho-bakery seed refuses to run with NODE_ENV=production");
  process.exit(1);
}

const client = createDbClient({ databaseUrl: config.database.url, max: 2 });

try {
  const seeded = await seedDevShoBakery(client.db);
  console.log(
    [
      `company ${devShoBakeryCompany.name} (${seeded.companyId})`,
      `products ${String(seeded.productCount)}, variants ${String(seeded.variantCount)}, customers ${String(seeded.customerCount)}`,
      `sign in with ${devShoBakeryOwner.email} or ${devShoBakeryOwner.phone}`,
      "the dev OTP transport sends nothing: read the code from the verification table",
    ].join("\n"),
  );
} finally {
  await client.pool.end();
}
