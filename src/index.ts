import { loadConfig } from "./config.js";
import { PokeBridge } from "./bridge.js";
import { logger } from "./logger.js";
import { convertTelethonSessionFile } from "./session-converter.js";
import { loginTelegramStringSession } from "./telegram-client.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "start";

  if (command === "login") {
    await loginTelegramStringSession();
    return;
  }

  if (command === "convert-telethon-session") {
    convertTelethonSessionFile(process.argv[3], process.argv[4]);
    return;
  }

  if (command !== "start") {
    throw new Error(`Unknown command: ${command}. Use "start", "login", or "convert-telethon-session".`);
  }

  const config = loadConfig();
  const bridge = new PokeBridge(config);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    await bridge.stop().catch((error) => logger.error({ err: error }, "shutdown failed"));
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await bridge.start();
}

main().catch((error) => {
  logger.error({ err: error }, "fatal error");
  process.exit(1);
});
