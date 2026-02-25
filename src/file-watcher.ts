import { watch, type FSWatcher } from "chokidar";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { EventEmitter } from "node:events";

export interface FileChangeEvent {
  file: string;
  content: string;
}

export class FileWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private filePath: string;
  private lastContent: string = "";

  constructor(filePath: string) {
    super();
    this.filePath = resolve(filePath);
  }

  async start(): Promise<string> {
    this.lastContent = await readFile(this.filePath, "utf-8");

    this.watcher = watch(this.filePath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });

    this.watcher.on("change", async () => {
      try {
        const newContent = await readFile(this.filePath, "utf-8");
        if (newContent !== this.lastContent) {
          const oldContent = this.lastContent;
          this.lastContent = newContent;
          this.emit("change", {
            file: this.filePath,
            content: newContent,
            oldContent,
          } as FileChangeEvent & { oldContent: string });
        }
      } catch (err) {
        process.stderr.write(`File watch read error: ${err}\n`);
      }
    });

    return this.lastContent;
  }

  getContent(): string {
    return this.lastContent;
  }

  getFilePath(): string {
    return this.filePath;
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
