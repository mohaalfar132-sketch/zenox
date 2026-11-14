import { Ionicons } from "@expo/vector-icons";
import { RecordingPresets, requestRecordingPermissionsAsync, useAudioRecorder, useAudioRecorderState } from "expo-audio";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenContainer } from "@/components/screen-container";
import { getApiBaseUrl } from "@/constants/oauth";
import { trimHistory } from "@/lib/chat-history";
import { loadGuestIdentity, loadMessages, saveMessages, type StoredMessage } from "@/lib/zenox-storage";
import { recordingMimeType, recordingUriToBase64, speakArabic } from "@/lib/zenox-voice";
import { trpc } from "@/lib/trpc";

const MODES = [
  { id: "general", label: "مساعد عام", icon: "sparkles-outline", color: "#A78BFA" },
  { id: "emotional", label: "عاطفي", icon: "heart-outline", color: "#FB7185" },
  { id: "debate", label: "مجادلة", icon: "git-compare-outline", color: "#FBBF24" },
  { id: "medical", label: "طبي", icon: "medkit-outline", color: "#2DD4BF" },
  { id: "study", label: "دراسي", icon: "school-outline", color: "#60A5FA" },
  { id: "code", label: "برمجي", icon: "code-slash-outline", color: "#C084FC" },
] as const;

type Message = { id: number; role: "assistant" | "user"; text: string };

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState("");
  const [selectedMode, setSelectedMode] = useState("general");
  const [voiceHint, setVoiceHint] = useState("");
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [guestIdentity, setGuestIdentity] = useState("ضيف");
  const [hydrated, setHydrated] = useState(false);
  const [sending, setSending] = useState(false);
  const aiStatus = trpc.chat.status.useQuery();
  const transcribeMutation = trpc.speech.transcribe.useMutation();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 250);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 1,
      role: "assistant",
      text: "أهلًا بك في ZENOX. أنا مساحتك الذكية تحت سيطرتك. اكتب طلبك وسأساعدك في تنظيمه.",
    },
  ]);

  useEffect(() => {
    let active = true;
    Promise.all([loadGuestIdentity(), loadMessages()]).then(([identity, saved]) => {
      if (!active) return;
      if (identity) setGuestIdentity(identity);
      if (saved?.length) setMessages(saved as Message[]);
      setHydrated(true);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (hydrated) void saveMessages(messages as StoredMessage[]);
  }, [hydrated, messages]);

  const mode = useMemo(() => MODES.find((item) => item.id === selectedMode) ?? MODES[0], [selectedMode]);

  const sendMessage = useCallback(async (messageText?: string, readAloud = false) => {
    const text = (messageText ?? draft).trim();
    if (!text || sending) return;
    const userMessage: Message = { id: Date.now(), role: "user", text };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setDraft("");
    const assistantId = Date.now() + 1;
    setSending(true);
    try {
      const payload = trimHistory(nextMessages.filter((item) => item.id !== 1 || item.role === "user")).map(
        ({ role, text: content }) => ({ role, content }),
      );
      const response = await fetch(`${getApiBaseUrl()}/api/chat/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ mode: mode.id, messages: payload }),
      });
      if (!response.ok || !response.body) {
        const detail = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(detail?.message || `تعذر بدء المحادثة (${response.status}).`);
      }

      // Append the bubble once, then fill it token by token.
      setMessages((current) => [...current, { id: assistantId, role: "assistant", text: "" }]);
      let answer = "";
      let streamError = "";
      let buffer = "";
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const event of events) {
          const line = event.split("\n").find((entry) => entry.startsWith("data:"));
          if (!line) continue;
          try {
            const parsed = JSON.parse(line.slice(5).trim()) as { delta?: string; error?: string };
            if (parsed.error) streamError = parsed.error;
            if (parsed.delta) {
              answer += parsed.delta;
              setMessages((current) => current.map((item) => (item.id === assistantId ? { ...item, text: answer } : item)));
            }
          } catch {
            // Ignore a keep-alive or a partial event.
          }
        }
      }

      if (streamError) throw new Error(streamError);
      if (!answer.trim()) throw new Error("لم يصل رد من النموذج. أعد إرسال الرسالة.");
      if (readAloud) await speakArabic(answer);
    } catch (error) {
      setMessages((current) => current.filter((item) => item.id !== assistantId || item.text.trim().length > 0));
      const raw = error instanceof Error ? error.message : "";
      // A tunnel/proxy can cut a slow reply, leaving an empty body that the
      // transport reports as a JSON parse error. Say what really happened.
      const dropped = /unexpected end of json|failed to fetch|network request failed|load failed|aborted|timeout/i.test(raw);
      const reason = dropped
        ? "انقطع الاتصال قبل وصول الرد. أعد إرسال الرسالة."
        : raw || "سبب غير معروف";
      setMessages((current) => [...current, { id: Date.now() + 1, role: "assistant", text: `تعذر تنفيذ الطلب: ${reason}` }]);
    } finally {
      setSending(false);
    }
  }, [draft, mode.id, messages, sending]);

  async function toggleVoice() {
    if (voiceBusy) return;
    if (recorderState.isRecording) {
      setVoiceBusy(true);
      try {
        await recorder.stop();
        if (!recorder.uri) throw new Error("لم يتم حفظ التسجيل");
        const audioBase64 = await recordingUriToBase64(recorder.uri);
        const result = await transcribeMutation.mutateAsync({ audioBase64, mimeType: recordingMimeType() });
        setDraft(result.text);
        setVoiceHint("تم تحويل صوتك إلى نص. راجعه ثم اضغط إرسال.");
      } catch (error) {
        setVoiceHint(error instanceof Error ? error.message : "تعذر قراءة التسجيل الصوتي الآن.");
      } finally {
        setVoiceBusy(false);
      }
      return;
    }

    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      setVoiceHint("اسمح لـ ZENOX باستخدام الميكروفون من إعدادات الجهاز لبدء التسجيل.");
      return;
    }
    try {
      await recorder.prepareToRecordAsync();
      recorder.record();
      setVoiceHint("أتلقى صوتك الآن… اضغط الميكروفون مرة أخرى للإيقاف.");
    } catch {
      setVoiceHint("تعذر تشغيل الميكروفون في هذه اللحظة.");
    }
  }

  return (
    <ScreenContainer className="flex-1" style={styles.screen}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={[styles.shell, { paddingTop: Math.max(insets.top, 18) }]}>
          <View style={styles.auroraOne} />
          <View style={styles.auroraTwo} />
          <View style={styles.header}>
            <View style={styles.brandRow}>
              <View style={styles.mark}><Text style={styles.markText}>Z</Text></View>
              <View>
                <Text style={styles.brand}>ZENOX</Text>
                <Text style={styles.brandSub}>مساحتك الذكية</Text>
              </View>
            </View>
            <View style={styles.headerActions}>
              <View style={styles.onlinePill}><View style={styles.onlineDot} /><Text style={styles.onlineText}>Online</Text></View>
              <Pressable style={styles.iconButton} onPress={() => router.push("/settings")} accessibilityLabel="الإعدادات">
                <Ionicons name="settings-outline" size={20} color="#CBD5E1" />
              </Pressable>
            </View>
          </View>

          {aiStatus.data?.rejected ? (
            <View style={styles.aiNotice}>
              <Ionicons name="close-circle-outline" size={16} color="#FDA4AF" />
              <Text style={styles.aiNoticeText}>مفاتيح النماذج الموجودة رفضها المزوّد، لذلك كل الأوضاع (مجادلة، طبي، برمجي…) ستفشل. أضف مفتاحًا صالحًا من صفحة المفاتيح أو .env ثم أعد التشغيل.</Text>
            </View>
          ) : null}
          {aiStatus.data && !aiStatus.data.configured ? (
            <View style={styles.aiNotice}>
              <Ionicons name="warning-outline" size={16} color="#FBBF24" />
              <Text style={styles.aiNoticeText}>الذكاء الاصطناعي غير مفعّل على الخادم: أضف مفتاح النموذج (ZENOX_LLM_API_KEY) في .env أو في أسرار المشروع ثم أعد التشغيل.</Text>
            </View>
          ) : null}

          <View style={styles.contextRow}>
            <View style={styles.avatarHalo}><View style={styles.avatar}><Text style={styles.avatarText}>Z</Text></View></View>
            <View style={styles.contextCopy}>
              <Text style={styles.contextTitle}>{mode.label}</Text>
              <Text style={styles.contextSubtitle}>{guestIdentity} · {sending ? "يكتب الآن…" : "جاهز للاستماع والتفكير معك"}</Text>
            </View>
            <Pressable style={styles.newChat} onPress={() => setMessages([messages[0]])}>
              <Ionicons name="add" size={17} color="#DDD6FE" /><Text style={styles.newChatText}>جديد</Text>
            </Pressable>
          </View>

          <ScrollView style={styles.messages} contentContainerStyle={styles.messagesContent} showsVerticalScrollIndicator={false}>
            {messages.map((message) => (
              <View key={message.id} style={[styles.messageRow, message.role === "user" && styles.userRow]}>
                {message.role === "assistant" && <View style={styles.miniAvatar}><Text style={styles.miniAvatarText}>Z</Text></View>}
                <View style={[styles.bubble, message.role === "user" ? styles.userBubble : styles.assistantBubble]}>
                  <Text style={[styles.messageText, message.role === "user" && styles.userMessageText]}>{message.text}</Text>
                </View>
              </View>
            ))}
          </ScrollView>

          {voiceHint && <View style={styles.hint}><Ionicons name="information-circle-outline" size={16} color="#67E8F9" /><Text style={styles.hintText}>{voiceHint}</Text></View>}

          <View style={styles.modeStrip}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.modeContent}>
              {MODES.map((item) => (
                <Pressable key={item.id} onPress={() => setSelectedMode(item.id)} style={[styles.modeChip, selectedMode === item.id && { borderColor: item.color, backgroundColor: `${item.color}18` }]}>
                  <Ionicons name={item.icon as keyof typeof Ionicons.glyphMap} size={16} color={selectedMode === item.id ? item.color : "#94A3B8"} />
                  <Text style={[styles.modeText, selectedMode === item.id && { color: "#F8FAFC" }]}>{item.label}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>

          <View style={styles.composerWrap}>
            <Pressable style={styles.attachButton} onPress={() => setVoiceHint("إرفاق الملفات سيضاف في مرحلة الأدوات. الصوت يعمل الآن Online.")}><Ionicons name="attach-outline" size={22} color="#94A3B8" /></Pressable>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={() => void sendMessage()}
              onKeyPress={(event) => {
                // A multiline box swallows Enter on the web; send instead.
                const native = event.nativeEvent as unknown as { key?: string; shiftKey?: boolean };
                if (Platform.OS === "web" && native.key === "Enter" && !native.shiftKey) {
                  event.preventDefault?.();
                  void sendMessage();
                }
              }}
              placeholder="اكتب رسالتك إلى ZENOX…"
              placeholderTextColor="#64748B"
              style={styles.input}
              multiline
              textAlign="right"
            />
            <Pressable style={[styles.voiceButton, recorderState.isRecording && styles.voiceButtonActive]} onPress={() => void toggleVoice()}><Ionicons name={recorderState.isRecording ? "stop" : "mic-outline"} size={21} color="#CBD5E1" /></Pressable>
            <Pressable style={[styles.sendButton, (!draft.trim() || sending) && styles.sendDisabled]} onPress={() => void sendMessage()}><Ionicons name={sending ? "ellipsis-horizontal" : "arrow-up"} size={21} color="#0A0D1F" /></Pressable>
          </View>
          <Text style={styles.disclaimer}>ZENOX يتصل بالإنترنت في هذه النسخة التجريبية · راجع النتائج قبل الاعتماد</Text>
        </View>
      </KeyboardAvoidingView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { backgroundColor: "#0A0D1F" },
  shell: { flex: 1, minHeight: 0, width: "100%", maxWidth: 900, alignSelf: "center", paddingHorizontal: 18, paddingBottom: 12 },
  auroraOne: { position: "absolute", width: 320, height: 320, borderRadius: 160, backgroundColor: "#321B73", opacity: 0.2, top: -160, right: -90 },
  auroraTwo: { position: "absolute", width: 220, height: 220, borderRadius: 110, backgroundColor: "#0F766E", opacity: 0.12, bottom: 100, left: -140 },
  header: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "center", paddingBottom: 18 },
  brandRow: { flexDirection: "row-reverse", alignItems: "center", gap: 10 },
  mark: { width: 38, height: 38, borderRadius: 13, backgroundColor: "#8B5CF6", alignItems: "center", justifyContent: "center", shadowColor: "#8B5CF6", shadowOpacity: 0.45, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 8 },
  markText: { color: "#FFFFFF", fontSize: 22, fontWeight: "900" },
  brand: { color: "#F8FAFC", fontSize: 17, fontWeight: "900", letterSpacing: 2 },
  brandSub: { color: "#94A3B8", fontSize: 10, textAlign: "right", marginTop: 1 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  onlinePill: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderColor: "#225E5B", backgroundColor: "#0D2528", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 99 },
  onlineDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#2DD4BF" },
  onlineText: { color: "#99F6E4", fontSize: 11, fontWeight: "700" },
  iconButton: { width: 35, height: 35, borderRadius: 12, borderWidth: 1, borderColor: "#27304D", alignItems: "center", justifyContent: "center" },
  contextRow: { flexDirection: "row-reverse", alignItems: "center", paddingVertical: 14, borderTopWidth: 1, borderBottomWidth: 1, borderColor: "#1B2440", gap: 10 },
  avatarHalo: { width: 48, height: 48, borderRadius: 24, borderWidth: 1, borderColor: "#8B5CF6", alignItems: "center", justifyContent: "center", backgroundColor: "#17143A" },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: "#2DD4BF", alignItems: "center", justifyContent: "center" },
  avatarText: { color: "#0A0D1F", fontSize: 20, fontWeight: "900" },
  contextCopy: { flex: 1 },
  contextTitle: { color: "#F8FAFC", fontSize: 15, fontWeight: "800", textAlign: "right" },
  contextSubtitle: { color: "#8190AD", fontSize: 11, textAlign: "right", marginTop: 3 },
  newChat: { flexDirection: "row", gap: 4, alignItems: "center", borderWidth: 1, borderColor: "#47327D", paddingVertical: 7, paddingHorizontal: 10, borderRadius: 9 },
  newChatText: { color: "#DDD6FE", fontSize: 11, fontWeight: "700" },
  messages: { flex: 1, minHeight: 200 },
  messagesContent: { paddingVertical: 22, gap: 16 },
  aiNotice: { flexDirection: "row-reverse", alignItems: "center", gap: 8, borderWidth: 1, borderColor: "#73511A", backgroundColor: "#1B1608", borderRadius: 12, padding: 10, marginBottom: 10 },
  aiNoticeText: { flex: 1, color: "#FDE68A", fontSize: 10, lineHeight: 16, textAlign: "right" },
  messageRow: { flexDirection: "row-reverse", alignItems: "flex-end", gap: 8, maxWidth: "94%" },
  userRow: { alignSelf: "flex-start", flexDirection: "row" },
  miniAvatar: { width: 26, height: 26, borderRadius: 13, backgroundColor: "#8B5CF6", alignItems: "center", justifyContent: "center" },
  miniAvatarText: { color: "#FFFFFF", fontSize: 13, fontWeight: "900" },
  bubble: { flexShrink: 1, paddingHorizontal: 15, paddingVertical: 12, borderRadius: 17 },
  assistantBubble: { backgroundColor: "#151B34", borderTopRightRadius: 5, borderWidth: 1, borderColor: "#202A4A" },
  userBubble: { backgroundColor: "#5B35B6", borderTopLeftRadius: 5 },
  messageText: { flexShrink: 1, color: "#E2E8F0", fontSize: 14, lineHeight: 23, textAlign: "right" },
  userMessageText: { color: "#FFFFFF" },
  hint: { flexDirection: "row-reverse", alignItems: "center", gap: 6, backgroundColor: "#102B35", borderWidth: 1, borderColor: "#164E63", paddingHorizontal: 11, paddingVertical: 9, borderRadius: 10, marginBottom: 10 },
  hintText: { color: "#A5F3FC", fontSize: 11, flex: 1, textAlign: "right" },
  modeStrip: { marginBottom: 10 },
  modeContent: { flexDirection: "row-reverse", gap: 8, paddingVertical: 2 },
  modeChip: { flexDirection: "row-reverse", alignItems: "center", gap: 6, borderWidth: 1, borderColor: "#27304D", backgroundColor: "#10162B", borderRadius: 11, paddingHorizontal: 11, paddingVertical: 8 },
  modeText: { color: "#94A3B8", fontSize: 11, fontWeight: "700" },
  composerWrap: { minHeight: 56, flexDirection: "row-reverse", alignItems: "flex-end", gap: 7, backgroundColor: "#11162B", borderWidth: 1, borderColor: "#303B61", borderRadius: 18, padding: 8 },
  input: { flex: 1, maxHeight: 94, color: "#F8FAFC", fontSize: 14, paddingHorizontal: 8, paddingVertical: 8, textAlignVertical: "top" },
  attachButton: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  voiceButton: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  voiceButtonActive: { backgroundColor: "#244E59", borderRadius: 12 },
  sendButton: { width: 37, height: 37, borderRadius: 13, backgroundColor: "#A78BFA", alignItems: "center", justifyContent: "center" },
  sendDisabled: { opacity: 0.45 },
  disclaimer: { color: "#64748B", fontSize: 10, textAlign: "center", paddingTop: 9 },
});
