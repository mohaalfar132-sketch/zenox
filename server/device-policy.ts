import { createHash, randomBytes } from "node:crypto";

export const DEVICE_CAPABILITIES = [
  "device.info.read",
  "files.read.selected",
  "files.write.selected",
  "apps.manage.allowed",
  "settings.manage.allowed",
  "usb.session.allowed",
] as const;

export type DeviceCapability = (typeof DEVICE_CAPABILITIES)[number];

export function createConsentToken() {
  return randomBytes(32).toString("base64url");
}

export function hashConsentToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function parseCapabilities(value: string): DeviceCapability[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is DeviceCapability => DEVICE_CAPABILITIES.includes(item as DeviceCapability));
  } catch {
    return [];
  }
}

export function hasCapability(value: string, capability: DeviceCapability) {
  return parseCapabilities(value).includes(capability);
}
