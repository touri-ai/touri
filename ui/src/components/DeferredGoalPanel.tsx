import { type ComponentProps, lazy, Suspense } from "react"

export const DeferredGoalPanel = (props: ComponentProps<typeof GoalPanel>) => (
  <Suspense fallback={null}>
    <GoalPanel {...props} />
  </Suspense>
)

const GoalPanel = lazy(() => import("./GoalPanel").then((module) => ({ default: module.GoalPanel })))
