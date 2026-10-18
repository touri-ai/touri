/** Test-only event injection into the real `touri serve` boot path. Never bundled with the app. */
import { plugin } from "bun"

plugin({
  name: "server-memory-fixture",
  setup(builder) {
    builder.onLoad({ filter: /sidecar\/src\/cli\/serve\.ts$/ }, async ({ path }) => ({
      contents: new Bun.Transpiler({ loader: "ts" }).transformSync(
        (await Bun.file(path).text()).replace(
          "await initModules(runtime)",
          `await initModules(runtime)\nawait import(${JSON.stringify(new URL("./server-memory-workload.ts", import.meta.url).pathname)}).then(m => m.install(runtime.kernel))`,
        ),
      ),
      loader: "js",
    }))
  },
})
