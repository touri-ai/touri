import type { RouteResponse } from "@touri/contracts"
import { getAttachmentBytesAsync } from "../kernel/async-files"

export const getAttachmentDownload = async (attachment: { path: string }, root: string): Promise<RouteResponse> => {
  try {
    const content = await getAttachmentBytesAsync({ root, path: attachment.path })

    return {
      status: 200,
      mime: content.mime,
      disposition: content.mime === "application/octet-stream" ? "attachment" : "inline",
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(content.bytes)
          controller.close()
        },
      }),
    }
  } catch {
    return getMissingAttachment()
  }
}

const getMissingAttachment = (): RouteResponse => ({
  status: 404,
  json: { errorCode: "NOT_FOUND", error: "Attachment not found" },
})
