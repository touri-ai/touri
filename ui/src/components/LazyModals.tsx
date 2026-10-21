import { type ComponentProps, lazy, Suspense } from "react"
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
  <Suspense fallback={<LoadingModal onClose={props.onClose} />}>
    <DeferredBotCreateModal {...props} />
  </Suspense>
)

export const BotSettingsModal = (props: ComponentProps<typeof DeferredBotSettingsModal>) => (
  <Suspense fallback={<LoadingModal onClose={props.onClose} />}>
    <DeferredBotSettingsModal {...props} />
  </Suspense>
)

export const DoctorModal = (props: ComponentProps<typeof DeferredDoctorModal>) => (
  <Suspense fallback={<LoadingModal onClose={props.onClose} />}>
    <DeferredDoctorModal {...props} />
  </Suspense>
)

export const ImportWizard = (props: ComponentProps<typeof DeferredImportWizard>) => (
  <Suspense fallback={<LoadingModal onClose={props.onClose} />}>
    <DeferredImportWizard {...props} />
  </Suspense>
)

export const ProjectModal = (props: ComponentProps<typeof DeferredProjectModal>) => (
  <Suspense fallback={<LoadingModal onClose={props.onClose} />}>
    <DeferredProjectModal {...props} />
  </Suspense>
)

export const SettingsModal = (props: ComponentProps<typeof DeferredSettingsModal>) => (
  <Suspense fallback={<LoadingModal onClose={props.onClose} />}>
    <DeferredSettingsModal {...props} />
  </Suspense>
)

const LoadingModal = ({ onClose }: { onClose: () => void }) => (
  <Modal title={t("Loading")} onClose={onClose}>
    <MotionSkeleton />
  </Modal>
)
