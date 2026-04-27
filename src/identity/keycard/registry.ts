/**
 * Process-wide registry for the active Keycard resolver.
 *
 * Keep this seam tiny: gateway startup writes the resolver after config is
 * loaded, and `runtime-model-auth.runtime.ts` reads it during API-key
 * resolution. The registry is intentionally loose-typed so the runtime seam
 * can stay free of the heavier resolver imports that pull in fetch/UDS code.
 */
import type { KeycardResolver } from "./resolver.js";

let activeResolver: KeycardResolver | undefined;

export function setActiveKeycardResolver(resolver: KeycardResolver | undefined): void {
  if (activeResolver && activeResolver !== resolver) {
    activeResolver.dispose();
  }
  activeResolver = resolver;
}

export function getActiveKeycardResolver(): KeycardResolver | undefined {
  return activeResolver;
}

export function clearActiveKeycardResolverForTests(): void {
  activeResolver?.dispose();
  activeResolver = undefined;
}
