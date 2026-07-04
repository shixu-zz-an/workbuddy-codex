import { spawn } from "node:child_process";
import { JsonRpcLineClient } from "./json-rpc-line-client.mjs";

export class CodexAppServerClient {
  constructor({ config, logger = console } = {}) {
    this.config = config;
    this.logger = logger;
    this.child = null;
    this.rpc = null;
    this.started = false;
    this.stderrTail = [];
  }

  async start() {
    if (this.started) return;
    const codex = this.config.codex || {};
    const args = ["app-server", "--stdio"];
    if (codex.effort) args.push("-c", `model_reasoning_effort="${codex.effort}"`);
    if (Array.isArray(codex.appServerArgs)) args.push(...codex.appServerArgs);

    this.child = spawn(codex.bin || "codex", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      this.stderrTail.push(text);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
    });

    this.rpc = new JsonRpcLineClient({
      input: this.child.stdout,
      output: this.child.stdin,
      logger: this.logger,
    });

    this.child.on("exit", (code, signal) => {
      this.started = false;
      this.logger.warn?.(`codex app-server exited code=${code} signal=${signal || ""}`);
    });

    await this.rpc.request("initialize", {
      clientInfo: { name: "workbuddy-codex", version: "0.1.0" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.rpc.notify("initialized");
    this.started = true;
  }

  request(method, params) {
    if (!this.rpc) throw new Error("Codex app-server client is not started");
    return this.rpc.request(method, params);
  }

  onNotification(handler) {
    if (!this.rpc) throw new Error("Codex app-server client is not started");
    this.rpc.onNotification(handler);
  }

  onRequest(handler) {
    if (!this.rpc) throw new Error("Codex app-server client is not started");
    this.rpc.onRequest(handler);
  }

  async stop() {
    if (!this.child) return;
    this.child.kill("SIGTERM");
    this.child = null;
    this.rpc = null;
    this.started = false;
  }

  diagnostics() {
    return {
      started: this.started,
      stderrTail: this.stderrTail.join("").slice(-4000),
    };
  }
}
