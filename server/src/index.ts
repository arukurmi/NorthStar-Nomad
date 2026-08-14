import { createApp } from "./app.js";
import { assertVaultConfigured } from "./ai/vault.js";

// Before anything is built or bound: a production process without a usable
// NOMAD_MASTER_KEY cannot encrypt anyone's AI key, so it refuses to start
// rather than accepting keys it can only store badly.
assertVaultConfigured();

const port = Number(process.env.PORT ?? 4000);
createApp().listen(port, () => {
  console.log(`northstar-nomad server listening on :${port}`);
});
