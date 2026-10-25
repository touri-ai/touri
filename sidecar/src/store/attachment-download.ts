import type { RouteResponse } from "@touri/contracts"
import { getLocalImageAsync } from "../kernel/async-files"

export const getAttachmentDownload = async (
  attachment: { path: string; mime: string },
  root: string,
): Promise<RouteResponse> => {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(attachment.mime)) {
    if (!(await Bun.file(attachment.path).exists())) return getMissingAttachment()

    return { status: 200, file: attachment.path, mime: attachment.mime }
  }
  try {
    const image = await getLocalImageAsync({ root, path: attachment.path })

    return {
      status: 200,
      mime: image.mime,
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(image.bytes)
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
