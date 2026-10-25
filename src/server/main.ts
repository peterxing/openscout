import { spawn } from "node:child_process";
import { OpenScoutApp } from "./app.js";
import { log } from "./util.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const app = new OpenScoutApp({ host: "web" });
const { url } = await app.start({ port: Number(arg("--port") ?? 47710) });
log("app", `OpenScout is running at ${url}`);

if (process.argv.includes("--open")) {
  const cmd = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  log("app", "Shutting down…");
  await app.stop().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
