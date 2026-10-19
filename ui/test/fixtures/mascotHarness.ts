import { type MascotEvent, MascotMachine } from "../../src/components/mascotState"

/** Replay runtime/composer events without wall clocks, RAF or randomness. */
export class MascotHarness {
  readonly machine = new MascotMachine()
  now = 0
  send(event: MascotEvent, at = this.now) {
    this.now = at
    return this.machine.send(event, at)
  }
  frame(at: number) {
    this.send({ type: "tick" }, at)
    return { state: this.machine.snapshot.state }
  }
}
