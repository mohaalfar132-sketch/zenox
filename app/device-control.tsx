import { Ionicons } from "@expo/vector-icons";
import * as SecureStore from "expo-secure-store";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenContainer } from "@/components/screen-container";
import { trpc } from "@/lib/trpc";

const ACTIVE_SESSION_KEY = "zenox.active.device.session";
const CAPABILITY_LABELS: Record<string, string> = {
  "device.info.read": "معلومات الجهاز",
  "files.read.selected": "قراءة ملفات محددة",
  "files.write.selected": "كتابة ملفات محددة",
  "apps.manage.allowed": "إدارة تطبيقات مسموحة",
  "settings.manage.allowed": "إعدادات مسموحة",
  "usb.session.allowed": "جلسة USB",
};

type StoredSession = { sessionId: string; sessionToken: string; deviceId: string; capabilities: string[]; expiresAt: string };

type Action = { capability: string; title: string; description: string; icon: keyof typeof Ionicons.glyphMap; command: string };

const ACTIONS: Action[] = [
  { capability: "device.info.read", title: "فحص حالة الجهاز", description: "قراءة معلومات آمنة من الجهاز دون تغيير أي شيء.", icon: "information-circle-outline", command: "قراءة حالة الجهاز" },
  { capability: "files.read.selected", title: "قراءة ملف محدد", description: "يتطلب اختيار ملف يدوي من نظام التشغيل.", icon: "document-text-outline", command: "قراءة ملف محدد بعد اختيار المستخدم" },
  { capability: "files.write.selected", title: "كتابة ملف محدد", description: "يتطلب اختيار مكان الحفظ يدويًا من نظام التشغيل.", icon: "create-outline", command: "كتابة ملف محدد بعد اختيار المستخدم" },
  { capability: "apps.manage.allowed", title: "إدارة تطبيق مسموح", description: "ينتظر ربط واجهة نظام التشغيل الرسمية.", icon: "apps-outline", command: "إدارة تطبيق مسموح" },
  { capability: "settings.manage.allowed", title: "تغيير إعداد مسموح", description: "ينتظر موافقة نظام التشغيل الرسمية.", icon: "settings-outline", command: "تغيير إعداد مسموح" },
  { capability: "usb.session.allowed", title: "بدء جلسة USB", description: "يتطلب دعم USB رسميًا واتصالًا فعليًا.", icon: "hardware-chip-outline", command: "بدء جلسة USB" },
];

export default function DeviceControlScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [session, setSession] = useState<StoredSession | null>(null);
  const [status, setStatus] = useState("جارٍ تحميل الجلسة الآمنة…");
  const authorizeMutation = trpc.devices.authorizeAction.useMutation();
  const endMutation = trpc.devices.endSession.useMutation();

  useEffect(() => {
    void SecureStore.getItemAsync(ACTIVE_SESSION_KEY).then((value) => {
      if (!value) {
        setStatus("لا توجد جلسة جهاز محفوظة. ابدأ من شاشة قبول الجلسة.");
        return;
      }
      try {
        const parsed = JSON.parse(value) as StoredSession;
        setSession(parsed);
        setStatus("الجلسة جاهزة. كل إجراء يحتاج تفويضًا منفصلًا.");
      } catch {
        setStatus("تعذر قراءة الجلسة الآمنة.");
      }
    });
  }, []);

  const allowedCapabilities = useMemo(() => new Set(session?.capabilities ?? []), [session]);

  async function runAction(action: Action) {
    if (!session) return;
    setStatus(`جارٍ طلب تفويض: ${action.title}…`);
    try {
      const result = await authorizeMutation.mutateAsync({ sessionId: session.sessionId, sessionToken: session.sessionToken, capability: action.capability as Parameters<typeof authorizeMutation.mutateAsync>[0]["capability"], action: action.command });
      if (!result.allowed) {
        setStatus("رفض الخادم هذا الإجراء.");
        return;
      }
      if (action.capability === "device.info.read") {
        setStatus(`تم التفويض. الجهاز يعمل على ${Platform.OS}، لكن التنفيذ المحلي الكامل يحتاج Adapter رسمي لنظام التشغيل.`);
      } else {
        setStatus(`تم التفويض لخدمة «${action.title}». التنفيذ المحلي يحتاج واجهة نظام التشغيل الرسمية؛ لم يُنفذ أمر عشوائي.`);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "تعذر تفويض الإجراء.");
    }
  }

  async function endSession() {
    if (!session) return;
    try {
      await endMutation.mutateAsync({ sessionId: session.sessionId, sessionToken: session.sessionToken });
      await SecureStore.deleteItemAsync(ACTIVE_SESSION_KEY);
      await SecureStore.deleteItemAsync(`zenox.device.${session.sessionId}`);
      setSession(null);
      setStatus("تم إنهاء الجلسة وحذف رمزها من الجهاز.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "تعذر إنهاء الجلسة.");
    }
  }

  return (
    <ScreenContainer style={styles.screen}>
      <ScrollView contentContainerStyle={[styles.container, { paddingTop: Math.max(insets.top, 22) }]}>
        <View style={styles.topbar}><Pressable onPress={() => router.back()} style={styles.back}><Ionicons name="arrow-forward" size={20} color="#CBD5E1" /></Pressable><View style={styles.brand}><View style={styles.mark}><Text style={styles.markText}>Z</Text></View><View><Text style={styles.eyebrow}>ZENOX / COMPANION</Text><Text style={styles.title}>لوحة الجهاز</Text></View></View></View>
        <View style={[styles.statusCard, !session && styles.warningCard]}><Ionicons name={session ? "shield-checkmark-outline" : "alert-circle-outline"} size={23} color={session ? "#2DD4BF" : "#FBBF24"} /><Text style={styles.statusText}>{status}</Text></View>
        {session ? <>
          <View style={styles.sessionCard}><Text style={styles.sessionTitle}>جلسة مصرح بها</Text><Text style={styles.sessionMeta}>معرف الجهاز: {session.deviceId}</Text><Text style={styles.sessionMeta}>تنتهي: {new Date(session.expiresAt).toLocaleString("ar-EG")}</Text></View>
          <Text style={styles.section}>الصلاحيات</Text><View style={styles.capabilities}>{session.capabilities.map((capability) => <View key={capability} style={styles.capability}><Ionicons name="checkmark-circle" size={16} color="#2DD4BF" /><Text style={styles.capabilityText}>{CAPABILITY_LABELS[capability] ?? capability}</Text></View>)}</View>
          <Text style={styles.section}>الأفعال المسموحة</Text><View style={styles.actions}>{ACTIONS.map((action) => { const allowed = allowedCapabilities.has(action.capability); return <Pressable key={action.capability} disabled={!allowed || authorizeMutation.isPending} onPress={() => void runAction(action)} style={[styles.action, !allowed && styles.actionDisabled]}><View style={styles.actionIcon}><Ionicons name={action.icon} size={20} color={allowed ? "#C4B5FD" : "#64748B"} /></View><View style={styles.actionCopy}><Text style={[styles.actionTitle, !allowed && styles.muted]}>{action.title}</Text><Text style={styles.actionDescription}>{action.description}</Text></View><Ionicons name={allowed ? "chevron-back" : "lock-closed-outline"} size={17} color={allowed ? "#A78BFA" : "#475569"} /></Pressable>; })}</View>
          <Pressable onPress={() => void endSession()} style={[styles.endButton, endMutation.isPending && styles.disabled]}><Ionicons name="stop-circle-outline" size={18} color="#FDA4AF" /><Text style={styles.endText}>{endMutation.isPending ? "جارٍ إنهاء الجلسة…" : "إنهاء الجلسة"}</Text></Pressable>
        </> : <Pressable onPress={() => router.push("/device-consent")} style={styles.primary}><Text style={styles.primaryText}>فتح شاشة قبول جلسة</Text><Ionicons name="arrow-back" size={18} color="#0A0D1F" /></Pressable>}
        <Text style={styles.footer}>ZENOX لا يفتح Shell خفيًا ولا يتجاوز صلاحيات النظام. كل فعل يمر عبر الخادم وموافقة الجهاز وواجهات Android/iOS الرسمية.</Text>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({ screen: { flex: 1, backgroundColor: "#0A0D1F" }, container: { paddingHorizontal: 18, paddingBottom: 40, width: "100%", maxWidth: 720, alignSelf: "center" }, topbar: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }, back: { width: 40, height: 40, borderWidth: 1, borderColor: "#27304D", borderRadius: 13, alignItems: "center", justifyContent: "center" }, brand: { flexDirection: "row-reverse", alignItems: "center", gap: 10 }, mark: { width: 42, height: 42, borderRadius: 13, backgroundColor: "#8B5CF6", alignItems: "center", justifyContent: "center" }, markText: { color: "#FFF", fontSize: 22, fontWeight: "900" }, eyebrow: { color: "#67E8F9", fontSize: 9, fontWeight: "900", textAlign: "right" }, title: { color: "#F8FAFC", fontSize: 23, fontWeight: "900", textAlign: "right", marginTop: 4 }, statusCard: { flexDirection: "row-reverse", alignItems: "center", gap: 9, backgroundColor: "#0E2524", borderWidth: 1, borderColor: "#145A53", borderRadius: 15, padding: 13, marginBottom: 16 }, warningCard: { backgroundColor: "#2A2110", borderColor: "#735512" }, statusText: { flex: 1, color: "#CCFBF1", fontSize: 11, lineHeight: 18, textAlign: "right" }, sessionCard: { backgroundColor: "#11162B", borderWidth: 1, borderColor: "#47327D", borderRadius: 15, padding: 14, marginBottom: 18 }, sessionTitle: { color: "#DDD6FE", fontSize: 14, fontWeight: "900", textAlign: "right" }, sessionMeta: { color: "#94A3B8", fontSize: 11, textAlign: "right", marginTop: 6 }, section: { color: "#64748B", fontSize: 11, fontWeight: "900", textAlign: "right", marginBottom: 8, marginTop: 6 }, capabilities: { backgroundColor: "#11162B", borderRadius: 15, padding: 12, marginBottom: 17 }, capability: { flexDirection: "row-reverse", alignItems: "center", gap: 8, minHeight: 34 }, capabilityText: { color: "#CBD5E1", fontSize: 11, textAlign: "right" }, actions: { gap: 8 }, action: { flexDirection: "row-reverse", alignItems: "center", gap: 10, backgroundColor: "#11162B", borderWidth: 1, borderColor: "#27304D", borderRadius: 14, padding: 12 }, actionDisabled: { opacity: 0.5 }, actionIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: "#211846", alignItems: "center", justifyContent: "center" }, actionCopy: { flex: 1 }, actionTitle: { color: "#F8FAFC", fontSize: 12, fontWeight: "900", textAlign: "right" }, actionDescription: { color: "#8190AD", fontSize: 10, lineHeight: 16, textAlign: "right", marginTop: 3 }, muted: { color: "#64748B" }, primary: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: "#A78BFA", borderRadius: 13, height: 50, marginTop: 12 }, primaryText: { color: "#0A0D1F", fontSize: 13, fontWeight: "900" }, endButton: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 8, borderWidth: 1, borderColor: "#7F1D1D", backgroundColor: "#3A172A", borderRadius: 13, height: 48, marginTop: 20 }, endText: { color: "#FDA4AF", fontSize: 12, fontWeight: "900" }, disabled: { opacity: 0.5 }, footer: { color: "#64748B", fontSize: 10, lineHeight: 17, textAlign: "center", marginTop: 22 }, });
