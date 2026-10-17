import { TouriError } from "../kernel/errors"

// Keep the synchronous filesystem contract without entering the HTTP event loop
// while a native helper runs. Child I/O and exit handling stay on this worker.
const source = `self.onmessage = async ({ data }) => {
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
    exitCode = await child.exited;
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
};`

let worker: Worker | undefined
let workerUrl: string | undefined
const helperWorker = () => {
  if (!worker) {
    workerUrl = URL.createObjectURL(new Blob([source], { type: "application/javascript" }))
    worker = new Worker(workerUrl, { smol: true, ref: false })
  }
  return worker
}

export const stopHelperWorker = (): void => {
  worker?.terminate()
  worker = undefined
  if (workerUrl) URL.revokeObjectURL(workerUrl)
  workerUrl = undefined
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
  try {
    helperWorker().postMessage({ buffer, command, input, env, deadline: Date.now() + timeoutMs })
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
  }
}
