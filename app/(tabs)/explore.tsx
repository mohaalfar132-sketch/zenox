import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { ScrollView, StyleSheet, Text, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenContainer } from "@/components/screen-container";

const patterns = [
  { title: "مساعد عام", subtitle: "تنظيم، كتابة، أفكار", icon: "sparkles-outline", color: "#A78BFA" },
  { title: "عاطفي", subtitle: "استماع هادئ ودعم إنساني", icon: "heart-outline", color: "#FB7185" },
  { title: "مجادلة", subtitle: "حجج واضحة من الجهتين", icon: "git-compare-outline", color: "#FBBF24" },
  { title: "طبي", subtitle: "تثقيف عام مع تنبيه", icon: "medkit-outline", color: "#2DD4BF" },
  { title: "دراسي", subtitle: "شرح خطوة بخطوة", icon: "school-outline", color: "#60A5FA" },
  { title: "برمجي", subtitle: "كود، مراجعة، وحلول", icon: "code-slash-outline", color: "#C084FC" },
];

export default function ExploreScreen() {
  const insets = useSafeAreaInsets();
  return (
    <ScreenContainer style={styles.screen}>
      <ScrollView contentContainerStyle={[styles.container, { paddingTop: Math.max(insets.top, 22) }]} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View><Text style={styles.eyebrow}>ZENOX / MODES</Text><Text style={styles.title}>اختر طريقة التفكير</Text><Text style={styles.subtitle}>كل نمط له شخصية وإيقاع وأدوات قابلة للتطوير.</Text></View>
          <Pressable style={styles.roundButton} onPress={() => router.push("/settings")}><Ionicons name="options-outline" size={20} color="#CBD5E1" /></Pressable>
        </View>
        <View style={styles.feature}><View style={styles.featureIcon}><Ionicons name="radio-outline" size={22} color="#67E8F9" /></View><View style={styles.featureCopy}><Text style={styles.featureTitle}>أنماط تحت سيطرتك</Text><Text style={styles.featureText}>يمكن تعديل الأسماء والصور والتعليمات من الإعدادات في أي وقت.</Text></View></View>
        <View style={styles.grid}>{patterns.map((pattern) => <Pressable key={pattern.title} style={styles.card} onPress={() => pattern.title === "برمجي" && router.push("/coding")}><View style={[styles.cardIcon, { backgroundColor: `${pattern.color}20`, borderColor: `${pattern.color}66` }]}><Ionicons name={pattern.icon as keyof typeof Ionicons.glyphMap} size={22} color={pattern.color} /></View><Text style={styles.cardTitle}>{pattern.title}</Text><Text style={styles.cardSubtitle}>{pattern.subtitle}</Text><View style={styles.cardFooter}><Text style={styles.online}>{pattern.title === "برمجي" ? "OPEN LAB" : "ONLINE"}</Text><Ionicons name="arrow-back" size={14} color="#64748B" /></View></Pressable>)}</View>
        <Text style={styles.note}>هذه نسخة تجريبية Online؛ الأدوات المتقدمة ستتصل بالخادم بعد إعدادها.</Text>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0A0D1F" },
  container: { paddingHorizontal: 18, paddingBottom: 32, width: "100%", maxWidth: 900, alignSelf: "center" },
  header: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 22 },
  eyebrow: { color: "#67E8F9", fontSize: 10, fontWeight: "800", letterSpacing: 1.5, textAlign: "right", marginBottom: 8 },
  title: { color: "#F8FAFC", fontSize: 26, fontWeight: "900", textAlign: "right" },
  subtitle: { color: "#94A3B8", fontSize: 12, textAlign: "right", marginTop: 7 },
  roundButton: { width: 42, height: 42, borderRadius: 14, borderWidth: 1, borderColor: "#27304D", alignItems: "center", justifyContent: "center" },
  feature: { flexDirection: "row-reverse", alignItems: "center", gap: 12, backgroundColor: "#101C30", borderWidth: 1, borderColor: "#164E63", borderRadius: 17, padding: 14, marginBottom: 20 },
  featureIcon: { width: 42, height: 42, borderRadius: 14, backgroundColor: "#123642", alignItems: "center", justifyContent: "center" },
  featureCopy: { flex: 1 },
  featureTitle: { color: "#CFFAFE", fontSize: 14, fontWeight: "800", textAlign: "right" },
  featureText: { color: "#7DD3FC", fontSize: 11, lineHeight: 18, textAlign: "right", marginTop: 4 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  card: { flexGrow: 1, flexBasis: "46%", minWidth: 145, backgroundColor: "#11162B", borderWidth: 1, borderColor: "#232D4B", borderRadius: 18, padding: 14, minHeight: 150 },
  cardIcon: { width: 42, height: 42, borderRadius: 14, borderWidth: 1, alignItems: "center", justifyContent: "center", marginBottom: 12 },
  cardTitle: { color: "#F8FAFC", fontSize: 15, fontWeight: "800", textAlign: "right" },
  cardSubtitle: { color: "#94A3B8", fontSize: 11, textAlign: "right", marginTop: 5, lineHeight: 17 },
  cardFooter: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", marginTop: "auto", paddingTop: 12 },
  online: { color: "#64748B", fontSize: 9, fontWeight: "800", letterSpacing: 1 },
  note: { color: "#64748B", fontSize: 11, textAlign: "center", marginTop: 22 },
});
