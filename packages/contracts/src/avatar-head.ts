import type { AvatarLegacyShape } from "./types"

export type AvatarAnchor = Readonly<{ x: number; y: number; scaleX: number; scaleY: number }>
export type AvatarHeadGeometry = Readonly<{
  path: string
  horns: AvatarAnchor
  ears: AvatarAnchor
  snout: AvatarAnchor
  eyes: AvatarAnchor
  forehead: AvatarAnchor
  temple: AvatarAnchor
  headphones: AvatarAnchor
}>

/** Original bull silhouettes, with independent registrations for the features attached to each head. */
export const getAvatarHeadGeometry = (shape: AvatarLegacyShape): AvatarHeadGeometry => HEADS[shape]

const HEADS: Readonly<Record<AvatarLegacyShape, AvatarHeadGeometry>> = {
  cercle: {
    path: "M50 30C67.7 30 82 44.3 82 62C82 79.7 67.7 94 50 94C32.3 94 18 79.7 18 62C18 44.3 32.3 30 50 30Z",
    horns: { x: 29, y: 37, scaleX: 0.9, scaleY: 0.94 },
    ears: { x: 20, y: 51, scaleX: 0.9, scaleY: 0.9 },
    snout: { x: 50, y: 78, scaleX: 0.74, scaleY: 0.86 },
    eyes: { x: 50, y: 55.5, scaleX: 0.85, scaleY: 0.96 },
    forehead: { x: 50, y: 33, scaleX: 0.88, scaleY: 0.94 },
    temple: { x: 76, y: 39, scaleX: 0.9, scaleY: 0.9 },
    headphones: { x: 50, y: 51, scaleX: 0.85, scaleY: 0.96 },
  },
  galet: {
    path: "M50 31C65 31 77 31 83 35C88 38 89 44 88 51C87 62 85 73 79 82C74 89 64 93 50 93C36 93 26 89 21 82C15 73 13 62 12 51C11 44 12 38 17 35C23 31 35 31 50 31Z",
    horns: { x: 28, y: 36, scaleX: 1, scaleY: 1 },
    ears: { x: 17, y: 51.5, scaleX: 1, scaleY: 1 },
    snout: { x: 50, y: 79.5, scaleX: 1, scaleY: 1 },
    eyes: { x: 50, y: 56, scaleX: 1, scaleY: 1 },
    forehead: { x: 50, y: 35, scaleX: 1, scaleY: 1 },
    temple: { x: 82, y: 33, scaleX: 1, scaleY: 1 },
    headphones: { x: 50, y: 50, scaleX: 1, scaleY: 1 },
  },
  squircle: {
    path: "M34 31H66C79 31 84 36 84 49V76C84 89 79 94 66 94H34C21 94 16 89 16 76V49C16 36 21 31 34 31Z",
    horns: { x: 29, y: 35, scaleX: 0.94, scaleY: 0.92 },
    ears: { x: 19, y: 51.5, scaleX: 0.94, scaleY: 0.94 },
    snout: { x: 50, y: 79, scaleX: 0.86, scaleY: 0.97 },
    eyes: { x: 50, y: 55.5, scaleX: 0.88, scaleY: 0.98 },
    forehead: { x: 50, y: 34, scaleX: 0.94, scaleY: 0.96 },
    temple: { x: 79, y: 35, scaleX: 0.94, scaleY: 0.94 },
    headphones: { x: 50, y: 51.5, scaleX: 0.92, scaleY: 1 },
  },
  capsule: {
    path: "M50 28C66 28 77 40 77 55V69C77 84 66 96 50 96C34 96 23 84 23 69V55C23 40 34 28 50 28Z",
    horns: { x: 32, y: 33, scaleX: 0.76, scaleY: 0.85 },
    ears: { x: 25, y: 52, scaleX: 0.85, scaleY: 1 },
    snout: { x: 50, y: 79, scaleX: 0.6, scaleY: 0.94 },
    eyes: { x: 50, y: 54, scaleX: 0.7, scaleY: 1 },
    forehead: { x: 50, y: 31, scaleX: 0.72, scaleY: 0.9 },
    temple: { x: 71, y: 38, scaleX: 0.85, scaleY: 0.85 },
    headphones: { x: 50, y: 52, scaleX: 0.7, scaleY: 1.16 },
  },
  triangle: {
    path: "M20 31H80Q88 31 84 42L60 86Q50 104 40 86L16 42Q12 31 20 31Z",
    horns: { x: 29, y: 32.5, scaleX: 0.9, scaleY: 0.86 },
    ears: { x: 18, y: 44.5, scaleX: 0.88, scaleY: 0.84 },
    snout: { x: 50, y: 71, scaleX: 0.47, scaleY: 0.72 },
    eyes: { x: 50, y: 51, scaleX: 0.8, scaleY: 0.9 },
    forehead: { x: 50, y: 32, scaleX: 0.96, scaleY: 0.88 },
    temple: { x: 80, y: 33, scaleX: 0.86, scaleY: 0.86 },
    headphones: { x: 50, y: 43, scaleX: 0.87, scaleY: 0.78 },
  },
  hexagone: {
    path: "M47 28Q50 26 53 28L81 44Q84 46 84 50V77Q84 81 80 83L53 97Q50 99 47 97L20 83Q16 81 16 77V50Q16 46 19 44Z",
    horns: { x: 28, y: 40, scaleX: 0.92, scaleY: 1.08 },
    ears: { x: 18, y: 54, scaleX: 0.92, scaleY: 0.92 },
    snout: { x: 50, y: 80, scaleX: 0.78, scaleY: 0.9 },
    eyes: { x: 50, y: 58, scaleX: 0.9, scaleY: 1 },
    forehead: { x: 50, y: 37, scaleX: 0.84, scaleY: 1 },
    temple: { x: 78, y: 44, scaleX: 0.9, scaleY: 0.9 },
    headphones: { x: 50, y: 54, scaleX: 0.91, scaleY: 1.08 },
  },
  nuage: {
    path: "M50 32C42 23 28 27 27 38C16 33 8 43 15 53C5 63 12 76 22 77C19 90 34 97 44 91C48 96 52 96 56 91C66 97 81 90 78 77C88 76 95 63 85 53C92 43 84 33 73 38C72 27 58 23 50 32Z",
    horns: { x: 30, y: 36, scaleX: 1.04, scaleY: 0.96 },
    ears: { x: 17, y: 50, scaleX: 0.9, scaleY: 0.86 },
    snout: { x: 50, y: 78.5, scaleX: 0.82, scaleY: 0.9 },
    eyes: { x: 50, y: 56.5, scaleX: 0.96, scaleY: 0.92 },
    forehead: { x: 50, y: 33.5, scaleX: 0.9, scaleY: 0.9 },
    temple: { x: 78, y: 38, scaleX: 0.92, scaleY: 0.92 },
    headphones: { x: 50, y: 50.5, scaleX: 1.02, scaleY: 1.04 },
  },
}
