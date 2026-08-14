import "dotenv/config";
import app from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();

if (!process.env.VERCEL) {
  app.listen(config.port, "127.0.0.1", () => {
    console.info(
      JSON.stringify({
        event: "server_started",
        address: `http://127.0.0.1:${config.port}`,
        paymentsMode: config.paymentsMode,
        treasuryMode: config.treasuryMode,
      }),
    );
  });
}

export default app;
