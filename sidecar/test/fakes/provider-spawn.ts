import type { Kernel } from "@touri/contracts"

// Protocol fixtures load test scripts/scenarios from outside the bot workspace.
// Only their registered fake executable bypasses the namespace. Confinement is
// exercised separately by the real-bwrap adversarial suite and live CLI test.
export const fakeProviderSpawn =
  (spawn: Kernel["spawnTree"], command: string, scenario: string): Kernel["spawnTree"] =>
  (input) => {
    const separator = input.args.indexOf("--")
    if (/\/bwrap$/.test(input.cmd) && separator >= 0 && input.args[separator + 1] === command)
      return spawn({
        ...input,
        cmd: command,
        args: input.args.slice(separator + 2),
        env: { ...input.env, TOURI_FAKE_SCENARIO: scenario },
      })
    return spawn(input)
  }
