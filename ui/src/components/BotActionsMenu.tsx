import { t } from "../i18n"
import { SidebarActionsMenu } from "./SidebarActionsMenu"

export const BotActionsMenu = ({
  name,
  open,
  onOpenChange,
  onSettings,
  onRoutines,
  onDelete,
}: {
  name: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSettings: () => void
  onRoutines: () => void
  onDelete?: (() => void) | undefined
}) => (
  <SidebarActionsMenu
    label={t("Actions for {name}", { name })}
    open={open}
    onOpenChange={onOpenChange}
    actions={[
      { label: t("Advanced"), onSelect: onSettings },
      { label: t("Routines"), onSelect: onRoutines },
      ...(onDelete ? [{ label: t("Delete bot"), onSelect: onDelete, destructive: true }] : []),
    ]}
  />
)
