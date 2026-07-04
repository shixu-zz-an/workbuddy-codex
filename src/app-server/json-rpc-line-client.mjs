import { EventEmitter } from "node:events";

export class JsonRpcLineClient {
  constructor({ input, output, logger = console }) {
    this.input = input;
    this.output = output;
    this.logger = logger;
    this.nextId = 1;
    this.buffer = "";
    this.pending = new Map();
    this.events = new EventEmitter();
    this.requestHandlers = [];

    this.input.on("data", (chunk) => this.#onData(chunk));
    this.input.on("error", (error) => this.#rejectAll(error));
    this.input.on("end", () => this.#rejectAll(new Error("JSON-RPC input ended")));
  }

  onNotification(handler) {
    this.events.on("notification", handler);
  }

  onRequest(handler) {
    this.requestHandlers.push(handler);
  }

  request(method, params = undefined) {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    const payload = `${JSON.stringify(message)}\n`;
    this.output.write(payload);

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
    });
  }

  notify(method, params = undefined) {
    const message = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  async #onData(chunk) {
    this.buffer += chunk.toString("utf8");
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        await this.#handleMessage(JSON.parse(line));
      } catch (error) {
        this.logger.warn?.("failed to process JSON-RPC line", error);
      }
    }
  }

  async #handleMessage(message) {
    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (Object.hasOwn(message, "id") && message.method) {
      this.#handleServerRequest(message);
      return;
    }

    if (message.method) {
      this.events.emit("notification", message);
    }
  }

  #handleServerRequest(message) {
    this.#resolveServerRequest(message).then(
      (result) => {
        this.output.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
      },
      (error) => {
        this.output.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32000, message: error?.message || String(error) },
          })}\n`,
        );
      },
    );
  }

  async #resolveServerRequest(message) {
    for (const handler of this.requestHandlers) {
      const handled = await handler(message);
      if (handled !== undefined) return handled;
    }
    throw new Error(`No handler for ${message.method}`);
  }

  #rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
