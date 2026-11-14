import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { trpc } from "@/lib/trpc";

type Provider = "groq" | "gemini" | "openai" | "openrouter" | "zai";
type Draft = { key: number; provider: Provider; value: string };
type Result = { label: string; ok: boolean; error: string };

const PROVIDERS: { id: Provider; label: string; hint: string }[] = [
  { id: "groq", label: "Groq", hint: "gsk_..." },
  { id: "gemini", label: "Gemini", hint: "AIza..." },
  { id: "openrouter", label: "OpenRouter", hint: "sk-or-..." },
  { id: "openai", label: "OpenAI", hint: "sk-..." },
  { id: "zai", label: "Z.AI", hint: "..." },
];

let nextKey = 3;

/**
 * Phone-sized key manager: paste any number of keys, pick each provider, one
 * button saves and probes them all. Nothing is echoed back or logged.
 */
export default function KeysScreen() {
  const router = useRouter();
  // `/keys?provider=openrouter` opens with that provider already selected, so a
  // link sent to the owner lands straight on the right field.
  const params = useLocalSearchParams<{ provider?: string }>();
  const wanted = PROVIDERS.find((item) => item.id === params.provider)?.id ?? "openrouter";
  const [password, setPassword] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>(
    wanted === "openrouter"
      ? [{ key: 1, provider: "openrouter", value: "" }]
      : [
          { key: 1, provider: wanted, value: "" },
          { key: 2, provider: "openrouter", value: "" },
        ],
  );
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const [message, setMessage] = useState("");

  const [unlocked, setUnlocked] = useState(false);
  const ownerStatus = trpc.owner.auth.status.useQuery();
  const login = trpc.owner.auth.login.useMutation();
  const setup = trpc.owner.auth.setup.useMutation();
  const addKey = trpc.owner.ai.add.useMutation();
  const stats = trpc.owner.ai.stats.useQuery(undefined, { enabled: unlocked, refetchInterval: 15_000 });
  const clearCache = trpc.owner.ai.clearCache.useMutation({ onSuccess: () => void stats.refetch() });
  const probeAll = trpc.owner.ai.probeAll.useMutation();
  const freeModels = trpc.owner.ai.freeModels.useQuery(undefined, { enabled: unlocked, refetchInterval: 60_000 });
  const [probes, setProbes] = useState<{ provider: string; label: string; ok: boolean; ms: number; mathModel?: string; model: string; error: string }[] | null>(null);

  async function checkEverything() {
    setMessage("أفحص كل المزوّدين…");
    try {
      const result = await probeAll.mutateAsync();
      setProbes(result.rows);
      const good = result.rows.filter((row) => row.ok).length;
      setMessage(good > 0 ? `${good} من ${result.rows.length} يعمل الآن. المزوّد النشط: ${result.active.provider}.` : "لا يعمل أي مزوّد — راجع السبب لكل صف.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "تعذّر فحص المزوّدين.");
    }
  }

  const updateDraft = (key: number, patch: Partial<Draft>) =>
    setDrafts((current) => current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));

  const save = async () => {
    setResults(null);
    setMessage("");
    const filled = drafts.filter((draft) => draft.value.trim());
    if (!password.trim()) {
      setMessage("اكتب كلمة مرور ZENOX أولًا.");
      return;
    }
    if (filled.length === 0) {
      setMessage("الصق مفتاحًا واحدًا على الأقل.");
      return;
    }

    setBusy(true);
    const secret = password.trim();
    try {
      await login.mutateAsync({ password: secret });
      setUnlocked(true);
    } catch (error) {
      const text = error instanceof Error ? error.message : "";
      // First run: no owner password exists yet — create it from the same field.
      if (text.includes("لم تُضبط") || text.includes("إنشاء")) {
        try {
          await setup.mutateAsync({ password: secret });
          setMessage("أُنشئت كلمة مرور ZENOX بهذه القيمة — احفظها في مكان آمن.");
        } catch (setupError) {
          setBusy(false);
          setMessage(setupError instanceof Error ? setupError.message : "تعذّر إنشاء كلمة المرور.");
          return;
        }
      } else {
        setBusy(false);
        setMessage(text || "كلمة المرور غير صحيحة.");
        return;
      }
    }

    const collected: Result[] = [];
    for (const draft of filled) {
      const label = PROVIDERS.find((provider) => provider.id === draft.provider)?.label ?? draft.provider;
      try {
        const saved = await addKey.mutateAsync({
          label: `مفتاح ${label}`,
          provider: draft.provider,
          apiKey: draft.value.trim(),
        });
        collected.push({ label, ok: saved.ok, error: saved.error || "" });
      } catch (error) {
        collected.push({ label, ok: false, error: error instanceof Error ? error.message : "تعذّر الحفظ" });
      }
    }

    setBusy(false);
    setResults(collected);
    setDrafts((current) => current.map((draft) => ({ ...draft, value: "" })));
    setPassword("");
    const healthy = collected.filter((item) => item.ok).length;
    if (healthy === collected.length) setMessage("تم — كل المفاتيح محفوظة وتعمل الآن.");
    else if (healthy > 0) setMessage(`${healthy} من ${collected.length} تعمل. راجع النتائج أدناه.`);
    else setMessage("لم يعمل أي مفتاح — راجع السبب أدناه.");
  };

  // Owner-only screen: the password box keeps the add-key form one step away,
  // and never reveals whether any key exists before it is entered.
  async function unlock() {
    const secret = password.trim();
    if (!secret) {
      setMessage("أدخل كلمة المرور.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await login.mutateAsync({ password: secret });
      await ownerStatus.refetch();
    } catch (error) {
      const text = error instanceof Error ? error.message : "";
      if (text.includes("لم تُضبط") || text.includes("إنشاء")) {
        try {
          await setup.mutateAsync({ password: secret });
          await ownerStatus.refetch();
          setMessage("أُنشئت كلمة المرور بهذه القيمة — احفظها في مكان آمن.");
        } catch (setupError) {
          setMessage(setupError instanceof Error ? setupError.message : "تعذّر إنشاء كلمة المرور.");
        }
      } else {
        setMessage(text || "كلمة المرور غير صحيحة.");
      }
    } finally {
      setBusy(false);
    }
  }

  if (!ownerStatus.data?.authenticated) {
    return (
      <View style={styles.page}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <Pressable style={styles.back} onPress={() => router.replace("/")}>
              <Ionicons name="arrow-back" size={20} color="#CBD5E1" />
            </Pressable>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>دخول محمي</Text>
              <Text style={styles.subtitle}>أدخل كلمة المرور للمتابعة.</Text>
            </View>
          </View>
          <View style={styles.card}>
            <Text style={styles.label}>كلمة المرور</Text>
            <TextInput
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              placeholder="••••••••"
              placeholderTextColor="#64748B"
              style={styles.input}
              autoCapitalize="none"
              onSubmitEditing={() => void unlock()}
            />
            <Pressable style={[styles.save, busy && styles.saveDisabled]} disabled={busy} onPress={() => void unlock()}>
              <Text style={styles.saveText}>{busy ? "جارٍ التحقق…" : "دخول"}</Text>
            </Pressable>
            {message ? <Text style={styles.message}>{message}</Text> : null}
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.page}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Pressable style={styles.back} onPress={() => router.replace("/")}>
            <Ionicons name="arrow-back" size={20} color="#CBD5E1" />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>مفاتيح الذكاء الاصطناعي</Text>
            <Text style={styles.subtitle}>أضف أي عدد من المفاتيح. نجرّب كل مفتاح فورًا ونستخدم الأسرع.</Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>كلمة مرور ZENOX</Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="••••••••"
            placeholderTextColor="#64748B"
            style={styles.input}
            autoCapitalize="none"
          />

          {drafts.map((draft) => (
            <View key={draft.key} style={styles.draft}>
              <View style={styles.rowTop}>
                <Text style={styles.label}>مفتاح {PROVIDERS.find((p) => p.id === draft.provider)?.label ?? draft.provider}</Text>
                {drafts.length > 1 ? (
                  <Pressable
                    onPress={() => setDrafts((current) => current.filter((item) => item.key !== draft.key))}
                    hitSlop={8}
                  >
                    <Ionicons name="close-circle" size={20} color="#64748B" />
                  </Pressable>
                ) : null}
              </View>
              <View style={styles.chips}>
                {PROVIDERS.map((provider) => (
                  <Pressable
                    key={provider.id}
                    style={[styles.chip, draft.provider === provider.id && styles.chipActive]}
                    onPress={() => updateDraft(draft.key, { provider: provider.id })}
                  >
                    <Text style={[styles.chipText, draft.provider === provider.id && styles.chipTextActive]}>
                      {provider.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <TextInput
                value={draft.value}
                onChangeText={(value) => updateDraft(draft.key, { value })}
                secureTextEntry
                placeholder={PROVIDERS.find((p) => p.id === draft.provider)?.hint}
                placeholderTextColor="#64748B"
                style={styles.input}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          ))}

          <Pressable
            style={styles.addRow}
            onPress={() => {
              const key = nextKey++;
              setDrafts((current) => [...current, { key, provider: "groq", value: "" }]);
            }}
          >
            <Ionicons name="add-circle-outline" size={20} color="#A78BFA" />
            <Text style={styles.addRowText}>إضافة مفتاح آخر</Text>
          </Pressable>

          <Pressable onPress={() => void checkEverything()} style={styles.cacheButton} disabled={probeAll.isPending}>
            <Text style={styles.addRowText}>{probeAll.isPending ? "أفحص كل المزوّدين…" : "فحص كل المزوّدين معًا (Gemini + OpenAI + غيرهم)"}</Text>
          </Pressable>
          {freeModels.data ? (
            <View style={styles.statsBox}>
              <Text style={styles.sectionTitle}>الموديلات المجانية الآن (تُقرأ من كتالوج OpenRouter تلقائيًا)</Text>
              <Text style={styles.statsLine}>
                {freeModels.data.models.length} موديلًا · المصدر: {freeModels.data.source === "live" ? "الكتالوج المباشر" : "قائمة احتياطية"}
                {freeModels.data.fetchedAt ? ` · آخر تحديث ${new Date(freeModels.data.fetchedAt).toLocaleTimeString("ar-EG")}` : ""}
              </Text>
              {freeModels.data.models.slice(0, 15).map((row) => (
                <Text key={row.id} style={styles.statsLine}>
                  {row.lastMs > 0 ? "✅" : row.attempts > 0 ? "❌" : "•"} {row.id}
                  {row.lastMs > 0 ? ` · ${row.lastMs}ms` : ""}
                </Text>
              ))}
            </View>
          ) : null}
          {probes ? (
            <View style={styles.statsBox}>
              {probes.map((row) => (
                <Text key={`${row.provider}-${row.label}`} style={styles.statsLine}>
                  {row.ok ? "✅" : "❌"} {row.provider} · {row.model} · {row.ms}ms{row.ok ? "" : ` — ${row.error}`}
                </Text>
              ))}
            </View>
          ) : null}
          <Pressable style={[styles.save, busy && styles.saveDisabled]} onPress={() => void save()} disabled={busy}>
            {busy ? <ActivityIndicator color="#0A0D1F" /> : <Text style={styles.saveText}>حفظ وفحص</Text>}
          </Pressable>

          {message ? <Text style={styles.message}>{message}</Text> : null}

          {unlocked && stats.data ? (
            <View style={styles.statsBox}>
              <Text style={styles.statsTitle}>حالة النظام</Text>
              <Text style={styles.statsLine}>
                المفاتيح: {stats.data.totalKeys} · سليمة {stats.data.healthyKeys} · معطلة {stats.data.failingKeys}
              </Text>
              <Text style={styles.statsLine}>
                المزوّد النشط: {stats.data.provider} · {stats.data.model}
              </Text>
              <Text style={styles.statsLine}>
                ردود مخزّنة: {stats.data.cacheEntries} · ردود جارية: {stats.data.inFlightStreams} · تشغيل:{" "}
                {Math.round(stats.data.uptimeSeconds / 60)} دقيقة
              </Text>
              <Pressable style={styles.cacheButton} onPress={() => clearCache.mutate()}>
                <Text style={styles.cacheButtonText}>
                  {clearCache.isPending ? "جارٍ التفريغ…" : "تفريغ الردود المخزّنة"}
                </Text>
              </Pressable>
            </View>
          ) : null}

          {results?.map((item, index) => (
            <View key={`${item.label}-${index}`} style={[styles.result, item.ok ? styles.resultOk : styles.resultFail]}>
              <Ionicons name={item.ok ? "checkmark-circle" : "alert-circle"} size={18} color={item.ok ? "#4ADE80" : "#F87171"} />
              <Text style={styles.resultText}>
                {item.label}: {item.ok ? "يعمل ✓" : `فشل — ${item.error.slice(0, 90)}`}
              </Text>
            </View>
          ))}
        </View>

        <Text style={styles.hint}>
          القيم لا تُعرض مرة أخرى ولا تظهر في أي سجل؛ تُحفظ في قاعدة البيانات وتُستخدم على الخادم فقط.
        </Text>
        <Text style={styles.hint}>
          النظام يدوّر بين المفاتيح السليمة ويتجاوز أي مفتاح يفشل أو يتأخر، فلا يتوقف التطبيق لو تعطّل أحدها.
        </Text>
        {Platform.OS === "web" ? <Text style={styles.hint}>من الهاتف: أضف /keys إلى رابط التطبيق.</Text> : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#080B18" },
  content: { padding: 20, gap: 14, maxWidth: 560, width: "100%", alignSelf: "center" },
  header: { flexDirection: "row-reverse", alignItems: "center", gap: 10, marginTop: 8 },
  back: { width: 38, height: 38, borderRadius: 12, backgroundColor: "#141B2E", alignItems: "center", justifyContent: "center" },
  title: { color: "#F1F5F9", fontSize: 20, fontWeight: "700", textAlign: "right" },
  subtitle: { color: "#94A3B8", fontSize: 13, marginTop: 4, textAlign: "right" },
  card: { backgroundColor: "#0F1526", borderRadius: 18, padding: 16, gap: 8, borderWidth: 1, borderColor: "#1E293B" },
  label: { color: "#CBD5E1", fontSize: 13, marginTop: 6, textAlign: "right" },
  draft: { gap: 6, borderTopWidth: 1, borderTopColor: "#1B2440", paddingTop: 10, marginTop: 4 },
  rowTop: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between" },
  chips: { flexDirection: "row-reverse", flexWrap: "wrap", gap: 6 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: "#141D33", borderWidth: 1, borderColor: "#1E293B" },
  chipActive: { backgroundColor: "#2A1F4D", borderColor: "#A78BFA" },
  chipText: { color: "#94A3B8", fontSize: 12 },
  chipTextActive: { color: "#E9D5FF", fontWeight: "700" },
  addRow: { flexDirection: "row-reverse", alignItems: "center", gap: 6, paddingVertical: 10 },
  addRowText: { color: "#A78BFA", fontSize: 13, fontWeight: "700" },
  input: {
    backgroundColor: "#111A2E",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#1E293B",
    color: "#F1F5F9",
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 15,
    textAlign: "left",
  },
  save: { backgroundColor: "#A78BFA", borderRadius: 12, paddingVertical: 14, alignItems: "center", marginTop: 14 },
  saveDisabled: { opacity: 0.6 },
  saveText: { color: "#0A0D1F", fontWeight: "800", fontSize: 15 },
  message: { color: "#E2E8F0", textAlign: "center", marginTop: 8 },
  result: { flexDirection: "row-reverse", alignItems: "center", gap: 8, borderRadius: 10, padding: 10, marginTop: 6 },
  resultOk: { backgroundColor: "rgba(74,222,128,0.08)" },
  resultFail: { backgroundColor: "rgba(248,113,113,0.08)" },
  resultText: { color: "#E2E8F0", fontSize: 13, flex: 1, textAlign: "right" },
  statsBox: { marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: "#101B33", gap: 4 },
  statsTitle: { color: "#E9D5FF", fontWeight: "800", fontSize: 13, textAlign: "right" },
  sectionTitle: {
    color: "#E7E9EE",
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 2,
  },
  statsLine: { color: "#94A3B8", fontSize: 12, textAlign: "right" },
  cacheButton: { marginTop: 8, borderRadius: 10, borderWidth: 1, borderColor: "#A78BFA", paddingVertical: 8, alignItems: "center" },
  cacheButtonText: { color: "#C4B5FD", fontSize: 12, fontWeight: "700" },
  hint: { color: "#64748B", fontSize: 12, textAlign: "right", lineHeight: 18 },
});
