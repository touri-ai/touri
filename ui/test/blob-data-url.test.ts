import { describe, expect, it } from "vitest"
import { blobDataUrl } from "../src/blobDataUrl"

describe("image data URLs", () => {
  it("encodes a native browser Blob without requiring a JavaScript byte conversion", async () => {
    const blob = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" })

    const result = await blobDataUrl(blob)

    expect(result).toBe("data:image/png;base64,iVBORw0KGgo=")
  })
})
