import { blockAt, type Look, SHAPE_BY_ID } from "@norbert_bodziony/bloub"
import {
  AVATAR_FPS,
  type AvatarFrame,
  type AvatarMood,
  type AvatarProfile,
  avatarCycle,
  avatarExpressionProfile,
  avatarFrameMarkup,
  createAvatarEngine,
  setAvatarState,
} from "@touri/contracts/avatar"

import type { MascotPose } from "./mascotMotion"

type FrameNodes = {
  mask: SVGPathElement
  body: SVGPathElement
  fill: SVGRectElement
  group: SVGGElement
  eyes: SVGPathElement[]
}
const frameNodes = new WeakMap<SVGSVGElement, FrameNodes>()

/** Reuse SVG resources: replacing masks and paths each frame makes the renderer allocate continuously. */
export const paintAvatarFrame = (svg: SVGSVGElement, frame: AvatarFrame, color: string, id: string): void => {
  let nodes = frameNodes.get(svg)
  if (!nodes || !svg.contains(nodes.group) || nodes.eyes.length !== frame.eyes.length) {
    svg.innerHTML = avatarFrameMarkup(frame, color, id)
    nodes = {
      mask: svg.querySelector("mask > path") as SVGPathElement,
      body: svg.querySelector("g > path") as SVGPathElement,
      fill: svg.querySelector("[data-avatar-body]") as SVGRectElement,
      group: svg.querySelector("g") as SVGGElement,
      eyes: [...svg.querySelectorAll<SVGPathElement>("[data-avatar-eye]")],
    }
    frameNodes.set(svg, nodes)
  }
  nodes.mask.setAttribute("d", frame.bodyPath)
  nodes.body.setAttribute("d", frame.bodyPath)
  nodes.fill.setAttribute("fill", color)
  nodes.group.setAttribute("opacity", String(frame.bodyAlpha))
  frame.eyes.forEach((eye, index) => {
    const path = nodes.eyes[index]
    path?.setAttribute("d", eye.d)
    path?.setAttribute("transform", eye.matrix)
    path?.setAttribute("opacity", String(eye.alpha))
  })
}

/** The clock advances only while visible. Sampling is capped independently of RAF frequency. */
export class AvatarPlayback {
  readonly engine
  private blocks
  private index: number
  private end: number
  private mood: AvatarMood
  private offset: number
  private previous: number | null = null
  private painted = -Infinity
  readonly origin: number
  time: number
  constructor(profile: AvatarProfile, mood: AvatarMood, offset = 0, phase = profile.phase) {
    this.blocks = avatarCycle(mood, offset)
    this.mood = mood
    this.offset = offset
    const at = blockAt(this.blocks, phase)
    this.index = at.index
    this.time = phase
    this.origin = phase
    this.engine = createAvatarEngine(profile, mood)
    const first = this.blocks[this.index]
    if (first) this.engine.reset(first.state, phase - at.elapsed)
    this.end = phase - at.elapsed + (first?.duration ?? Infinity)
  }
  update(profile: AvatarProfile, mood: AvatarMood, offset = 0): void {
    this.engine.setShape(SHAPE_BY_ID.get(profile.shape)?.radii ?? null, this.time)
    this.engine.setExpression(avatarExpressionProfile(profile, mood), this.time)
    if (this.mood === mood && this.offset === offset) return
    const began = this.end - (this.blocks[this.index]?.duration ?? 0)
    this.mood = mood
    this.offset = offset
    this.blocks = avatarCycle(mood, offset)
    this.index = Math.min(this.index, this.blocks.length - 1)
    const next = this.blocks[this.index]
    if (!next) return
    if (this.engine.state !== next.state) {
      const elapsed = this.origin % next.duration
      this.engine.setState(next.state, this.time, elapsed)
      this.end = this.time - elapsed + next.duration
    } else this.end = began + next.duration
  }

  resume(): void {
    this.previous = null
  }
  advance(now: number, gaze?: (seconds: number) => Look, gesture?: (seconds: number) => MascotPose): boolean {
    const delta = this.previous === null ? 0 : Math.min(0.064, Math.max(0, (now - this.previous) / 1000))
    this.previous = now
    this.time += delta
    if (this.time - this.painted < 1 / AVATAR_FPS) return false
    this.painted = this.time
    if (!gesture && this.time >= this.end) {
      this.index = (this.index + 1) % this.blocks.length
      const block = this.blocks[this.index]
      if (block) {
        setAvatarState(this.engine, block.state, this.time)
        this.end = this.time + block.duration
      }
    }
    const seconds = this.time - this.origin
    const pose = gesture?.(seconds)
    if (pose) {
      const state = pose.blink ? "wink" : "idle"
      if (this.engine.state !== state) setAvatarState(this.engine, state, this.time)
      const pointer = gaze?.(seconds)
      const look = pointer && pointer.mix > 0 ? { ...pointer, pitch: pointer.pitch + pose.look.pitch - 10 } : pose.look
      this.engine.setLook(look, this.time, 1 / AVATAR_FPS)
    } else if (gaze) this.engine.setLook(gaze(seconds), this.time, 1 / 60)
    return true
  }
}

export class AvatarGaze {
  private yaw = 0
  private pitch = 10
  private mix = 0
  private last = 0
  private pressed = false
  private nodAt: number | null = null
  press(): void {
    if (this.nodAt === null) this.pressed = true
  }
  sample(
    time: number,
    pointer: { x: number; y: number } | null,
    box?: Pick<DOMRect, "left" | "top" | "width" | "height">,
  ): Look {
    const blend = -Math.expm1(-9 * Math.min(0.1, Math.max(0, time - this.last)))
    this.last = time
    const known =
      pointer !== null &&
      box !== undefined &&
      box.width > 0 &&
      box.height > 0 &&
      Number.isFinite(pointer.x + pointer.y + box.left + box.top + box.width + box.height)
    if (known) {
      const unit = (value: number) => Math.max(-1, Math.min(1, value / 320))
      this.yaw += (24 * unit(pointer.x - box.left - box.width / 2) - this.yaw) * blend
      this.pitch += (10 - 16 * unit(pointer.y - box.top - box.height / 2) - this.pitch) * blend
    }
    this.mix += ((known ? 1 : 0) - this.mix) * blend
    if (this.pressed) {
      this.nodAt = time
      this.pressed = false
    }
    let dip = 0
    if (this.nodAt !== null) {
      const fraction = Math.min(1, Math.max(0, (time - this.nodAt) / 0.55))
      dip = -14 * Math.sin(4 * Math.PI * fraction) * (1 - fraction)
      if (fraction === 1) this.nodAt = null
    }
    return { yaw: this.yaw, pitch: this.pitch + dip, mix: this.mix, spin: 0, wander: 1 - this.mix }
  }
}

let position: { x: number; y: number } | null = null
const subscribers = new Set<symbol>()
const track = (event: PointerEvent): void => {
  if (event.pointerType !== "touch") position = { x: event.clientX, y: event.clientY }
}
const leave = (event: PointerEvent): void => {
  if (event.relatedTarget === null) position = null
}
export const attachAvatarGaze = (
  element: HTMLElement,
  gaze: AvatarGaze,
): { sample: (time: number) => Look; release: () => void } => {
  const token = Symbol()
  if (subscribers.size === 0) {
    window.addEventListener("pointermove", track, { passive: true })
    document.addEventListener("pointerout", leave, { passive: true })
  }
  subscribers.add(token)
  const press = (): void => gaze.press()
  element.addEventListener("pointerdown", press)
  return {
    sample: (time) => gaze.sample(time, position, element.isConnected ? element.getBoundingClientRect() : undefined),
    release: () => {
      element.removeEventListener("pointerdown", press)
      subscribers.delete(token)
      if (subscribers.size > 0) return
      window.removeEventListener("pointermove", track)
      document.removeEventListener("pointerout", leave)
      position = null
    },
  }
}
