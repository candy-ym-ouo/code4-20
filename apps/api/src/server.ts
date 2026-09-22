import { buildApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./lib/db.js";
import { ReminderScheduler } from "./lib/reminderScheduler.js";
import { initReminderReconciler } from "./lib/reminderReconcileTrigger.js";

const app = await buildApp({ runDatabaseMigrations: true });

initReminderReconciler(app.log);
const reminderScheduler = config.REMINDER_SCHEDULER_ENABLED ? new ReminderScheduler(app.log) : null;

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  try {
    reminderScheduler?.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, "shutdown failed");
    process.exit(1);
  }
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.APP_HOST, port: config.APP_PORT });
  reminderScheduler?.start();
} catch (error) {
  app.log.error(error);
  await pool.end();
  process.exit(1);
}
