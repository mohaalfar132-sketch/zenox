import AsyncStorage from "@react-native-async-storage/async-storage";

export const ZENOX_GUEST_KEY = "zenox.guest.identity";
export const ZENOX_MESSAGES_KEY = "zenox.chat.messages";

export type StoredMessage = { id: number; role: "assistant" | "user"; text: string };

export async function saveGuestIdentity(identity: string) {
  await AsyncStorage.setItem(ZENOX_GUEST_KEY, identity.trim());
}

export async function loadGuestIdentity() {
  return AsyncStorage.getItem(ZENOX_GUEST_KEY);
}

export async function saveMessages(messages: StoredMessage[]) {
  await AsyncStorage.setItem(ZENOX_MESSAGES_KEY, JSON.stringify(messages.slice(-80)));
}

export async function loadMessages(): Promise<StoredMessage[] | null> {
  const raw = await AsyncStorage.getItem(ZENOX_MESSAGES_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredMessage[]) : null;
  } catch {
    return null;
  }
}

export async function clearGuestSession() {
  await AsyncStorage.multiRemove([ZENOX_GUEST_KEY, ZENOX_MESSAGES_KEY]);
}
