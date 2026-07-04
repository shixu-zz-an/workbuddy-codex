import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";

export class RequestLog {
  constructor({ file, logger = console } = {}) {
    this.file = file || path.join(process.cwd(), "logs", "requests.log");
    this.logger = logger;
    this.pending = Promise.resolve();
  }

  write(event, fields = {}) {
    const payload = {
      timestamp: new Date().toISOString(),
      event,
      ...fields,
    };
    const line = `${JSON.stringify(payload)}\n`;
    this.pending = this.pending
      .then(async () => {
        await mkdir(path.dirname(this.file), { recursive: true });
        await appendFile(this.file, line, "utf8");
      })
      .catch((error) => {
        this.logger.warn?.(`failed to write request log: ${error?.message || error}`);
      });
    return this.pending;
  }

  async flush() {
    await this.pending;
  }
}
