import type { SQLQueryBindings } from "bun:sqlite"
import { deferWorkerReply } from "../kernel/worker-reply"
import { messageRowSource } from "./message-row"

type ReadQuery = { sql: string; bindings: SQLQueryBindings[] }
export type MessageReferences = { threadId: string; messageId: string; attachmentIds: string[] }
type MessageReply = { body: Uint8Array; references: MessageReferences[] }

export const createStoreReader = (filename: string) => {
  // Each request owns its connection. Cancellation kills SQL as well as its waiter.
  const pending = new Map<Worker, () => void>()
  let disposed = false

  const getResult = <Value>(query: ReadQuery, signal: AbortSignal, messages = false): Promise<Value> => {
    signal.throwIfAborted()
    if (disposed || pending.size >= 2) return Promise.reject(new Error("STORE_READ_CAPACITY"))

    const url = URL.createObjectURL(new Blob([storeReadWorkerSource], { type: "application/javascript" }))
    const worker = new Worker(url, { smol: true, ref: false })

    return new Promise<Value>((resolve, reject) => {
      const finish = (value?: Value, error?: Error): void => {
        if (!pending.has(worker)) return

        clearTimeout(timer)
        signal.removeEventListener("abort", abort)
        pending.delete(worker)
        worker.terminate()
        URL.revokeObjectURL(url)
        deferWorkerReply(() => (error ? reject(error) : resolve(value as Value)))
      }
      const abort = (): void => finish(undefined, new Error("STORE_READ_ABORTED"))
      const timer = setTimeout(() => finish(undefined, new Error("STORE_READ_TIMEOUT")), 15_000)
      pending.set(worker, abort)
      signal.addEventListener("abort", abort, { once: true })
      worker.onmessage = ({ data }) => {
        if (data.ok) finish(data.value)
        else finish(undefined, new Error("STORE_READ_FAILED"))
      }
      worker.onerror = (event) => {
        event.preventDefault()
        finish(undefined, new Error("STORE_READ_FAILED"))
      }
      worker.postMessage({ filename, query, messages })
    })
  }

  const dispose = (): void => {
    disposed = true
    pending.forEach((abort) => {
      abort()
    })
  }

  return {
    getRows: <Row>(query: ReadQuery, signal: AbortSignal): Promise<Row[]> => getResult<Row[]>(query, signal),
    getMessages: (
      query: ReadQuery & { activeLeafId: string | null; reverse?: boolean },
      signal: AbortSignal,
    ): Promise<MessageReply> => getResult<MessageReply>(query, signal, true),
    dispose,
  }
}

export const storeReadWorkerSource = `
import { Database, constants } from "bun:sqlite";
${messageRowSource}
self.onmessage = ({ data }) => {
  let database;
  try {
    database = new Database(data.filename, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW);
    database.exec("PRAGMA busy_timeout = 0; PRAGMA query_only = ON; PRAGMA cache_size = -8192");
    const statement = database.query(data.query.sql);
    if (!data.messages) {
      self.postMessage({ ok: true, value: statement.all(...data.query.bindings) });
      return;
    }

    // Accumulators are private to this worker. Large JSON never crosses as an object
    // or gets parsed/serialized again on the server event loop. Bound peak memory.
    const messages = [];
    const references = [];
    let bytes = 0;
    for (const row of statement.iterate(...data.query.bindings)) {
      const message = getMessageFromRow(row);
      const serialized = JSON.stringify(message);
      bytes += Buffer.byteLength(serialized);
      if (bytes > 64 * 1024 * 1024) throw new Error("STORE_READ_LIMIT");
      messages.push(serialized);
      const ids = [...new Set(message.parts.flatMap((part) => {
        if (part.type === "image" || part.type === "file") return [part.attachmentId];
        return typeof part.outputAttachmentId === "string" ? [part.outputAttachmentId] : [];
      }))];
      if (ids.length) references.push({ threadId: message.threadId, messageId: message.id, attachmentIds: ids });
    }
    // Reverse only the worker-local ancestry, just as the synchronous active path did.
    const ordered = data.query.reverse ? messages.reverse() : messages;
    const body = new TextEncoder().encode('{"messages":[' + ordered.join(',') +
      '],"activeLeafId":' + JSON.stringify(data.query.activeLeafId ?? null) + '}');
    self.postMessage({ ok: true, value: { body, references } }, [body.buffer]);
  } catch {
    // Never forward SQL, bindings, database paths or stored content as diagnostics.
    self.postMessage({ ok: false });
  } finally {
    database?.close();
  }
};
`
