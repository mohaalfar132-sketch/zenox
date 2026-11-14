import { Platform } from "react-native";

export const REWARDED_AD_UNIT = "ca-app-pub-1039693134727160/4238961930";

type RewardedModule = {
  RewardedAd: { createForAdRequest: (id: string, opts?: any) => any };
  RewardedAdEventType: { LOADED: string; EARNED_REWARD: string; CLOSED: string; ERROR: string };
};

let cached: RewardedModule | null | undefined;

export function loadRewardedModule(): RewardedModule | null {
  if (cached !== undefined) return cached;
  if (Platform.OS === "web") {
    cached = null;
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require("react-native-google-mobile-ads");
    cached = {
      RewardedAd: m.RewardedAd,
      RewardedAdEventType: m.RewardedAdEventType,
    };
    return cached;
  } catch {
    cached = null;
    return null;
  }
}

export function isNativeAdsAvailable(): boolean {
  return loadRewardedModule() !== null;
}

/**
 * Shows a rewarded ad. Resolves true if the user earned the reward.
 * Falls back to a simulated 5s "ad" on web/dev where AdMob is unavailable.
 */
export function showRewardedAd(): Promise<boolean> {
  const mod = loadRewardedModule();
  if (!mod) {
    return new Promise((resolve) => {
      setTimeout(() => resolve(true), 5000);
    });
  }
  return new Promise((resolve) => {
    const ad = mod.RewardedAd.createForAdRequest(REWARDED_AD_UNIT, {
      requestNonPersonalizedAdsOnly: true,
    });
    let earned = false;
    const unsub: Array<() => void> = [];
    const finish = (value: boolean) => {
      unsub.forEach((fn) => fn());
      resolve(value);
    };
    unsub.push(ad.addAdEventListener(mod.RewardedAdEventType.LOADED, () => ad.show()));
    unsub.push(ad.addAdEventListener(mod.RewardedAdEventType.EARNED_REWARD, () => { earned = true; }));
    unsub.push(ad.addAdEventListener(mod.RewardedAdEventType.CLOSED, () => finish(earned)));
    unsub.push(ad.addAdEventListener(mod.RewardedAdEventType.ERROR, () => finish(false)));
    ad.load();
  });
}