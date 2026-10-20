export {}

const mode = process.argv[2]
const request = (await new Response(Bun.stdin.stream()).json()) as { max_bytes: number }
if (mode === "stall") await Bun.sleep(60_000)
if (mode === "failure") process.exit(1)
await Bun.sleep(50)
await Bun.write(Bun.stdout, Buffer.alloc(request.max_bytes + (mode === "oversized" ? 1 : 0), 65))
