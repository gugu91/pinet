// Durable, non-reloadable hibernation runtime-activation authority.
//
// The Phase B live process/tmux adapters must be activated ONLY by a durable
// authority captured at broker start and FROZEN for the entire process
// lifetime. This deliberately does NOT read agent-editable `SlackBridgeSettings`
// (which pi re-reads on config reload): there must be NO settings, reload, or
// other in-process path that can elevate a running broker into live-runtime
// activation. The single source of truth is an external, process-launch
// environment variable, captured exactly once.
//
// Security rationale: an attacker (or a well-meaning agent) who can edit the
// broker's settings file or trigger a settings reload must never be able to turn
// on the live runtime. Requiring an external launch-environment variable moves
// the activation decision to whoever started the broker process and freezes it
// for the lifetime of that process.

/** External process-launch env var that authorizes live-runtime activation. */
const ACTIVATION_ENV_VAR = "PINET_HIBERNATION_RUNTIME_ACTIVATION";

/** Captured once at broker start; never re-read afterwards. */
let frozen: boolean | undefined;

/**
 * Capture the activation authority from the process-launch environment ONCE and
 * freeze it for the process lifetime. Idempotent: the first call wins, and any
 * later environment or settings mutation cannot change the frozen value. Returns
 * the frozen authority. Call this explicitly at broker start so the freeze point
 * is deterministic; reads via {@link hibernationActivationAuthorized} also
 * freeze lazily on first use.
 *
 * Accepts `1`, `true`, `yes`, or `on` (case-insensitive, trimmed) as authorized;
 * everything else — including unset/empty — is unauthorized (the production
 * default, a strict no-op).
 */
export function freezeHibernationActivationAuthority(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (frozen === undefined) {
    const raw = env[ACTIVATION_ENV_VAR]?.trim().toLowerCase();
    frozen = raw === "1" || raw === "true" || raw === "yes" || raw === "on";
  }
  return frozen;
}

/**
 * The frozen live-runtime activation authority. Lazily freezes on first read
 * from the process-launch environment when {@link freezeHibernationActivationAuthority}
 * has not run yet, so the gate is always a process-lifetime constant. Config
 * reloads and settings edits can never flip it.
 */
export function hibernationActivationAuthorized(): boolean {
  return freezeHibernationActivationAuthority();
}

/** Test-only: clear the frozen value so a test can re-capture a chosen env. */
export function __resetHibernationActivationAuthorityForTest(): void {
  frozen = undefined;
}
