import { TouriError } from "../kernel/errors"
import { deferWorkerReply } from "../kernel/worker-reply"

// Keep the synchronous filesystem contract without entering the HTTP event loop
// while a native helper runs. Child I/O and exit handling stay on this worker.
const source = `const execute = async (data) => {
  const { buffer, command, input, env, deadline } = data;
  const state = new Int32Array(buffer, 0, 4);
  const bytes = new Uint8Array(buffer, 16);
  if (Atomics.load(state, 0) !== 0) return;
  let child;
  let timer;
  let length = 0;
  let status = 2;
  let exitCode = 1;
  try {
    child = Bun.spawn({ cmd: command, stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "ignore", env });
    const exited = child.exited;
    timer = setInterval(() => {
      if (Date.now() >= deadline || Atomics.load(state, 0) < 0) { try { child.kill("SIGKILL"); } catch {} }
    }, 20);
    if (input !== undefined) { child.stdin.write(input); child.stdin.end(); }
    const reader = child.stdout.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (length + chunk.value.length > bytes.length) throw new Error("reply limit");
        bytes.set(chunk.value, length);
        length += chunk.value.length;
      }
    } finally { reader.releaseLock(); }
    exitCode = await exited;
    // A deadline kill can settle before the waiting caller wakes up.
    // Publish failure even when that child exit was otherwise handled normally.
    status = Date.now() < deadline ? 1 : 2;
  } catch {
    if (child) { try { child.kill("SIGKILL"); } catch {} await child.exited.catch(() => {}); }
  } finally {
    clearInterval(timer);
    Atomics.store(state, 1, exitCode);
    Atomics.store(state, 2, length);
    if (Atomics.compareExchange(state, 0, 0, status) === 0) Atomics.notify(state, 0);
  }
};

// Subprocess I/O must not await completion inside a worker inbox continuation.
self.onmessage = ({ data }) => {
  setTimeout(() => { void execute(data); }, 0);
};
self.postMessage("ready");`

type RefableWorker = Worker & { ref: () => void; unref: () => void }
type Helper = { worker: RefableWorker; ready: Promise<void>; stop: () => void }

// This module owns one native helper worker and its bounded startup lifecycle.
let helper: Helper | undefined
const createHelperWorker = (createWorker = (url: string) => new Worker(url, { smol: true })): Helper => {
  if (helper) return helper

  const url = URL.createObjectURL(new Blob([source], { type: "application/javascript" }))
  const worker = createNativeWorker(url, createWorker)
  const ready = Promise.withResolvers<void>()
  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (helper?.worker === worker) helper = undefined
    clearTimeout(deadline)
    worker.terminate()
    URL.revokeObjectURL(url)
    deferWorkerReply(() => ready.reject(new TouriError("TOURI-E2001")))
  }
  const deadline = setTimeout(stop, 10_000)
  worker.onmessage = ({ data }): void => {
    if (data !== "ready" || stopped) return
    clearTimeout(deadline)
    deferWorkerReply(() => {
      if (stopped) return
      worker.unref()
      ready.resolve()
    })
  }
  worker.onerror = (event): void => {
    event.preventDefault()
    stop()
  }
  worker.addEventListener("close", stop)
  // Synchronous startup callers cannot await this acknowledgement, but still own cleanup.
  void ready.promise.catch(() => undefined)
  helper = { worker, ready: ready.promise, stop }
  return helper
}

const createNativeWorker = (url: string, createWorker: (url: string) => Worker): RefableWorker => {
  try {
    return createWorker(url) as RefableWorker
  } catch {
    URL.revokeObjectURL(url)
    throw new TouriError("TOURI-E2001")
  }
}

export const startHelperWorker = (createWorker?: (url: string) => Worker): Promise<void> =>
  createHelperWorker(createWorker).ready

export const stopHelperWorker = (): void => {
  helper?.stop()
}

export const runHelperBlocking = ({
  command,
  input,
  env,
  timeoutMs = 10_000,
  maxResponseBytes = 1024 * 1024,
}: {
  command: string[]
  input?: string
  env: Record<string, string>
  timeoutMs?: number
  maxResponseBytes?: number
}): { stdout: string; exitCode: number } => {
  const buffer = new SharedArrayBuffer(16 + maxResponseBytes)
  const state = new Int32Array(buffer, 0, 4)
  const current = createHelperWorker()
  current.worker.ref()
  try {
    current.worker.postMessage({ buffer, command, input, env, deadline: Date.now() + timeoutMs })
    Atomics.wait(state, 0, 0, timeoutMs)
    if (Atomics.load(state, 0) !== 1) {
      Atomics.compareExchange(state, 0, 0, -1)
      throw new TouriError("TOURI-E2001")
    }
    return {
      stdout: new TextDecoder().decode(new Uint8Array(buffer, 16, Atomics.load(state, 2))),
      exitCode: Atomics.load(state, 1),
    }
  } catch {
    throw new TouriError("TOURI-E2001")
  } finally {
    current.worker.unref()
  }
}
