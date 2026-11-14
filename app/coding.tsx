import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenContainer } from "@/components/screen-container";
import { trpc } from "@/lib/trpc";

const DRAFT_KEY = "zenox.coding.draft";
const LANGUAGES = ["TypeScript", "JavaScript", "Python", "C++", "SQL"] as const;
type Language = (typeof LANGUAGES)[number];

function extractCode(value: string) {
  const match = value.match(/```(?:[a-zA-Z0-9+#-]+)?\s*([\s\S]*?)```/);
  return match?.[1]?.trim() || value.trim();
}

export default function CodingScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [language, setLanguage] = useState<Language>("TypeScript");
  const [task, setTask] = useState("");
  const [code, setCode] = useState("// اكتب فكرتك أو اطلب توليد كود من ZENOX\n");
  const [saved, setSaved] = useState(false);
  const [status, setStatus] = useState("بيئة البرمجة جاهزة — التشغيل المباشر للكود غير مفعّل بعد.");
  const generateMutation = trpc.chat.complete.useMutation();

  useEffect(() => {
    void AsyncStorage.getItem(DRAFT_KEY).then((raw) => {
      if (!raw) return;
      try {
        const draft = JSON.parse(raw) as { language?: Language; task?: string; code?: string };
        if (draft.language && LANGUAGES.includes(draft.language)) setLanguage(draft.language);
        if (draft.task) setTask(draft.task);
        if (draft.code) setCode(draft.code);
        setStatus("تم استرجاع آخر مسودة محليًا.");
      } catch {
        setStatus("تعذر قراءة المسودة السابقة.");
      }
    });
  }, []);

  async function saveDraft() {
    await AsyncStorage.setItem(DRAFT_KEY, JSON.stringify({ language, task, code }));
    setSaved(true);
    setStatus("تم حفظ المسودة على هذا الجهاز فقط.");
    setTimeout(() => setSaved(false), 1800);
  }

  async function generateCode() {
    if (!task.trim() || generateMutation.isPending) {
      setStatus("اكتب المطلوب أولًا، مثل: أنشئ دالة للتحقق من البريد الإلكتروني.");
      return;
    }
    setStatus("ZENOX يكتب الحل ويراجع القيود…");
    try {
      const result = await generateMutation.mutateAsync({
        mode: "coding",
        audience: "guest",
        messages: [{ role: "user", content: `اكتب كودًا بلغة ${language} للمهمة التالية: ${task}. أعد الكود داخل كتلة واحدة فقط، ثم سطرًا قصيرًا يذكر طريقة الاستخدام.` }],
      });
      setCode(extractCode(result.content));
      setStatus(`تم توليد كود ${language}. راجع التغييرات قبل استخدامها.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "تعذر توليد الكود.");
    }
  }

  function clearEditor() {
    setCode("");
    setStatus("تم تفريغ المحرر. لم يتم حذف المسودة المحفوظة حتى تضغط حفظًا جديدًا.");
  }

  return (
    <ScreenContainer style={styles.screen}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={[styles.container, { paddingTop: Math.max(insets.top, 20) }]} keyboardShouldPersistTaps="handled">
          <View style={styles.topbar}><Pressable onPress={() => router.back()} style={styles.back}><Ionicons name="arrow-forward" size={20} color="#CBD5E1" /></Pressable><View><Text style={styles.eyebrow}>ZENOX / CODE LAB</Text><Text style={styles.title}>مختبر البرمجة</Text></View><View style={styles.icon}><Ionicons name="code-slash" size={20} color="#C084FC" /></View></View>
          <View style={styles.notice}><Ionicons name="shield-checkmark-outline" size={20} color="#2DD4BF" /><Text style={styles.noticeText}>يولد ZENOX الكود ويراجعه، ويحفظ المسودة محليًا. لا يتم تشغيل كود عشوائي أو الوصول إلى ملفات جهازك تلقائيًا.</Text></View>
          <Text style={styles.section}>لغة المشروع</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.languageRow}>{LANGUAGES.map((item) => <Pressable key={item} onPress={() => setLanguage(item)} style={[styles.languageChip, language === item && styles.languageActive]}><Text style={[styles.languageText, language === item && styles.languageTextActive]}>{item}</Text></Pressable>)}</ScrollView>
          <Text style={styles.section}>ماذا تريد أن تبني؟</Text><TextInput value={task} onChangeText={setTask} placeholder="مثال: أنشئ API صغيرة تتحقق من البريد وتعيد رسالة عربية…" placeholderTextColor="#64748B" multiline style={styles.taskInput} textAlign="right" />
          <Pressable onPress={() => void generateCode()} style={[styles.generate, generateMutation.isPending && styles.disabled]}><Ionicons name="sparkles-outline" size={18} color="#0A0D1F" /><Text style={styles.generateText}>{generateMutation.isPending ? "جارٍ التوليد…" : "توليد الكود"}</Text></Pressable>
          <View style={styles.editorHeader}><Text style={styles.editorTitle}>{language} · main</Text><View style={styles.editorActions}><Pressable onPress={clearEditor}><Ionicons name="trash-outline" size={17} color="#FDA4AF" /></Pressable><Pressable onPress={() => void saveDraft()}><Ionicons name={saved ? "checkmark-circle" : "save-outline"} size={18} color="#67E8F9" /></Pressable></View></View>
          <TextInput value={code} onChangeText={setCode} multiline autoCapitalize="none" autoCorrect={false} spellCheck={false} style={styles.editor} textAlign="left" textAlignVertical="top" placeholder="سيظهر الكود هنا…" placeholderTextColor="#475569" />
          <View style={styles.status}><View style={styles.statusDot} /><Text style={styles.statusText}>{status}</Text></View>
          <View style={styles.bottomNote}><Ionicons name="construct-outline" size={17} color="#FBBF24" /><Text style={styles.bottomText}>الخطوة التالية: إضافة Sandbox خادمي لفحص وبناء المشاريع قبل تشغيلها. لا تستخدم زر التشغيل على ملفات غير موثوقة.</Text></View>
        </ScrollView>
      </KeyboardAvoidingView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 }, screen: { flex: 1, backgroundColor: "#0A0D1F" }, container: { paddingHorizontal: 18, paddingBottom: 38, width: "100%", maxWidth: 900, alignSelf: "center" }, topbar: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", marginBottom: 22 }, back: { width: 40, height: 40, borderWidth: 1, borderColor: "#27304D", borderRadius: 13, alignItems: "center", justifyContent: "center" }, icon: { width: 42, height: 42, borderRadius: 14, backgroundColor: "#211846", alignItems: "center", justifyContent: "center" }, eyebrow: { color: "#67E8F9", fontSize: 9, fontWeight: "900", letterSpacing: 1.2, textAlign: "right" }, title: { color: "#F8FAFC", fontSize: 24, fontWeight: "900", textAlign: "right", marginTop: 4 }, notice: { flexDirection: "row-reverse", alignItems: "center", gap: 9, backgroundColor: "#0E2524", borderWidth: 1, borderColor: "#145A53", borderRadius: 15, padding: 13, marginBottom: 20 }, noticeText: { flex: 1, color: "#99F6E4", fontSize: 11, lineHeight: 18, textAlign: "right" }, section: { color: "#64748B", fontSize: 11, fontWeight: "900", textAlign: "right", marginBottom: 8, marginTop: 8 }, languageRow: { gap: 8, paddingBottom: 6 }, languageChip: { borderWidth: 1, borderColor: "#334155", backgroundColor: "#11162B", borderRadius: 10, paddingHorizontal: 13, paddingVertical: 9 }, languageActive: { borderColor: "#A78BFA", backgroundColor: "#211846" }, languageText: { color: "#94A3B8", fontSize: 11, fontWeight: "800" }, languageTextActive: { color: "#DDD6FE" }, taskInput: { minHeight: 92, backgroundColor: "#11162B", borderWidth: 1, borderColor: "#27304D", borderRadius: 14, color: "#F8FAFC", padding: 13, fontSize: 12, lineHeight: 19 }, generate: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 8, height: 48, borderRadius: 12, backgroundColor: "#A78BFA", marginTop: 10 }, generateText: { color: "#0A0D1F", fontSize: 13, fontWeight: "900" }, editorHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "#151B34", borderTopLeftRadius: 14, borderTopRightRadius: 14, paddingHorizontal: 13, paddingVertical: 10, marginTop: 20 }, editorTitle: { color: "#C4B5FD", fontSize: 11, fontWeight: "800" }, editorActions: { flexDirection: "row", gap: 16 }, editor: { minHeight: 310, backgroundColor: "#070A16", borderWidth: 1, borderColor: "#27304D", borderBottomLeftRadius: 14, borderBottomRightRadius: 14, color: "#D1FAE5", padding: 14, fontSize: 12, lineHeight: 19, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" }, status: { flexDirection: "row-reverse", alignItems: "center", gap: 7, marginTop: 12 }, statusDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#2DD4BF" }, statusText: { flex: 1, color: "#94A3B8", fontSize: 10, lineHeight: 16, textAlign: "right" }, bottomNote: { flexDirection: "row-reverse", gap: 8, alignItems: "flex-start", backgroundColor: "#2A2110", borderWidth: 1, borderColor: "#735512", borderRadius: 13, padding: 11, marginTop: 18 }, bottomText: { flex: 1, color: "#FDE68A", fontSize: 10, lineHeight: 16, textAlign: "right" }, disabled: { opacity: 0.5 } });
