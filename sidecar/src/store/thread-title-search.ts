import type { ApiRoutes } from "@touri/contracts"

type Matches = NonNullable<ApiRoutes["GET /search"]["res"]["threads"]>
type SearchInput = { query: string; botId?: string; personId?: string; signal: AbortSignal }

export const createThreadTitleSearch = (filename: string) => {
  // Keep worker ownership local and bound concurrent reads when someone types quickly.
  const workers = new Map<Worker, () => void>()
  let disposed = false

  const search = async ({ query, botId, personId, signal }: SearchInput): Promise<Matches> => {
    if (disposed || signal.aborted || !query.trim() || workers.size >= 2) return []
    const url = URL.createObjectURL(new Blob([workerSource], { type: "application/javascript" }))
    const worker = new Worker(url, { smol: true, ref: false })
    return new Promise<Matches>((resolve) => {
      const finish = (matches: Matches = []): void => {
        clearTimeout(timer)
        signal.removeEventListener("abort", abort)
        workers.delete(worker)
        worker.terminate()
        URL.revokeObjectURL(url)
        resolve(matches)
      }
      const abort = (): void => finish()
      const timer = setTimeout(abort, 5000)
      workers.set(worker, abort)
      signal.addEventListener("abort", abort, { once: true })
      worker.onmessage = ({ data }: MessageEvent<Matches>) => finish(Array.isArray(data) ? data : [])
      worker.onerror = (event) => {
        event.preventDefault()
        finish()
      }
      worker.postMessage({ filename, query: query.slice(0, 256), botId: botId ?? null, personId: personId ?? null })
    })
  }
  const dispose = (): void => {
    disposed = true
    workers.forEach((abort) => {
      abort()
    })
  }

  return { search, dispose }
}

const workerSource = `
import { Database, constants } from "bun:sqlite";
const normalize = (value) => value.normalize("NFD").replace(/\\p{M}/gu, "").toLocaleLowerCase("pt-BR");
self.onmessage = ({ data }) => {
  let database;
  try {
    database = new Database(data.filename, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW);
    database.exec("PRAGMA busy_timeout = 0");
    const tokens = normalize(data.query).trim().split(/\\s+/u);
    database.function("title_matches", { deterministic: true }, (title) => {
      const text = normalize(title);
      return tokens.every((token) => text.includes(token)) ? 1 : 0;
    });
    const matches = database.query(\`SELECT t.id, t.bot_id AS botId, substr(t.title, 1, 512) AS title,
      t.created_at AS createdAt, t.archived_at AS archivedAt
      FROM threads t JOIN bots b ON b.id = t.bot_id
      WHERE t.archived_at IS NOT NULL AND t.group_id IS NULL AND b.archived_at IS NULL
        AND (?1 IS NULL OR t.bot_id = ?1)
        AND (?2 IS NULL OR coalesce(t.owner_person_id, 'owner') = ?2)
        AND NOT EXISTS (SELECT 1 FROM thread_deletions WHERE thread_id = t.id)
        AND NOT EXISTS (SELECT 1 FROM bot_deletions WHERE bot_id = t.bot_id)
        AND title_matches(substr(t.title, 1, 512)) = 1
      ORDER BY t.id DESC LIMIT 50\`).all(data.botId, data.personId);
    self.postMessage(matches);
  } catch {
    self.postMessage([]);
  } finally {
    database?.close();
  }
};
`
