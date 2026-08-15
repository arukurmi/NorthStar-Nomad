import { createApp } from "./app.js";
import { assertVaultConfigured } from "./ai/vault.js";
import { assertAuthConfigured } from "./auth/tokens.js";

// Before anything is built or bound: a production process without a usable
// NOMAD_MASTER_KEY cannot encrypt anyone's AI key, so it refuses to start
// rather than accepting keys it can only store badly.
assertVaultConfigured();

// The same bar for the token secret. An encrypted vault is worth nothing if
// anyone holding this repo can forge the session that opens it.
assertAuthConfigured();

const port = Number(process.env.PORT ?? 4000);
createApp().listen(port, () => {
  console.log(`northstar-nomad server listening on :${port}`);
});
