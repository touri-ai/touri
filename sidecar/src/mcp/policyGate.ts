export type PolicyGateArgs = { name: string; mutates: boolean; delegated: boolean }

/**
 * Delegation tools are never denied for read-only callers: the delegation ceiling
 * (min of caller and target) keeps the delegated run read-only. They need a consent
 * card instead, also for read-only callers whose approvals are "never".
 */
export const CONSENT_REQUIRED_TOOLS: ReadonlySet<string> = new Set(["ask_bot", "coordinate_bots", "ask_all"])

/** Catalogued as read-only, but arbitrary page script can submit forms or post; a delegated run treats it as mutating. */
const DELEGATED_MUTATING_TOOLS: ReadonlySet<string> = new Set(["browser_evaluate"])

// Setup handlers enforce their own self-scoping and consent. Identity changes
// and access reductions need only a notice, including for read-only bots.
const SELF_CONFIGURATION_TOOLS: ReadonlySet<string> = new Set([
  "bot_rename",
  "team_create",
  "capability_request",
  "project_link",
  "project_unlink",
  "folder_access_request",
  "folder_access_remove",
])

const OBSERVED_BY_OWN_GUARDS: ReadonlySet<string> = new Set([
  // Checkpoints only update the goal already authorized for this exact turn.
  "goal_checkpoint",
  // Learning tools write only the bot's own home, refuse read-only bots and send
  // changes proposed by an automatic review to an approval card themselves.
  "memory_write",
  "skill_create",
  "skill_patch",
  "skill_archive",
  "notify_user",
  "preview_open",
  "browser_open",
  "browser_close_tab",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_hover",
  "browser_scroll",
  "browser_select_option",
  "browser_set_checked",
])

/**
 * Whether a built-in tool call must pass the bot access and approval gate.
 *
 * Tools that change the host (processes, environment files, routines, uploads of
 * host files, secrets) and group delegation (`ask_bot`, `coordinate_bots`, which B05
 * requires a card for) are always gated. Browser page interaction, notifications
 * and previews keep the guards they had before the gate existed (the browser toggle,
 * per-origin secret entry and rate limits); prompting for each click would make
 * every browser bot unusable. A delegated run borrows another bot's capabilities,
 * so there every mutating tool is gated against the ceiling.
 */
export const requiresPolicyGate = ({ name, mutates, delegated }: PolicyGateArgs): boolean =>
  !SELF_CONFIGURATION_TOOLS.has(name) &&
  (mutates || (delegated && DELEGATED_MUTATING_TOOLS.has(name))) &&
  (delegated || !OBSERVED_BY_OWN_GUARDS.has(name))
