import { Ionicons } from "@expo/vector-icons";
import * as SecureStore from "expo-secure-store";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenContainer } from "@/components/screen-container";
import { trpc } from "@/lib/trpc";

const CAPABILITY_LABELS: Record<string, string> = {
  "device.info.read": "قراءة معلومات الجهاز وحالته",
  "files.read.selected": "قراءة الملفات أو المجلدات المحددة فقط",
  "files.write.selected": "كتابة الملفات أو المجلدات المحددة فقط",
  "apps.manage.allowed": "إدارة التطبيقات المسموحة فقط",
  "settings.manage.allowed": "تغيير الإعدادات المسموحة فقط",
  "usb.session.allowed": "جلسة USB إذا دعمها نظام التشغيل",
};
const ACTIVE_SESSION_KEY = "zenox.active.device.session";

function firstParam(value?: string | string[]) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default function DeviceConsentScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string | string[]; deviceId?: string | string[]; deviceName?: string | string[]; platform?: string | string[]; capabilities?: string | string[] }>();
  const [consentToken, setConsentToken] = useState(firstParam(params.token));
  const [deviceId, setDeviceId] = useState(firstParam(params.deviceId));
  const [deviceName, setDeviceName] = useState(firstParam(params.deviceName) || "جهاز ZENOX");
  const [platform, setPlatform] = useState(firstParam(params.platform) || Platform.OS);
  const [accepted, setAccepted] = useState(false);
  const [activeSession, setActiveSession] = useState<{ sessionId: string; sessionToken: string } | null>(null);
  const [error, setError] = useState("");
  const acceptMutation = trpc.devices.acceptSession.useMutation();
  const endSessionMutation = trpc.devices.endSession.useMutation();

  const capabilities = useMemo(() => {
    const raw = firstParam(params.capabilities);
    if (!raw) return ["device.info.read"];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && Boolean(CAPABILITY_LABELS[item])) : ["device.info.read"];
    } catch {
      return ["device.info.read"];
    }
  }, [params.capabilities]);

  async function acceptDeviceSession() {
    setError("");
    if (Platform.OS === "web") {
      setError("قبول جلسات الأجهزة متاح من تطبيق الهاتف الرسمي فقط، وليس من معاينة الويب.");
      return;
    }
    if (!consentToken.trim() || !deviceId.trim()) {
      setError("أدخل رمز الموافقة ومعرف الجهاز للمتابعة.");
      return;
    }
    if (!accepted) {
      setError("اقرأ الصلاحيات واضغط على مربع الموافقة أولًا.");
      return;
    }
    try {
      const result = await acceptMutation.mutateAsync({ consentToken: consentToken.trim(), deviceId: deviceId.trim(), deviceName: deviceName.trim() || "جهاز ZENOX", platform: platform.trim() || Platform.OS });
      const storedSession = { sessionId: result.sessionId, sessionToken: result.sessionToken, deviceId: deviceId.trim(), capabilities: result.capabilities, expiresAt: result.expiresAt };
      await SecureStore.setItemAsync(`zenox.device.${result.sessionId}`, JSON.stringify(storedSession), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
      await SecureStore.setItemAsync(ACTIVE_SESSION_KEY, JSON.stringify(storedSession), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
      setActiveSession({ sessionId: result.sessionId, sessionToken: result.sessionToken });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "تعذر قبول جلسة الجهاز.");
    }
  }

  async function endDeviceSession() {
    if (!activeSession) return;
    setError("");
    try {
      await endSessionMutation.mutateAsync(activeSession);
      await SecureStore.deleteItemAsync(`zenox.device.${activeSession.sessionId}`);
      await SecureStore.deleteItemAsync(ACTIVE_SESSION_KEY);
      setActiveSession(null);
      setAccepted(false);
      setError("تم إنهاء الجلسة وحذف رمزها من هذا الجهاز.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "تعذر إنهاء الجلسة.");
    }
  }

  return (
    <ScreenContainer style={styles.screen}>
      <ScrollView contentContainerStyle={[styles.container, { paddingTop: Math.max(insets.top, 22) }]} keyboardShouldPersistTaps="handled">
        <View style={styles.brand}><View style={styles.brandMark}><Text style={styles.brandMarkText}>Z</Text></View><View><Text style={styles.eyebrow}>ZENOX / DEVICE CONSENT</Text><Text style={styles.title}>قبول جلسة الجهاز</Text></View></View>
        <View style={styles.infoCard}><Ionicons name="shield-checkmark-outline" size={24} color="#2DD4BF" /><Text style={styles.infoText}>يُستخدم ما توافق عليه هنا لهذه الجلسة فقط، ويمكنك سحبها من جهازك في أي وقت.</Text></View>

        {activeSession && <View style={styles.activeCard}><View style={styles.activeHeader}><Ionicons name="radio-outline" size={20} color="#99F6E4" /><Text style={styles.activeTitle}>الجلسة نشطة</Text></View><Text style={styles.activeText}>تم قبول الجلسة وحفظ رمزها في التخزين الآمن. يمكنك إدارتها من لوحة الجهاز أو إنهاؤها هنا.</Text><Pressable onPress={() => router.push("/device-control")} style={styles.controlButton}><Text style={styles.controlText}>فتح لوحة الجهاز</Text><Ionicons name="arrow-back" size={17} color="#0A0D1F" /></Pressable><Pressable onPress={() => void endDeviceSession()} style={[styles.endButton, endSessionMutation.isPending && styles.disabled]}><Text style={styles.endText}>{endSessionMutation.isPending ? "جارٍ الإنهاء…" : "إنهاء الجلسة من هذا الجهاز"}</Text><Ionicons name="stop-circle-outline" size={17} color="#FDA4AF" /></Pressable></View>}

        <Text style={styles.section}>بيانات الطلب</Text>
        <View style={styles.panel}>
          <TextInput value={consentToken} onChangeText={setConsentToken} placeholder="رمز الموافقة" placeholderTextColor="#64748B" style={styles.input} autoCapitalize="none" textAlign="right" />
          <TextInput value={deviceId} onChangeText={setDeviceId} placeholder="معرف الجهاز" placeholderTextColor="#64748B" style={styles.input} autoCapitalize="none" textAlign="right" />
          <TextInput value={deviceName} onChangeText={setDeviceName} placeholder="اسم الجهاز" placeholderTextColor="#64748B" style={styles.input} textAlign="right" />
          <TextInput value={platform} onChangeText={setPlatform} placeholder="android أو ios" placeholderTextColor="#64748B" style={styles.input} autoCapitalize="none" textAlign="right" />
        </View>

        <Text style={styles.section}>الصلاحيات المطلوبة</Text>
        <View style={styles.panel}>{capabilities.map((capability) => <View key={capability} style={styles.permissionRow}><View style={styles.permissionIcon}><Ionicons name="checkmark" size={16} color="#99F6E4" /></View><Text style={styles.permissionText}>{CAPABILITY_LABELS[capability] ?? capability}</Text></View>)}</View>

        <Pressable onPress={() => setAccepted((value) => !value)} style={styles.acceptRow}><View style={[styles.checkbox, accepted && styles.checkboxActive]}>{accepted && <Ionicons name="checkmark" size={15} color="#0A0D1F" />}</View><Text style={styles.acceptText}>أوافق على بدء هذه الجلسة بهذه الصلاحيات ولهذه المدة.</Text></Pressable>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Pressable onPress={() => void acceptDeviceSession()} style={[styles.primaryButton, acceptMutation.isPending && styles.disabled]}><Text style={styles.primaryText}>{acceptMutation.isPending ? "جارٍ قبول الجلسة…" : "قبول وبدء الجلسة"}</Text><Ionicons name="arrow-back" size={18} color="#0A0D1F" /></Pressable>
        <Pressable onPress={() => router.back()} style={styles.cancelButton}><Text style={styles.cancelText}>إلغاء</Text></Pressable>
        <Text style={styles.footer}>لا تشارك رمز الجلسة مع أي شخص. لا تستخدم هذه الشاشة إلا على جهاز تملكه أو لديك تفويض صريح لإدارته.</Text>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0A0D1F" },
  container: { paddingHorizontal: 18, paddingBottom: 40, width: "100%", maxWidth: 700, alignSelf: "center" },
  brand: { flexDirection: "row-reverse", alignItems: "center", gap: 12, marginBottom: 22 },
  brandMark: { width: 46, height: 46, borderRadius: 15, backgroundColor: "#8B5CF6", alignItems: "center", justifyContent: "center" },
  brandMarkText: { color: "#FFFFFF", fontSize: 25, fontWeight: "900" },
  eyebrow: { color: "#67E8F9", fontSize: 9, fontWeight: "900", letterSpacing: 1.2, textAlign: "right" },
  title: { color: "#F8FAFC", fontSize: 23, fontWeight: "900", textAlign: "right", marginTop: 5 },
  infoCard: { flexDirection: "row-reverse", gap: 10, alignItems: "center", backgroundColor: "#0E2524", borderWidth: 1, borderColor: "#145A53", borderRadius: 15, padding: 13, marginBottom: 24 },
  infoText: { flex: 1, color: "#99F6E4", fontSize: 11, lineHeight: 19, textAlign: "right" },
  activeCard: { backgroundColor: "#102C2B", borderWidth: 1, borderColor: "#2DD4BF", borderRadius: 15, padding: 13, marginBottom: 22 },
  activeHeader: { flexDirection: "row-reverse", alignItems: "center", gap: 8 },
  activeTitle: { color: "#99F6E4", fontSize: 14, fontWeight: "900" },
  activeText: { color: "#CCFBF1", fontSize: 11, lineHeight: 18, textAlign: "right", marginTop: 7 },
  endButton: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 7, borderWidth: 1, borderColor: "#7F1D1D", backgroundColor: "#3A172A", borderRadius: 11, height: 44, marginTop: 11 },
  endText: { color: "#FDA4AF", fontSize: 11, fontWeight: "900" },
  controlButton: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 7, backgroundColor: "#A78BFA", borderRadius: 11, height: 44, marginTop: 11 },
  controlText: { color: "#0A0D1F", fontSize: 11, fontWeight: "900" },
  section: { color: "#64748B", fontSize: 11, fontWeight: "800", textAlign: "right", marginBottom: 9 },
  panel: { backgroundColor: "#11162B", borderWidth: 1, borderColor: "#27304D", borderRadius: 17, padding: 13, marginBottom: 20 },
  input: { height: 49, backgroundColor: "#0A0D1F", borderWidth: 1, borderColor: "#27304D", borderRadius: 12, color: "#F8FAFC", paddingHorizontal: 13, marginBottom: 9, fontSize: 13 },
  permissionRow: { flexDirection: "row-reverse", alignItems: "center", gap: 9, minHeight: 42, borderBottomWidth: 1, borderBottomColor: "#202A4A" },
  permissionIcon: { width: 27, height: 27, borderRadius: 9, backgroundColor: "#123E3A", alignItems: "center", justifyContent: "center" },
  permissionText: { flex: 1, color: "#E2E8F0", fontSize: 12, textAlign: "right" },
  acceptRow: { flexDirection: "row-reverse", alignItems: "center", gap: 10, marginBottom: 15 },
  checkbox: { width: 24, height: 24, borderWidth: 1, borderColor: "#475569", borderRadius: 7, alignItems: "center", justifyContent: "center" },
  checkboxActive: { backgroundColor: "#2DD4BF", borderColor: "#2DD4BF" },
  acceptText: { flex: 1, color: "#CBD5E1", fontSize: 11, lineHeight: 18, textAlign: "right" },
  error: { color: "#FDA4AF", fontSize: 11, lineHeight: 18, textAlign: "right", marginBottom: 12 },
  primaryButton: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 8, height: 50, backgroundColor: "#A78BFA", borderRadius: 13 },
  primaryText: { color: "#0A0D1F", fontSize: 13, fontWeight: "900" },
  cancelButton: { alignItems: "center", paddingVertical: 14 },
  cancelText: { color: "#94A3B8", fontSize: 12, fontWeight: "800" },
  disabled: { opacity: 0.5 },
  footer: { color: "#64748B", fontSize: 10, lineHeight: 17, textAlign: "center", marginTop: 8 },
});
