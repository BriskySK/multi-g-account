import "dotenv/config";
import { loadConfig } from "./config.js";
import { TokenStore } from "./db.js";
import { GoogleAuthService } from "./google/auth.js";
import { createApp } from "./http.js";

const config = loadConfig();
const store = new TokenStore(config.DB_PATH, config.TOKEN_ENCRYPTION_KEY);
const auth = new GoogleAuthService(config, store);
const app = createApp({ config, store, auth });

const server = app.listen(config.PORT, () => {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: "server_started",
      port: config.PORT,
      publicUrl: config.PUBLIC_URL,
      redirectUri: config.redirectUri,
    }),
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
