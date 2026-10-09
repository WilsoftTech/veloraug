import "server-only";
import { mkdir, open, readFile, unlink, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveJournalDir, writeAtomicJournalJson } from "@/lib/uploader/journal";
import { initialInbox } from "@/lib/discovery/events";
import { inboxSchema, type Inbox, type InboxStore } from "@/lib/discovery/model";

/** Single-machine offline store. Database authority is deliberately not emulated here. */
export async function openInbox(directory: string, projectRoot: string, channelId: number): Promise<InboxStore> {
  const dir = resolveJournalDir(directory, projectRoot);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "discovery-inbox.json");
  const lockPath = join(dir, "discovery.lock");
  const reclaimPath = join(dir, "discovery-reclaim");
  async function read(): Promise<Inbox> {
    try {
      if ((await stat(path)).size > 32 * 1024 * 1024) throw new Error("inbox_size_limit");
      const inbox = inboxSchema.parse(JSON.parse(await readFile(path, "utf8")));
      if (inbox.channelId !== channelId) throw new Error("inbox_channel_mismatch");
      return inbox;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return initialInbox(channelId);
      throw error;
    }
  }
  async function reclaimDeadOwner() {
    try { await mkdir(reclaimPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
      throw error;
    }
    try {
      let owner: { pid?: number };
      try { owner = JSON.parse(await readFile(lockPath, "utf8")); } catch { return; }
      if (!Number.isSafeInteger(owner.pid) || !owner.pid || owner.pid <= 0) return;
      try { process.kill(owner.pid, 0); } catch (error) {
        // Only a definitely dead local PID is reclaimable; permission errors fail closed.
        if ((error as NodeJS.ErrnoException).code === "ESRCH") await unlink(lockPath);
      }
    } finally { await rmdir(reclaimPath); }
  }
  async function lock() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID() }));
        await handle.sync(); await handle.close();
        return async () => { await unlink(lockPath); };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await reclaimDeadOwner();
        await new Promise((done) => setTimeout(done, 20));
      }
    }
    throw new Error("inbox_busy_operator_required");
  }
  return { read, async transaction<T>(change: (inbox: Inbox) => T): Promise<T> {
    const release = await lock();
    try {
      const inbox = await read();
      const result = change(inbox);
      // Synchronous callbacks only: no external effect can happen inside the local transaction.
      if (result instanceof Promise) throw new Error("async_transaction_not_allowed");
      const validated = inboxSchema.parse(inbox);
      if (Buffer.byteLength(JSON.stringify(validated)) > 32 * 1024 * 1024) throw new Error("inbox_size_limit");
      await writeAtomicJournalJson(path, validated);
      return result;
    } finally { await release(); }
  } };
}
