import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

/**
 * The owner centre's area strip and the «أدوات سريعة» panel, kept in one place so
 * the screen and its test render exactly the same components.
 */

export const OWNER_AREAS = [
  { id: "management", label: "المنصة", icon: "layers-outline", color: "#A78BFA" },
  { id: "monitor", label: "المراقبة", icon: "pulse-outline", color: "#22D3EE" },
  { id: "tools", label: "أدوات سريعة", icon: "flash-outline", color: "#FBBF24" },
  { id: "notice", label: "الإعلان", icon: "megaphone-outline", color: "#34D399" },
  { id: "security", label: "الأمن", icon: "shield-half-outline", color: "#F87171" },
  { id: "chats", label: "المحادثات", icon: "chatbubbles-outline", color: "#38BDF8" },
  { id: "memory", label: "الذاكرة", icon: "bulb-outline", color: "#A78BFA" },
  { id: "website", label: "الموقع", icon: "globe-outline", color: "#67E8F9" },
  { id: "policy", label: "السياسات", icon: "shield-checkmark-outline", color: "#2DD4BF" },
  { id: "root", label: "Root Manager", icon: "construct-outline", color: "#FBBF24" },
  { id: "terminal", label: "Terminal", icon: "terminal-outline", color: "#34D399" },
  { id: "code", label: "كود البنية", icon: "git-branch-outline", color: "#F472B6" },
  { id: "ai", label: "الذكاء الاصطناعي", icon: "sparkles-outline", color: "#38BDF8" },
  { id: "integrations", label: "التكاملات", icon: "link-outline", color: "#60A5FA" },
  { id: "secrets", label: "الأسرار", icon: "key-outline", color: "#F59E0B" },
  { id: "files", label: "الملفات", icon: "document-attach-outline", color: "#C084FC" },
  { id: "devices", label: "الأجهزة", icon: "phone-portrait-outline", color: "#FB7185" },
  { id: "reports", label: "التقارير", icon: "document-text-outline", color: "#FBBF24" },
] as const;

export type OwnerArea = (typeof OWNER_AREAS)[number];
export type OwnerAreaId = OwnerArea["id"];

const SIDEBAR_GROUPS: { title: string; ids: OwnerAreaId[] }[] = [
  { title: "القيادة", ids: ["management", "monitor", "chats", "memory", "reports"] },
  { title: "البناء", ids: ["root", "terminal", "code", "files"] },
  { title: "المنصة", ids: ["website", "notice", "integrations", "ai", "secrets", "devices", "policy", "security", "tools"] },
];

export function OwnerAreaTabs({
  selected,
  onSelect,
}: {
  selected: OwnerAreaId;
  onSelect: (id: OwnerAreaId) => void;
}) {
  return (
    <View style={styles.strip}>
      {OWNER_AREAS.map((area) => (
        <Pressable
          key={area.id}
          testID={`owner-area-${area.id}`}
          accessibilityRole="button"
          accessibilityLabel={area.label}
          onPress={() => onSelect(area.id)}
          style={[styles.areaChip, selected === area.id && { borderColor: area.color, backgroundColor: `${area.color}18` }]}
        >
          <Ionicons name={area.icon as keyof typeof Ionicons.glyphMap} size={16} color={selected === area.id ? area.color : "#94A3B8"} />
          <Text style={[styles.areaText, selected === area.id && styles.areaTextActive]}>{area.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function OwnerSidebar({
  selected,
  onSelect,
  onClose,
}: {
  selected: OwnerAreaId;
  onSelect: (id: OwnerAreaId) => void;
  onClose?: () => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim();
  const groups = SIDEBAR_GROUPS.map((group) => ({
    title: group.title,
    areas: group.ids
      .map((id) => OWNER_AREAS.find((area) => area.id === id))
      .filter((area): area is OwnerArea => Boolean(area))
      .filter((area) => !needle || area.label.includes(needle)),
  })).filter((group) => group.areas.length > 0);

  return (
    <View style={styles.sidebar} testID="owner-sidebar">
      <View style={styles.sidebarHead}>
        <View style={styles.sidebarBrand}><Text style={styles.sidebarBrandText}>Z</Text></View>
        <View style={styles.sidebarHeading}>
          <Text style={styles.sidebarTitle}>ZENOX</Text>
          <Text style={styles.sidebarSubtitle}>مساحة العمل</Text>
        </View>
        {onClose ? (
          <Pressable accessibilityRole="button" accessibilityLabel="إغلاق القائمة" onPress={onClose} style={styles.sidebarClose}>
            <Ionicons name="close" size={17} color="#94A3B8" />
          </Pressable>
        ) : null}
      </View>

      <View style={styles.sidebarSearch}>
        <Ionicons name="search-outline" size={15} color="#64748B" />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="ابحث في الأقسام"
          placeholderTextColor="#64748B"
          style={styles.sidebarSearchInput}
          textAlign="right"
        />
      </View>

      <ScrollView style={styles.sidebarNav} contentContainerStyle={styles.sidebarNavContent} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {groups.map((group) => (
          <View key={group.title} style={styles.sidebarGroup}>
            <Text style={styles.sidebarGroupTitle}>{group.title}</Text>
            {group.areas.map((area) => {
              const active = selected === area.id;
              return (
                <Pressable
                  key={area.id}
                  testID={`owner-sidebar-${area.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={area.label}
                  onPress={() => onSelect(area.id)}
                  style={[styles.sidebarItem, active && { backgroundColor: `${area.color}18`, borderColor: `${area.color}55` }]}
                >
                  <Ionicons name={area.icon as keyof typeof Ionicons.glyphMap} size={16} color={active ? area.color : "#94A3B8"} />
                  <Text style={[styles.sidebarItemText, active && { color: "#F8FAFC" }]}>{area.label}</Text>
                  {active ? <View style={[styles.sidebarActiveDot, { backgroundColor: area.color }]} /> : null}
                </Pressable>
              );
            })}
          </View>
        ))}
        {groups.length === 0 ? <Text style={styles.sidebarEmpty}>لا يوجد قسم بهذا الاسم.</Text> : null}
      </ScrollView>

      <View style={styles.sidebarFooter}>
        <View style={styles.sidebarOnlineDot} />
        <Text style={styles.sidebarFooterText}>الجلسة نشطة</Text>
      </View>
    </View>
  );
}

export type OwnerToolItem = { name: string; label: string; args?: readonly string[] };

export function OwnerToolsPanel({
  tools,
  unlocked,
  busy,
  result,
  onRun,
  onRunWithArgs,
}: {
  tools: OwnerToolItem[];
  unlocked: boolean;
  busy: boolean;
  result: string;
  onRun: (name: string) => void;
  onRunWithArgs?: (name: string, args: Record<string, unknown>) => void;
}) {
  const [toolName, setToolName] = useState("");
  const [toolArgs, setToolArgs] = useState("{}");
  const [argsError, setArgsError] = useState("");

  function runWithArgs() {
    const name = toolName.trim();
    if (!name || !onRunWithArgs) return;
    try {
      const parsed: unknown = JSON.parse(toolArgs.trim() || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      setArgsError("");
      onRunWithArgs(name, parsed as Record<string, unknown>);
    } catch {
      setArgsError("الوسائط يجب أن تكون JSON على شكل {\"key\": \"value\"}.");
    }
  }

  return (
    <View style={styles.panel} testID="owner-tools-panel">
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>أدوات فورية</Text>
          <Text style={styles.hint}>
            تنفيذ مباشر على الخادم بلا نموذج: اختبارات، فحص أنواع، نسخة احتياطية، بناء الواجهة، المرفوعات، حالة Git، الأحجام، تقرير السرعة.
          </Text>
        </View>
        <Ionicons name="flash" size={23} color="#FBBF24" />
      </View>
      {!unlocked ? (
        <View style={styles.gate}>
          <Ionicons name="lock-closed-outline" size={17} color="#FDA4AF" />
          <Text style={styles.gateText}>الأدوات معطّلة حتى يتم الدخول إلى مساحة ZENOX.</Text>
        </View>
      ) : (
        <>
          <View style={styles.chips}>
            {tools.map((tool) => (
              <Pressable
                key={tool.name}
                testID={`owner-tool-${tool.name}`}
                accessibilityRole="button"
                accessibilityLabel={tool.label}
                disabled={busy}
                onPress={() => onRun(tool.name)}
                style={[styles.chip, busy && styles.disabled]}
              >
                <Text style={styles.chipText}>{tool.label}</Text>
              </Pressable>
            ))}
          </View>
          {onRunWithArgs ? (
            <View style={styles.argsBox}>
              <Text style={styles.argsTitle}>أداة بوسائط</Text>
              <TextInput
                value={toolName}
                onChangeText={setToolName}
                placeholder="اسم الأداة مثل run_command أو write_file"
                placeholderTextColor="#64748B"
                style={styles.argsInput}
                autoCapitalize="none"
                textAlign="left"
              />
              <TextInput
                value={toolArgs}
                onChangeText={setToolArgs}
                placeholder='{"command":"git status"}'
                placeholderTextColor="#64748B"
                style={styles.argsInput}
                autoCapitalize="none"
                textAlign="left"
              />
              <Pressable disabled={busy || !toolName.trim()} onPress={runWithArgs} style={[styles.argsRun, (busy || !toolName.trim()) && styles.disabled]}>
                <Text style={styles.argsRunText}>تشغيل الأداة</Text>
              </Pressable>
              {argsError ? <Text style={styles.argsError}>{argsError}</Text> : null}
            </View>
          ) : null}
          <View style={styles.report}>
            <Text style={styles.reportText} testID="owner-tools-result">
              {result}
            </Text>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { flexDirection: "row-reverse", gap: 7 },
  areaChip: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: "#27304D",
    backgroundColor: "#10162B",
    borderRadius: 11,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  areaText: { color: "#94A3B8", fontSize: 11, fontWeight: "700" },
  areaTextActive: { color: "#F8FAFC" },
  panel: { backgroundColor: "#171A2B", borderWidth: 1, borderColor: "#73511A", borderRadius: 17, padding: 13, marginBottom: 10 },
  header: { flexDirection: "row-reverse", alignItems: "flex-start", justifyContent: "space-between", gap: 10, marginBottom: 12 },
  title: { color: "#FDE68A", fontSize: 14, fontWeight: "900", textAlign: "right" },
  hint: { color: "#CBD5E1", fontSize: 10, lineHeight: 17, textAlign: "right", marginTop: 5 },
  gate: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 7,
    backgroundColor: "#3A172A",
    borderWidth: 1,
    borderColor: "#7F1D1D",
    borderRadius: 10,
    padding: 9,
    marginBottom: 10,
  },
  gateText: { color: "#FDA4AF", fontSize: 10, lineHeight: 16, textAlign: "right" },
  chips: { flexDirection: "row-reverse", flexWrap: "wrap", gap: 6, marginBottom: 8 },
  chip: { borderWidth: 1, borderColor: "#27304D", borderRadius: 9, paddingHorizontal: 9, paddingVertical: 5, backgroundColor: "#0F1424" },
  chipText: { color: "#A7F3D0", fontSize: 10, fontWeight: "700" },
  argsBox: { backgroundColor: "#10162B", borderWidth: 1, borderColor: "#27304D", borderRadius: 12, padding: 10, gap: 7, marginBottom: 8 },
  argsTitle: { color: "#CBD5E1", fontSize: 10, fontWeight: "900", textAlign: "right" },
  argsInput: { backgroundColor: "#070A16", borderWidth: 1, borderColor: "#27304D", borderRadius: 9, color: "#E2E8F0", fontSize: 11, paddingHorizontal: 9, paddingVertical: 8 },
  argsRun: { backgroundColor: "#FBBF24", borderRadius: 9, alignItems: "center", paddingVertical: 8 },
  argsRunText: { color: "#0A0D1F", fontSize: 11, fontWeight: "900" },
  argsError: { color: "#FDA4AF", fontSize: 9, textAlign: "right" },
  report: { backgroundColor: "#101C30", borderWidth: 1, borderColor: "#164E63", borderRadius: 15, padding: 12 },
  reportText: { color: "#CFFAFE", fontSize: 11, lineHeight: 19, textAlign: "right" },
  sidebar: { width: 228, flexShrink: 0, alignSelf: "stretch", backgroundColor: "#0D1328", borderWidth: 1, borderColor: "#27304D", borderRadius: 18, padding: 12 },
  sidebarHead: { flexDirection: "row-reverse", alignItems: "center", gap: 9, marginBottom: 12 },
  sidebarBrand: { width: 31, height: 31, borderRadius: 10, backgroundColor: "#8B5CF6", alignItems: "center", justifyContent: "center" },
  sidebarBrandText: { color: "#FFFFFF", fontSize: 17, fontWeight: "900" },
  sidebarHeading: { flex: 1, alignItems: "flex-end" },
  sidebarTitle: { color: "#F8FAFC", fontSize: 14, fontWeight: "900", letterSpacing: 1 },
  sidebarSubtitle: { color: "#64748B", fontSize: 9, fontWeight: "700", marginTop: 2 },
  sidebarClose: { width: 28, height: 28, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: "#10162B" },
  sidebarSearch: { flexDirection: "row-reverse", alignItems: "center", gap: 7, borderWidth: 1, borderColor: "#27304D", backgroundColor: "#0A0D1F", borderRadius: 10, paddingHorizontal: 9, marginBottom: 10 },
  sidebarSearchInput: { flex: 1, color: "#F8FAFC", fontSize: 11, paddingVertical: 8, textAlign: "right" },
  sidebarNav: { flex: 1 },
  sidebarNavContent: { paddingBottom: 8 },
  sidebarGroup: { marginBottom: 10 },
  sidebarGroupTitle: { color: "#64748B", fontSize: 9, fontWeight: "900", letterSpacing: 1, textAlign: "right", marginBottom: 5, paddingHorizontal: 6 },
  sidebarItem: { flexDirection: "row-reverse", alignItems: "center", gap: 8, borderWidth: 1, borderColor: "transparent", borderRadius: 9, paddingHorizontal: 8, paddingVertical: 8, marginBottom: 2 },
  sidebarItemText: { flex: 1, color: "#94A3B8", fontSize: 11, fontWeight: "700", textAlign: "right" },
  sidebarActiveDot: { width: 5, height: 5, borderRadius: 3 },
  sidebarEmpty: { color: "#64748B", fontSize: 10, textAlign: "right", padding: 8 },
  sidebarFooter: { flexDirection: "row-reverse", alignItems: "center", gap: 6, borderTopWidth: 1, borderTopColor: "#1E2540", paddingTop: 9, marginTop: 6 },
  sidebarOnlineDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#2DD4BF" },
  sidebarFooterText: { color: "#99F6E4", fontSize: 9, fontWeight: "800" },
  disabled: { opacity: 0.4 },
});
