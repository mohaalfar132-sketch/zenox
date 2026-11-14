import AsyncStorage from "@react-native-async-storage/async-storage";

export const DEFAULT_CURRENCY = "ZCOIN";
export const WATCH_REWARD = 10;
export const PREMIUM_COST = 100;
export const PREMIUM_KEY = "zenox.premium.unlocked";
export const BALANCE_KEY = "zenox.zcoin.balance";

export async function getBalance(): Promise<number> {
  const raw = await AsyncStorage.getItem(BALANCE_KEY);
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export async function addCoins(amount: number): Promise<number> {
  const current = await getBalance();
  const next = current + Math.max(0, Math.floor(amount));
  await AsyncStorage.setItem(BALANCE_KEY, String(next));
  return next;
}

export async function spendCoins(amount: number): Promise<{ ok: boolean; balance: number }> {
  const current = await getBalance();
  if (current < amount) return { ok: false, balance: current };
  const next = current - amount;
  await AsyncStorage.setItem(BALANCE_KEY, String(next));
  return { ok: true, balance: next };
}

export async function isPremium(): Promise<boolean> {
  return (await AsyncStorage.getItem(PREMIUM_KEY)) === "1";
}

export async function unlockPremium(): Promise<boolean> {
  const { ok, balance } = await spendCoins(PREMIUM_COST);
  if (!ok) return false;
  await AsyncStorage.setItem(PREMIUM_KEY, "1");
  return true;
}