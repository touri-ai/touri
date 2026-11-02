import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { OwnerProfile } from "@touri/contracts"
import { useState } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { OwnerProfileSettings } from "../src/components/OwnerProfileSettings"
import { SettingsModal } from "../src/components/SettingsModal"

const photoUrl = "data:image/webp;base64,UklGRg=="
const previousUrl = "data:image/png;base64,iVBORw0KGgo="

const getBitmap = (): ImageBitmap => ({ width: 256, height: 128, close: vi.fn() })
const getPhoto = () => new File(["synthetic photo"], "photo.png", { type: "image/png" })
const installPhotoReader = () => {
  const context = { clearRect: vi.fn(), drawImage: vi.fn() } as CanvasRenderingContext2D
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context)
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(photoUrl)
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
    callback(new Blob(["RIFF"], { type: "image/webp" }))
  })
  const read = vi.fn(async () => getBitmap())
  vi.stubGlobal("createImageBitmap", read)

  return read
}
const ProfileEditor = () => {
  const [profile, setProfile] = useState<OwnerProfile>({
    name: "Pessoa Teste",
    avatar: { kind: "image", dataUrl: previousUrl },
  })

  return <OwnerProfileSettings profile={profile} onChange={setProfile} />
}
const uploadPhoto = async () => {
  fireEvent.change(screen.getByLabelText("Enviar foto do perfil"), { target: { files: [getPhoto()] } })

  await waitFor(() => expect(screen.getByLabelText("Prévia do recorte da foto")).toBeVisible())
  await waitFor(() => expect(HTMLCanvasElement.prototype.toBlob).toHaveBeenCalled())
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it("saves the current crop without a separate crop confirmation", async () => {
  installPhotoReader()
  const save = vi.fn(async () => {})
  render(<SettingsModal settings={null} onClose={vi.fn()} onSave={save} />)
  fireEvent.click(screen.getByRole("button", { name: /^Chat, perfil e atalhos/ }))

  await uploadPhoto()
  fireEvent.change(screen.getByLabelText("Nome do perfil"), { target: { value: "Pessoa Teste" } })
  fireEvent.change(screen.getByLabelText("Zoom"), { target: { value: "2" } })
  expect(save).not.toHaveBeenCalled()
  await waitFor(() => expect(screen.getByRole("button", { name: "Salvar preferências" })).toBeEnabled())
  fireEvent.click(screen.getByRole("button", { name: "Salvar preferências" }))

  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ ownerProfile: { name: "Pessoa Teste", avatar: { kind: "image", dataUrl: photoUrl } } }),
    ),
  )
})

it("cancel restores the earlier avatar while preserving the edited name", async () => {
  installPhotoReader()
  const view = render(<ProfileEditor />)
  await uploadPhoto()
  await waitFor(() => expect(view.container.querySelector("img.person-avatar")).toHaveAttribute("src", photoUrl))

  fireEvent.change(screen.getByLabelText("Nome do perfil"), { target: { value: "Nome Atualizado" } })
  fireEvent.click(screen.getByRole("button", { name: "Cancelar", exact: true }))

  expect(screen.queryByLabelText("Prévia do recorte da foto")).toBeNull()
  expect(view.container.querySelector("img.person-avatar")).toHaveAttribute("src", previousUrl)
  expect(screen.getByLabelText("Nome do perfil")).toHaveValue("Nome Atualizado")
})

it.each(["Cancelar", "Usar foto recortada"])("%s discards an unfinished replacement read", async (button) => {
  const read = installPhotoReader()
  const view = render(<ProfileEditor />)
  await uploadPhoto()
  await waitFor(() => expect(view.container.querySelector("img.person-avatar")).toHaveAttribute("src", photoUrl))
  const replacement = getBitmap()
  const pending = Promise.withResolvers<ImageBitmap>()
  read.mockImplementationOnce(() => pending.promise)
  fireEvent.change(screen.getByLabelText("Enviar foto do perfil"), { target: { files: [getPhoto()] } })

  fireEvent.click(screen.getByRole("button", { name: button, exact: true }))
  await act(async () => {
    pending.resolve(replacement)
    await pending.promise
  })

  expect(screen.queryByLabelText("Prévia do recorte da foto")).toBeNull()
  expect(view.container.querySelector("img.person-avatar")).toHaveAttribute(
    "src",
    button === "Cancelar" ? previousUrl : photoUrl,
  )
  expect(replacement.close).toHaveBeenCalledOnce()
})

it("waits for asynchronous photo encoding before saving preferences", async () => {
  installPhotoReader()
  const encode = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(() => {})
  const save = vi.fn(async () => {})
  render(<SettingsModal settings={null} onClose={vi.fn()} onSave={save} />)
  fireEvent.click(screen.getByRole("button", { name: /^Chat, perfil e atalhos/ }))
  await uploadPhoto()

  const button = screen.getByRole("button", { name: "Salvar preferências" })
  expect(button).toBeDisabled()
  expect(screen.getByRole("button", { name: "Usar foto recortada" })).toBeDisabled()
  fireEvent.click(button)
  expect(save).not.toHaveBeenCalled()
  const finish = encode.mock.calls[0]?.[0]
  if (!finish) throw new Error("Missing photo encoding callback")
  act(() => finish(new Blob(["RIFF"], { type: "image/webp" })))
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)

  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ ownerProfile: { name: "", avatar: { kind: "image", dataUrl: photoUrl } } }),
    ),
  )
})

it("cancel ignores an earlier crop encoding callback", async () => {
  installPhotoReader()
  const encode = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(() => {})
  const view = render(<ProfileEditor />)
  await uploadPhoto()
  const finish = encode.mock.calls[0]?.[0]
  if (!finish) throw new Error("Missing photo encoding callback")

  fireEvent.click(screen.getByRole("button", { name: "Cancelar", exact: true }))
  act(() => finish(new Blob(["RIFF"], { type: "image/webp" })))

  expect(screen.queryByLabelText("Prévia do recorte da foto")).toBeNull()
  expect(view.container.querySelector("img.person-avatar")).toHaveAttribute("src", previousUrl)
})

it("finishing an earlier crop does not enable saving during a replacement read", async () => {
  const read = installPhotoReader()
  const encode = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(() => {})
  render(<SettingsModal settings={null} onClose={vi.fn()} onSave={vi.fn(async () => {})} />)
  fireEvent.click(screen.getByRole("button", { name: /^Chat, perfil e atalhos/ }))
  await uploadPhoto()
  const pending = Promise.withResolvers<ImageBitmap>()
  read.mockImplementationOnce(() => pending.promise)
  fireEvent.change(screen.getByLabelText("Enviar foto do perfil"), { target: { files: [getPhoto()] } })
  const finish = encode.mock.calls[0]?.[0]
  if (!finish) throw new Error("Missing photo encoding callback")

  act(() => finish(new Blob(["RIFF"], { type: "image/webp" })))
  await waitFor(() => expect(document.querySelector("img.person-avatar")).toHaveAttribute("src", photoUrl))

  expect(screen.getByRole("button", { name: "Salvar preferências" })).toBeDisabled()
  const editor = screen.getByLabelText("Nome do perfil").parentElement
  if (!editor) throw new Error("Missing profile editor")
  fireEvent.click(within(editor).getByRole("button", { name: "Cancelar", exact: true }))
  await act(async () => pending.resolve(getBitmap()))
  await waitFor(() => expect(screen.getByRole("button", { name: "Salvar preferências" })).toBeEnabled())
})

it("keeps the error for an invalid replacement when an earlier crop finishes", async () => {
  installPhotoReader()
  const encode = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(() => {})
  const view = render(<ProfileEditor />)
  await uploadPhoto()
  const finish = encode.mock.calls[0]?.[0]
  if (!finish) throw new Error("Missing photo encoding callback")
  const invalid = new File(["invalid"], "photo.svg", { type: "image/svg+xml" })

  fireEvent.change(screen.getByLabelText("Enviar foto do perfil"), { target: { files: [invalid] } })
  expect(screen.getByRole("alert")).toBeVisible()
  act(() => finish(new Blob(["RIFF"], { type: "image/webp" })))
  await waitFor(() => expect(view.container.querySelector("img.person-avatar")).toHaveAttribute("src", photoUrl))

  expect(screen.getByRole("alert")).toBeVisible()
})
