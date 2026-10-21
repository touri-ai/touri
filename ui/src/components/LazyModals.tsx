import { type ComponentProps, lazy, type ReactNode, Suspense, useEffect, useRef } from "react"
import { t } from "../i18n"
import { Modal } from "./Modal"
import { MotionSkeleton } from "./Motion"

export { Modal } from "./Modal"

const DeferredBotCreateModal = lazy(() => import("./Modals").then((module) => ({ default: module.BotCreateModal })))

const DeferredBotSettingsModal = lazy(() => import("./Modals").then((module) => ({ default: module.BotSettingsModal })))

const DeferredDoctorModal = lazy(() => import("./Modals").then((module) => ({ default: module.DoctorModal })))

const DeferredImportWizard = lazy(() => import("./Modals").then((module) => ({ default: module.ImportWizard })))

const DeferredProjectModal = lazy(() => import("./Modals").then((module) => ({ default: module.ProjectModal })))

const DeferredSettingsModal = lazy(() =>
  import("./SettingsModal").then((module) => ({ default: module.SettingsModal })),
)

export const BotCreateModal = (props: ComponentProps<typeof DeferredBotCreateModal>) => (
  <DeferredDialog onClose={props.onClose}>
    <DeferredBotCreateModal {...props} />
  </DeferredDialog>
)

export const BotSettingsModal = (props: ComponentProps<typeof DeferredBotSettingsModal>) => (
  <DeferredDialog onClose={props.onClose}>
    <DeferredBotSettingsModal {...props} />
  </DeferredDialog>
)

export const DoctorModal = (props: ComponentProps<typeof DeferredDoctorModal>) => (
  <DeferredDialog onClose={props.onClose}>
    <DeferredDoctorModal {...props} />
  </DeferredDialog>
)

export const ImportWizard = (props: ComponentProps<typeof DeferredImportWizard>) => (
  <DeferredDialog onClose={props.onClose}>
    <DeferredImportWizard {...props} />
  </DeferredDialog>
)

export const ProjectModal = (props: ComponentProps<typeof DeferredProjectModal>) => (
  <DeferredDialog onClose={props.onClose}>
    <DeferredProjectModal {...props} />
  </DeferredDialog>
)

export const SettingsModal = (props: ComponentProps<typeof DeferredSettingsModal>) => (
  <DeferredDialog onClose={props.onClose}>
    <DeferredSettingsModal {...props} />
  </DeferredDialog>
)

const LoadingModal = ({ onClose }: { onClose: () => void }) => (
  <Modal title={t("Loading")} onClose={onClose}>
    <MotionSkeleton />
  </Modal>
)

const DeferredDialog = ({ onClose, children }: { onClose: () => void; children: ReactNode }) => {
  const returnFocus = useRef(document.activeElement)
  useEffect(
    () => () => {
      if (returnFocus.current instanceof HTMLElement && returnFocus.current.isConnected)
        returnFocus.current.focus({ preventScroll: true })
    },
    [],
  )

  return <Suspense fallback={<LoadingModal onClose={onClose} />}>{children}</Suspense>
}
