import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenContainer } from "@/components/screen-container";
import { isOwnerEntryWord } from "@/lib/owner-entry";
import { loadGuestIdentity, saveGuestIdentity } from "@/lib/zenox-storage";
import { trpc } from "@/lib/trpc";

export default function LoginScreen() {
  const insets = useSafeAreaInsets();
  const [identity, setIdentity] = useState("");
  const [message, setMessage] = useState("");
  const [restoring, setRestoring] = useState(true);
  const googleStatus = trpc.google.status.useQuery(undefined, { retry: false, staleTime: 30_000 });

  useEffect(() => {
    let active = true;
    void loadGuestIdentity().then((saved) => {
      if (!active) return;
      if (saved?.trim()) {
        router.replace("/(tabs)");
        return;
      }
      setRestoring(false);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (restoring || !googleStatus.data?.connected || !googleStatus.data.email) return;
    void saveGuestIdentity(`gmail:${googleStatus.data.email}`);
    router.replace("/(tabs)");
  }, [googleStatus.data, restoring]);
  function continueFromLogin() {
    const value = identity.trim();
    if (!value) {
      setMessage("اكتب بريدك أو اسمًا للمتابعة كضيف.");
      return;
    }
    if (isOwnerEntryWord(value)) {
      setMessage("");
      router.push("/console");
      return;
    }
    void saveGuestIdentity(value);
    router.replace("/(tabs)");
  }

  function enterAsGuest() {
    void saveGuestIdentity("ضيف");
    router.replace("/(tabs)");
  }

  function continueWithGoogle() {
    if (Platform.OS !== "web") {
      setMessage("افتح ZENOX من المتصفح لربط Gmail وDrive، ثم ارجع للتطبيق.");
      return;
    }
    setMessage("");
    window.location.assign(`/api/google/start?return=${encodeURIComponent("/")}`);
  }

  if (restoring) {
    return (
      <ScreenContainer style={styles.screen}>
        <View style={styles.loading}>
          <View style={styles.logoHalo}><View style={styles.logo}><Text style={styles.logoText}>Z</Text></View></View>
          <Text style={styles.brand}>ZENOX</Text>
          <ActivityIndicator color="#A78BFA" style={{ marginTop: 18 }} />
          <Text style={styles.loadingText}>أفتح محادثتك…</Text>
        </View>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer style={styles.screen}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={[styles.container, { paddingTop: Math.max(insets.top, 28), paddingBottom: Math.max(insets.bottom, 20) }]}>
          <View style={styles.auroraTop} />
          <View style={styles.auroraBottom} />
          <View style={styles.topline}><View style={styles.online}><View style={styles.dot} /><Text style={styles.onlineText}>ONLINE ONLY</Text></View><Text style={styles.version}>ZENOX v0.1</Text></View>
          <View style={styles.hero}>
            <View style={styles.logoHalo}><View style={styles.logo}><Text style={styles.logoText}>Z</Text></View></View>
            <Text style={styles.brand}>ZENOX</Text>
            <Text style={styles.tagline}>مساحتك الذكية تحت سيطرتك.</Text>
            <Text style={styles.description}>محادثة وأدوات متعددة في تجربة واحدة، بسرعة وخصوصية كاملة.</Text>
          </View>
          <View style={styles.loginCard}>
            <Text style={styles.cardTitle}>تسجيل الدخول</Text>
            <Text style={styles.cardSub}>اكتب بريدك أو اسمك. لا تحتاج دعوة للنسخة التجريبية.</Text>
            <View style={styles.inputWrap}><Ionicons name="person-outline" size={19} color="#8190AD" /><TextInput value={identity} onChangeText={(text) => { setIdentity(text); setMessage(""); }} onSubmitEditing={continueFromLogin} placeholder="البريد أو اسم المستخدم" placeholderTextColor="#64748B" style={styles.input} textAlign="right" autoCapitalize="none" autoCorrect={false} /></View>
            {message ? <Text style={styles.message}>{message}</Text> : null}
            <Pressable style={styles.primaryButton} onPress={continueFromLogin}><Text style={styles.primaryText}>متابعة</Text><Ionicons name="arrow-back" size={18} color="#0A0D1F" /></Pressable>
            <Pressable style={styles.googleButton} onPress={continueWithGoogle}><Ionicons name="logo-google" size={18} color="#111827" /><Text style={styles.googleText}>الدخول بجوجل</Text><Text style={styles.googleHint}>Gmail + Drive</Text></Pressable>
            <View style={styles.or}><View style={styles.line} /><Text style={styles.orText}>أو</Text><View style={styles.line} /></View>
            <Pressable style={styles.guestButton} onPress={enterAsGuest}><Ionicons name="person-circle-outline" size={19} color="#C4B5FD" /><Text style={styles.guestText}>دخول كضيف</Text></Pressable>
          </View>
          <Text style={styles.terms}>بالمتابعة أنت توافق على الشروط والأحكام وسياسة الخصوصية.</Text>
        </View>
      </KeyboardAvoidingView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: "#0A0D1F" },
  container: { flex: 1, width: "100%", maxWidth: 520, alignSelf: "center", paddingHorizontal: 22, justifyContent: "space-between", overflow: "hidden" },
  auroraTop: { position: "absolute", width: 360, height: 360, borderRadius: 180, backgroundColor: "#321B73", opacity: 0.2, top: -220, right: -100 },
  auroraBottom: { position: "absolute", width: 260, height: 260, borderRadius: 130, backgroundColor: "#0F766E", opacity: 0.12, bottom: -150, left: -120 },
  topline: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  version: { color: "#64748B", fontSize: 10, fontWeight: "700" },
  online: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderColor: "#225E5B", backgroundColor: "#0D2528", borderRadius: 99, paddingHorizontal: 9, paddingVertical: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#2DD4BF" },
  onlineText: { color: "#99F6E4", fontSize: 9, fontWeight: "900", letterSpacing: 0.8 },
  hero: { alignItems: "center", paddingTop: 20, paddingBottom: 10 },
  logoHalo: { width: 100, height: 100, borderRadius: 36, borderWidth: 1, borderColor: "#47327D", backgroundColor: "#17113A", alignItems: "center", justifyContent: "center", shadowColor: "#8B5CF6", shadowOpacity: 0.35, shadowRadius: 24, shadowOffset: { width: 0, height: 8 }, elevation: 10 },
  logo: { width: 70, height: 70, borderRadius: 24, backgroundColor: "#8B5CF6", alignItems: "center", justifyContent: "center" },
  logoText: { color: "#FFFFFF", fontSize: 42, fontWeight: "900" },
  brand: { color: "#F8FAFC", fontSize: 30, fontWeight: "900", letterSpacing: 5, marginTop: 17 },
  tagline: { color: "#DDD6FE", fontSize: 16, fontWeight: "800", marginTop: 8, textAlign: "center" },
  description: { color: "#8190AD", fontSize: 12, lineHeight: 20, textAlign: "center", maxWidth: 300, marginTop: 8 },
  loginCard: { backgroundColor: "#11162B", borderWidth: 1, borderColor: "#303B61", borderRadius: 22, padding: 17 },
  cardTitle: { color: "#F8FAFC", fontSize: 17, fontWeight: "900", textAlign: "right" },
  cardSub: { color: "#8190AD", fontSize: 11, lineHeight: 18, textAlign: "right", marginTop: 5, marginBottom: 14 },
  inputWrap: { flexDirection: "row-reverse", alignItems: "center", gap: 8, height: 52, backgroundColor: "#0A0D1F", borderWidth: 1, borderColor: "#27304D", borderRadius: 13, paddingHorizontal: 13 },
  input: { flex: 1, color: "#F8FAFC", fontSize: 13, height: "100%" },
  message: { color: "#FDA4AF", fontSize: 11, textAlign: "right", marginTop: 7 },
  primaryButton: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 8, height: 50, backgroundColor: "#A78BFA", borderRadius: 13, marginTop: 12 },
  primaryText: { color: "#0A0D1F", fontSize: 13, fontWeight: "900" },
  or: { flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 14 },
  line: { flex: 1, height: 1, backgroundColor: "#27304D" },
  orText: { color: "#64748B", fontSize: 11 },
  guestButton: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 8, height: 48, borderWidth: 1, borderColor: "#47327D", borderRadius: 13, backgroundColor: "#151033" },

  guestText: { color: "#C4B5FD", fontSize: 13, fontWeight: "800" },
  googleButton: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 8, height: 50, borderWidth: 1, borderColor: "#3B4A72", borderRadius: 13, backgroundColor: "#F8FAFC", marginTop: 10 },
  googleText: { color: "#111827", fontSize: 13, fontWeight: "900" },
  googleHint: { color: "#64748B", fontSize: 10, fontWeight: "700" },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  loadingText: { color: "#8190AD", fontSize: 12, marginTop: 10 },
  ownerLink: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 12 },
  ownerLinkText: { color: "#64748B", fontSize: 10, fontWeight: "700" },
  terms: { color: "#64748B", fontSize: 10, textAlign: "center", lineHeight: 16, paddingHorizontal: 18 },
});
