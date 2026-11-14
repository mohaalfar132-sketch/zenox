import { Ionicons } from "@expo/vector-icons";
import { RecordingPresets, requestRecordingPermissionsAsync, useAudioRecorder, useAudioRecorderState } from "expo-audio";
import { useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenContainer } from "@/components/screen-container";
import { liveVoiceSupported, startLiveConversation, type LiveConversation, type LiveVoiceState } from "@/lib/live-voice";
import { recordingMimeType, recordingUriToBase64, speakArabic } from "@/lib/zenox-voice";
import { trpc } from "@/lib/trpc";

type InteractiveMessage = { id: number; from: "zenox" | "you"; text: string };

export default function InteractiveScreen() {
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState("");
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [liveState, setLiveState] = useState<LiveVoiceState>("idle");
  const liveRef = useRef<LiveConversation | null>(null);
  const liveSupported = useMemo(() => liveVoiceSupported(), []);
  const chatMutation = trpc.chat.complete.useMutation();
  const transcribeMutation = trpc.speech.transcribe.useMutation();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 250);
  const [messages, setMessages] = useState<InteractiveMessage[]>([
    { id: 1, from: "zenox", text: "أنا جاهز للحديث معك. يمكنك الكتابة أو بدء جلسة صوتية تفاعلية." },
  ]);

  async function send(valueOverride?: string, readAloud = false, modeOverride = "general") {
    const value = (valueOverride ?? draft).trim();
    if (!value || chatMutation.isPending) return;
    const userMessage = { id: Date.now(), from: "you" as const, text: value };
    setMessages((current) => [...current, userMessage]);
    setDraft("");
    try {
      const result = await chatMutation.mutateAsync({
        mode: modeOverride,
        audience: "guest",
        messages: [...messages, userMessage].slice(-20).map((message) => ({ role: message.from === "you" ? "user" as const : "assistant" as const, content: message.text })),
      });
      setMessages((current) => [...current, { id: Date.now() + 1, from: "zenox", text: result.content }]);
      if (readAloud) await speakArabic(result.content);
    } catch {
      setMessages((current) => [...current, { id: Date.now() + 1, from: "zenox", text: "تعذر الاتصال بخدمة الذكاء الاصطناعي الآن. حاول مرة أخرى." }]);
    }
  }

  async function toggleVoice() {
    if (voiceBusy) return;
    if (recorderState.isRecording) {
      setVoiceBusy(true);
      try {
        await recorder.stop();
        if (!recorder.uri) throw new Error("لم يتم حفظ التسجيل");
        const audioBase64 = await recordingUriToBase64(recorder.uri);
        const result = await transcribeMutation.mutateAsync({ audioBase64, mimeType: recordingMimeType() });
        await send(result.text, true);
      } catch (error) {
        setMessages((current) => [...current, { id: Date.now() + 1, from: "zenox", text: error instanceof Error ? error.message : "تعذر فهم التسجيل الصوتي الآن." }]);
      } finally {
        setVoiceBusy(false);
      }
      return;
    }

    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      setMessages((current) => [...current, { id: Date.now() + 1, from: "zenox", text: "اسمح لـ ZENOX باستخدام الميكروفون من إعدادات الجهاز لبدء الجلسة الصوتية." }]);
      return;
    }
    try {
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch {
      setMessages((current) => [...current, { id: Date.now() + 1, from: "zenox", text: "تعذر تشغيل الميكروفون في هذه اللحظة." }]);
    }
  }

  function toggleLiveConversation() {
    if (liveRef.current?.isActive()) {
      liveRef.current.stop();
      liveRef.current = null;
      setLiveState("idle");
      return;
    }
    if (!liveSupported) {
      setMessages((current) => [...current, { id: Date.now(), from: "zenox", text: "المحادثة الحية تحتاج متصفح Chrome أو Edge على الويب. استخدم زر التسجيل الصوتي هنا بدلًا منها." }]);
      return;
    }
    const conversation = startLiveConversation({
      onState: setLiveState,
      onTranscript: (text) => setMessages((current) => [...current, { id: Date.now(), from: "you", text }]),
      onReply: async (text) => {
        setLiveState("speaking");
        await send(text, true, "live");
        setLiveState("listening");
      },
      onError: (message) => setMessages((current) => [...current, { id: Date.now(), from: "zenox", text: message }]),
    });
    if (!conversation) {
      setMessages((current) => [...current, { id: Date.now(), from: "zenox", text: "تعذر تشغيل المحادثة الحية في هذا المتصفح." }]);
      return;
    }
    liveRef.current = conversation;
  }

  return (
    <ScreenContainer style={styles.screen}>
      <ScrollView contentContainerStyle={[styles.container, { paddingTop: Math.max(insets.top, 22) }]} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={styles.header}><View><Text style={styles.eyebrow}>ZENOX / LIVE INTERACTION</Text><Text style={styles.title}>الحديث التفاعلي</Text><Text style={styles.subtitle}>نص وصوت في مساحة واحدة.</Text></View><View style={styles.liveBadge}><View style={styles.dot} /><Text style={styles.liveText}>ONLINE</Text></View></View>
          <View style={styles.voiceCard}>
          <View style={[styles.wave, recorderState.isRecording && styles.waveActive]}><View style={styles.waveBarSmall} /><View style={styles.waveBar} /><View style={styles.waveBarTall} /><View style={styles.waveBar} /><View style={styles.waveBarSmall} /></View>
          <Text style={styles.voiceTitle}>{recorderState.isRecording ? "أستمع إليك…" : "ابدأ حديثًا صوتيًا"}</Text>
          <Text style={styles.voiceSub}>سجّل كلامك، وسيحوّله ZENOX إلى نص ثم يقرأ الرد بالعربية</Text>
          <Pressable style={[styles.voiceButton, recorderState.isRecording && styles.voiceButtonActive]} onPress={() => void toggleVoice()}><Ionicons name={recorderState.isRecording ? "stop" : "mic"} size={25} color="#0A0D1F" /><Text style={styles.voiceButtonText}>{recorderState.isRecording ? "إيقاف وتحليل الصوت" : "بدء الحديث الصوتي"}</Text></Pressable>
          {recorderState.isRecording && <Text style={styles.demoNote}>التسجيل نشط Online · اضغط مرة أخرى لإرسال الصوت للتحليل</Text>}
          <Pressable onPress={toggleLiveConversation} style={[styles.liveButton, liveState !== "idle" && styles.liveButtonActive]}><Ionicons name={liveState === "idle" ? "radio-outline" : "stop-circle-outline"} size={18} color={liveState === "idle" ? "#99F6E4" : "#0A0D1F"} /><Text style={[styles.liveButtonText, liveState !== "idle" && styles.liveButtonTextActive]}>{liveState === "idle" ? "محادثة حية بدون ضغط" : liveState === "listening" ? "أستمع… تحدث الآن" : liveState === "thinking" ? "أفكر…" : "أقرأ الرد…"}</Text></Pressable>
          <Text style={styles.liveHint}>{liveSupported ? "تحدث وسيُرسل كلامك ويُقرأ الرد تلقائيًا، ثم يعود للاستماع." : "المحادثة الحية تعمل على Chrome/Edge — التسجيل الصوتي متاح هنا دائمًا."}</Text>
        </View>
        <View style={styles.chatHeader}><Text style={styles.sectionTitle}>المحادثة التفاعلية</Text><Text style={styles.messageCount}>{chatMutation.isPending ? "يفكر الآن…" : `${messages.length} رسائل`}</Text></View>
        <View style={styles.chatBox}>{messages.map((message) => <View key={message.id} style={[styles.messageRow, message.from === "you" && styles.youRow]}><View style={[styles.avatar, message.from === "you" ? styles.youAvatar : styles.zenoxAvatar]}><Text style={styles.avatarText}>{message.from === "you" ? "أ" : "Z"}</Text></View><View style={[styles.bubble, message.from === "you" ? styles.youBubble : styles.zenoxBubble]}><Text style={styles.bubbleText}>{message.text}</Text></View></View>)}</View>
        <View style={styles.composer}><TextInput value={draft} onChangeText={setDraft} onSubmitEditing={() => void send()} placeholder="اكتب ما تريد مناقشته…" placeholderTextColor="#64748B" style={styles.input} multiline textAlign="right" /><Pressable style={[styles.send, (!draft.trim() || chatMutation.isPending) && styles.disabled]} onPress={() => void send()}><Ionicons name={chatMutation.isPending ? "ellipsis-horizontal" : "arrow-up"} size={19} color="#0A0D1F" /></Pressable></View>
        <Text style={styles.footer}>يمكنك إيقاف الجلسة في أي وقت · ZENOX يعمل عبر الإنترنت</Text>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0A0D1F" },
  container: { paddingHorizontal: 18, paddingBottom: 35, width: "100%", maxWidth: 900, alignSelf: "center" },
  header: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 },
  eyebrow: { color: "#67E8F9", fontSize: 10, fontWeight: "900", letterSpacing: 1.3, textAlign: "right", marginBottom: 8 },
  title: { color: "#F8FAFC", fontSize: 26, fontWeight: "900", textAlign: "right" },
  subtitle: { color: "#94A3B8", fontSize: 12, textAlign: "right", marginTop: 6 },
  liveBadge: { flexDirection: "row", alignItems: "center", gap: 5, borderWidth: 1, borderColor: "#225E5B", backgroundColor: "#0D2528", borderRadius: 99, paddingHorizontal: 9, paddingVertical: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#2DD4BF" },
  liveText: { color: "#99F6E4", fontSize: 9, fontWeight: "900", letterSpacing: 1 },
  voiceCard: { alignItems: "center", backgroundColor: "#11162B", borderWidth: 1, borderColor: "#47327D", borderRadius: 21, padding: 20, marginBottom: 22 },
  wave: { height: 54, flexDirection: "row", alignItems: "center", gap: 5, marginBottom: 11 },
  waveActive: { transform: [{ scale: 1.08 }] },
  waveBarSmall: { width: 5, height: 16, borderRadius: 4, backgroundColor: "#2DD4BF" },
  waveBar: { width: 5, height: 31, borderRadius: 4, backgroundColor: "#8B5CF6" },
  waveBarTall: { width: 5, height: 48, borderRadius: 4, backgroundColor: "#A78BFA" },
  voiceTitle: { color: "#F8FAFC", fontSize: 16, fontWeight: "900" },
  voiceSub: { color: "#8190AD", fontSize: 11, textAlign: "center", marginTop: 5 },
  voiceButton: { flexDirection: "row-reverse", alignItems: "center", gap: 8, backgroundColor: "#A78BFA", borderRadius: 13, paddingHorizontal: 17, paddingVertical: 11, marginTop: 15 },
  voiceButtonActive: { backgroundColor: "#2DD4BF" },
  voiceButtonText: { color: "#0A0D1F", fontSize: 12, fontWeight: "900" },
  liveButton: { flexDirection: "row-reverse", alignItems: "center", gap: 7, borderWidth: 1, borderColor: "#225E5B", backgroundColor: "#0D2528", borderRadius: 13, paddingHorizontal: 15, paddingVertical: 10, marginTop: 12 },
  liveButtonActive: { backgroundColor: "#2DD4BF", borderColor: "#2DD4BF" },
  liveButtonText: { color: "#99F6E4", fontSize: 12, fontWeight: "900" },
  liveButtonTextActive: { color: "#0A0D1F" },
  liveHint: { color: "#64748B", fontSize: 10, textAlign: "center", marginTop: 8 },
  demoNote: { color: "#A5F3FC", fontSize: 10, textAlign: "center", marginTop: 10 },
  chatHeader: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "center", marginBottom: 9 },
  sectionTitle: { color: "#CBD5E1", fontSize: 13, fontWeight: "900", textAlign: "right" },
  messageCount: { color: "#64748B", fontSize: 10 },
  chatBox: { backgroundColor: "#10162B", borderWidth: 1, borderColor: "#232D4B", borderRadius: 17, padding: 13, gap: 13 },
  messageRow: { flexDirection: "row-reverse", alignItems: "flex-end", gap: 8 },
  youRow: { flexDirection: "row" },
  avatar: { width: 27, height: 27, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  zenoxAvatar: { backgroundColor: "#8B5CF6" },
  youAvatar: { backgroundColor: "#2DD4BF" },
  avatarText: { color: "#0A0D1F", fontSize: 12, fontWeight: "900" },
  bubble: { flex: 1, padding: 11, borderRadius: 14 },
  zenoxBubble: { backgroundColor: "#18203B", borderTopRightRadius: 4 },
  youBubble: { backgroundColor: "#244E59", borderTopLeftRadius: 4 },
  bubbleText: { color: "#E2E8F0", fontSize: 12, lineHeight: 20, textAlign: "right" },
  composer: { flexDirection: "row-reverse", alignItems: "flex-end", backgroundColor: "#11162B", borderWidth: 1, borderColor: "#303B61", borderRadius: 16, padding: 8, marginTop: 12 },
  input: { flex: 1, minHeight: 42, maxHeight: 100, color: "#F8FAFC", fontSize: 13, paddingHorizontal: 8, textAlignVertical: "top" },
  send: { width: 37, height: 37, borderRadius: 13, backgroundColor: "#A78BFA", alignItems: "center", justifyContent: "center" },
  disabled: { opacity: 0.4 },
  footer: { color: "#475569", fontSize: 10, textAlign: "center", marginTop: 14 },
});
