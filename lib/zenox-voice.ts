import * as Speech from "expo-speech";
import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";

const MAX_AUDIO_BASE64_LENGTH = 80_000_000;

async function webUriToBase64(uri: string) {
  const response = await fetch(uri);
  if (!response.ok) throw new Error("تعذر قراءة ملف التسجيل في المتصفح");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 60_000_000) throw new Error("التسجيل الصوتي أكبر من الحد المسموح به");

  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export async function recordingUriToBase64(uri: string) {
  const base64 = Platform.OS === "web"
    ? await webUriToBase64(uri)
    : await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });

  if (base64.length > MAX_AUDIO_BASE64_LENGTH) {
    throw new Error("التسجيل الصوتي أكبر من الحد المسموح به");
  }

  return base64;
}

export function recordingMimeType() {
  return Platform.OS === "web" ? "audio/webm" as const : "audio/m4a" as const;
}

export async function speakArabic(text: string) {
  await Speech.stop();
  Speech.speak(text, {
    language: "ar-EG",
    rate: 0.95,
    pitch: 1,
  });
}

export function stopSpeaking() {
  void Speech.stop();
}
