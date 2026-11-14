export const REWARDED_AD_UNIT = "ca-app-pub-1039693134727160/4238961930";

export function isNativeAdsAvailable(): boolean {
  return false;
}

/**
 * Web has no AdMob SDK. Simulate a short rewarded ad so the flow stays testable.
 */
export function showRewardedAd(): Promise<boolean> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(true), 5000);
  });
}