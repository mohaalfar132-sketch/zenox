import { Ionicons } from "@expo/vector-icons";
import { RecordingPresets, requestRecordingPermissionsAsync, useAudioRecorder, useAudioRecorderState } from "expo-audio";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { ScreenContainer } from "@/components/screen-container";
import { trpc } from "@/lib/trpc";
import { DEFAULT_CURRENCY, PREMIUM_COST, WATCH_REWARD, addCoins, getBalance, isPremium, unlockPremium } from "@/lib/zcoin";
import { showRewardedAd } from "@/lib/admob";
import { recordingMimeType, recordingUriToBase64, speakArabic } from "@/lib/zenox-voice";

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const [notifications, setNotifications] = useState(true);
  const [language, setLanguage] = useState<"AR" | "EN">("AR");
  const [voiceReport, setVoiceReport] = useState("");
  const [voiceBusy, setVoiceBusy] = useState(false);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 250);
  const transcribe = trpc.speech.transcribe.useMutation();
  const [zcoinBalance, setZcoinBalance] = useState(0);
  const [zcoinPremium, setZcoinPremium] = useState(false);
  const [watching, setWatching] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [zcoinMsg, setZcoinMsg] = useState("");

  useEffect(() => {
    void (async () => {
      setZcoinBalance(await getBalance());
      setZcoinPremium(await isPremium());
    })();
  }, []);

  async function watchAd() {
    if (watching) return;
    setZcoinMsg("");
    setWatching(true);
    try {
      const earned = await showRewardedAd();
      if (earned) {
        const next = await addCoins(WATCH_REWARD);
        setZcoinBalance(next);
        setZcoinMsg(`+${WATCH_REWARD} ${DEFAULT_CURRENCY} — شكرًا لمشاهدتك الإعلان.`);
      } else {
        setZcoinMsg("لم تكتمل مشاهدة الإعلان — لم يُحتسب الرصيد.");
      }
    } catch (e) {
      setZcoinMsg(e instanceof Error ? e.message : "تعذر عرض الإعلان.");
    } finally {
      setWatching(false);
    }
  }

  async function buyPremium() {
    setZcoinMsg("");
    const ok = await unlockPremium();
    if (ok) {
      setZcoinPremium(true);
      setZcoinBalance(await getBalance());
      setZcoinMsg("تم فتح Premium — شكرًا!");
    } else {
      setZcoinMsg(`رصيدك غير كافٍ (تحتاج ${PREMIUM_COST} ${DEFAULT_CURRENCY}).`);
    }
  }

  async function testSpeaker() {
    setVoiceReport("جارٍ تشغيل جملة الاختبار…");
    await speakArabic("هذا اختبار صوت ZENOX. إن سمعت هذه الجملة فمكبر الصوت يعمل.");
    setVoiceReport("شغّلت جملة الاختبار — إن سمعتها فالصوت يعمل.");
  }

  async function testMicrophone() {
    if (voiceBusy) return;
    if (recorderState.isRecording) {
      setVoiceBusy(true);
      try {
        await recorder.stop();
        if (!recorder.uri) throw new Error("لم يُحفظ التسجيل.");
        const audioBase64 = await recordingUriToBase64(recorder.uri);
        const result = await transcribe.mutateAsync({ audioBase64, mimeType: recordingMimeType() });
        setVoiceReport(result.text ? `الميكروفون يعمل، سمعت: «${result.text}»` : "لم أسمع كلامًا واضحًا — اقترب من الميكروفون وحاول مرة أخرى.");
      } catch (error) {
        setVoiceReport(error instanceof Error ? error.message : "تعذر اختبار الميكروفون.");
      } finally {
        setVoiceBusy(false);
      }
      return;
    }
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      setVoiceReport("اسمح باستخدام الميكروفون من إعدادات الجهاز ثم أعد المحاولة.");
      return;
    }
    try {
      await recorder.prepareToRecordAsync();
      recorder.record();
      setVoiceReport("أسجّل الآن — قل جملة قصيرة ثم اضغط «إيقاف وتحليل».");
    } catch {
      setVoiceReport("تعذر تشغيل الميكروفون في هذه اللحظة.");
    }
  }
  return (
    <ScreenContainer style={styles.screen}>
      <ScrollView contentContainerStyle={[styles.container, { paddingTop: Math.max(insets.top, 22) }]}>
        <View style={styles.header}><View><Text style={styles.eyebrow}>ZENOX / CONTROL</Text><Text style={styles.title}>الإعدادات</Text><Text style={styles.subtitle}>تحكم هادئ في تجربة التطبيق.</Text></View><View style={styles.settingsIcon}><Ionicons name="options" size={20} color="#A78BFA" /></View></View>
        <Text style={styles.section}>الحساب والتطبيق</Text>
        <View style={styles.panel}>
          <View style={styles.row}><View style={styles.rowIcon}><Ionicons name="language-outline" size={19} color="#67E8F9" /></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>اللغة</Text><Text style={styles.rowSub}>العربية / English</Text></View><View style={styles.segment}><Pressable onPress={() => setLanguage("AR")} style={[styles.segmentButton, language === "AR" && styles.segmentActive]}><Text style={[styles.segmentText, language === "AR" && styles.segmentTextActive]}>عربي</Text></Pressable><Pressable onPress={() => setLanguage("EN")} style={[styles.segmentButton, language === "EN" && styles.segmentActive]}><Text style={[styles.segmentText, language === "EN" && styles.segmentTextActive]}>EN</Text></Pressable></View></View>
          <View style={styles.divider} />
          <View style={styles.row}><View style={styles.rowIcon}><Ionicons name="moon-outline" size={19} color="#C084FC" /></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>السمة</Text><Text style={styles.rowSub}>Midnight Aurora</Text></View><View style={styles.themeSwatch}><View style={styles.swatchPurple} /><View style={styles.swatchTeal} /></View></View>
          <View style={styles.divider} />
          <View style={styles.row}><View style={styles.rowIcon}><Ionicons name="notifications-outline" size={19} color="#FBBF24" /></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>إشعارات الحالة</Text><Text style={styles.rowSub}>تنبيهات الوكيل والتحديثات</Text></View><Switch value={notifications} onValueChange={setNotifications} trackColor={{ false: "#27304D", true: "#5B35B6" }} thumbColor={notifications ? "#C4B5FD" : "#94A3B8"} /></View>
        </View>
        <Text style={styles.section}>الأمان والخصوصية</Text>
        <View style={styles.panel}>
          <View style={styles.row}><View style={styles.rowIcon}><Ionicons name="shield-checkmark-outline" size={19} color="#2DD4BF" /></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>سياسة الخصوصية</Text><Text style={styles.rowSub}>راجع ما يتم حفظه ومشاركته</Text></View><Ionicons name="chevron-back" size={18} color="#64748B" /></View>
          <View style={styles.divider} />
          <View style={styles.row}><View style={styles.rowIcon}><Ionicons name="cloud-outline" size={19} color="#60A5FA" /></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>حالة الاتصال</Text><Text style={styles.rowSub}>كل وظائف ZENOX تعمل Online</Text></View><View style={styles.status}><View style={styles.dot} /><Text style={styles.statusText}>متصل</Text></View></View>
        </View>
        <Text style={styles.section}>اختبار الصوت</Text>
        <View style={styles.card}>
          <Text style={styles.rowTitle}>هل يسمعك التطبيق ويسمعك أنت؟</Text>
          <Text style={styles.rowSub}>جرّب السماعة بجملة مسموعة، والميكروفون بتسجيل قصير يُحوَّل إلى نص.</Text>
          <View style={styles.voiceActions}>
            <Pressable onPress={() => void testSpeaker()} style={styles.voiceButton}><Ionicons name="volume-high-outline" size={17} color="#0A0D1F" /><Text style={styles.voiceButtonText}>اختبار السماعة</Text></Pressable>
            <Pressable onPress={() => void testMicrophone()} style={[styles.voiceButton, styles.voiceButtonAlt, recorderState.isRecording && styles.voiceButtonRec]}><Ionicons name={recorderState.isRecording ? "stop" : "mic-outline"} size={17} color={recorderState.isRecording ? "#0A0D1F" : "#2DD4BF"} /><Text style={[styles.voiceButtonText, recorderState.isRecording ? styles.voiceButtonTextRec : styles.voiceButtonTextAlt]}>{recorderState.isRecording ? "إيقاف وتحليل" : "اختبار الميكروفون"}</Text></Pressable>
          </View>
          {voiceReport ? <Text style={styles.voiceReport}>{voiceReport}</Text> : null}
        </View>
        <Text style={styles.section}>العملة (ZCOIN)</Text>
        <View style={styles.card}>
          <Text style={styles.rowTitle}>العملة الافتراضية: {DEFAULT_CURRENCY}</Text>
          <Text style={styles.rowSub}>رصيدك: {zcoinBalance} {DEFAULT_CURRENCY} · Premium: {zcoinPremium ? "مفعّل" : "غير مفعّل"}</Text>
          <View style={styles.voiceActions}>
            <Pressable disabled={watching} onPress={() => void watchAd()} style={[styles.voiceButton, watching && styles.voiceButtonRec]}>
              <Ionicons name="play-circle-outline" size={17} color={watching ? "#0A0D1F" : "#0A0D1F"} />
              <Text style={styles.voiceButtonText}>{watching ? "جارٍ عرض الإعلان…" : `شاهد إعلان (+${WATCH_REWARD} ${DEFAULT_CURRENCY})`}</Text>
            </Pressable>
            <Pressable disabled={zcoinPremium || zcoinBalance < PREMIUM_COST} onPress={() => void buyPremium()} style={[styles.voiceButton, styles.voiceButtonAlt, (zcoinPremium || zcoinBalance < PREMIUM_COST) && styles.disabled]}>
              <Ionicons name="star-outline" size={17} color="#2DD4BF" />
              <Text style={[styles.voiceButtonText, styles.voiceButtonTextAlt]}>{zcoinPremium ? "Premium مفعّل" : `استر Premium (${PREMIUM_COST})`}</Text>
            </Pressable>
          </View>
          {zcoinMsg ? <Text style={styles.voiceReport}>{zcoinMsg}</Text> : null}
        </View>
        <Text style={styles.version}>ZENOX v0.1 · نسخة تجريبية</Text>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0A0D1F" },
  container: { paddingHorizontal: 18, paddingBottom: 38, width: "100%", maxWidth: 900, alignSelf: "center" },
  header: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 28 },
  eyebrow: { color: "#67E8F9", fontSize: 10, fontWeight: "800", letterSpacing: 1.5, textAlign: "right", marginBottom: 8 },
  title: { color: "#F8FAFC", fontSize: 27, fontWeight: "900", textAlign: "right" },
  subtitle: { color: "#94A3B8", fontSize: 12, textAlign: "right", marginTop: 7 },
  settingsIcon: { width: 42, height: 42, borderRadius: 14, backgroundColor: "#211846", alignItems: "center", justifyContent: "center" },
  section: { color: "#64748B", fontSize: 11, fontWeight: "800", textAlign: "right", marginBottom: 9, letterSpacing: 0.6 },
  panel: { backgroundColor: "#11162B", borderWidth: 1, borderColor: "#232D4B", borderRadius: 18, paddingHorizontal: 14, marginBottom: 24 },
  row: { flexDirection: "row-reverse", alignItems: "center", minHeight: 70, gap: 11 },
  rowIcon: { width: 36, height: 36, borderRadius: 12, backgroundColor: "#1A2140", alignItems: "center", justifyContent: "center" },
  rowCopy: { flex: 1 },
  rowTitle: { color: "#F8FAFC", fontSize: 13, fontWeight: "800", textAlign: "right" },
  rowSub: { color: "#8190AD", fontSize: 11, textAlign: "right", marginTop: 4 },
  divider: { height: 1, backgroundColor: "#232D4B" },
  segment: { flexDirection: "row", backgroundColor: "#0A0D1F", borderRadius: 9, padding: 3 },
  segmentButton: { paddingHorizontal: 8, paddingVertical: 5, borderRadius: 7 },
  segmentActive: { backgroundColor: "#5B35B6" },
  segmentText: { color: "#8190AD", fontSize: 10, fontWeight: "700" },
  segmentTextActive: { color: "#FFFFFF" },
  themeSwatch: { flexDirection: "row", gap: 5 },
  swatchPurple: { width: 12, height: 12, borderRadius: 6, backgroundColor: "#8B5CF6" },
  swatchTeal: { width: 12, height: 12, borderRadius: 6, backgroundColor: "#2DD4BF" },
  status: { flexDirection: "row", alignItems: "center", gap: 5 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#2DD4BF" },
  statusText: { color: "#99F6E4", fontSize: 11, fontWeight: "700" },
  card: { backgroundColor: "#11162B", borderWidth: 1, borderColor: "#2A3454", borderRadius: 16, padding: 14, gap: 6 },
  voiceActions: { flexDirection: "row-reverse", gap: 8, marginTop: 6 },
  voiceButton: { flexDirection: "row-reverse", alignItems: "center", gap: 6, backgroundColor: "#A78BFA", borderRadius: 11, paddingHorizontal: 13, paddingVertical: 9 },
  voiceButtonAlt: { backgroundColor: "#0D2528", borderWidth: 1, borderColor: "#225E5B" },
  voiceButtonRec: { backgroundColor: "#2DD4BF", borderColor: "#2DD4BF" },
  voiceButtonText: { color: "#0A0D1F", fontSize: 11, fontWeight: "900" },
  voiceButtonTextAlt: { color: "#99F6E4" },
  voiceButtonTextRec: { color: "#0A0D1F" },
  voiceReport: { color: "#CBD5E1", fontSize: 11, marginTop: 8, textAlign: "right", lineHeight: 18 },
  version: { color: "#475569", textAlign: "center", fontSize: 10, marginTop: 20 },
  disabled: { opacity: 0.5 },
});
