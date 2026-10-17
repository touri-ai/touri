import { expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { release, tmpdir } from "node:os"
import { join, resolve } from "node:path"

const minimalPath = "/usr/bin:/bin:/usr/sbin:/sbin"

test("Finder PATH resolves and launches installed tools with the same child environment", async () => {
  const home = mkdtempSync(join(tmpdir(), "touri-tool-path-"))
  try {
    const bin = join(home, ".local/bin")
    const tools = ["container", "codex", "claude", "opencode", "git", "node"]
    mkdirSync(bin, { recursive: true })
    // An env shebang also proves that a resolved CLI can launch its own dependencies.
    for (const tool of [...tools, "touri-tool-helper"]) {
      const directory = tool === "opencode" ? join(home, ".opencode/bin") : bin
      mkdirSync(directory, { recursive: true })
      const path = join(directory, tool)
      writeFileSync(
        path,
        tool === "touri-tool-helper"
          ? '#!/bin/sh\nprintf "%s\\n" "$HOME" "$PATH"\n'
          : "#!/usr/bin/env touri-tool-helper\n",
      )
      chmodSync(path, 0o755)
    }
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `import { spawnTree } from "./sidecar/src/kernel/spawn";
         import { resolveProviderExecutable } from "./sidecar/src/runtime/resolveProviderExecutable";
         import { createVmCommandRunner } from "./sidecar/src/vm/command";
         import { createAppleContainerProvider } from "./sidecar/src/vm/apple-container";
         import { machineCapability } from "./sidecar/src/vm/doctor";
         const env = {HOME: process.env.HOME, PATH: process.env.PATH};
         const tools = ${JSON.stringify(tools)};
         const system = tools.map(command => Bun.which(command));
         const launched = [];
         const resolved = [];
         for (const command of tools) {
           const found = await resolveProviderExecutable({command, env, kernel: {shellEnv: async () => ({PATH: env.PATH})}});
           resolved.push(found.success ? {path: found.path, env: found.env} : found);
           const process = spawnTree({cmd: command, args: ["--version"], cwd: env.HOME, env});
           launched.push(process.success ? {output: await new Response(process.stdout).text(), exit: await process.exited} : process);
         }
         const run = await createVmCommandRunner({binary: "container"})(["--version"]);
         const vm = createAppleContainerProvider().spawn({id: "disposable", command: "node"});
         const guest = vm.success ? {output: await new Response(vm.stdout).text(), exit: await vm.exited} : vm;
         console.log(JSON.stringify({raw: Bun.which("container"), capability: machineCapability(), system, resolved, launched, run, guest}));`,
      ],
      cwd: resolve(import.meta.dir, "../../.."),
      env: { HOME: home, PATH: minimalPath },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    const result = JSON.parse(stdout)
    expect(result.raw).toBeNull()
    for (const [index, tool] of tools.entries()) {
      const directory = tool === "opencode" ? join(home, ".opencode/bin") : bin
      expect(result.resolved[index].path).toBe(result.system[index] ?? join(directory, tool))
      expect(result.resolved[index].env.PATH.split(":")).toContain(bin)
      expect(result.launched[index].exit.code).toBe(0)
      if (result.system[index]) continue
      expect(result.launched[index].output.split("\n")[0]).toBe(home)
      expect(result.launched[index].output.split("\n")[1].split(":")).toContain(bin)
    }
    expect(result.run.code).toBe(0)
    expect(result.run.stdout.split("\n")[0]).toBe(home)
    expect(result.guest.exit.code).toBe(0)
    expect(result.guest.output.split("\n")[0]).toBe(home)
    // Capability remains platform-specific; the fixture must not enable VMs on unsupported hosts.
    if (process.platform === "darwin" && process.arch === "arm64" && Number(release().split(".")[0]) >= 25)
      expect(result.capability).toEqual({ available: true, reason: null, provider: "apple-container" })
    else expect(result.capability.available).toBe(false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 15_000)
