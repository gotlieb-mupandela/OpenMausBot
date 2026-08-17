import type { SaasUser } from "./auth.ts";
import { isPlus } from "./auth.ts";
import { SAAS_MODE } from "./mode.ts";

/** Visible bots allowed on the Free SaaS plan. Unused while Plus is complimentary. */
export const FREE_BOT_LIMIT = 1;

/** Plus features are unlocked for every signed-in SaaS user. */
export function plusUnlocked(user: SaasUser | null | undefined): boolean {
  if (!SAAS_MODE) return true;
  return isPlus(user);
}

export function plusRequiredPayload(feature: string) {
  return {
    error: "plus_required",
    feature,
    message: `${feature} is included with Aishe Plus (N$350 / month).`,
  };
}
