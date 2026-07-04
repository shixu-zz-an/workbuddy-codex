import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { CONFIG_FILE, endpointFor, readConfig, sanitizeConfigForDisplay, writeConfig } from "./config.mjs";
import { startGateway } from "./server.mjs";
import { installDefaultWorkBuddyModels } from "./workbuddy-config.mjs";

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || "serve";
  if (command === "serve" || command === "start") return serve();
  if (command === "install-workbuddy") return installWorkBuddy();
  if (command === "doctor") return doctor();
  if (command === "config") return printConfig();
  usage();
  process.exitCode = 1;
}

async function serve() {
  const config = await readConfig();
  await writeConfig(config);
  const gateway = await startGateway({ config, configFile: CONFIG_FILE });
  console.log(`workbuddy-codex listening on ${endpointFor(config)}`);
  console.log(`dashboard: http://${config.server.host}:${config.server.port}/`);
  process.on("SIGINT", async () => {
    await gateway.close();
    process.exit(0);
  });
}

async function installWorkBuddy() {
  const config = await readConfig();
  const results = await installDefaultWorkBuddyModels({ config, endpoint: endpointFor(config) });
  for (const result of results) {
    console.log(`wrote ${result.model.id} -> ${result.file}`);
  }
}

async function doctor() {
  const config = await readConfig();
  const codex = spawnSync(config.codex.bin || "codex", ["--version"], { encoding: "utf8" });
  const checks = {
    configFile: CONFIG_FILE,
    endpoint: endpointFor(config),
    codexFound: codex.status === 0,
    codexVersion: (codex.stdout || codex.stderr || "").trim(),
    workbuddyConfigDirExists: await exists(config.workbuddy.configDir),
    config: sanitizeConfigForDisplay(config),
  };
  console.log(JSON.stringify(checks, null, 2));
}

async function printConfig() {
  const config = await readConfig();
  console.log(JSON.stringify(sanitizeConfigForDisplay(config), null, 2));
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function usage() {
  console.log(`Usage:
  workbuddy-codex serve
  workbuddy-codex install-workbuddy
  workbuddy-codex doctor
  workbuddy-codex config`);
}
