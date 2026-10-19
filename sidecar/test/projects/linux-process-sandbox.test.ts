import type { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { refreshHostFolderAccess } from "../../src/kernel/folder-capability"
import { createHarness } from "./harness"

const available = process.platform === "linux" && (await refreshHostFolderAccess())

// Full access has no folder restriction, so only bounded bots are confined.
for (const access of ["workspace-write"])
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
        const result = await response.json()
        if (response.status !== 201)
          throw new Error(`Project setup failed (${response.status}): ${JSON.stringify(result)}`)
        const { project } = result as { project: { id: string; dataDir: string } }
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
          `printf '%s' "$APPROVED_TOKEN" > ${quote(join(rw, "env-proof"))}`,
          `printf '%s' "$NODE_ENV" > ${quote(join(rw, "mode-proof"))}`,
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
                env: { APPROVED_TOKEN: "approved-proof", NODE_ENV: "production" },
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
        expect(readFileSync(join(rw, "mode-proof"), "utf8")).toBe("production")
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

for (const mode of ["remove", "read-only"] as const)
  test.skipIf(!available)(
    `a running process loses its old mounts when a grant is ${mode}`,
    async () => {
      const h = await createHarness()
      const root = mkdtempSync(join(homedir(), "touri-process-revoke-"))
      try {
        writeFileSync(join(root, "reference"), "revocation-proof")
        const response = await h.request("/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: h.projectPath }),
        })
        const result = await response.json()
        if (response.status !== 201)
          throw new Error(`Project setup failed (${response.status}): ${JSON.stringify(result)}`)
        const { project } = result as { project: { id: string } }
        const db = h.runtime.kernel.db as Database
        const patch = (folders: unknown[]) =>
          h.request("/bots/bot-test", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ access: "workspace-write", folders }),
          })
        expect((await patch([{ path: root, access: "read-write" }])).status).toBe(200)
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
        const trigger = join(h.projectPath, "continue")
        const output = join(root, "after-revocation")
        const command = `echo READY; while [ ! -f ${quote(trigger)} ]; do sleep 0.05; done; cat ${quote(join(root, "reference"))}; printf stale > ${quote(output)}; echo ATTEMPTED; sleep 60`
        expect(
          (
            await h.tool(
              "process_define",
              { name: "waiting", command, ready: { logRegex: "READY" }, restart: "always" },
              project.id,
            )
          ).success,
        ).toBe(true)
        expect((await h.tool("process_start", { name: "waiting", waitMs: 5000 }, project.id)).success).toBe(true)
        const run = db.query("SELECT id FROM process_runs ORDER BY started_at DESC LIMIT 1").get() as { id: string }
        expect((await patch(mode === "remove" ? [] : [{ path: root, access: "read-only" }])).status).toBe(200)
        const deadline = Date.now() + 5000
        while (
          (db.query("SELECT status FROM process_runs WHERE id = ?").get(run.id) as { status: string }).status !==
            "stopped" &&
          Date.now() < deadline
        )
          await Bun.sleep(10)
        expect(db.query("SELECT status FROM process_runs WHERE id = ?").get(run.id)).toEqual({ status: "stopped" })
        writeFileSync(trigger, "continue")
        expect((await h.tool("process_start", { name: "waiting", waitMs: 5000 }, project.id)).success).toBe(true)
        let logs = await h.tool("process_logs", { name: "waiting" }, project.id)
        const attemptedDeadline = Date.now() + 5000
        while (!JSON.stringify(logs).includes("ATTEMPTED") && Date.now() < attemptedDeadline) {
          await Bun.sleep(10)
          logs = await h.tool("process_logs", { name: "waiting" }, project.id)
        }
        expect(logs).toMatchObject({ success: true })
        expect(JSON.stringify(logs)).toContain("ATTEMPTED")
        expect(existsSync(output)).toBe(false)
        if (mode === "remove") expect(JSON.stringify(logs)).not.toContain("revocation-proof")
        else expect(JSON.stringify(logs)).toContain("revocation-proof")
        await h.tool("process_stop", { name: "waiting" }, project.id)
      } finally {
        await h.close()
        rmSync(root, { recursive: true, force: true })
      }
    },
    30_000,
  )
