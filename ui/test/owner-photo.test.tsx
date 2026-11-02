import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { OwnerProfile } from "@touri/contracts"
import { useState } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { OwnerProfileSettings } from "../src/components/OwnerProfileSettings"
import { SettingsModal } from "../src/components/SettingsModal"

const photoUrl = "data:image/webp;base64,UklGRg=="
const previousUrl = "data:image/png;base64,iVBORw0KGgo="

const getBitmap = (): ImageBitmap => ({ width: 256, height: 128, close: vi.fn() })
const getPhoto = () => new File(["synthetic photo"], "photo.png", { type: "image/png" })
const getPhotoReader = () => {
  const context = { clearRect: vi.fn(), drawImage: vi.fn() } as CanvasRenderingContext2D
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context)
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(photoUrl)
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
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it("saves the current crop without a separate crop confirmation", async () => {
  getPhotoReader()
  const save = vi.fn(async () => {})
  render(<SettingsModal settings={null} onClose={vi.fn()} onSave={save} />)
  fireEvent.click(screen.getByRole("button", { name: /^Perfil/ }))

  await uploadPhoto()
  fireEvent.change(screen.getByLabelText("Nome do perfil"), { target: { value: "Pessoa Teste" } })
  fireEvent.change(screen.getByLabelText("Zoom"), { target: { value: "2" } })
  expect(save).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Salvar preferências" }))

  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ ownerProfile: { name: "Pessoa Teste", avatar: { kind: "image", dataUrl: photoUrl } } }),
    ),
  )
})

it("cancel restores the earlier avatar while preserving the edited name", async () => {
  getPhotoReader()
  const view = render(<ProfileEditor />)
  await uploadPhoto()

  fireEvent.change(screen.getByLabelText("Nome do perfil"), { target: { value: "Nome Atualizado" } })
  fireEvent.click(screen.getByRole("button", { name: "Cancelar", exact: true }))

  expect(screen.queryByLabelText("Prévia do recorte da foto")).toBeNull()
  expect(view.container.querySelector("img.person-avatar")).toHaveAttribute("src", previousUrl)
  expect(screen.getByLabelText("Nome do perfil")).toHaveValue("Nome Atualizado")
})

it.each(["Cancelar", "Usar foto recortada"])("%s discards an unfinished replacement read", async (button) => {
  const read = getPhotoReader()
  const view = render(<ProfileEditor />)
  await uploadPhoto()
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
