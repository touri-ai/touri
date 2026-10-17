import type { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { refreshHostFolderAccess } from "../../src/kernel/folder-capability"
import { createHarness } from "./harness"

const available = process.platform === "linux" && (await refreshHostFolderAccess())

for (const access of ["workspace-write", "full"])
  test.skipIf(!available)(
    `approved ${access} project processes inherit folder isolation`,
    async () => {
      const h = await createHarness()
      const root = mkdtempSync(join(homedir(), "touri-process-isolation-"))
      try {
        const ro = join(root, "reference")
        const rw = join(root, "output")
        const outside = join(root, "ungranted/secret")
        for (const path of [ro, rw, join(root, "ungranted")]) mkdirSync(path)
        writeFileSync(outside, "outside-secret")
        writeFileSync(join(ro, "reference.txt"), "reference-proof")
        symlinkSync(outside, join(rw, "link"))
        const response = await h.request("/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: h.projectPath }),
        })
        const { project } = (await response.json()) as { project: { id: string; dataDir: string } }
        const db = h.runtime.kernel.db as Database
        db.query("UPDATE bots SET access = ?, folders_json = ? WHERE id = 'bot-test'").run(
          access,
          JSON.stringify([
            { path: ro, access: "read-only" },
            { path: rw, access: "read-write" },
          ]),
        )
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
        const denied = [
          outside,
          `${ro}/../ungranted/secret`,
          join(rw, "link"),
          `/proc/self/root${outside}`,
          `/proc/${process.pid}/root${outside}`,
          join(h.runtime.kernel.paths.appData, "touri.db"),
        ]
        const script = [
          ...denied.map((path) => `if cat ${quote(path)}; then echo ESCAPED; exit 9; fi`),
          `if printf bad > ${quote(join(ro, "reference.txt"))}; then echo ESCAPED; exit 9; fi`,
          `cat ${quote(join(ro, "reference.txt"))}`,
          `printf saved > ${quote(join(rw, "saved.txt"))}`,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: expanded by the confined shell
          `printf '%s' "$APPROVED_TOKEN" > ${quote(join(rw, "env-proof"))}`,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: expanded by the confined shell
          "printf '%s\\n' \"${UNRELATED_SECRET:-absent}\"",
          "echo READY; sleep 60",
        ].join("; ")
        expect(
          (
            await h.tool(
              "process_define",
              {
                name: "confined",
                command: script,
                env: { APPROVED_TOKEN: "approved-proof" },
                ready: { logRegex: "READY" },
                autostart: false,
              },
              project.id,
            )
          ).success,
        ).toBe(true)
        const previous = process.env.UNRELATED_SECRET
        process.env.UNRELATED_SECRET = "unrelated-proof"
        try {
          expect((await h.tool("process_start", { name: "confined", waitMs: 5000 }, project.id)).success).toBe(true)
        } finally {
          if (previous === undefined) delete process.env.UNRELATED_SECRET
          else process.env.UNRELATED_SECRET = previous
        }
        const logs = await h.tool("process_logs", { name: "confined" }, project.id)
        expect(logs.success).toBe(true)
        expect(JSON.stringify(logs)).toContain("reference-proof")
        expect(readFileSync(join(rw, "env-proof"), "utf8")).toBe("approved-proof")
        expect(JSON.stringify(logs)).not.toMatch(/ESCAPED|outside-secret|unrelated-proof/)
        expect(readFileSync(join(ro, "reference.txt"), "utf8")).toBe("reference-proof")
        expect(existsSync(join(rw, "saved.txt"))).toBe(true)
        await h.tool("process_stop", { name: "confined" }, project.id)
      } finally {
        await h.close()
        rmSync(root, { recursive: true, force: true })
      }
    },
    30_000,
  )
