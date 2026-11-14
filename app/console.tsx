import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { RecordingPresets, requestRecordingPermissionsAsync, useAudioRecorder, useAudioRecorderState } from "expo-audio";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";

// The promo site lives on its own static host; the editor is protected there.
const SITE_URL = (process.env.EXPO_PUBLIC_SITE_URL || "https://site-46a89efcae814916890b8988f2f1d0dd.freebuff.page").replace(/\/$/, "");
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { OWNER_AREAS, OwnerAreaTabs, OwnerSidebar, OwnerToolsPanel } from "@/components/owner-areas";
import { ScreenContainer } from "@/components/screen-container";
import { startOAuthLogin } from "@/constants/oauth";
import { sendOwnerOrder } from "@/lib/owner-order";
import { trimHistory } from "@/lib/chat-history";
import { recordingMimeType, recordingUriToBase64, speakArabic } from "@/lib/zenox-voice";
import { trpc } from "@/lib/trpc";

type OwnerMessage = { id: number; role: "assistant" | "user"; text: string };

const AREAS = OWNER_AREAS;


const suggestions = [
  "اعرض حالة الموقع والتطبيق",
  "راجع سياسة الاستخدام الحالية",
  "اعرض الأجهزة المرتبطة وموافقاتها",
  "اقترح تحسينًا لتجربة الأعضاء",
];

const DEVICE_CAPABILITIES = [
  { id: "device.info.read", label: "معلومات الجهاز" },
  { id: "files.read.selected", label: "قراءة ملفات محددة" },
  { id: "files.write.selected", label: "كتابة ملفات محددة" },
  { id: "apps.manage.allowed", label: "إدارة تطبيقات مسموحة" },
  { id: "settings.manage.allowed", label: "إعدادات مسموحة" },
  { id: "usb.session.allowed", label: "جلسة USB" },
] as const;

// Remembers that this device already unlocked the owner panel, so a left-open
// owner dashboard does not ask again until the owner presses «قفل».
const OWNER_UNLOCK_KEY = "zenox.owner.unlocked";

const SESSION_STATUS_LABELS: Record<string, string> = { pending: "بانتظار قبول الجهاز", active: "نشطة", revoked: "مسحوبة", expired: "منتهية" };

function sessionCapabilityCount(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

export default function OwnerScreen() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const isWide = width >= 980;
  const [draft, setDraft] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedArea, setSelectedArea] = useState<(typeof AREAS)[number]["id"]>("management");
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [report, setReport] = useState("لم يبدأ أي إجراء. اكتب أمرًا أو اختر اقتراحًا.");
  const [deviceId, setDeviceId] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [devicePlatform, setDevicePlatform] = useState("android");
  const [deviceMinutes, setDeviceMinutes] = useState("30");
  const [deviceCapabilities, setDeviceCapabilities] = useState<string[]>(["device.info.read"]);
  const [policyId, setPolicyId] = useState<number | undefined>();
  const [policyKey, setPolicyKey] = useState("");
  const [policyLabel, setPolicyLabel] = useState("");
  const [policyDescription, setPolicyDescription] = useState("");
  const [policyEnabled, setPolicyEnabled] = useState(true);
  const [rootRequestText, setRootRequestText] = useState("");
  const [shellCommand, setShellCommand] = useState("");
  const [termMode, setTermMode] = useState<"command" | "request">("command");
  const [termLog, setTermLog] = useState<{ id: number; kind: "cmd" | "out" | "err" | "meta" | "ask"; text: string }[]>([]);
  const [termCwd, setTermCwd] = useState("");
  const [termBusy, setTermBusy] = useState(false);
  const [termHistory, setTermHistory] = useState<string[]>([]);
  const [termHistoryIndex, setTermHistoryIndex] = useState(-1);
  const termLogRef = useRef<ScrollView>(null);
  const termAbortRef = useRef<AbortController | null>(null);
  const [ownerPassword, setOwnerPassword] = useState("");
  const [ownerPasswordConfirm, setOwnerPasswordConfirm] = useState("");
  const [ownerLoginMessage, setOwnerLoginMessage] = useState("");
  const [currentOwnerPassword, setCurrentOwnerPassword] = useState("");
  const [newOwnerPassword, setNewOwnerPassword] = useState("");
  const [newOwnerPasswordConfirm, setNewOwnerPasswordConfirm] = useState("");
  const [passwordChangeMessage, setPasswordChangeMessage] = useState("");
  const [connectionLabel, setConnectionLabel] = useState("");
  const [connectionKind, setConnectionKind] = useState("mysql");
  const [connectionHost, setConnectionHost] = useState("");
  const [connectionDatabase, setConnectionDatabase] = useState("");
  const [connectionUsername, setConnectionUsername] = useState("");
  const [connectionSecretRef, setConnectionSecretRef] = useState("");
  const [keyProvider, setKeyProvider] = useState("");
  const [keyLabel, setKeyLabel] = useState("");
  const [keySecretRef, setKeySecretRef] = useState("");
  const [keyScopes, setKeyScopes] = useState("");
  const [secretsPassword, setSecretsPassword] = useState("");
  const [secretsList, setSecretsList] = useState<{ name: string; value: string }[] | null>(null);
  const secretsOpenMutation = trpc.owner.secrets.open.useMutation();
  const [filePath, setFilePath] = useState("");
  const [fileSummary, setFileSummary] = useState("");
  const [filePatch, setFilePatch] = useState("");
  const [authTurns, setAuthTurns] = useState<{ id: number; role: "user" | "assistant"; text: string }[]>([]);
  const [ownerStreaming, setOwnerStreaming] = useState(false);
  const [toolResult, setToolResult] = useState<string>("اضغط أداة لتنفيذها فورًا — بلا نموذج ولا انتظار.");
  const [noticeText, setNoticeText] = useState("");
  const [noticeTone, setNoticeTone] = useState<"info" | "warning" | "danger">("warning");
  const [noticeAlarm, setNoticeAlarm] = useState(true);
  const [maintenanceText, setMaintenanceText] = useState("الموقع في صيانة قصيرة، نعود بعد قليل.");
  const [siteState, setSiteState] = useState<{ banner: { enabled: boolean; text: string; tone: string; alarm: boolean }; maintenance: { enabled: boolean; message: string } } | null>(null);
  const [promoJson, setPromoJson] = useState("");
  const [promoAdTitle, setPromoAdTitle] = useState("");
  const [promoAdBody, setPromoAdBody] = useState("");
  const [promoAdCta, setPromoAdCta] = useState("");
  const [promoAdUrl, setPromoAdUrl] = useState("");
  const [promoMsg, setPromoMsg] = useState("");
  const [siteEditorMsg, setSiteEditorMsg] = useState("");
  const [securityReport, setSecurityReport] = useState<{
    score: number;
    scannedFiles: number;
    checks: number;
    durationMs: number;
    findings: { id: string; severity: string; title: string; detail: string; file?: string; line?: number }[];
  } | null>(null);
  // The password is requested on every entry to the center, even with a live
  // session cookie: ZANOX opens the door, the password opens the panel.
  const [unlocked, setUnlocked] = useState(false);
  const [codeDepth, setCodeDepth] = useState(2);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [aiProvider, setAiProvider] = useState<"groq" | "gemini" | "openai" | "openrouter" | "zai">("groq");
  const [aiModel, setAiModel] = useState("");
  const [aiLabel, setAiLabel] = useState("");
  const [aiKey, setAiKey] = useState("");
  const [aiMessage, setAiMessage] = useState("");
  const [aiResults, setAiResults] = useState<{ id: number; label: string; ok: boolean; error: string }[]>([]);
  const [ownerDiagnosis, setOwnerDiagnosis] = useState("");
  const messagesScrollRef = useRef<ScrollView>(null);
  const chatMutation = trpc.chat.complete.useMutation();
  const ownerStatusQuery = trpc.owner.auth.status.useQuery();
  const ownerLoginMutation = trpc.owner.auth.login.useMutation();
  const ownerSetupMutation = trpc.owner.auth.setup.useMutation();
  const ownerChangePasswordMutation = trpc.owner.auth.change.useMutation();
  const ownerDiagnoseMutation = trpc.owner.auth.diagnose.useMutation();
  const ownerSetupMode = Boolean(ownerStatusQuery.data && !ownerStatusQuery.data.passwordConfigured);
  const ownerLogoutMutation = trpc.owner.auth.logout.useMutation();
  const ownerAuthPending = ownerLoginMutation.isPending || ownerSetupMutation.isPending;
  const isAuthenticatedOwner = Boolean(ownerStatusQuery.data?.authenticated);

  useEffect(() => {
    if (!isAuthenticatedOwner) return;
    void AsyncStorage.getItem(OWNER_UNLOCK_KEY).then((value) => {
      if (value === "1") setUnlocked(true);
    });
  }, [isAuthenticatedOwner]);
  const ownerSessionQuery = trpc.auth.me.useQuery();
  const googleStatusQuery = trpc.google.status.useQuery();
  const googleConfigureMutation = trpc.owner.google.configure.useMutation();
  const [googleClientId, setGoogleClientId] = useState("");
  const [googleClientSecret, setGoogleClientSecret] = useState("");
  const [googleConfigMessage, setGoogleConfigMessage] = useState("");
  const [showGoogleForm, setShowGoogleForm] = useState(false);
  const deviceControlAvailable = ownerSessionQuery.data?.role === "admin";
  const deviceSessionsQuery = trpc.devices.listSessions.useQuery(undefined, { enabled: deviceControlAvailable && selectedArea === "devices" });
  const policiesQuery = trpc.policies.list.useQuery(undefined, { enabled: deviceControlAvailable && selectedArea === "policy" });
  const savePolicyMutation = trpc.policies.save.useMutation();
  const removePolicyMutation = trpc.policies.remove.useMutation();
  const rootRequestsQuery = trpc.rootManager.list.useQuery(undefined, { enabled: deviceControlAvailable && selectedArea === "root" });
  const rootPlanMutation = trpc.rootManager.plan.useMutation();
  const rootApproveMutation = trpc.rootManager.approve.useMutation();
  const rootCancelMutation = trpc.rootManager.cancel.useMutation();
  const connectionsQuery = trpc.integrations.connections.list.useQuery(undefined, { enabled: deviceControlAvailable && selectedArea === "integrations" });
  const apiKeysQuery = trpc.integrations.apiKeys.list.useQuery(undefined, { enabled: deviceControlAvailable && selectedArea === "integrations" });
  const fileChangesQuery = trpc.integrations.fileChanges.list.useQuery(undefined, { enabled: deviceControlAvailable && selectedArea === "files" });
  const saveConnectionMutation = trpc.integrations.connections.save.useMutation();
  const testConnectionMutation = trpc.integrations.connections.test.useMutation();
  const removeConnectionMutation = trpc.integrations.connections.remove.useMutation();
  const registerKeyMutation = trpc.integrations.apiKeys.register.useMutation();
  const revokeKeyMutation = trpc.integrations.apiKeys.revoke.useMutation();
  const proposeFileMutation = trpc.integrations.fileChanges.propose.useMutation();
  const approveFileMutation = trpc.integrations.fileChanges.approve.useMutation();
  const applyFileMutation = trpc.integrations.fileChanges.applyPatch.useMutation();
  const shellMutation = trpc.owner.terminal.exec.useMutation();
  const securityMutation = trpc.owner.security.audit.useMutation();
  const siteSetMutation = trpc.owner.site.set.useMutation();
  const promoGetQuery = trpc.owner.promo.get.useQuery(undefined, { enabled: false });
  const promoAdminLinkQuery = trpc.owner.promo.adminLink.useQuery(undefined, { enabled: false });
  const promoSetMutation = trpc.owner.promo.set.useMutation();
  const promoAdAddMutation = trpc.owner.promo.ads.add.useMutation();
  const promoAdRemoveMutation = trpc.owner.promo.ads.remove.useMutation();
  const ownerToolsQuery = trpc.owner.tools.list.useQuery(undefined, { enabled: deviceControlAvailable });
  const runToolMutation = trpc.owner.tools.run.useMutation();
  const codeTreeQuery = trpc.owner.code.tree.useQuery({ depth: codeDepth }, { enabled: deviceControlAvailable && selectedArea === "code" });
  const aiQuery = trpc.owner.ai.list.useQuery(undefined, { enabled: deviceControlAvailable && selectedArea === "ai" });
  const addAiKeyMutation = trpc.owner.ai.add.useMutation();
  const removeAiKeyMutation = trpc.owner.ai.remove.useMutation();
  const testAiKeysMutation = trpc.owner.ai.test.useMutation();
  const codeFileQuery = trpc.owner.code.read.useQuery({ path: openFile ?? "" }, { enabled: Boolean(openFile) });

  // Uploaded files (the owner's and every user's) — the owner opens any of them.
  const uploadsQuery = trpc.owner.uploads.list.useQuery(undefined, {
    enabled: deviceControlAvailable && selectedArea === "files",
  });
  const saveFileMutation = trpc.owner.code.write.useMutation();
  const monitorQuery = trpc.owner.monitor.stats.useQuery(undefined, { enabled: deviceControlAvailable && selectedArea === "monitor", refetchInterval: 10_000 });
  const auditQuery = trpc.owner.monitor.audit.useQuery({ limit: 20 }, { enabled: deviceControlAvailable && selectedArea === "monitor", refetchInterval: 20_000 });
  const chatsQuery = trpc.owner.chats.list.useQuery({ limit: 30 }, { enabled: deviceControlAvailable && selectedArea === "chats", refetchInterval: 15_000 });
  const chatTotalsQuery = trpc.owner.chats.totals.useQuery(undefined, { enabled: deviceControlAvailable && selectedArea === "chats" });
  const memoryQuery = trpc.owner.memory.list.useQuery(undefined, { enabled: deviceControlAvailable && selectedArea === "memory" });
  const addMemoryMutation = trpc.owner.memory.add.useMutation();
  const deleteMemoryMutation = trpc.owner.memory.delete.useMutation();
  const [memoryDraft, setMemoryDraft] = useState("");
  const clearChatsMutation = trpc.owner.chats.clear.useMutation();
  const [openChat, setOpenChat] = useState<string | null>(null);
  const chatThreadQuery = trpc.owner.chats.messages.useQuery({ conversation: openChat ?? "", limit: 300 }, { enabled: Boolean(openChat) });

  // The Android app exposes window.ZenoxNative: it packs files on the phone itself
  // (so the real size is known while offline) and uploads them once online.
  const phoneTool = (globalThis as unknown as { ZenoxNative?: any }).ZenoxNative;
  const phoneToolReady = Boolean(phoneTool && typeof phoneTool.pickFiles === "function");
  const [packs, setPacks] = useState<Array<{ name: string; size: number; sizeText?: string; sent?: boolean }>>([]);
  const [packState, setPackState] = useState<{ online?: boolean; uploading?: boolean; totalBytes?: number }>({});

  useEffect(() => {
    if (!phoneToolReady) return;
    const w = globalThis as unknown as { zenoxNativeResult?: (event: string, payload: any) => void };
    w.zenoxNativeResult = (event: string, payload: any) => {
      if (event === "upload" && payload?.message) setReport(String(payload.message));
      if (event === "packs" && Array.isArray(payload)) setPacks(payload);
      try {
        const raw = phoneTool.state();
        const parsed = JSON.parse(raw) as { online?: boolean; uploading?: boolean; totalBytes?: number; packs?: any[] };
        setPackState({ online: parsed.online, uploading: parsed.uploading, totalBytes: parsed.totalBytes });
        if (Array.isArray(parsed.packs)) setPacks(parsed.packs);
      } catch {
        // The bridge answers a JSON string; a broken answer just leaves the list as is.
      }
    };
    try {
      w.zenoxNativeResult("packs", JSON.parse(phoneTool.listPacks() || "[]"));
      const parsed = JSON.parse(phoneTool.state() || "{}") as { online?: boolean; totalBytes?: number; packs?: any[] };
      setPackState({ online: parsed.online, totalBytes: parsed.totalBytes });
      if (Array.isArray(parsed.packs)) setPacks(parsed.packs);
    } catch {
      // Old app build without the tool: nothing to show.
    }
    return () => {
      try {
        delete w.zenoxNativeResult;
      } catch {
        // Ignore: the page is going away anyway.
      }
    };
  }, [phoneToolReady, phoneTool]);

  /** Picks files and stores them on the server (owner session only). */
  async function uploadFromPhone() {
    if (Platform.OS !== "web") {
      setReport("رفع الملفات متاح من متصفح الهاتف أو من تطبيق ZENOX.");
      return;
    }
    const doc = (globalThis as unknown as { document?: any }).document;
    if (!doc) return;
    const input = doc.createElement("input") as any;
    input.type = "file";
    input.multiple = true;
    input.onchange = async () => {
      const files: any[] = Array.from(input.files ?? []);
      if (!files.length) return;
      const done: string[] = [];
      for (const file of files) {
        try {
          setReport(`جارٍ رفع ${file.name} (${Math.max(1, Math.round(file.size / 1024))} كيلوبايت)…`);
          const response = await fetch(`/api/owner/upload?name=${encodeURIComponent(file.name)}`, {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: file,
            credentials: "include",
          });
          const data = (await response.json().catch(() => null)) as { ok?: boolean; path?: string; message?: string } | null;
          done.push(data?.ok ? String(data.path) : `${file.name}: ${data?.message ?? `فشل (${response.status})`}`);
        } catch {
          done.push(`${file.name}: تعذر الرفع.`);
        }
      }
      setReport(`رفعت ${done.filter((line) => line.startsWith("uploads/")).length} من ${files.length}:\n${done.join("\n")}`);
      void codeTreeQuery.refetch();
      void uploadsQuery.refetch();
    };
    input.click();
  }

  /** Opens one uploaded file in a tab (web) or the system viewer (app). */
  async function extractUpload(name: string) {
    setReport(`أفكّ ضغط ${name}…`);
    try {
      const response = await fetch("/api/owner/archive/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name }),
      });
      const result = (await response.json().catch(() => null)) as
        | { ok?: boolean; dir?: string; files?: string[]; skipped?: number; message?: string }
        | null;
      if (!response.ok || !result?.ok) throw new Error(result?.message ?? `تعذر فك الضغط (${response.status}).`);
      const files = result.files ?? [];
      setReport(`استُخرج ${name} (${result.dir})\n${files.slice(0, 12).join("\n")}${files.length > 12 ? `\n… و${files.length - 12} ملفًا آخر` : ""}${result.skipped ? `\nتجاهلت ${result.skipped} عنصرًا.` : ""}`);
    } catch (error) {
      setReport(error instanceof Error ? error.message : "تعذر فك الضغط.");
    }
  }

  async function openSealedSecrets() {
    try {
      const result = await secretsOpenMutation.mutateAsync({ password: secretsPassword });
      setSecretsList(result.secrets);
      setReport(`فُتح ملف الأسرار: ${result.secrets.length} متغيرًا. لا تُشارك هذه القيم في محادثة أو لقطة شاشة.`);
    } catch (error) {
      setSecretsList(null);
      setReport(error instanceof Error ? error.message : "تعذر فتح ملف الأسرار.");
    }
  }

  function openUpload(name: string) {
    const url = `/api/owner/file?name=${encodeURIComponent(name)}`;
    if (Platform.OS === "web") {
      (globalThis as unknown as { open?: (link: string, target?: string) => unknown }).open?.(url, "_blank");
      setReport(`فُتح ${name} في تبويب جديد.`);
      return;
    }
    void Linking.openURL(url);
  }

  const [fileDraft, setFileDraft] = useState<string | null>(null);
  const [fileNote, setFileNote] = useState<string | null>(null);

  async function saveOpenFile() {
    if (!openFile || fileDraft === null) return;
    try {
      const saved = await saveFileMutation.mutateAsync({ path: openFile, content: fileDraft });
      setFileNote(saved.backup ? `حُفظ الملف. نسخة سابقة محفوظة في ${saved.backup}` : "حُفظ الملف الجديد.");
      await codeFileQuery.refetch();
      void auditQuery.refetch();
    } catch (error) {
      setFileNote(error instanceof Error ? error.message : "تعذر حفظ الملف.");
    }
  }
  type CodeEntry = NonNullable<typeof codeTreeQuery.data>["entries"][number];

  function renderCodeEntry(entry: CodeEntry, level: number) {
    return (
      <View key={entry.path}>
        <Pressable disabled={entry.type === "dir"} onPress={() => setOpenFile(entry.path)} style={[styles.treeRow, { marginRight: level * 12 }]}>
          <Ionicons name={entry.type === "dir" ? "folder-outline" : "document-text-outline"} size={14} color={entry.type === "dir" ? "#FBBF24" : "#94A3B8"} />
          <Text style={styles.treeName} numberOfLines={1}>{entry.name}</Text>
          {entry.type === "file" ? <Text style={styles.treeSize}>{Math.max(1, Math.round(entry.size / 1024))}K</Text> : null}
        </Pressable>
        {entry.children?.map((child) => renderCodeEntry(child, level + 1))}
      </View>
    );
  }
  const cancelFileMutation = trpc.integrations.fileChanges.cancel.useMutation();
  const requestDeviceSessionMutation = trpc.devices.requestSession.useMutation();
  const revokeDeviceSessionMutation = trpc.devices.revokeSession.useMutation();
  const transcribeMutation = trpc.speech.transcribe.useMutation();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 250);
  const [messages, setMessages] = useState<OwnerMessage[]>([
    { id: 1, role: "assistant", text: "أهلًا بك في ZENOX. هذه مساحة أوامر ZENOX لإدارة المنصة والموقع والسياسات." },
  ]);

  async function signInOwner() {
    setReport("سيتم فتح تسجيل الدخول الآمن. بعد العودة اكتب ZENOX مرة أخرى لفتح المركز.");
    await startOAuthLogin();
  }

  function selectArea(id: (typeof AREAS)[number]["id"]) {
    setSelectedArea(id);
    setSidebarOpen(false);
  }

  function toggleDeviceCapability(capability: string) {
    setDeviceCapabilities((current) => current.includes(capability) ? current.filter((item) => item !== capability) : [...current, capability]);
  }

  function editPolicy(policy: { id: number; policyKey: string; label: string; description: string; enabled: number }) {
    setPolicyId(policy.id);
    setPolicyKey(policy.policyKey);
    setPolicyLabel(policy.label);
    setPolicyDescription(policy.description);
    setPolicyEnabled(Boolean(policy.enabled));
  }

  function clearPolicyEditor() {
    setPolicyId(undefined);
    setPolicyKey("");
    setPolicyLabel("");
    setPolicyDescription("");
    setPolicyEnabled(true);
  }

  async function savePolicy() {
    if (!deviceControlAvailable) {
      setReport("إدارة الصلاحيات تحتاج مصادقة ZENOX على الخادم.");
      return;
    }
    try {
      await savePolicyMutation.mutateAsync({ id: policyId, policyKey: policyKey.trim(), label: policyLabel.trim(), description: policyDescription.trim(), enabled: policyEnabled });
      clearPolicyEditor();
      await policiesQuery.refetch();
      setReport("تم حفظ الصلاحية في قاعدة البيانات.");
    } catch {
      setReport("تعذر حفظ الصلاحية. تحقق من الحقول ومصادقة ZENOX.");
    }
  }

  async function removePolicy(id: number) {
    try {
      await removePolicyMutation.mutateAsync({ id });
      await policiesQuery.refetch();
      if (policyId === id) clearPolicyEditor();
      setReport("تم حذف الصلاحية من قاعدة البيانات.");
    } catch {
      setReport("تعذر حذف الصلاحية.");
    }
  }

  async function createRootPlan() {
    if (!deviceControlAvailable) {
      setReport("Root Manager يحتاج مصادقة ZENOX على الخادم.");
      return;
    }
    if (!rootRequestText.trim()) return;
    try {
      await rootPlanMutation.mutateAsync({ requestText: rootRequestText.trim() });
      setRootRequestText("");
      await rootRequestsQuery.refetch();
      setReport("تم إنشاء خطة التغيير للمراجعة. لم يتم تعديل أو نشر أي ملف.");
    } catch {
      setReport("تعذر إنشاء خطة Root Manager. لم يتم تنفيذ أي تغيير.");
    }
  }

  async function approveRootPlan(id: number) {
    try {
      await rootApproveMutation.mutateAsync({ id });
      await rootRequestsQuery.refetch();
      setReport("تم اعتماد الخطة. نفّذ خطواتها من قسم Terminal.");
    } catch {
      setReport("تعذر اعتماد خطة Root Manager.");
    }
  }

  async function cancelRootPlan(id: number) {
    try {
      await rootCancelMutation.mutateAsync({ id });
      await rootRequestsQuery.refetch();
      setReport("تم إلغاء خطة Root Manager.");
    } catch {
      setReport("تعذر إلغاء الخطة.");
    }
  }

  async function saveConnection() {
    if (!deviceControlAvailable) return setReport("إدارة الاتصالات تحتاج مصادقة ZENOX على الخادم.");
    try {
      await saveConnectionMutation.mutateAsync({ label: connectionLabel.trim(), kind: connectionKind as "mysql" | "postgres" | "supabase" | "rest_api", host: connectionHost.trim(), databaseName: connectionDatabase.trim() || undefined, username: connectionUsername.trim() || undefined, secretRef: connectionSecretRef.trim(), sslRequired: true, enabled: true });
      await connectionsQuery.refetch();
      setConnectionLabel(""); setConnectionHost(""); setConnectionDatabase(""); setConnectionUsername(""); setConnectionSecretRef("");
      setReport("تم حفظ تعريف الاتصال ومرجع السر فقط. لم تُحفظ كلمة المرور أو DSN.");
    } catch { setReport("تعذر حفظ الاتصال. راجع الحقول ومرجع السر."); }
  }

  async function testConnection(id: number) {
    if (!deviceControlAvailable) return setReport("اختبار الاتصال يحتاج مصادقة ZENOX على الخادم.");
    try {
      const result = await testConnectionMutation.mutateAsync({ id });
      setReport(result.reachable ? `نجح اتصال ${result.kind} خلال ${result.latencyMs}ms. لم يتم عرض أو حفظ السر.` : `فشل اتصال ${result.kind}: ${result.message}`);
    } catch {
      setReport("تعذر اختبار الاتصال. تحقق من وجود السر على الخادم ومن إعدادات TLS.");
    }
  }

  async function registerApiKey() {
    if (!deviceControlAvailable) return setReport("إدارة المفاتيح تحتاج مصادقة ZENOX على الخادم.");
    try {
      await registerKeyMutation.mutateAsync({ provider: keyProvider.trim(), label: keyLabel.trim(), secretRef: keySecretRef.trim(), scopes: keyScopes.split(",").map((item) => item.trim()).filter(Boolean) });
      await apiKeysQuery.refetch();
      setKeyProvider(""); setKeyLabel(""); setKeySecretRef(""); setKeyScopes("");
      setReport("تم تسجيل مرجع API Key دون استقبال أو عرض قيمة المفتاح.");
    } catch { setReport("تعذر تسجيل مرجع API Key. لا تضع المفتاح نفسه هنا."); }
  }

  async function proposeFileChange() {
    if (!deviceControlAvailable) return setReport("تعديل الملفات يحتاج مصادقة ZENOX على الخادم.");
    try {
      await proposeFileMutation.mutateAsync({ filePath: filePath.trim(), summary: fileSummary.trim(), patch: filePatch, risk: "medium" });
      await fileChangesQuery.refetch();
      setFilePath(""); setFileSummary(""); setFilePatch("");
      setReport("تم حفظ Patch للمراجعة. لم يتم تعديل الملف مباشرة.");
    } catch { setReport("تعذر حفظ Patch. تحقق من المسار ومن اتصال قاعدة البيانات."); }
  }

  async function approveFileChange(id: number) {
    try { await approveFileMutation.mutateAsync({ id }); await fileChangesQuery.refetch(); setReport("تم اعتماد Patch. استخدم «تطبيق مباشر» لتنفيذه."); } catch { setReport("تعذر اعتماد Patch."); }
  }

  async function applyFileChange(id: number) {
    try {
      const result = await applyFileMutation.mutateAsync({ id });
      await fileChangesQuery.refetch();
      setReport(result.applied ? "تم تطبيق التعديل على الملفات." : `فشل التطبيق (exit ${result.code}): ${result.stderr || result.stdout || "راجع سجل التدقيق"}`);
    } catch (error) {
      setReport(error instanceof Error ? `فشل تطبيق Patch: ${error.message}` : "فشل تطبيق Patch.");
    }
  }

  async function cancelFileChange(id: number) {
    try { await cancelFileMutation.mutateAsync({ id }); await fileChangesQuery.refetch(); setReport("تم إلغاء Patch."); } catch { setReport("تعذر إلغاء Patch."); }
  }

  async function requestDeviceSession() {
    if (!deviceControlAvailable) {
      setReport("التحكم بالأجهزة يحتاج جلسة ZENOX مصادقًا عليها. وضع ZENOX المفتوح يعرض القسم فقط ولا ينفذ طلبات أجهزة.");
      return;
    }
    if (!deviceId.trim() || !deviceName.trim() || deviceCapabilities.length === 0) {
      setReport("أدخل معرف الجهاز واسمه واختر صلاحية واحدة على الأقل.");
      return;
    }
    try {
      const result = await requestDeviceSessionMutation.mutateAsync({
        deviceId: deviceId.trim(),
        deviceName: deviceName.trim(),
        platform: devicePlatform.trim() || "unknown",
        capabilities: deviceCapabilities as (typeof DEVICE_CAPABILITIES)[number]["id"][],
        expiresInMinutes: Math.max(1, Number(deviceMinutes) || 30),
      });
      setReport(`تم إنشاء طلب موافقة للجهاز. رمز التسليم: ${result.consentToken} — يجب إدخاله في الجهاز نفسه لقبول الجلسة.`);
      setMessages((current) => [...current, { id: Date.now(), role: "assistant", text: `طلب جلسة للجهاز «${deviceName}» جاهز. لا تصبح الجلسة نشطة إلا بعد قبول الجهاز.` }]);
      void deviceSessionsQuery.refetch();
    } catch {
      setReport("تعذر إنشاء طلب جلسة الجهاز. تأكد من مصادقة ZENOX واتصال قاعدة البيانات.");
    }
  }

  async function revokeDeviceSession(sessionId: string) {
    try {
      await revokeDeviceSessionMutation.mutateAsync({ sessionId });
      setReport("تم سحب جلسة الجهاز. لن تُقبل أفعال جديدة لهذا الجهاز.");
      void deviceSessionsQuery.refetch();
    } catch {
      setReport("تعذر سحب جلسة الجهاز. تحقق من جلسة ZENOX واتصال الخادم.");
    }
  }

  async function sendMessage(valueOverride?: string, readAloud = false) {
    const value = (valueOverride ?? draft).trim();
    if (!value || ownerStreaming) return;
    const userMessage: OwnerMessage = { id: Date.now(), role: "user", text: value };
    const nextMessages = [...messages, userMessage];
    const assistantId = Date.now() + 1;
    setMessages([...nextMessages, { id: assistantId, role: "assistant", text: "" }]);
    setDraft("");
    setOwnerStreaming(true);
    const applied: { summary?: string }[] = [];
    let answer = "";
    try {
      const response = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          mode: `owner-${selectedArea}`,
          audience: "owner",
          messages: trimHistory(nextMessages).map(({ role, text: content }) => ({ role, content })),
        }),
      });
      if (!response.ok || !response.body) {
        const detail = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
        throw new Error(detail?.message ?? detail?.error ?? `تعذر بدء المحادثة (${response.status}).`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamError = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((entry) => entry.startsWith("data:"));
          if (!line) continue;
          try {
            const parsed = JSON.parse(line.slice(5).trim()) as {
              delta?: string;
              error?: string;
              step?: { summary?: string };
            };
            if (parsed.error) streamError = parsed.error;
            if (parsed.step) applied.push(parsed.step);
            if (parsed.delta) {
              answer += parsed.delta;
              const shown = answer;
              setMessages((current) => current.map((item) => (item.id === assistantId ? { ...item, text: shown } : item)));
            }
          } catch {
            // keep-alive or a partial frame
          }
        }
      }
      if (streamError && !answer.trim()) throw new Error(streamError);
      const summaryText = applied.length
        ? `${answer}\n\nما نُفّذ:\n${applied.map((step) => `• ${step.summary ?? ""}`).join("\n")}`
        : answer;
      setMessages((current) => current.map((item) => (item.id === assistantId ? { ...item, text: summaryText } : item)));
      setReport(
        applied.length
          ? `نُفّذ ${applied.length} إجراءً بصلاحيات ZENOX في قسم «${AREAS.find((area) => area.id === selectedArea)?.label ?? "المنصة"}».`
          : `تمت معالجة الأمر في قسم «${AREAS.find((area) => area.id === selectedArea)?.label ?? "المنصة"}».`,
      );
      if (applied.length) {
        void codeTreeQuery.refetch();
        void aiQuery.refetch();
        void monitorQuery.refetch();
        void fileChangesQuery.refetch();
        void chatsQuery.refetch();
        void deviceSessionsQuery.refetch();
      }
      if (readAloud) await speakArabic(summaryText);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "سبب غير معروف";
      setMessages((current) => [
        ...current.filter((item) => item.id !== assistantId || item.text.trim().length > 0),
        { id: Date.now() + 2, role: "assistant", text: `تعذر تنفيذ الأمر: ${reason}` },
      ]);
      setReport("فشلت معالجة الأمر؛ لم يتم تنفيذ أي تغيير.");
    } finally {
      setOwnerStreaming(false);
    }
  }

  async function addAiKey() {
    const key = aiKey.trim();
    if (!key) {
      setAiMessage("الصق المفتاح في الخانة السرية أولًا.");
      return;
    }
    setAiMessage("جارٍ الحفظ واختبار المفتاح…");
    try {
      const result = await addAiKeyMutation.mutateAsync({
        label: aiLabel.trim() || aiProvider,
        provider: aiProvider,
        model: aiModel.trim() || undefined,
        apiKey: key,
      });
      setAiKey("");
      setAiMessage(result.ok ? "المفتاح يعمل وحُفظ في قاعدة البيانات. الذكاء الاصطناعي مفعّل الآن." : `حُفظ المفتاح لكن الاختبار فشل: ${result.error}`);
      await aiQuery.refetch();
    } catch (error) {
      setAiMessage(error instanceof Error ? error.message : "تعذر حفظ المفتاح.");
    }
  }

  async function testAiKeys() {
    setAiMessage("جارٍ اختبار كل المفاتيح…");
    try {
      const results = await testAiKeysMutation.mutateAsync();
      setAiResults(results);
      const ok = results.filter((item) => item.ok).length;
      setAiMessage(`${ok}/${results.length} مفتاح يعمل.`);
      await aiQuery.refetch();
    } catch (error) {
      setAiMessage(error instanceof Error ? error.message : "تعذر اختبار المفاتيح.");
    }
  }

  async function signInWithPassword() {
    if (!ownerPassword) return;
    const isSetup = ownerSetupMode;
    const maskedUserTurn = { id: Date.now(), role: "user" as const, text: "•••••••• (خانة سرية)" };
    try {
      if (isSetup) {
        if (ownerPassword !== ownerPasswordConfirm) {
          setOwnerLoginMessage("كلمتا المرور غير متطابقتين.");
          setAuthTurns((current) => [...current, maskedUserTurn, { id: Date.now() + 1, role: "assistant", text: "كلمتا المرور غير متطابقتين. أعد الإرسال من الخانة السرية." }]);
          return;
        }
        const created = await ownerSetupMutation.mutateAsync({ password: ownerPassword });
        setOwnerPasswordConfirm("");
        setOwnerLoginMessage("أُنشئت كلمة مرور ZENOX وفُتحت الجلسة.");
        setAuthTurns((current) => [...current, maskedUserTurn, { id: Date.now() + 1, role: "assistant", text: `تم تثبيت كلمة المرور كتجزئة scrypt في ${created.storage === "database" ? "قاعدة البيانات" : "ملف محلي بصلاحية 600"}. المركز مفتوح الآن: SHELL وكود البنية تحت أمرك.` }]);
      } else {
        await ownerLoginMutation.mutateAsync({ password: ownerPassword });
        setOwnerLoginMessage("تم فتح جلسة ZENOX.");
        setAuthTurns((current) => [...current, maskedUserTurn, { id: Date.now() + 1, role: "assistant", text: "تم التحقق من كلمة المرور مقابل التجزئة المحفوظة في قاعدة البيانات. المركز مفتوح: SHELL وكود البنية تحت أمرك." }]);
      }
      setOwnerPassword("");
      setUnlocked(true);
      void AsyncStorage.setItem(OWNER_UNLOCK_KEY, "1");
      await ownerStatusQuery.refetch();
      // The owner session changes auth.me from null to admin; without this the
      // Terminal and code sections stay gated after a successful login.
      await ownerSessionQuery.refetch();
    } catch (error) {
      const text = error instanceof Error ? error.message : "تعذر تسجيل الدخول.";
      setOwnerLoginMessage(text);
      setAuthTurns((current) => [...current, maskedUserTurn, { id: Date.now() + 1, role: "assistant", text }]);
    }
  }

  async function changeOwnerPassword() {
    setPasswordChangeMessage("");
    if (!currentOwnerPassword || !newOwnerPassword) {
      setPasswordChangeMessage("أدخل كلمة المرور الحالية والجديدة.");
      return;
    }
    if (newOwnerPassword !== newOwnerPasswordConfirm) {
      setPasswordChangeMessage("كلمتا المرور الجديدتان غير متطابقتين.");
      return;
    }
    if (newOwnerPassword.length < 10) {
      setPasswordChangeMessage("كلمة المرور الجديدة يجب أن تكون 10 أحرف على الأقل.");
      return;
    }
    try {
      const result = await ownerChangePasswordMutation.mutateAsync({
        currentPassword: currentOwnerPassword,
        newPassword: newOwnerPassword,
      });
      setCurrentOwnerPassword("");
      setNewOwnerPassword("");
      setNewOwnerPasswordConfirm("");
      setPasswordChangeMessage(
        `تم تغيير كلمة المرور وحفظ التجزئة الجديدة في ${result.storage === "database" ? "قاعدة البيانات" : "ملف محلي بصلاحية 600"}. استخدم الجديدة في الدخول القادم.`,
      );
    } catch (error) {
      setPasswordChangeMessage(error instanceof Error ? error.message : "تعذر تغيير كلمة المرور.");
    }
  }

  function connectGoogleFromOwner() {
    if (Platform.OS !== "web") return;
    window.location.assign(`/api/google/start?return=${encodeURIComponent("/console")}`);
  }

  async function importGoogleOAuthJson() {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text()) as {
          web?: { client_id?: string; client_secret?: string };
          installed?: { client_id?: string; client_secret?: string };
        };
        const clientId = parsed.web?.client_id || parsed.installed?.client_id || "";
        const clientSecret = parsed.web?.client_secret || parsed.installed?.client_secret || "";
        if (!clientId || !clientSecret) throw new Error("الملف لا يحتوي بيانات OAuth من نوع Web application.");
        setGoogleClientId(clientId);
        setGoogleClientSecret(clientSecret);
        setGoogleConfigMessage("قُرئ الملف. اضغط «حفظ المفاتيح وتفعيل الربط» لتشفيره على الخادم.");
      } catch (error) {
        setGoogleConfigMessage(error instanceof Error ? error.message : "تعذر قراءة ملف JSON.");
      }
    };
    input.click();
  }

  async function saveGoogleOAuthCredentials() {
    setGoogleConfigMessage("");
    try {
      await googleConfigureMutation.mutateAsync({ clientId: googleClientId, clientSecret: googleClientSecret });
      setGoogleClientId("");
      setGoogleClientSecret("");
      setShowGoogleForm(false);
      setGoogleConfigMessage("حُفظت بيانات OAuth مشفّرة على الخادم. اضغط «ربط Gmail وDrive الآن».");
      await googleStatusQuery.refetch();
    } catch (error) {
      setGoogleConfigMessage(error instanceof Error ? error.message : "تعذر حفظ بيانات OAuth.");
    }
  }

  async function diagnoseOwnerGate() {
    setOwnerDiagnosis("");
    try {
      const result = await ownerDiagnoseMutation.mutateAsync({ reason: ownerLoginMessage || "فشل دخول ZENOX" });
      setOwnerDiagnosis(result.diagnosis);
    } catch (error) {
      setOwnerDiagnosis(error instanceof Error ? error.message : "تعذر تشغيل التشخيص الذكي.");
    }
  }

  function appendTermLine(kind: "cmd" | "out" | "err" | "meta" | "ask", text: string) {
    if (!text) return;
    setTermLog((current) => [...current, { id: Date.now() + Math.random(), kind, text }].slice(-500));
  }

  /** One live shell session: chunks are appended as the command prints them. */
  async function runTerminal() {
    const command = shellCommand.trim();
    if (!command || termBusy) return;
    setShellCommand("");
    setTermHistory((current) => [...current.slice(-50), command]);
    setTermHistoryIndex(-1);
    if (termMode === "request") {
      await askTerminal(command);
      return;
    }
    appendTermLine("cmd", `$ ${command}`);
    setTermBusy(true);
    try {
      const controller = new AbortController();
      termAbortRef.current = controller;
      const response = await fetch("/api/owner/terminal/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ command }),
        signal: controller.signal,
      });
      // A native build without streaming support falls back to the one-shot call.
      if (!response.ok || !response.body) {
        const result = await shellMutation.mutateAsync({ command });
        appendTermLine("out", result.stdout);
        appendTermLine("err", result.stderr);
        appendTermLine("meta", `[exit ${result.code} · ${result.durationMs}ms]`);
        setTermCwd(result.cwd);
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.split("\n").find((row) => row.startsWith("data:"));
          if (!line) continue;
          try {
            const event = JSON.parse(line.slice(5).trim()) as {
              type?: string;
              stream?: string;
              text?: string;
              code?: number | null;
              cwd?: string;
              durationMs?: number;
              message?: string;
            };
            if (event.type === "chunk") appendTermLine(event.stream === "stderr" ? "err" : "out", event.text ?? "");
            if (event.type === "error") appendTermLine("err", event.message ?? "خطأ");
            if (event.type === "exit") {
              if (event.cwd) setTermCwd(event.cwd);
              appendTermLine("meta", `[exit ${event.code} · ${event.durationMs}ms]`);
            }
          } catch {
            // Keep-alive comment or a partial frame: ignore and keep reading.
          }
        }
      }
    } catch (error) {
      appendTermLine("err", error instanceof Error && error.name !== "AbortError" ? error.message : "أُوقف الأمر.");
    } finally {
      setTermBusy(false);
      termAbortRef.current = null;
    }
  }

  async function runSecurityScan() {
    try {
      const report = await securityMutation.mutateAsync();
      setSecurityReport(report as typeof securityReport);
      setReport(`فحص أمني: ${report.score}/100 · ${report.findings.length} ملاحظة.`);
    } catch (error) {
      setReport(error instanceof Error ? `تعذر الفحص: ${error.message}` : "تعذر إجراء الفحص الأمني.");
    }
  }

  /** Arabic request → the owner agent writes the command/patch and runs it. */
  /** Order → the console applies it (banner, maintenance) or runs a command now. */
  /** Order → the console applies it, with an id and automatic retries on a drop. */
  async function askTerminal(request: string) {
    setTermBusy(true);
    const result = await sendOwnerOrder(request, {
      onAsk: (text) => appendTermLine("ask", `◆ ${text}`),
      onPlan: (event) => {
        if (event.kind === "command" && event.command) appendTermLine("cmd", `$ ${event.command}`);
        if (event.kind === "site" || event.kind === "tool") {
          appendTermLine("meta", `• ${event.summary ?? "طُبّق على المنصة"}`);
        }
      },
      onOutput: (stream, text) => appendTermLine(stream === "stderr" ? "err" : "out", text),
      onResult: (summary, cached) => appendTermLine("meta", `• ${summary}${cached ? " (لم يُعَد التنفيذ)" : ""}`),
      onRetry: (attempt, reason) => appendTermLine("err", `انقطع: ${reason} — إعادة المحاولة ${attempt}/3`),
      onError: (message) => appendTermLine("err", message),
    });
    if (result.ok) void codeTreeQuery.refetch();
    setTermBusy(false);
  }

  async function runTool(name: string, args?: Record<string, unknown>) {
    setToolResult(`جارٍ تنفيذ ${name}…`);
    try {
      const result = await runToolMutation.mutateAsync({ name, args });
      setToolResult(`${result.ok ? "✓" : "✕"} ${result.summary} (${result.ms}ms)`);
      void codeTreeQuery.refetch();
    } catch (error) {
      setToolResult(error instanceof Error ? `تعذر التنفيذ: ${error.message}` : "تعذر التنفيذ.");
    }
  }

  async function applyBanner(enabled: boolean) {
    try {
      const next = await siteSetMutation.mutateAsync({
        bannerEnabled: enabled,
        bannerText: noticeText,
        bannerTone: noticeTone,
        bannerAlarm: noticeAlarm,
      });
      setSiteState(next as typeof siteState);
      setReport(enabled ? "ظهر شريط الإعلان على المنصة الآن." : "أُخفي شريط الإعلان.");
    } catch (error) {
      setReport(error instanceof Error ? `تعذر التطبيق: ${error.message}` : "تعذر تطبيق الإعلان.");
    }
  }

  async function toggleMaintenance(enabled: boolean) {
    try {
      const next = await siteSetMutation.mutateAsync({ maintenance: enabled, maintenanceMessage: maintenanceText });
      setSiteState(next as typeof siteState);
      setReport(enabled ? "وضع الصيانة مفعّل للمستخدمين." : "أُوقف وضع الصيانة.");
    } catch (error) {
      setReport(error instanceof Error ? `تعذر التبديل: ${error.message}` : "تعذر تبديل وضع الصيانة.");
    }
  }

  async function stopTerminal() {
    try {
      termAbortRef.current?.abort();
      await fetch("/api/owner/terminal/stop", { method: "POST", credentials: "include" });
      appendTermLine("meta", "[أُوقف]");
    } catch {
      appendTermLine("err", "تعذر إيقاف الأمر.");
    } finally {
      setTermBusy(false);
    }
  }

  useEffect(() => {
    if (selectedArea !== "terminal" || !deviceControlAvailable) return;
    void fetch("/api/owner/terminal/state", { credentials: "include" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { cwd?: string } | null) => {
        if (data?.cwd) setTermCwd(data.cwd);
      })
      .catch(() => undefined);
  }, [selectedArea, deviceControlAvailable]);

  async function toggleVoice() {
    if (voiceBusy) return;
    if (recorderState.isRecording) {
      setVoiceBusy(true);
      try {
        await recorder.stop();
        if (!recorder.uri) throw new Error("لم يتم حفظ التسجيل");
        const audioBase64 = await recordingUriToBase64(recorder.uri);
        const result = await transcribeMutation.mutateAsync({ audioBase64, mimeType: recordingMimeType() });
        await sendMessage(result.text, true);
      } catch (error) {
        setMessages((current) => [...current, { id: Date.now() + 1, role: "assistant", text: error instanceof Error ? error.message : "تعذر فهم التسجيل الصوتي الآن." }]);
      } finally {
        setVoiceBusy(false);
      }
      return;
    }

    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      setMessages((current) => [...current, { id: Date.now() + 1, role: "assistant", text: "اسمح لـ ZENOX باستخدام الميكروفون من إعدادات الجهاز لبدء جلسة الأوامر الصوتية." }]);
      return;
    }
    try {
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch {
      setMessages((current) => [...current, { id: Date.now() + 1, role: "assistant", text: "تعذر تشغيل الميكروفون في هذه اللحظة." }]);
    }
  }

  return (
    <ScreenContainer style={styles.screen}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={[styles.container, isWide && styles.containerWide, { paddingTop: Math.max(insets.top, 18) }]}>
          <View style={styles.topbar}>
            <Pressable onPress={() => router.back()} style={styles.back}><Ionicons name="arrow-forward" size={21} color="#CBD5E1" /></Pressable>
            <View style={styles.ownerTag}><View style={styles.ownerDot} /><Text style={styles.ownerTagText}>ZENOX COMMAND CENTER</Text></View>
            <View style={styles.topbarActions}>
              {unlocked && !isWide ? (
                <Pressable accessibilityRole="button" accessibilityLabel="فتح القائمة الجانبية" testID="owner-sidebar-open" onPress={() => setSidebarOpen(true)} style={styles.menuButton}>
                  <Ionicons name="menu-outline" size={19} color="#CBD5E1" />
                </Pressable>
              ) : null}
              {unlocked ? (
                <Pressable
                  onPress={async () => {
                    await ownerLogoutMutation.mutateAsync().catch(() => undefined);
                    void AsyncStorage.removeItem(OWNER_UNLOCK_KEY);
                    setUnlocked(false);
                    setAuthTurns([]);
                    setOwnerLoginMessage("قُفل المركز. أدخل كلمة المرور لفتحه من جديد.");
                    await ownerStatusQuery.refetch();
                  }}
                  style={styles.lockButton}
                >
                  <Ionicons name="lock-closed" size={16} color="#FDE68A" />
                  <Text style={styles.lockText}>قفل</Text>
                </Pressable>
              ) : (
                <View style={styles.brandMark}><Text style={styles.brandMarkText}>Z</Text></View>
              )}
            </View>
          </View>

          {!unlocked ? (
            <ScrollView contentContainerStyle={styles.loginContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <View style={styles.hero}><View style={styles.ownerAvatar}><Text style={styles.ownerAvatarText}>Z</Text></View><Text style={styles.kicker}>ZENOX</Text><Text style={styles.title}>دخول محمي</Text><Text style={styles.subtitle}>أدخل كلمة المرور للمتابعة.</Text></View>
              <View style={styles.loginCard}>
                <View style={styles.cardHeader}><View style={styles.miniAvatar}><Text style={styles.miniAvatarText}>Z</Text></View><Text style={styles.cardTitle}>تأمين المركز</Text></View>
                <View style={styles.authThread}>
                  <View style={[styles.messageRow, styles.assistantRow]}><View style={styles.miniAvatar}><Text style={styles.miniAvatarText}>Z</Text></View><View style={[styles.bubble, styles.assistantBubble]}><Text style={styles.messageText}>{ownerSetupMode ? "هذه أول مرة. اكتب كلمة مرور قوية مرة واحدة في الخانة السرية أدناه، وستُحفظ كتجزئة scrypt على الخادم ولا يمكن استرجاع نصها." : "أدخل كلمة المرور في الخانة السرية أدناه للتحقق منها على الخادم."}</Text></View></View>
                  {authTurns.map((turn) => <View key={turn.id} style={[styles.messageRow, turn.role === "user" && styles.userRow]}>{turn.role === "assistant" && <View style={styles.miniAvatar}><Text style={styles.miniAvatarText}>Z</Text></View>}<View style={[styles.bubble, turn.role === "user" ? styles.userBubble : styles.assistantBubble]}><Text style={[styles.messageText, turn.role === "user" && styles.userMessageText]}>{turn.text}</Text></View></View>)}
                </View>
                <View style={styles.secretLabel}><Ionicons name="lock-closed-outline" size={13} color="#C4B5FD" /><Text style={styles.secretLabelText}>خانة سرية — لا تظهر على الشاشة ولا تُسجَّل في السجل</Text></View>
                <TextInput value={ownerPassword} onChangeText={(value) => { setOwnerPassword(value); setOwnerLoginMessage(""); }} placeholder="كلمة مرور ZENOX" placeholderTextColor="#64748B" secureTextEntry style={styles.input} textAlign="right" onSubmitEditing={() => void signInWithPassword()} />
                {ownerSetupMode ? <TextInput value={ownerPasswordConfirm} onChangeText={setOwnerPasswordConfirm} placeholder="تأكيد كلمة المرور" placeholderTextColor="#64748B" secureTextEntry style={styles.input} textAlign="right" onSubmitEditing={() => void signInWithPassword()} /> : null}
                <Pressable disabled={ownerAuthPending || !ownerPassword} style={[styles.primaryButton, (ownerAuthPending || !ownerPassword) && styles.disabled]} onPress={() => void signInWithPassword()}><Ionicons name="lock-closed-outline" size={16} color="#0A0D1F" /><Text style={styles.primaryText}>{ownerAuthPending ? "جارٍ…" : ownerSetupMode ? "حفظ كلمة المرور وفتح المركز" : "فتح مركز ZENOX"}</Text><Ionicons name="arrow-back" size={17} color="#0A0D1F" /></Pressable>
                <Text style={styles.helper}>{ownerLoginMessage || (ownerSetupMode ? "أول تشغيل: تُحفظ تجزئة scrypt في بوابة ZENOX المستقلة، ولا يُحفظ النص أبدًا." : "التحقق يحدث في بوابة ZENOX المستقلة، ولا يتوقف على قاعدة بيانات المحادثات.")}</Text>
                {!ownerSetupMode ? <Pressable disabled={ownerDiagnoseMutation.isPending} onPress={() => void diagnoseOwnerGate()} style={[styles.diagnoseButton, ownerDiagnoseMutation.isPending && styles.disabled]}><Ionicons name="pulse-outline" size={15} color="#67E8F9" /><Text style={styles.diagnoseText}>{ownerDiagnoseMutation.isPending ? "أفحص البوابة…" : "تشخيص ذكي للخادم"}</Text></Pressable> : null}
                {ownerDiagnosis ? <View style={styles.diagnoseBox}><Ionicons name="sparkles-outline" size={15} color="#C4B5FD" /><Text style={styles.diagnoseBoxText}>{ownerDiagnosis}</Text></View> : null}
              </View>
            </ScrollView>
          ) : (
            <View style={styles.workspace}>
              {isWide ? (
                <OwnerSidebar selected={selectedArea} onSelect={selectArea} />
              ) : null}
              <View style={styles.dashboard}>
              <View style={styles.header}><View><Text style={styles.eyebrow}>ZENOX / SECURE MODE</Text><Text style={styles.dashboardTitle}>ماذا تريد أن ينفذ الوكيل؟</Text></View><View style={styles.onlinePill}><View style={styles.onlineDot} /><Text style={styles.onlineText}>ONLINE</Text></View></View>
              <Text style={styles.dashboardSub}>اكتب أو تحدث. وضع ZENOX ينفذ الأوامر مباشرة دون رأي أو جدال، ويعرض تقريرًا مختصرًا بالنتيجة.</Text>

              {!isWide ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.areaStrip}>
                  <OwnerAreaTabs selected={selectedArea} onSelect={selectArea} />
                </ScrollView>
              ) : null}

              {selectedArea === "root" && <View style={styles.rootPanel}>
                <View style={styles.rootHeader}><View><Text style={styles.rootTitle}>Root Manager</Text><Text style={styles.rootHint}>حوّل أمر ZENOX إلى خطة تنفيذ. تطبيق التعديل متاح من قسم الملفات بعد موافقتك.</Text></View><Ionicons name="construct-outline" size={23} color="#FBBF24" /></View>
                {!deviceControlAvailable ? <View style={styles.deviceGate}><Ionicons name="lock-closed-outline" size={17} color="#FDA4AF" /><View style={styles.deviceGateCopy}><Text style={styles.deviceGateText}>Root Manager معطل حتى تتم مصادقة ZENOX على الخادم.</Text><Pressable style={styles.deviceAuthButton} onPress={() => void signInOwner()}><Text style={styles.deviceAuthText}>مصادقة ZENOX الآن</Text><Ionicons name="arrow-back" size={14} color="#FDA4AF" /></Pressable></View></View> : <>
                  <TextInput value={rootRequestText} onChangeText={setRootRequestText} placeholder="اكتب التعديل المطلوب في الموقع أو المنصة…" placeholderTextColor="#64748B" style={styles.rootInput} multiline textAlign="right" />
                  <Pressable disabled={rootPlanMutation.isPending || !rootRequestText.trim()} onPress={() => void createRootPlan()} style={[styles.primaryButton, (rootPlanMutation.isPending || !rootRequestText.trim()) && styles.disabled]}><Text style={styles.primaryText}>{rootPlanMutation.isPending ? "جارٍ إعداد الخطة…" : "إنشاء خطة مراجعة"}</Text><Ionicons name="git-branch-outline" size={17} color="#0A0D1F" /></Pressable>
                  <View style={styles.sessionListHeader}><Text style={styles.sessionListTitle}>طلبات التغيير</Text><Pressable onPress={() => void rootRequestsQuery.refetch()}><Ionicons name="refresh-outline" size={17} color="#FBBF24" /></Pressable></View>
                  {rootRequestsQuery.isLoading ? <Text style={styles.deviceHint}>جارٍ تحميل الطلبات…</Text> : rootRequestsQuery.data?.length ? rootRequestsQuery.data.map((request) => { let plan: { changes?: string[]; validation?: string[]; affectedFiles?: string[] } = {}; try { plan = JSON.parse(request.planJson) as typeof plan; } catch { /* سجل غير قابل للعرض */ } return <View key={request.id} style={styles.rootCard}><View style={styles.rootCardTop}><Text style={styles.rootCardStatus}>{request.status}</Text><Text style={styles.rootCardRisk}>خطورة {request.risk}</Text></View><Text style={styles.rootCardSummary}>{request.summary}</Text><Text style={styles.rootCardMeta}>الملفات: {plan.affectedFiles?.join("، ") || "غير محددة"}</Text><Text style={styles.rootCardMeta}>التغييرات: {plan.changes?.join(" — ") || "غير متاحة"}</Text><Text style={styles.rootCardMeta}>الفحص: {plan.validation?.join("، ") || "لم يحدد"}</Text><View style={styles.rootCardActions}>{request.status === "awaiting_approval" && <Pressable onPress={() => void approveRootPlan(request.id)}><Text style={styles.rootApprove}>اعتماد الخطة</Text></Pressable>}<Pressable onPress={() => void cancelRootPlan(request.id)}><Text style={styles.policyDelete}>إلغاء</Text></Pressable></View></View> }) : <Text style={styles.deviceHint}>لا توجد طلبات تغيير بعد.</Text>}
                </>}
              </View>}

              {selectedArea === "integrations" && <View style={styles.rootPanel}>
                <View style={styles.rootHeader}><View><Text style={styles.rootTitle}>التكاملات والمفاتيح</Text><Text style={styles.rootHint}>تُحفظ المراجع والبيانات الوصفية فقط. قيم المفاتيح وكلمات مرور قواعد البيانات تبقى خارج قاعدة البيانات والواجهة.</Text></View><Ionicons name="link-outline" size={23} color="#60A5FA" /></View>
                {isAuthenticatedOwner ? (
                  <>
                    <Text style={styles.integrationHeading}>Gmail وDrive</Text>
                    <View style={styles.rootCard}>
                    <View style={styles.rootCardTop}>
                      <Text style={styles.rootCardSummary}>{googleStatusQuery.data?.connected ? `مرتبط: ${googleStatusQuery.data.email || "حساب Google"}` : googleStatusQuery.data?.configured ? "جاهز للربط بحسابك" : "يحتاج إعداد Google OAuth"}</Text>
                      <Text style={styles.rootCardRisk}>{googleStatusQuery.data?.connected ? "متصل" : "غير متصل"}</Text>
                    </View>
                    <Text style={styles.rootCardMeta}>{googleStatusQuery.data?.connected ? "تحكم كامل: قراءة Gmail وإرساله وأرشفته وحذفه، وإدارة ملفات Drive ومجلداتها ومشاركتها من مساحة ZENOX." : "الربط يمنح مساحة ZENOX تحكمًا كاملًا في Gmail وDrive، وتبقى الرموز مشفّرة على الخادم."}</Text>
                    {googleStatusQuery.data?.needsReconnect ? <Text style={styles.rootCardMeta}>الربط الحالي بصلاحيات قديمة أو انتهى رمزه. أعد الربط لتفعيل التحكم الكامل.</Text> : null}
                    {!googleStatusQuery.data?.configured || showGoogleForm ? (
                      <View>
                        <Text style={styles.rootCardMeta}>افتح ملف JSON على جهازك وانسخ client_id وclient_secret في الخانتين، أو اختر الملف مباشرة. تُحفظ القيم مشفّرة على الخادم ولا تُعرض مرة أخرى.</Text>
                        {Platform.OS === "web" ? <Pressable onPress={() => void importGoogleOAuthJson()} style={styles.deviceAuthButton}><Ionicons name="document-attach-outline" size={15} color="#FDA4AF" /><Text style={styles.deviceAuthText}>اختيار ملف JSON من الجهاز</Text></Pressable> : null}
                        <TextInput value={googleClientId} onChangeText={(value) => { setGoogleClientId(value); setGoogleConfigMessage(""); }} placeholder="Google Client ID" placeholderTextColor="#64748B" style={styles.input} autoCapitalize="none" autoCorrect={false} textAlign="left" />
                        <TextInput value={googleClientSecret} onChangeText={(value) => { setGoogleClientSecret(value); setGoogleConfigMessage(""); }} placeholder="Google Client Secret" placeholderTextColor="#64748B" style={styles.input} autoCapitalize="none" autoCorrect={false} secureTextEntry textAlign="left" />
                        <Pressable disabled={googleConfigureMutation.isPending || !googleClientId.trim() || !googleClientSecret.trim()} onPress={() => void saveGoogleOAuthCredentials()} style={[styles.primaryButton, (googleConfigureMutation.isPending || !googleClientId.trim() || !googleClientSecret.trim()) && styles.disabled]}><Text style={styles.primaryText}>{googleConfigureMutation.isPending ? "جارٍ الحفظ…" : "حفظ المفاتيح وتفعيل الربط"}</Text><Ionicons name="save-outline" size={17} color="#0A0D1F" /></Pressable>
                        {showGoogleForm ? <Pressable onPress={() => setShowGoogleForm(false)}><Text style={styles.helper}>إلغاء التعديل</Text></Pressable> : null}
                      </View>
                    ) : (
                      <Pressable onPress={() => setShowGoogleForm(true)}><Text style={styles.policyEdit}>تحديث بيانات OAuth</Text></Pressable>
                    )}
                    {googleConfigMessage ? <Text style={styles.helper}>{googleConfigMessage}</Text> : null}
                    {!googleStatusQuery.data?.configured ? <Text style={styles.rootCardMeta}>عنوان العودة المطلوب في Google: {googleStatusQuery.data?.redirectUri || "أعد تحميل الحالة لعرضه"}</Text> : null}
                    {googleStatusQuery.data?.configured && (!googleStatusQuery.data.connected || googleStatusQuery.data.needsReconnect) && Platform.OS === "web" ? <Pressable style={styles.deviceAuthButton} onPress={connectGoogleFromOwner}><Text style={styles.deviceAuthText}>{googleStatusQuery.data.connected ? "إعادة ربط Google بالصلاحيات الكاملة" : "ربط Gmail وDrive الآن"}</Text><Ionicons name="logo-google" size={14} color="#FDA4AF" /></Pressable> : null}
                    {googleStatusQuery.data?.connected ? <Pressable style={styles.deviceAuthButton} onPress={() => router.push("/google")}><Text style={styles.deviceAuthText}>فتح مركز Google — تحكم كامل</Text><Ionicons name="arrow-back" size={14} color="#FDA4AF" /></Pressable> : null}
                  </View>
                  </>
                ) : null}
                {!deviceControlAvailable ? (
                  <View style={styles.deviceGate}><Ionicons name="lock-closed-outline" size={17} color="#FDA4AF" /><View style={styles.deviceGateCopy}><Text style={styles.deviceGateText}>التكاملات معطلة حتى تتم مصادقة ZENOX على الخادم.</Text><Pressable style={styles.deviceAuthButton} onPress={() => void signInOwner()}><Text style={styles.deviceAuthText}>مصادقة ZENOX الآن</Text><Ionicons name="arrow-back" size={14} color="#FDA4AF" /></Pressable></View></View>
                ) : (
                  <>
                    <Text style={styles.integrationHeading}>اتصال قاعدة بيانات أو API خارجي</Text>
                  <TextInput value={connectionLabel} onChangeText={setConnectionLabel} placeholder="اسم الاتصال" placeholderTextColor="#64748B" style={styles.input} textAlign="right" />
                  <TextInput value={connectionKind} onChangeText={setConnectionKind} placeholder="mysql / postgres / supabase / rest_api" placeholderTextColor="#64748B" style={styles.input} autoCapitalize="none" textAlign="right" />
                  <TextInput value={connectionHost} onChangeText={setConnectionHost} placeholder="المضيف أو عنوان API دون سر" placeholderTextColor="#64748B" style={styles.input} autoCapitalize="none" textAlign="right" />
                  <View style={styles.deviceRow}><TextInput value={connectionDatabase} onChangeText={setConnectionDatabase} placeholder="اسم القاعدة" placeholderTextColor="#64748B" style={[styles.input, styles.deviceSmallInput]} textAlign="right" /><TextInput value={connectionUsername} onChangeText={setConnectionUsername} placeholder="اسم المستخدم" placeholderTextColor="#64748B" style={[styles.input, styles.deviceSmallInput]} textAlign="right" /></View>
                  <TextInput value={connectionSecretRef} onChangeText={setConnectionSecretRef} placeholder="مرجع السر مثل EXTERNAL_DB_SECRET" placeholderTextColor="#64748B" style={styles.input} autoCapitalize="characters" textAlign="right" />
                  <Pressable disabled={saveConnectionMutation.isPending} onPress={() => void saveConnection()} style={[styles.primaryButton, saveConnectionMutation.isPending && styles.disabled]}><Text style={styles.primaryText}>{saveConnectionMutation.isPending ? "جارٍ الحفظ…" : "حفظ تعريف الاتصال"}</Text><Ionicons name="server-outline" size={17} color="#0A0D1F" /></Pressable>
                  <Text style={styles.integrationHeading}>تسجيل API Key كمرجع آمن</Text>
                  <TextInput value={keyProvider} onChangeText={setKeyProvider} placeholder="اسم المزود" placeholderTextColor="#64748B" style={styles.input} textAlign="right" />
                  <TextInput value={keyLabel} onChangeText={setKeyLabel} placeholder="اسم المفتاح داخل ZENOX" placeholderTextColor="#64748B" style={styles.input} textAlign="right" />
                  <TextInput value={keySecretRef} onChangeText={setKeySecretRef} placeholder="مرجع السر مثل PROVIDER_API_KEY" placeholderTextColor="#64748B" style={styles.input} autoCapitalize="characters" textAlign="right" />
                  <TextInput value={keyScopes} onChangeText={setKeyScopes} placeholder="الصلاحيات مفصولة بفواصل" placeholderTextColor="#64748B" style={styles.input} textAlign="right" />
                  <Pressable disabled={registerKeyMutation.isPending} onPress={() => void registerApiKey()} style={[styles.primaryButton, registerKeyMutation.isPending && styles.disabled]}><Text style={styles.primaryText}>{registerKeyMutation.isPending ? "جارٍ التسجيل…" : "تسجيل مرجع المفتاح"}</Text><Ionicons name="key-outline" size={17} color="#0A0D1F" /></Pressable>
                  <View style={styles.sessionListHeader}><Text style={styles.sessionListTitle}>الاتصالات المسجلة</Text><Pressable onPress={() => void connectionsQuery.refetch()}><Ionicons name="refresh-outline" size={17} color="#60A5FA" /></Pressable></View>
                  {connectionsQuery.data?.map((connection) => <View key={connection.id} style={styles.rootCard}><Text style={styles.rootCardSummary}>{connection.label} · {connection.kind}</Text><Text style={styles.rootCardMeta}>{connection.host} · مرجع السر: {connection.secretRef} · SSL مفعّل</Text><View style={styles.rootCardActions}><Pressable disabled={testConnectionMutation.isPending} onPress={() => void testConnection(connection.id)}><Text style={styles.policyEdit}>{testConnectionMutation.isPending ? "جارٍ الاختبار…" : "اختبار الاتصال"}</Text></Pressable><Pressable onPress={() => void removeConnectionMutation.mutateAsync({ id: connection.id }).then(() => connectionsQuery.refetch())}><Text style={styles.policyDelete}>حذف التعريف</Text></Pressable></View></View>)}
                  <Text style={styles.sessionListTitle}>مراجع API Keys</Text>
                  {apiKeysQuery.data?.map((key) => <View key={key.id} style={styles.rootCard}><Text style={styles.rootCardSummary}>{key.provider} · {key.label}</Text><Text style={styles.rootCardMeta}>مرجع السر: {key.secretRef} · الحالة: {key.status}</Text><Pressable onPress={() => void revokeKeyMutation.mutateAsync({ id: key.id }).then(() => apiKeysQuery.refetch())}><Text style={styles.policyDelete}>إلغاء المرجع</Text></Pressable></View>)}
                  </>
                )}
              </View>}

              {selectedArea === "secrets" && <View style={styles.rootPanel}>
                <View style={styles.rootHeader}><View><Text style={styles.rootTitle}>ملف الأسرار</Text><Text style={styles.rootHint}>الأسرار مشفّرة AES-256-GCM داخل المشروع، والمفتاح محفوظ خارج المشروع. اكتب كلمة مرور ZENOX لعرض القيم.</Text></View><Ionicons name="key-outline" size={23} color="#F59E0B" /></View>
                <TextInput value={secretsPassword} onChangeText={setSecretsPassword} placeholder="كلمة مرور ZENOX" placeholderTextColor="#64748B" style={styles.input} secureTextEntry textAlign="right" />
                <Pressable disabled={secretsOpenMutation.isPending} onPress={() => void openSealedSecrets()} style={[styles.primaryButton, secretsOpenMutation.isPending && styles.disabled]}><Text style={styles.primaryText}>{secretsOpenMutation.isPending ? "جارٍ الفتح…" : "فتح ملف الأسرار"}</Text><Ionicons name="lock-open-outline" size={17} color="#0A0D1F" /></Pressable>
                {secretsList && <View style={styles.report}><Text style={styles.reportText}>{secretsList.map((item) => `${item.name}=${item.value}`).join("\n")}</Text></View>}
                {!secretsList && <Text style={styles.deviceHint}>يظهر هنا محتوى .env كاملًا بعد التحقق من كلمة مرور ZENOX. الملف المشفّر يُسلَّم مع المشروع، والقيم لا تُكشف لأي وكيل.</Text>}
              </View>}

              {selectedArea === "files" && <View style={styles.rootPanel}>
                <View style={styles.rootHeader}><View><Text style={styles.rootTitle}>تعديل الملفات</Text><Text style={styles.rootHint}>اكتب Patch بمسار محدد ثم طبّقه مباشرة من هنا.</Text></View><Ionicons name="document-attach-outline" size={23} color="#C084FC" /></View>
                {!deviceControlAvailable ? <View style={styles.deviceGate}><Ionicons name="lock-closed-outline" size={17} color="#FDA4AF" /><View style={styles.deviceGateCopy}><Text style={styles.deviceGateText}>تعديل الملفات معطل حتى تتم مصادقة ZENOX على الخادم.</Text><Pressable style={styles.deviceAuthButton} onPress={() => void signInOwner()}><Text style={styles.deviceAuthText}>مصادقة ZENOX الآن</Text><Ionicons name="arrow-back" size={14} color="#FDA4AF" /></Pressable></View></View> : <>
                  {phoneToolReady && <View style={styles.rootCard}>
                    <View style={styles.rootCardTop}><Text style={styles.rootCardSummary}>أداة جمع ملفات الهاتف</Text><Text style={styles.rootCardRisk}>{packState.online ? "متصل" : "بلا إنترنت"}</Text></View>
                    <Text style={styles.rootCardMeta}>تجمع ملفات أو مجلدًا من الهاتف وتضغطها داخل الجهاز نفسه، فتعرف المساحة الحقيقية قبل الرفع. بدون إنترنت تبقى محفوظة، وتُرفع تلقائيًا لحظة عودة الاتصال. لا تُحذف من الهاتف أبدًا — تبقى لفحص أجهزة المستخدمين. و«بيانات التطبيق» يجمع التفضيلات وقواعد البيانات والملفات المؤقتة من الجهاز نفسه.</Text>
                    <View style={styles.rootCardTop}><Pressable onPress={() => phoneTool.pickFiles()} style={styles.codeAction}><Ionicons name="folder-open-outline" size={14} color="#38BDF8" /><Text style={styles.codeActionText}>اجمع ملفات</Text></Pressable><Pressable onPress={() => phoneTool.pickFolder()} style={styles.codeAction}><Ionicons name="folder-outline" size={14} color="#38BDF8" /><Text style={styles.codeActionText}>اجمع مجلدًا</Text></Pressable><Pressable onPress={() => phoneTool.packAppData()} style={styles.codeAction}><Ionicons name="albums-outline" size={14} color="#C084FC" /><Text style={styles.codeActionText}>بيانات التطبيق</Text></Pressable><Pressable disabled={Boolean(packState.uploading)} onPress={() => phoneTool.uploadNow()} style={styles.codeAction}><Ionicons name="cloud-upload-outline" size={14} color="#7DD3FC" /><Text style={styles.codeActionText}>{packState.uploading ? "جارٍ الرفع…" : "ارفع الجديد"}</Text></Pressable></View>
                    <Text style={styles.deviceHint}>{packs.length ? `${packs.length} أرشيف على الهاتف · ${packs.filter((item) => !item.sent).length} بانتظار الرفع · ${(((packState.totalBytes ?? 0) / (1024 * 1024))).toFixed(1)} ميجابايت` : "لا يوجد أرشيف محفوظ على الهاتف."}</Text>
                    {packs.map((pack) => <View key={pack.name} style={styles.rootCardTop}><Text style={styles.rootCardMeta}>{pack.name} · {pack.sizeText ?? `${Math.round((pack.size ?? 0) / 1024)} كيلوبايت`}{pack.sent ? " · رُفع" : " · في انتظار الرفع"}</Text><Pressable onPress={() => phoneTool.deletePack(pack.name)} style={styles.codeAction}><Ionicons name="trash-outline" size={13} color="#FDA4AF" /><Text style={styles.codeActionText}>حذف</Text></Pressable></View>)}
                  </View>}
                  <Pressable onPress={() => void uploadFromPhone()} style={styles.apkButton}><Ionicons name="cloud-upload-outline" size={16} color="#0A0D1F" /><Text style={styles.apkButtonText}>{phoneToolReady ? "رفع ملف واحد من الهاتف (المتصفح)" : "رفع ملف من ذاكرة الهاتف"}</Text></Pressable>
                  <View style={styles.sessionListHeader}><Text style={styles.sessionListTitle}>الملفات المرفوعة</Text><Pressable onPress={() => void uploadsQuery.refetch()}><Ionicons name="refresh-outline" size={17} color="#C084FC" /></Pressable></View>
                  {(uploadsQuery.data ?? []).length === 0 ? <Text style={styles.deviceHint}>لا يوجد ملف مرفوع بعد — اضغط زر الرفع أعلى القسم.</Text> : (uploadsQuery.data ?? []).map((item) => (
                    <View key={item.name} style={styles.rootCardTop}>
                      <Pressable onPress={() => openUpload(item.name)} style={styles.codeAction}><Ionicons name="eye-outline" size={14} color="#38BDF8" /><Text style={styles.codeActionText}>فتح</Text></Pressable>
                      {/\.(zip|rar)$/i.test(item.name) && <Pressable onPress={() => void extractUpload(item.name)} style={styles.codeAction}><Ionicons name="folder-open-outline" size={14} color="#F59E0B" /><Text style={styles.codeActionText}>فك الضغط</Text></Pressable>}
                      <Text style={styles.rootCardMeta}>{item.name} · {Math.max(1, Math.round(item.size / 1024))} كيلوبايت</Text>
                    </View>
                  ))}
                  <TextInput value={filePath} onChangeText={setFilePath} placeholder="مسار داخل المشروع مثل app/console.tsx" placeholderTextColor="#64748B" style={styles.input} autoCapitalize="none" textAlign="right" />
                  <TextInput value={fileSummary} onChangeText={setFileSummary} placeholder="وصف التعديل" placeholderTextColor="#64748B" style={styles.input} textAlign="right" />
                  <TextInput value={filePatch} onChangeText={setFilePatch} placeholder="الصق Patch هنا" placeholderTextColor="#64748B" style={styles.rootInput} multiline autoCapitalize="none" textAlign="left" />
                  <Pressable disabled={proposeFileMutation.isPending} onPress={() => void proposeFileChange()} style={[styles.primaryButton, proposeFileMutation.isPending && styles.disabled]}><Text style={styles.primaryText}>{proposeFileMutation.isPending ? "جارٍ الحفظ…" : "حفظ Patch للمراجعة"}</Text><Ionicons name="git-branch-outline" size={17} color="#0A0D1F" /></Pressable>
                  <View style={styles.sessionListHeader}><Text style={styles.sessionListTitle}>طلبات تعديل الملفات</Text><Pressable onPress={() => void fileChangesQuery.refetch()}><Ionicons name="refresh-outline" size={17} color="#C084FC" /></Pressable></View>
                  {fileChangesQuery.data?.map((change) => <View key={change.id} style={styles.rootCard}><Text style={styles.rootCardSummary}>{change.filePath} · {change.status}</Text><Text style={styles.rootCardMeta}>{change.summary} · خطورة {change.risk}</Text><Text style={styles.patchPreview}>{change.patch}</Text><View style={styles.rootCardActions}>{change.status === "awaiting_approval" && <Pressable onPress={() => void approveFileChange(change.id)}><Text style={styles.rootApprove}>اعتماد</Text></Pressable>}{(change.status === "awaiting_approval" || change.status === "approved") && <Pressable onPress={() => void applyFileChange(change.id)}><Text style={styles.policyEdit}>تطبيق مباشر</Text></Pressable>}<Pressable onPress={() => void cancelFileChange(change.id)}><Text style={styles.policyDelete}>إلغاء</Text></Pressable></View></View>)}
                </>}
              </View>}

              {selectedArea === "tools" && (
                <OwnerToolsPanel
                  tools={ownerToolsQuery.data ?? []}
                  unlocked={deviceControlAvailable}
                  busy={runToolMutation.isPending}
                  result={toolResult}
                  onRun={(name) => void runTool(name)}
                  onRunWithArgs={(name, args) => void runTool(name, args)}
                />
              )}

              {selectedArea === "notice" && <View style={styles.rootPanel}>
                <View style={styles.rootHeader}><View><Text style={styles.rootTitle}>إعلان فوري على المنصة</Text><Text style={styles.rootHint}>يظهر لكل زائر خلال ١٥ ثانية بلا تعديل كود ولا إعادة بناء. تحذير أحمر/أصفر أو خبر عادي — وأيضًا وضع صيانة يغطي الموقع للمستخدمين.</Text></View><Ionicons name="megaphone-outline" size={23} color="#34D399" /></View>
                {!deviceControlAvailable ? <View style={styles.deviceGate}><Ionicons name="lock-closed-outline" size={17} color="#FDA4AF" /><View style={styles.deviceGateCopy}><Text style={styles.deviceGateText}>الإعلان معطّل حتى تسجل دخول ZENOX.</Text></View></View> : <>
                  <TextInput value={noticeText} onChangeText={setNoticeText} placeholder="نص الإعلان، مثل: تحذير — صيانة الليلة ١٢" placeholderTextColor="#64748B" style={styles.rootInput} textAlign="right" />
                  <View style={styles.termChips}>
                    {(["info", "warning", "danger"] as const).map((tone) => (
                      <Pressable key={tone} onPress={() => setNoticeTone(tone)} style={[styles.termChip, noticeTone === tone && styles.termTabActive]}>
                        <Text style={styles.termChipText}>{tone === "info" ? "خبر" : tone === "warning" ? "تحذير" : "خطر"}</Text>
                      </Pressable>
                    ))}
                    <Pressable onPress={() => setNoticeAlarm((value) => !value)} style={[styles.termChip, noticeAlarm && styles.termTabActive]}>
                      <Text style={styles.termChipText}>{noticeAlarm ? "🔔 صوت الإنذار: مفعّل" : "🔕 صوت الإنذار: متوقف"}</Text>
                    </Pressable>
                  </View>
                  <View style={styles.termActions}>
                    <Pressable disabled={siteSetMutation.isPending || !noticeText.trim()} onPress={() => void applyBanner(true)} style={[styles.primaryButton, styles.termRun, (siteSetMutation.isPending || !noticeText.trim()) && styles.disabled]}><Text style={styles.primaryText}>أظهر على المنصة</Text><Ionicons name="megaphone" size={16} color="#0A0D1F" /></Pressable>
                    <Pressable onPress={() => void applyBanner(false)} style={[styles.primaryButton, styles.termStop]}><Text style={styles.termStopText}>إخفاء</Text></Pressable>
                  </View>
                  <TextInput value={maintenanceText} onChangeText={setMaintenanceText} placeholder="رسالة الصيانة" placeholderTextColor="#64748B" style={styles.rootInput} textAlign="right" />
                  <View style={styles.termActions}>
                    <Pressable disabled={siteSetMutation.isPending} onPress={() => void toggleMaintenance(true)} style={[styles.primaryButton, styles.termRun, siteSetMutation.isPending && styles.disabled]}><Text style={styles.primaryText}>تشغيل وضع الصيانة</Text><Ionicons name="construct" size={16} color="#0A0D1F" /></Pressable>
                    <Pressable onPress={() => void toggleMaintenance(false)} style={[styles.primaryButton, styles.termStop]}><Text style={styles.termStopText}>إيقاف</Text></Pressable>
                  </View>
                  <Text style={styles.deviceHint}>{siteState ? `الحالة: الشريط ${siteState.banner.enabled ? `ظاهر (${siteState.banner.tone})` : "مخفي"} · الصيانة ${siteState.maintenance.enabled ? "مفعّلة" : "متوقفة"}` : "الحالة تُقرأ بعد أول تطبيق."}</Text>
                </>}

                <View style={styles.rootHeader}><View><Text style={styles.rootTitle}>تحكم موقع ZANOX9.AI (إعلانات/تعديل/إضافة)</Text><Text style={styles.rootHint}>جلب/حفظ كامل محتوى الموقع (نصوص، مزايا، FAQ، إعلانات) أو إضافة/حذف إعلان — من الواجهة، بأمر.</Text></View><Ionicons name="globe-outline" size={23} color="#34D399" /></View>
                {!deviceControlAvailable ? <View style={styles.deviceGate}><Ionicons name="lock-closed-outline" size={17} color="#FDA4AF" /><View style={styles.deviceGateCopy}><Text style={styles.deviceGateText}>معطّل حتى تسجيل دخول ZENOX.</Text></View></View> : <>
                  <View style={styles.termActions}>
                    <Pressable disabled={promoGetQuery.isFetching} onPress={async () => { setPromoMsg(""); try { const r = await promoGetQuery.refetch(); setPromoJson(JSON.stringify(r.data?.content ?? {}, null, 2)); setPromoMsg("تم جلب المحتوى."); } catch (e) { setPromoMsg(String(e)); } }} style={[styles.primaryButton, styles.termRun, promoGetQuery.isFetching && styles.disabled]}><Text style={styles.primaryText}>{promoGetQuery.isFetching ? "جارٍ الجلب…" : "جلب محتوى الموقع"}</Text><Ionicons name="download-outline" size={16} color="#0A0D1F" /></Pressable>
                  </View>
                  <TextInput value={promoJson} onChangeText={setPromoJson} placeholder="{ ... محتوى JSON ... }" placeholderTextColor="#64748B" style={[styles.rootInput, { minHeight: 120 }]} multiline textAlign="right" />
                  <View style={styles.termActions}>
                    <Pressable disabled={promoSetMutation.isPending || !promoJson.trim()} onPress={async () => { setPromoMsg(""); try { const parsed = JSON.parse(promoJson); await promoSetMutation.mutateAsync({ content: parsed }); setPromoMsg("تم حفظ محتوى الموقع."); } catch (e) { setPromoMsg(String(e)); } }} style={[styles.primaryButton, styles.termRun, (promoSetMutation.isPending || !promoJson.trim()) && styles.disabled]}><Text style={styles.primaryText}>{promoSetMutation.isPending ? "جارٍ الحفظ…" : "حفظ المحتوى"}</Text><Ionicons name="save-outline" size={16} color="#0A0D1F" /></Pressable>
                  </View>
                  <TextInput value={promoAdTitle} onChangeText={setPromoAdTitle} placeholder="عنوان الإعلان" placeholderTextColor="#64748B" style={styles.rootInput} textAlign="right" />
                  <TextInput value={promoAdBody} onChangeText={setPromoAdBody} placeholder="نص الإعلان" placeholderTextColor="#64748B" style={styles.rootInput} textAlign="right" />
                  <TextInput value={promoAdCta} onChangeText={setPromoAdCta} placeholder="نص الزر (اختياري)" placeholderTextColor="#64748B" style={styles.rootInput} textAlign="right" />
                  <TextInput value={promoAdUrl} onChangeText={setPromoAdUrl} placeholder="رابط الزر https:// (اختياري)" placeholderTextColor="#64748B" style={styles.rootInput} textAlign="right" />
                  <View style={styles.termActions}>
                    <Pressable disabled={promoAdAddMutation.isPending} onPress={async () => { setPromoMsg(""); try { await promoAdAddMutation.mutateAsync({ ad: { title: promoAdTitle, body: promoAdBody, ctaLabel: promoAdCta, ctaUrl: promoAdUrl, tone: "info", enabled: true } }); setPromoMsg("تمت إضافة الإعلان."); setPromoAdTitle(""); setPromoAdBody(""); setPromoAdCta(""); setPromoAdUrl(""); } catch (e) { setPromoMsg(String(e)); } }} style={[styles.primaryButton, styles.termRun, promoAdAddMutation.isPending && styles.disabled]}><Text style={styles.primaryText}>{promoAdAddMutation.isPending ? "جارٍ…" : "إضافة إعلان"}</Text><Ionicons name="add-circle-outline" size={16} color="#0A0D1F" /></Pressable>
                  </View>
                  {promoMsg ? <Text style={styles.deviceHint}>{promoMsg}</Text> : null}
                </>}
              </View>}

              {selectedArea === "security" && <View style={styles.rootPanel}>
                <View style={styles.rootHeader}><View><Text style={styles.rootTitle}>مركز الأمن</Text><Text style={styles.rootHint}>فحص حقيقي لمشروعك ونشرك فقط: مفاتيح مكشوفة، صلاحيات الملفات، ثغرات الحزم، ومسارات ZENOX المفتوحة. لا يلمس أي جهاز آخر.</Text></View><Ionicons name="shield-half-outline" size={23} color="#F87171" /></View>
                {!deviceControlAvailable ? <View style={styles.deviceGate}><Ionicons name="lock-closed-outline" size={17} color="#FDA4AF" /><View style={styles.deviceGateCopy}><Text style={styles.deviceGateText}>مركز الأمن معطّل حتى تسجل دخول ZENOX.</Text></View></View> : <>
                  <View style={styles.rootCard}>
                    <Text style={styles.rootCardSummary}>تغيير كلمة مرور المالك</Text>
                    <Text style={styles.rootCardMeta}>يتطلب جلستك الحالية وكلمة المرور الحالية. تُحفظ الكلمة الجديدة كتجزئة scrypt، ولا تُخزَّن أبدًا كنص.</Text>
                    <TextInput value={currentOwnerPassword} onChangeText={(value) => { setCurrentOwnerPassword(value); setPasswordChangeMessage(""); }} placeholder="كلمة المرور الحالية" placeholderTextColor="#64748B" secureTextEntry style={styles.rootInput} textAlign="right" />
                    <TextInput value={newOwnerPassword} onChangeText={(value) => { setNewOwnerPassword(value); setPasswordChangeMessage(""); }} placeholder="كلمة المرور الجديدة (10 أحرف على الأقل)" placeholderTextColor="#64748B" secureTextEntry style={styles.rootInput} textAlign="right" />
                    <TextInput value={newOwnerPasswordConfirm} onChangeText={(value) => { setNewOwnerPasswordConfirm(value); setPasswordChangeMessage(""); }} placeholder="تأكيد كلمة المرور الجديدة" placeholderTextColor="#64748B" secureTextEntry style={styles.rootInput} textAlign="right" onSubmitEditing={() => void changeOwnerPassword()} />
                    <Pressable disabled={ownerChangePasswordMutation.isPending} onPress={() => void changeOwnerPassword()} style={[styles.primaryButton, ownerChangePasswordMutation.isPending && styles.disabled]}><Text style={styles.primaryText}>{ownerChangePasswordMutation.isPending ? "جارٍ التغيير…" : "تغيير كلمة المرور"}</Text><Ionicons name="key-outline" size={16} color="#0A0D1F" /></Pressable>
                    {passwordChangeMessage ? <Text style={styles.deviceHint}>{passwordChangeMessage}</Text> : null}
                  </View>
                  <Pressable disabled={securityMutation.isPending} onPress={() => void runSecurityScan()} style={[styles.primaryButton, securityMutation.isPending && styles.disabled]}><Text style={styles.primaryText}>{securityMutation.isPending ? "جارٍ الفحص…" : "افحص الآن"}</Text><Ionicons name="shield-checkmark" size={16} color="#0A0D1F" /></Pressable>
                  {securityReport ? <>
                    <Text style={styles.patchPreview}>{`الدرجة: ${securityReport.score}/100 · ملفات ${securityReport.scannedFiles} · فحوص ${securityReport.checks} · ${securityReport.durationMs}ms`}</Text>
                    {securityReport.findings.length === 0 ? <Text style={styles.deviceHint}>لا ملاحظات — النتيجة نظيفة.</Text> : securityReport.findings.map((finding, index) => (
                      <View key={`${finding.id}-${index}`} style={styles.rootCard}>
                        <Text style={[styles.rootCardSummary, { color: finding.severity === "critical" ? "#FCA5A5" : finding.severity === "high" ? "#FDBA74" : finding.severity === "medium" ? "#FDE68A" : "#A7F3D0" }]}>{finding.severity.toUpperCase()} · {finding.title}</Text>
                        <Text style={styles.rootCardMeta}>{finding.detail}{finding.file ? ` — ${finding.file}${finding.line ? `:${finding.line}` : ""}` : ""}</Text>
                      </View>
                    ))}
                  </> : <Text style={styles.deviceHint}>لم يُشغَّل فحص بعد. اضغط «افحص الآن».</Text>}
                </>}
              </View>}

              {selectedArea === "terminal" && <View style={styles.rootPanel}>
                <View style={styles.rootHeader}><View><Text style={styles.rootTitle}>Terminal متصل</Text><Text style={styles.rootHint}>جلسة حقيقية على الخادم: الناتج يظهر سطرًا بسطر، والمجلد يبقى بعد cd. «أمر مباشر» ينفّذ shell، و«طلب بالعربي» يحوّل كلامك إلى أوامر أو تعديلات وينفّذها بنفسه.</Text></View><Ionicons name="terminal-outline" size={23} color="#34D399" /></View>
                {!deviceControlAvailable ? <View style={styles.deviceGate}><Ionicons name="lock-closed-outline" size={17} color="#FDA4AF" /><View style={styles.deviceGateCopy}><Text style={styles.deviceGateText}>Terminal معطّل حتى تسجل دخول ZENOX.</Text><Pressable style={styles.deviceAuthButton} onPress={() => router.replace("/")}><Text style={styles.deviceAuthText}>العودة لشاشة الدخول</Text><Ionicons name="arrow-back" size={14} color="#FDA4AF" /></Pressable></View></View> : <>
                  <View style={styles.termTabs}>
                    <Pressable onPress={() => setTermMode("command")} style={[styles.termTab, termMode === "command" && styles.termTabActive]}><Text style={[styles.termTabText, termMode === "command" && styles.termTabTextActive]}>أمر مباشر</Text></Pressable>
                    <Pressable onPress={() => setTermMode("request")} style={[styles.termTab, termMode === "request" && styles.termTabActive]}><Text style={[styles.termTabText, termMode === "request" && styles.termTabTextActive]}>طلب بالعربي</Text></Pressable>
                    <Text style={styles.termCwd} numberOfLines={1}>{termCwd || "…"}</Text>
                  </View>
                  <ScrollView ref={termLogRef} style={styles.termLog} onContentSizeChange={() => termLogRef.current?.scrollToEnd({ animated: false })}>
                    {termLog.length === 0 ? <Text style={styles.termEmpty}>جاهز. اكتب pwd أو ls، أو حوّل الوضع إلى «طلب بالعربي» وقل ما تريد تنفيذه.</Text> : termLog.map((line) => <Text key={line.id} selectable style={[styles.termLine, line.kind === "cmd" && styles.termLineCmd, line.kind === "err" && styles.termLineErr, line.kind === "meta" && styles.termLineMeta, line.kind === "ask" && styles.termLineAsk]}>{line.text}</Text>)}
                  </ScrollView>
                  <View style={styles.termChips}>
                    {(termMode === "command" ? ["pwd", "ls", "git status", "npx pnpm@9.12.0 check"] : ["شغّل الاختبارات وأصلح أي فشل", "اعرض حالة السيرفر", "أضف زر الوضع الليلي في شاشة المستخدم"]).map((chip) => (
                      <Pressable key={chip} onPress={() => setShellCommand(chip)} style={styles.termChip}><Text style={styles.termChipText}>{chip}</Text></Pressable>
                    ))}
                  </View>
                  <TextInput
                    value={shellCommand}
                    onChangeText={setShellCommand}
                    placeholder={termMode === "command" ? "pnpm check" : "مثال: شغّل الاختبارات وأصلح أي فشل"}
                    placeholderTextColor="#64748B"
                    style={styles.rootInput}
                    multiline
                    autoCapitalize="none"
                    autoCorrect={false}
                    textAlign="left"
                    onKeyPress={(event: any) => {
                      const key = event?.nativeEvent?.key;
                      if (key === "ArrowUp" && termHistory.length) {
                        const next = Math.max(0, (termHistoryIndex < 0 ? termHistory.length : termHistoryIndex) - 1);
                        setTermHistoryIndex(next);
                        setShellCommand(termHistory[next] ?? "");
                      }
                      if (key === "ArrowDown" && termHistoryIndex >= 0) {
                        const next = termHistoryIndex + 1;
                        if (next >= termHistory.length) {
                          setTermHistoryIndex(-1);
                          setShellCommand("");
                        } else {
                          setTermHistoryIndex(next);
                          setShellCommand(termHistory[next] ?? "");
                        }
                      }
                    }}
                  />
                  <View style={styles.termActions}>
                    <Pressable disabled={termBusy || !shellCommand.trim()} onPress={() => void runTerminal()} style={[styles.primaryButton, styles.termRun, (termBusy || !shellCommand.trim()) && styles.disabled]}><Text style={styles.primaryText}>{termBusy ? "جارٍ التنفيذ…" : termMode === "command" ? "تنفيذ" : "حوّل ونفّذ"}</Text><Ionicons name="play" size={16} color="#0A0D1F" /></Pressable>
                    {termBusy && <Pressable onPress={() => void stopTerminal()} style={[styles.primaryButton, styles.termStop]}><Text style={styles.termStopText}>إيقاف</Text><Ionicons name="stop" size={15} color="#FDA4AF" /></Pressable>}
                  </View>
                </>}
              </View>}

              {selectedArea === "code" && <View style={styles.rootPanel}>
                <View style={styles.rootHeader}><View><Text style={styles.rootTitle}>كود البنية</Text><Text style={styles.rootHint}>شجرة المشروع الحقيقية على الخادم. اضغط أي ملف لعرض محتواه، ونفّذ ما بعده من Terminal.</Text></View><Ionicons name="git-branch-outline" size={23} color="#F472B6" /></View>
                {!deviceControlAvailable ? <View style={styles.deviceGate}><Ionicons name="lock-closed-outline" size={17} color="#FDA4AF" /><View style={styles.deviceGateCopy}><Text style={styles.deviceGateText}>كود البنية معطّل حتى تفتح جلسة ZENOX بكلمة المرور.</Text><Pressable style={styles.deviceAuthButton} onPress={() => router.back()}><Text style={styles.deviceAuthText}>إدخال كلمة المرور</Text><Ionicons name="arrow-back" size={14} color="#FDA4AF" /></Pressable></View></View> : <>
                  <View style={styles.codeToolbar}>
                    <Pressable onPress={() => setCodeDepth((current) => (current >= 4 ? 2 : current + 1))} style={styles.codeAction}><Ionicons name="layers-outline" size={14} color="#F472B6" /><Text style={styles.codeActionText}>العمق {codeDepth}</Text></Pressable>
                    <Pressable onPress={() => { setOpenFile(null); void codeTreeQuery.refetch(); }} style={styles.codeAction}><Ionicons name="refresh-outline" size={14} color="#F472B6" /><Text style={styles.codeActionText}>تحديث الشجرة</Text></Pressable>
                  </View>
                  {codeTreeQuery.isLoading ? <Text style={styles.deviceHint}>جارٍ قراءة بنية المشروع…</Text> : codeTreeQuery.error ? <Text style={styles.deviceHint}>{codeTreeQuery.error.message}</Text> : (codeTreeQuery.data?.entries ?? []).map((entry) => renderCodeEntry(entry, 0))}
                  {codeTreeQuery.data?.truncated ? <Text style={styles.deviceHint}>عُرض جزء من الشجرة فقط (حد 5000 عنصر).</Text> : null}
                  {openFile ? <View style={styles.codeFileBox}>
                    <View style={styles.sessionListHeader}><Text style={styles.sessionListTitle}>{openFile}</Text><Pressable onPress={() => { setOpenFile(null); setFileDraft(null); setFileNote(null); }}><Text style={styles.policyDelete}>إغلاق</Text></Pressable></View>
                    {codeFileQuery.isLoading ? <Text style={styles.deviceHint}>جارٍ قراءة الملف…</Text> : codeFileQuery.error ? <Text style={styles.deviceHint}>{codeFileQuery.error.message}</Text> : <>
                      <TextInput
                        value={fileDraft ?? codeFileQuery.data?.content ?? ""}
                        onChangeText={setFileDraft}
                        multiline
                        autoCapitalize="none"
                        autoCorrect={false}
                        textAlign="left"
                        style={styles.codeEditor}
                      />
                      <View style={styles.codeToolbar}>
                        <Pressable disabled={saveFileMutation.isPending || fileDraft === null} onPress={() => void saveOpenFile()} style={[styles.codeSave, (saveFileMutation.isPending || fileDraft === null) && styles.disabled]}>
                          <Ionicons name="save-outline" size={14} color="#0A0D1F" />
                          <Text style={styles.codeSaveText}>{saveFileMutation.isPending ? "جارٍ الحفظ…" : "حفظ التعديل"}</Text>
                        </Pressable>
                        <Pressable onPress={() => { setFileDraft(null); setFileNote(null); }} style={styles.codeAction}><Ionicons name="refresh-outline" size={14} color="#F472B6" /><Text style={styles.codeActionText}>إلغاء التعديل</Text></Pressable>
                      </View>
                      {fileNote ? <Text style={styles.deviceHint}>{fileNote}</Text> : null}
                      {codeFileQuery.data?.truncated ? <Text style={styles.deviceHint}>الملف أكبر من حد العرض؛ عُرض أوله فقط.</Text> : null}
                    </>}
                  </View> : null}
                </>}
              </View>}

              {selectedArea === "monitor" && <View style={styles.rootPanel}>
                <View style={styles.rootHeader}><View><Text style={styles.rootTitle}>المراقبة الحيّة</Text><Text style={styles.rootHint}>حالة الخادم الآن: الطلبات والأخطاء والسرعة والذاكرة والمفاتيح والكاش. تتحدّث كل 10 ثوانٍ.</Text></View><Ionicons name="pulse-outline" size={23} color="#22D3EE" /></View>
                {!deviceControlAvailable ? <View style={styles.deviceGate}><Ionicons name="lock-closed-outline" size={17} color="#FDA4AF" /><View style={styles.deviceGateCopy}><Text style={styles.deviceGateText}>المراقبة معطّلة حتى تسجل دخول ZENOX.</Text></View></View> : <>
                  {monitorQuery.error ? <Text style={styles.deviceHint}>{monitorQuery.error.message}</Text> : null}
                  <View style={styles.monitorGrid}>
                    {[
                      { label: "الطلبات", value: String(monitorQuery.data?.requests ?? "—") },
                      { label: "الأخطاء", value: String(monitorQuery.data?.errors ?? "—") },
                      { label: "متوسط الرد", value: `${monitorQuery.data?.averageMs ?? "—"} ms` },
                      { label: "أبطأ رد", value: `${monitorQuery.data?.slowestMs ?? "—"} ms` },
                      { label: "الذاكرة", value: `${monitorQuery.data?.memoryMb ?? "—"} MB` },
                      { label: "التشغيل", value: `${Math.round((monitorQuery.data?.uptimeSeconds ?? 0) / 60)} د` },
                      { label: "مفاتيح سليمة", value: `${monitorQuery.data?.keys.healthy ?? 0}/${monitorQuery.data?.keys.total ?? 0}` },
                      { label: "كاش / جاري", value: `${monitorQuery.data?.chat.cacheEntries ?? 0} / ${monitorQuery.data?.chat.inFlight ?? 0}` },
                    ].map((tile) => (
                      <View key={tile.label} style={styles.monitorTile}>
                        <Text style={styles.monitorValue}>{tile.value}</Text>
                        <Text style={styles.monitorLabel}>{tile.label}</Text>
                      </View>
                    ))}
                  </View>
                  <Pressable style={styles.apkButton} onPress={() => void Linking.openURL(`${SITE_URL}/zenox.apk`)}>
                    <Ionicons name="logo-android" size={16} color="#0A0D1F" />
                    <Text style={styles.apkButtonText}>تحميل تطبيق ZENOX للهاتف (APK)</Text>
                  </Pressable>
                  <Pressable style={styles.apkButton} onPress={() => void Linking.openURL(SITE_URL)}>
                    <Ionicons name="globe-outline" size={16} color="#0A0D1F" />
                    <Text style={styles.apkButtonText}>افتح موقع ZANOX9.AI</Text>
                  </Pressable>
                  <Pressable
                    disabled={promoAdminLinkQuery.isFetching}
                    style={[styles.apkButton, promoAdminLinkQuery.isFetching && styles.disabled]}
                    onPress={async () => {
                      setSiteEditorMsg("");
                      try {
                        const result = await promoAdminLinkQuery.refetch();
                        if (!result.data?.url) throw new Error("تعذّر إنشاء رابط المحرر.");
                        if (Platform.OS === "web") window.open(result.data.url, "_blank", "noopener,noreferrer");
                        else await Linking.openURL(result.data.url);
                      } catch (error) {
                        setSiteEditorMsg(error instanceof Error ? error.message : "تعذّر فتح المحرر.");
                      }
                    }}
                  >
                    <Ionicons name="create-outline" size={16} color="#0A0D1F" />
                    <Text style={styles.apkButtonText}>{promoAdminLinkQuery.isFetching ? "جارٍ فتح المحرر…" : "تحرير الموقع (نصوص · إضافات · روابط)"}</Text>
                  </Pressable>
                  <Text style={styles.deviceHint}>
                    يفتح المحرر برابط موقّع من جلسة المالك — بلا كلمة مرور منفصلة. بعد الحفظ يظهر التعديل للزوّار فورًا.
                  </Text>
                  {siteEditorMsg ? <Text style={styles.deviceHint}>{siteEditorMsg}</Text> : null}
                  <Text style={styles.deviceHint}>
                    المزوّد النشط: {monitorQuery.data?.ai?.provider ?? "—"} · {monitorQuery.data?.ai?.model ?? "—"} · آخر نشاط:{" "}
                    {monitorQuery.data?.lastRequestSecondsAgo === null || monitorQuery.data?.lastRequestSecondsAgo === undefined ? "—" : `قبل ${monitorQuery.data.lastRequestSecondsAgo} ثانية`}
                  </Text>
                  <Text style={styles.rootTitle}>آخر العمليات</Text>
                  {(auditQuery.data ?? []).map((log) => (
                    <View key={log.id} style={styles.auditRow}>
                      <Text style={styles.auditAction} numberOfLines={1}>{log.action}</Text>
                      <Text style={styles.auditDetails} numberOfLines={2}>{log.details}</Text>
                    </View>
                  ))}
                  {auditQuery.data && auditQuery.data.length === 0 ? <Text style={styles.deviceHint}>لا توجد عمليات مسجّلة بعد.</Text> : null}
                  {(monitorQuery.data?.backups ?? []).length > 0 ? <Text style={styles.deviceHint}>نسخ احتياطية للتعديلات: {monitorQuery.data?.backups.length} ملف محفوظ.</Text> : null}
                </>}
              </View>}

              {selectedArea === "memory" && <View style={styles.rootPanel}>
                <View style={styles.rootHeader}><View><Text style={styles.rootTitle}>ذاكرة المساعد</Text><Text style={styles.rootHint}>كل ملاحظة هنا تُضاف إلى عقل المساعد في كل مرة، فلا تعيد شرح تفضيلاتك أو قواعد منصتك. المساعد نفسه يستطيع أن يحفظ ملاحظة بأمر منك.</Text></View><Ionicons name="bulb-outline" size={23} color="#A78BFA" /></View>
                {!deviceControlAvailable ? <View style={styles.deviceGate}><Ionicons name="lock-closed-outline" size={17} color="#FDA4AF" /><View style={styles.deviceGateCopy}><Text style={styles.deviceGateText}>الذاكرة معطّلة حتى تسجل دخول ZENOX.</Text></View></View> : <>
                  <View style={styles.rootCardTop}><TextInput value={memoryDraft} onChangeText={setMemoryDraft} placeholder="مثال: تفضيل دائم بأن تكون النصوص بالعربية المصرية" placeholderTextColor="#64748B" style={styles.rootInput} textAlign="right" /><Pressable disabled={addMemoryMutation.isPending || memoryDraft.trim().length < 3} onPress={() => void addMemoryMutation.mutateAsync({ text: memoryDraft.trim() }).then(() => { setMemoryDraft(""); return memoryQuery.refetch(); })} style={styles.codeAction}><Ionicons name="add-circle-outline" size={14} color="#A78BFA" /><Text style={styles.codeActionText}>احفظ</Text></Pressable></View>
                  {memoryQuery.isLoading ? <Text style={styles.deviceHint}>جارٍ قراءة الذاكرة…</Text> : memoryQuery.data?.length ? memoryQuery.data.map((item) => <View key={item.id} style={styles.rootCardTop}><Text style={styles.rootCardMeta}>{item.text}</Text><Pressable onPress={() => void deleteMemoryMutation.mutateAsync({ id: item.id }).then(() => memoryQuery.refetch())} style={styles.codeAction}><Ionicons name="trash-outline" size={13} color="#FDA4AF" /><Text style={styles.codeActionText}>حذف</Text></Pressable></View>) : <Text style={styles.deviceHint}>لا ملاحظات بعد. المساعد يتعلم من كل أمر تكتبه إذا طلبت منه أن يتذكر.</Text>}
                </>}
              </View>}

              {selectedArea === "chats" && <View style={styles.rootPanel}>
                <View style={styles.rootHeader}><View><Text style={styles.rootTitle}>محادثات المستخدمين</Text><Text style={styles.rootHint}>كل سؤال وجواب مرّا على المساعد محفوظ هنا لـ ZENOX: اقرأ ما يكتبه الناس، افتح المحادثة كاملة، أو امسح السجل. لا تُحفظ أي مفاتيح أو كلمات مرور.</Text></View><Ionicons name="chatbubbles-outline" size={23} color="#38BDF8" /></View>
                {!deviceControlAvailable ? <View style={styles.deviceGate}><Ionicons name="lock-closed-outline" size={17} color="#FDA4AF" /><View style={styles.deviceGateCopy}><Text style={styles.deviceGateText}>قراءة المحادثات معطّلة حتى تسجل دخول ZENOX.</Text></View></View> : <>
                  <View style={styles.codeToolbar}>
                    <Pressable onPress={() => { void chatsQuery.refetch(); void chatTotalsQuery.refetch(); }} style={styles.codeAction}><Ionicons name="refresh-outline" size={14} color="#38BDF8" /><Text style={styles.codeActionText}>تحديث</Text></Pressable>
                    <View style={styles.codeAction}><Ionicons name="albums-outline" size={14} color="#38BDF8" /><Text style={styles.codeActionText}>{chatTotalsQuery.data?.conversations ?? 0} محادثة · {chatTotalsQuery.data?.messages ?? 0} رسالة</Text></View>
                    <Pressable disabled={clearChatsMutation.isPending} onPress={() => void clearChatsMutation.mutateAsync().then(() => { setOpenChat(null); return Promise.all([chatsQuery.refetch(), chatTotalsQuery.refetch()]); })} style={styles.codeAction}><Ionicons name="trash-outline" size={14} color="#FDA4AF" /><Text style={styles.codeActionText}>{clearChatsMutation.isPending ? "جارٍ المسح…" : "مسح السجل"}</Text></Pressable>
                  </View>
                  {chatsQuery.isLoading ? <Text style={styles.deviceHint}>جارٍ قراءة المحادثات…</Text> : chatsQuery.data?.length ? chatsQuery.data.map((session) => <Pressable key={session.conversation} onPress={() => setOpenChat(openChat === session.conversation ? null : session.conversation)} style={styles.rootCard}><View style={styles.rootCardTop}><Text style={styles.rootCardSummary} numberOfLines={2}>{session.preview || "محادثة بلا نص"}</Text><Text style={styles.rootCardRisk}>{session.turns} رسالة</Text></View><Text style={styles.rootCardMeta}>{session.owner ? "ZENOX" : "ضيف"} · {session.mode} · {session.client} · {new Date(session.lastAt).toLocaleString("ar-EG")}</Text>{openChat === session.conversation ? <View>{chatThreadQuery.isLoading ? <Text style={styles.deviceHint}>جارٍ فتح المحادثة…</Text> : (chatThreadQuery.data ?? []).map((item, index) => <View key={`${item.at}-${index}`} style={styles.chatBubble}><Text style={styles.chatRole}>{item.role === "user" ? "المستخدم" : "ZENOX"}{item.cached ? " · من الكاش" : ""}</Text><Text style={styles.chatText}>{item.text}</Text></View>)}</View> : null}</Pressable>) : <Text style={styles.deviceHint}>لا توجد محادثات محفوظة بعد. أول سؤال للمساعد سيظهر هنا.</Text>}
                </>}
              </View>}

              {selectedArea === "ai" && <View style={styles.rootPanel}>
                <View style={styles.rootHeader}><View><Text style={styles.rootTitle}>الذكاء الاصطناعي</Text><Text style={styles.rootHint}>أضف مفاتيحك هنا — تُحفظ في قاعدة البيانات ولا تُعرض بعد الحفظ. المفاتيح تتبادل يوميًا، وإن فشل مفتاح ينتقل الخادم تلقائيًا إلى الذي بعده.</Text></View><Ionicons name="sparkles-outline" size={23} color="#38BDF8" /></View>
                {!deviceControlAvailable ? <View style={styles.deviceGate}><Ionicons name="lock-closed-outline" size={17} color="#FDA4AF" /><View style={styles.deviceGateCopy}><Text style={styles.deviceGateText}>إدارة المفاتيح معطّلة حتى تفتح جلسة ZENOX.</Text><Pressable style={styles.deviceAuthButton} onPress={() => router.replace("/")}><Text style={styles.deviceAuthText}>العودة لشاشة الدخول</Text><Ionicons name="arrow-back" size={14} color="#FDA4AF" /></Pressable></View></View> : <>
                  <View style={styles.codeToolbar}>
                    <View style={styles.codeAction}><Ionicons name={aiQuery.data?.configured ? "checkmark-circle" : "alert-circle"} size={14} color={aiQuery.data?.configured ? "#2DD4BF" : "#FDA4AF"} /><Text style={styles.codeActionText}>{aiQuery.data?.configured ? `مفعّل · ${aiQuery.data.keys} مفتاح` : "غير مفعّل"}</Text></View>
                    {aiQuery.data?.activeLabel ? <View style={styles.codeAction}><Ionicons name="today-outline" size={14} color="#38BDF8" /><Text style={styles.codeActionText}>مفتاح اليوم: {aiQuery.data.activeLabel}</Text></View> : null}
                    <Pressable onPress={() => void testAiKeys()} style={styles.codeAction}><Ionicons name="pulse-outline" size={14} color="#38BDF8" /><Text style={styles.codeActionText}>{testAiKeysMutation.isPending ? "جارٍ الاختبار…" : "اختبار الكل"}</Text></Pressable>
                  </View>
                  <View style={styles.aiProviderRow}>
                    {(["groq", "gemini", "openai", "openrouter", "zai"] as const).map((item) => (
                      <Pressable key={item} onPress={() => setAiProvider(item)} style={[styles.languageChip, aiProvider === item && styles.languageActive]}>
                        <Text style={[styles.languageText, aiProvider === item && styles.languageTextActive]}>{item}</Text>
                      </Pressable>
                    ))}
                  </View>
                  <TextInput value={aiLabel} onChangeText={setAiLabel} placeholder="اسم المفتاح داخل ZENOX مثل groq-1" placeholderTextColor="#64748B" style={styles.input} autoCapitalize="none" textAlign="right" />
                  <TextInput value={aiModel} onChangeText={setAiModel} placeholder="النموذج (اختياري) مثل llama-3.3-70b-versatile" placeholderTextColor="#64748B" style={styles.input} autoCapitalize="none" textAlign="right" />
                  <View style={styles.secretLabel}><Ionicons name="key-outline" size={13} color="#C4B5FD" /><Text style={styles.secretLabelText}>خانة سرية — المفتاح لا يظهر بعد الحفظ</Text></View>
                  <TextInput value={aiKey} onChangeText={setAiKey} placeholder="API key" placeholderTextColor="#64748B" secureTextEntry style={styles.input} autoCapitalize="none" textAlign="right" />
                  <Pressable disabled={addAiKeyMutation.isPending || !aiKey.trim()} onPress={() => void addAiKey()} style={[styles.primaryButton, (addAiKeyMutation.isPending || !aiKey.trim()) && styles.disabled]}><Ionicons name="add-circle-outline" size={17} color="#0A0D1F" /><Text style={styles.primaryText}>{addAiKeyMutation.isPending ? "جارٍ الحفظ…" : "حفظ المفتاح واختباره"}</Text></Pressable>
                  {aiMessage ? <Text style={styles.helper}>{aiMessage}</Text> : null}
                  <View style={styles.sessionListHeader}><Text style={styles.sessionListTitle}>المفاتيح المحفوظة</Text><Pressable onPress={() => void aiQuery.refetch()}><Ionicons name="refresh-outline" size={17} color="#38BDF8" /></Pressable></View>
                  {aiQuery.isLoading ? <Text style={styles.deviceHint}>جارٍ التحميل…</Text> : aiQuery.data?.keys.length ? aiQuery.data.keys.map((key) => <View key={key.id} style={styles.rootCard}><View style={styles.rootCardTop}><Text style={styles.rootCardSummary}>{key.label} · {key.provider}</Text><Text style={[styles.rootCardRisk, { color: key.status === "ok" ? "#99F6E4" : key.status === "failing" ? "#FDA4AF" : "#FBBF24" }]}>{key.status === "ok" ? "يعمل" : key.status === "failing" ? "فشل" : "لم يُختبر"}</Text></View><Text style={styles.rootCardMeta}>{key.model} · {key.masked} · {key.baseUrl}</Text>{key.lastError ? <Text style={styles.rootCardMeta}>{key.lastError.slice(0, 160)}</Text> : null}<View style={styles.rootCardActions}><Pressable onPress={() => void removeAiKeyMutation.mutateAsync({ id: key.id }).then(() => aiQuery.refetch())}><Text style={styles.policyDelete}>حذف</Text></Pressable></View></View>) : <Text style={styles.deviceHint}>لا توجد مفاتيح بعد. أضف أول مفتاح من الأعلى ليبدأ الذكاء الاصطناعي بالعمل.</Text>}
                  {aiResults.length ? <View style={styles.codeFileBox}><Text style={styles.sessionListTitle}>نتيجة الاختبار</Text>{aiResults.map((item) => <Text key={item.id} style={styles.rootCardMeta}>{item.ok ? "✓" : "✗"} {item.label}{item.ok ? "" : ` — ${item.error.slice(0, 120)}`}</Text>)}</View> : null}
                </>}
              </View>}

              {selectedArea === "devices" && <View style={styles.devicePanel}>
                <Text style={styles.deviceTitle}>طلب جلسة تحكم بموافقة الجهاز</Text>
                <Text style={styles.deviceHint}>لن تبدأ أي جلسة قبل قبولها من الجهاز نفسه. وضع الدخول المفتوح يسمح بالمحادثة ومساحة ZENOX، لكنه لا يمنح جلسة خادم للتحكم بالأجهزة.</Text>
                {!deviceControlAvailable && <View style={styles.deviceGate}><Ionicons name="lock-closed-outline" size={17} color="#FDA4AF" /><View style={styles.deviceGateCopy}><Text style={styles.deviceGateText}>التحكم بالأجهزة معطل حتى تتم مصادقة ZENOX على الخادم.</Text><Pressable style={styles.deviceAuthButton} onPress={() => void signInOwner()}><Text style={styles.deviceAuthText}>مصادقة ZENOX الآن</Text><Ionicons name="arrow-back" size={14} color="#FDA4AF" /></Pressable></View></View>}
                <TextInput editable={deviceControlAvailable} value={deviceId} onChangeText={setDeviceId} placeholder="معرّف الجهاز" placeholderTextColor="#64748B" style={[styles.input, !deviceControlAvailable && styles.disabled]} textAlign="right" />
                <TextInput editable={deviceControlAvailable} value={deviceName} onChangeText={setDeviceName} placeholder="اسم الجهاز" placeholderTextColor="#64748B" style={[styles.input, !deviceControlAvailable && styles.disabled]} textAlign="right" />
                <View style={styles.deviceRow}><TextInput editable={deviceControlAvailable} value={devicePlatform} onChangeText={setDevicePlatform} placeholder="android أو ios" placeholderTextColor="#64748B" style={[styles.input, styles.deviceSmallInput, !deviceControlAvailable && styles.disabled]} autoCapitalize="none" textAlign="right" /><TextInput editable={deviceControlAvailable} value={deviceMinutes} onChangeText={setDeviceMinutes} placeholder="المدة بالدقائق" placeholderTextColor="#64748B" style={[styles.input, styles.deviceSmallInput, !deviceControlAvailable && styles.disabled]} keyboardType="number-pad" textAlign="right" /></View>
                <View style={styles.capabilityWrap}>{DEVICE_CAPABILITIES.map((capability) => <Pressable disabled={!deviceControlAvailable} key={capability.id} onPress={() => toggleDeviceCapability(capability.id)} style={[styles.capabilityChip, deviceCapabilities.includes(capability.id) && styles.capabilityChipActive, !deviceControlAvailable && styles.disabled]}><Text style={styles.capabilityText}>{capability.label}</Text></Pressable>)}</View>
                <Pressable disabled={!deviceControlAvailable || requestDeviceSessionMutation.isPending} style={[styles.primaryButton, (!deviceControlAvailable || requestDeviceSessionMutation.isPending) && styles.disabled]} onPress={() => void requestDeviceSession()}><Text style={styles.primaryText}>{requestDeviceSessionMutation.isPending ? "جارٍ إنشاء الطلب…" : "إنشاء طلب موافقة"}</Text><Ionicons name="phone-portrait-outline" size={17} color="#0A0D1F" /></Pressable>
                <View style={styles.sessionListHeader}><Text style={styles.sessionListTitle}>الجلسات الأخيرة</Text><Pressable disabled={!deviceControlAvailable} onPress={() => void deviceSessionsQuery.refetch()}><Ionicons name="refresh-outline" size={17} color={deviceControlAvailable ? "#67E8F9" : "#64748B"} /></Pressable></View>
                {deviceSessionsQuery.isLoading ? <Text style={styles.deviceHint}>جارٍ تحميل الجلسات…</Text> : deviceSessionsQuery.data?.length ? deviceSessionsQuery.data.map((session) => <View key={session.sessionId} style={styles.sessionCard}><View style={styles.sessionTop}><Text style={styles.sessionName}>{session.deviceName}</Text><Text style={styles.sessionStatus}>{SESSION_STATUS_LABELS[session.status] ?? session.status}</Text></View><Text style={styles.sessionMeta}>{session.platform} · {sessionCapabilityCount(session.capabilities)} صلاحيات · تنتهي {new Date(session.expiresAt).toLocaleString("ar-EG")}</Text>{(session.status === "pending" || session.status === "active") && <Pressable onPress={() => void revokeDeviceSession(session.sessionId)} style={styles.revokeButton}><Text style={styles.revokeText}>{revokeDeviceSessionMutation.isPending ? "جارٍ السحب…" : "سحب الجلسة"}</Text></Pressable>}</View>) : <Text style={styles.deviceHint}>لا توجد جلسات مسجلة لZENOX.</Text>}
              </View>}

              {selectedArea === "policy" && <View style={styles.policyPanel}>
                <View style={styles.policyHeader}><View><Text style={styles.policyTitle}>إدارة صلاحيات ZENOX</Text><Text style={styles.policyHint}>أضف صلاحية أو عدّلها، وستُحفظ مرتبطة بـ ZENOX في قاعدة البيانات.</Text></View><Ionicons name="shield-checkmark-outline" size={22} color="#2DD4BF" /></View>
                {!deviceControlAvailable ? <View style={styles.deviceGate}><Ionicons name="lock-closed-outline" size={17} color="#FDA4AF" /><View style={styles.deviceGateCopy}><Text style={styles.deviceGateText}>إدارة الصلاحيات معطلة حتى تتم مصادقة ZENOX على الخادم.</Text><Pressable style={styles.deviceAuthButton} onPress={() => void signInOwner()}><Text style={styles.deviceAuthText}>مصادقة ZENOX الآن</Text><Ionicons name="arrow-back" size={14} color="#FDA4AF" /></Pressable></View></View> : <>
                  <TextInput value={policyKey} onChangeText={setPolicyKey} placeholder="مفتاح الصلاحية مثل: web.search" placeholderTextColor="#64748B" style={styles.input} autoCapitalize="none" textAlign="right" />
                  <TextInput value={policyLabel} onChangeText={setPolicyLabel} placeholder="اسم الصلاحية" placeholderTextColor="#64748B" style={styles.input} textAlign="right" />
                  <TextInput value={policyDescription} onChangeText={setPolicyDescription} placeholder="وصف ما تسمح به الصلاحية أو تمنعه" placeholderTextColor="#64748B" style={styles.policyDescriptionInput} multiline textAlign="right" />
                  <Pressable onPress={() => setPolicyEnabled((current) => !current)} style={styles.policyToggle}><Ionicons name={policyEnabled ? "checkmark-circle" : "close-circle"} size={19} color={policyEnabled ? "#2DD4BF" : "#FDA4AF"} /><Text style={styles.policyToggleText}>{policyEnabled ? "الصلاحية مفعّلة" : "الصلاحية معطّلة"}</Text></Pressable>
                  <View style={styles.policyActions}><Pressable disabled={savePolicyMutation.isPending} onPress={() => void savePolicy()} style={[styles.primaryButton, styles.policySaveButton, savePolicyMutation.isPending && styles.disabled]}><Text style={styles.primaryText}>{savePolicyMutation.isPending ? "جارٍ الحفظ…" : policyId ? "حفظ التعديل" : "إضافة الصلاحية"}</Text><Ionicons name="save-outline" size={17} color="#0A0D1F" /></Pressable>{policyId && <Pressable onPress={clearPolicyEditor} style={styles.policyCancel}><Text style={styles.policyCancelText}>إلغاء التعديل</Text></Pressable>}</View>
                  <Text style={styles.sessionListTitle}>الصلاحيات المحفوظة</Text>
                  {policiesQuery.isLoading ? <Text style={styles.deviceHint}>جارٍ تحميل الصلاحيات…</Text> : policiesQuery.data?.length ? policiesQuery.data.map((policy) => <View key={policy.id} style={styles.policyCard}><View style={styles.policyCardTop}><Text style={styles.policyCardLabel}>{policy.label}</Text><Text style={styles.policyKey}>{policy.policyKey}</Text></View><Text style={styles.policyCardDescription}>{policy.description}</Text><View style={styles.policyCardActions}><Text style={[styles.policyState, { color: policy.enabled ? "#99F6E4" : "#FDA4AF" }]}>{policy.enabled ? "مفعّلة" : "معطّلة"}</Text><Pressable onPress={() => editPolicy(policy)}><Text style={styles.policyEdit}>تعديل</Text></Pressable><Pressable onPress={() => void removePolicy(policy.id)}><Text style={styles.policyDelete}>حذف</Text></Pressable></View></View>) : <Text style={styles.deviceHint}>لا توجد صلاحيات مخصصة بعد. أضف أول صلاحية من الحقول أعلاه.</Text>}
                </>}
              </View>}

              <ScrollView ref={messagesScrollRef} style={styles.messages} contentContainerStyle={styles.messagesContent} showsVerticalScrollIndicator={true} onContentSizeChange={() => messagesScrollRef.current?.scrollToEnd({ animated: true })}>
                {messages.map((message) => <View key={message.id} style={[styles.messageRow, message.role === "user" && styles.userRow]}>{message.role === "assistant" && <View style={styles.miniAvatar}><Text style={styles.miniAvatarText}>Z</Text></View>}<View style={[styles.bubble, message.role === "user" ? styles.userBubble : styles.assistantBubble]}><Text style={[styles.messageText, message.role === "user" && styles.userMessageText]}>{message.text}</Text></View></View>)}
              </ScrollView>

              <View style={styles.composer}><TextInput value={draft} onChangeText={setDraft} onSubmitEditing={() => void sendMessage()} placeholder="اكتب أمرك… نفّذ shell مباشرة بـ /run مثل: /run ls" placeholderTextColor="#64748B" style={styles.commandInput} multiline textAlign="right" /><Pressable style={styles.micButton} onPress={() => void uploadFromPhone()}><Ionicons name="attach-outline" size={20} color="#CBD5E1" /></Pressable><Pressable style={[styles.micButton, recorderState.isRecording && styles.micButtonActive]} onPress={() => void toggleVoice()}><Ionicons name={recorderState.isRecording ? "stop" : "mic-outline"} size={20} color={recorderState.isRecording ? "#0A0D1F" : "#CBD5E1"} /></Pressable><Pressable style={[styles.sendButton, (!draft.trim() || (chatMutation.isPending || ownerStreaming)) && styles.disabled]} onPress={() => void sendMessage()}><Ionicons name={(chatMutation.isPending || ownerStreaming) ? "ellipsis-horizontal" : "arrow-up"} size={20} color="#0A0D1F" /></Pressable></View>
              <Text style={styles.voiceNote}>{recorderState.isRecording ? "التسجيل نشط… اضغط الميكروفون للإيقاف والتنفيذ." : "يمكنك استخدام الصوت أو النص. سيقرأ ZENOX الرد في الجلسة الصوتية."}</Text>

              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.suggestionRow}>{suggestions.map((item) => <Pressable key={item} onPress={() => void sendMessage(item)} style={styles.suggestion}><Text style={styles.suggestionText}>{item}</Text></Pressable>)}</ScrollView>
              <View style={styles.report}><View style={styles.reportHeader}><Text style={styles.reportStatus}>تقرير التنفيذ</Text><Ionicons name="shield-checkmark-outline" size={18} color="#67E8F9" /></View><Text style={styles.reportText}>{report}</Text></View>
              <View style={styles.notice}><Ionicons name="flash-outline" size={17} color="#2DD4BF" /><Text style={styles.noticeText}>سياسة ZENOX التشغيلية يحددها ZENOX. وضع التنفيذ لا يضيف رأيًا أو جدالًا؛ وتبقى الإجراءات غير القابلة للعكس خلف تأكيد صريح وحدود الصلاحيات الأساسية.</Text></View>
              </View>
            </View>
          )}
        </View>
        <Modal visible={unlocked && !isWide && sidebarOpen} transparent animationType="fade" onRequestClose={() => setSidebarOpen(false)}>
          <Pressable style={styles.drawerBackdrop} onPress={() => setSidebarOpen(false)}>
            <Pressable style={styles.drawerPanel} onPress={(event) => event.stopPropagation()}>
              <OwnerSidebar selected={selectedArea} onSelect={selectArea} onClose={() => setSidebarOpen(false)} />
            </Pressable>
          </Pressable>
        </Modal>
      </KeyboardAvoidingView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  codeEditor: { minHeight: 220, maxHeight: 420, borderRadius: 12, borderWidth: 1, borderColor: "#1E293B", backgroundColor: "#0B1220", color: "#E2E8F0", padding: 10, fontSize: 12, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  codeSave: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#F472B6", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  codeSaveText: { color: "#0A0D1F", fontWeight: "800", fontSize: 12 },
  chatBubble: { backgroundColor: "#080D1C", borderWidth: 1, borderColor: "#1E293B", borderRadius: 10, padding: 9, marginTop: 7 },
  chatRole: { color: "#67E8F9", fontSize: 10, fontWeight: "700", marginBottom: 3, textAlign: "right" },
  chatText: { color: "#E2E8F0", fontSize: 12, lineHeight: 19, textAlign: "right" },
  apkButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: "#34D399", borderRadius: 12, paddingVertical: 12, marginTop: 4 },
  apkButtonText: { color: "#0A0D1F", fontWeight: "800", fontSize: 13 },
  monitorGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginVertical: 10 },
  monitorTile: { width: "47%", borderRadius: 12, borderWidth: 1, borderColor: "#164E63", backgroundColor: "#0B1B24", padding: 10, gap: 2 },
  monitorValue: { color: "#67E8F9", fontWeight: "800", fontSize: 16, textAlign: "right" },
  monitorLabel: { color: "#64748B", fontSize: 11, textAlign: "right" },
  auditRow: { borderTopWidth: 1, borderTopColor: "#1E293B", paddingVertical: 7, gap: 2 },
  auditAction: { color: "#E2E8F0", fontSize: 12, fontWeight: "700", textAlign: "right" },
  auditDetails: { color: "#64748B", fontSize: 11, textAlign: "right" },
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: "#0A0D1F" },
  container: { flex: 1, paddingHorizontal: 18, width: "100%", maxWidth: 900, alignSelf: "center" },
  containerWide: { maxWidth: 1240 },
  topbar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  topbarActions: { flexDirection: "row-reverse", alignItems: "center", gap: 8 },
  menuButton: { width: 36, height: 36, borderWidth: 1, borderColor: "#27304D", borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: "#10162B" },
  workspace: { flex: 1, flexDirection: "row-reverse", gap: 14, minHeight: 0, paddingTop: 16 },
  drawerBackdrop: { flex: 1, backgroundColor: "rgba(3,6,18,0.72)", alignItems: "flex-end", justifyContent: "flex-start", paddingTop: 76, paddingHorizontal: 16, paddingBottom: 22 },
  drawerPanel: { width: "88%", maxWidth: 300, height: "100%", maxHeight: 720 },
  back: { width: 40, height: 40, borderWidth: 1, borderColor: "#27304D", borderRadius: 13, alignItems: "center", justifyContent: "center" },
  brandMark: { width: 40, height: 40, borderRadius: 13, backgroundColor: "#8B5CF6", alignItems: "center", justifyContent: "center" },
  brandMarkText: { color: "#FFFFFF", fontSize: 22, fontWeight: "900" },
  ownerTag: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#17113A", borderWidth: 1, borderColor: "#47327D", borderRadius: 99, paddingHorizontal: 10, paddingVertical: 7 },
  ownerDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#A78BFA" },
  ownerTagText: { color: "#C4B5FD", fontSize: 9, fontWeight: "900", letterSpacing: 1 },
  loginContent: { paddingBottom: 42, flexGrow: 1 },
  lockButton: { flexDirection: "row-reverse", alignItems: "center", gap: 5, borderWidth: 1, borderColor: "#73511A", backgroundColor: "#1B1608", borderRadius: 11, paddingHorizontal: 11, paddingVertical: 8 },
  lockText: { color: "#FDE68A", fontSize: 10, fontWeight: "900" },
  hero: { alignItems: "center", paddingVertical: 14 },
  ownerAvatar: { width: 72, height: 72, borderRadius: 25, backgroundColor: "#8B5CF6", alignItems: "center", justifyContent: "center", marginBottom: 15 },
  ownerAvatarText: { color: "#FFFFFF", fontSize: 33, fontWeight: "900" },
  kicker: { color: "#67E8F9", fontSize: 10, fontWeight: "900", letterSpacing: 1.4 },
  title: { color: "#F8FAFC", fontSize: 21, fontWeight: "900", textAlign: "center", marginTop: 8 },
  subtitle: { color: "#94A3B8", fontSize: 12, marginTop: 7, textAlign: "center" },
  loginCard: { backgroundColor: "#11162B", borderWidth: 1, borderColor: "#303B61", borderRadius: 20, padding: 17 },
  cardHeader: { flexDirection: "row-reverse", alignItems: "center", gap: 8, marginBottom: 15 },
  cardTitle: { color: "#F8FAFC", fontSize: 15, fontWeight: "800" },
  input: { height: 50, backgroundColor: "#0A0D1F", borderWidth: 1, borderColor: "#27304D", borderRadius: 12, color: "#F8FAFC", paddingHorizontal: 13, marginBottom: 10, fontSize: 13 },
  primaryButton: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: "#A78BFA", borderRadius: 12, height: 49, marginTop: 3 },
  primaryText: { color: "#0A0D1F", fontSize: 13, fontWeight: "900" },
  oauthButton: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 7, borderWidth: 1, borderColor: "#47327D", backgroundColor: "#151033", borderRadius: 12, height: 45, marginTop: 9 },
  oauthText: { color: "#C4B5FD", fontSize: 12, fontWeight: "800" },
  helper: { color: "#64748B", fontSize: 10, lineHeight: 16, textAlign: "right", marginTop: 11 },
  diagnoseButton: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 7, height: 38, marginTop: 9, borderWidth: 1, borderColor: "#225E5B", borderRadius: 10, backgroundColor: "#0D2528" },
  diagnoseText: { color: "#99F6E4", fontSize: 10, fontWeight: "800" },
  diagnoseBox: { flexDirection: "row-reverse", alignItems: "flex-start", gap: 7, marginTop: 9, padding: 10, borderRadius: 10, backgroundColor: "#17113A", borderWidth: 1, borderColor: "#47327D" },
  diagnoseBoxText: { flex: 1, color: "#DDD6FE", fontSize: 10, lineHeight: 17, textAlign: "right" },
  dashboard: { flex: 1, paddingTop: 22, paddingBottom: 12 },
  header: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "flex-start" },
  eyebrow: { color: "#67E8F9", fontSize: 10, fontWeight: "900", letterSpacing: 1.3, textAlign: "right", marginBottom: 7 },
  dashboardTitle: { color: "#F8FAFC", fontSize: 24, fontWeight: "900", textAlign: "right" },
  dashboardSub: { color: "#94A3B8", fontSize: 11, lineHeight: 18, textAlign: "right", marginTop: 8, marginBottom: 13 },
  onlinePill: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderColor: "#225E5B", backgroundColor: "#0D2528", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 99 },
  onlineDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#2DD4BF" },
  onlineText: { color: "#99F6E4", fontSize: 10, fontWeight: "700" },
  areaStrip: { flexDirection: "row-reverse", gap: 8, paddingBottom: 10 },
  areaChip: { flexDirection: "row-reverse", alignItems: "center", gap: 6, borderWidth: 1, borderColor: "#27304D", backgroundColor: "#10162B", borderRadius: 11, paddingHorizontal: 11, paddingVertical: 8 },
  areaText: { color: "#94A3B8", fontSize: 11, fontWeight: "700" },
  areaTextActive: { color: "#F8FAFC" },
  devicePanel: { backgroundColor: "#11162B", borderWidth: 1, borderColor: "#4C1D3D", borderRadius: 17, padding: 13, marginBottom: 10 },
  deviceTitle: { color: "#FDA4AF", fontSize: 14, fontWeight: "900", textAlign: "right" },
  deviceHint: { color: "#CBD5E1", fontSize: 10, lineHeight: 17, textAlign: "right", marginTop: 5, marginBottom: 10 },
  deviceGate: { flexDirection: "row-reverse", alignItems: "center", gap: 7, backgroundColor: "#3A172A", borderWidth: 1, borderColor: "#7F1D1D", borderRadius: 10, padding: 9, marginBottom: 10 },
  deviceGateCopy: { flex: 1, alignItems: "flex-end", gap: 7 },
  deviceGateText: { color: "#FDA4AF", fontSize: 10, lineHeight: 16, textAlign: "right" },
  deviceAuthButton: { flexDirection: "row-reverse", alignItems: "center", gap: 5, borderWidth: 1, borderColor: "#9F4255", borderRadius: 8, paddingHorizontal: 9, paddingVertical: 6 },
  deviceAuthText: { color: "#FDA4AF", fontSize: 10, fontWeight: "800" },
  deviceRow: { flexDirection: "row", gap: 8 },
  deviceSmallInput: { flex: 1 },
  capabilityWrap: { flexDirection: "row-reverse", flexWrap: "wrap", gap: 7, marginBottom: 12 },
  capabilityChip: { borderWidth: 1, borderColor: "#334155", backgroundColor: "#0D1328", borderRadius: 10, paddingHorizontal: 9, paddingVertical: 7 },
  capabilityChipActive: { borderColor: "#FB7185", backgroundColor: "#3A172A" },
  capabilityText: { color: "#E2E8F0", fontSize: 10 },
  sessionListHeader: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "center", marginTop: 16, marginBottom: 8 },
  sessionListTitle: { color: "#FDA4AF", fontSize: 12, fontWeight: "900", textAlign: "right" },
  sessionCard: { backgroundColor: "#0D1328", borderWidth: 1, borderColor: "#3F2947", borderRadius: 12, padding: 10, marginTop: 7 },
  sessionTop: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "center" },
  sessionName: { color: "#F8FAFC", fontSize: 12, fontWeight: "800" },
  sessionStatus: { color: "#99F6E4", fontSize: 10, fontWeight: "800" },
  sessionMeta: { color: "#94A3B8", fontSize: 10, lineHeight: 17, textAlign: "right", marginTop: 5 },
  revokeButton: { alignSelf: "flex-end", borderWidth: 1, borderColor: "#7F1D1D", backgroundColor: "#3A172A", borderRadius: 8, paddingHorizontal: 9, paddingVertical: 6, marginTop: 8 },
  revokeText: { color: "#FDA4AF", fontSize: 10, fontWeight: "800" },
  messages: { flex: 1, minHeight: 220, backgroundColor: "#0D1328", borderWidth: 1, borderColor: "#202A4A", borderRadius: 18 },
  messagesContent: { padding: 16, gap: 15, paddingBottom: 28 },
  messageRow: { width: "100%", maxWidth: 760, alignSelf: "center", flexDirection: "row-reverse", alignItems: "flex-start", gap: 8 },
  userRow: { flexDirection: "row", justifyContent: "flex-start" },
  miniAvatar: { width: 27, height: 27, borderRadius: 13, backgroundColor: "#8B5CF6", alignItems: "center", justifyContent: "center" },
  miniAvatarText: { color: "#FFFFFF", fontSize: 13, fontWeight: "900" },
  bubble: { flexShrink: 1, paddingHorizontal: 14, paddingVertical: 11, borderRadius: 16 },
  assistantBubble: { flex: 1, backgroundColor: "#151B34", borderTopRightRadius: 5, borderWidth: 1, borderColor: "#202A4A" },
  userBubble: { maxWidth: "82%", backgroundColor: "#5B35B6", borderTopLeftRadius: 5 },
  messageText: { flexShrink: 1, color: "#E2E8F0", fontSize: 13, lineHeight: 22, textAlign: "right" },
  userMessageText: { color: "#FFFFFF" },
  composer: { minHeight: 57, flexDirection: "row-reverse", alignItems: "flex-end", gap: 7, backgroundColor: "#11162B", borderWidth: 1, borderColor: "#303B61", borderRadius: 18, padding: 8, marginTop: 10 },
  commandInput: { flex: 1, maxHeight: 92, color: "#F8FAFC", fontSize: 13, paddingHorizontal: 8, paddingVertical: 8, textAlignVertical: "top" },
  micButton: { width: 37, height: 37, alignItems: "center", justifyContent: "center" },
  micButtonActive: { backgroundColor: "#2DD4BF", borderRadius: 12 },
  sendButton: { width: 38, height: 38, borderRadius: 13, backgroundColor: "#A78BFA", alignItems: "center", justifyContent: "center" },
  disabled: { opacity: 0.4 },
  voiceNote: { color: "#64748B", fontSize: 10, textAlign: "right", marginTop: 7 },
  suggestionRow: { flexDirection: "row-reverse", gap: 7, paddingVertical: 10 },
  suggestion: { borderWidth: 1, borderColor: "#27304D", backgroundColor: "#10162B", borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 },
  suggestionText: { color: "#A5B4FC", fontSize: 10 },
  report: { backgroundColor: "#101C30", borderWidth: 1, borderColor: "#164E63", borderRadius: 15, padding: 12 },
  reportHeader: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "center" },
  reportStatus: { color: "#67E8F9", fontSize: 10, fontWeight: "900", letterSpacing: 1 },
  reportText: { color: "#CFFAFE", fontSize: 11, lineHeight: 19, textAlign: "right", marginTop: 8 },
  notice: { flexDirection: "row-reverse", alignItems: "center", gap: 7, backgroundColor: "#0E2524", borderWidth: 1, borderColor: "#145A53", borderRadius: 12, padding: 10, marginTop: 9 },
  noticeText: { flex: 1, color: "#99F6E4", fontSize: 10, textAlign: "right", lineHeight: 17 },
  policyPanel: { backgroundColor: "#101C30", borderWidth: 1, borderColor: "#145A53", borderRadius: 17, padding: 13, marginBottom: 10 },
  policyHeader: { flexDirection: "row-reverse", alignItems: "flex-start", justifyContent: "space-between", gap: 10, marginBottom: 12 },
  policyTitle: { color: "#99F6E4", fontSize: 14, fontWeight: "900", textAlign: "right" },
  policyHint: { color: "#CBD5E1", fontSize: 10, lineHeight: 17, textAlign: "right", marginTop: 5 },
  policyDescriptionInput: { minHeight: 86, backgroundColor: "#0A0D1F", borderWidth: 1, borderColor: "#27304D", borderRadius: 12, color: "#F8FAFC", padding: 13, marginBottom: 10, fontSize: 12, lineHeight: 18, textAlignVertical: "top" },
  policyToggle: { flexDirection: "row-reverse", alignItems: "center", alignSelf: "flex-end", gap: 7, marginBottom: 10 },
  policyToggleText: { color: "#CBD5E1", fontSize: 11, fontWeight: "800" },
  policyActions: { flexDirection: "row-reverse", alignItems: "center", gap: 9, marginBottom: 16 },
  policySaveButton: { flex: 1 },
  policyCancel: { borderWidth: 1, borderColor: "#475569", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12 },
  policyCancelText: { color: "#CBD5E1", fontSize: 11, fontWeight: "800" },
  policyCard: { backgroundColor: "#0D1328", borderWidth: 1, borderColor: "#24505A", borderRadius: 12, padding: 10, marginTop: 8 },
  policyCardTop: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "center", gap: 8 },
  policyCardLabel: { color: "#F8FAFC", fontSize: 12, fontWeight: "900" },
  policyKey: { color: "#67E8F9", fontSize: 10, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  policyCardDescription: { color: "#CBD5E1", fontSize: 10, lineHeight: 17, textAlign: "right", marginTop: 7 },
  policyCardActions: { flexDirection: "row-reverse", alignItems: "center", gap: 14, marginTop: 9 },
  policyState: { flex: 1, fontSize: 10, fontWeight: "800", textAlign: "right" },
  policyEdit: { color: "#A78BFA", fontSize: 10, fontWeight: "900" },
  policyDelete: { color: "#FDA4AF", fontSize: 10, fontWeight: "900" },
  rootPanel: { backgroundColor: "#171A2B", borderWidth: 1, borderColor: "#73511A", borderRadius: 17, padding: 13, marginBottom: 10 },
  rootHeader: { flexDirection: "row-reverse", alignItems: "flex-start", justifyContent: "space-between", gap: 10, marginBottom: 12 },
  rootTitle: { color: "#FDE68A", fontSize: 14, fontWeight: "900", textAlign: "right" },
  termTabs: { flexDirection: "row-reverse", alignItems: "center", gap: 8, marginBottom: 9 },
  termTab: { paddingHorizontal: 11, paddingVertical: 7, borderRadius: 10, borderWidth: 1, borderColor: "#27304D", backgroundColor: "#0F1424" },
  termTabActive: { borderColor: "#34D399", backgroundColor: "#12312A" },
  termTabText: { color: "#94A3B8", fontSize: 11, fontWeight: "800" },
  termTabTextActive: { color: "#6EE7B7" },
  termCwd: { flex: 1, color: "#64748B", fontSize: 9, textAlign: "left" },
  termLog: { height: 240, backgroundColor: "#05070F", borderWidth: 1, borderColor: "#1E2540", borderRadius: 12, padding: 9, marginBottom: 8 },
  termEmpty: { color: "#64748B", fontSize: 11, lineHeight: 18, textAlign: "right" },
  termLine: { color: "#E2E8F0", fontSize: 11, lineHeight: 17, textAlign: "left", direction: "ltr" },
  termLineCmd: { color: "#6EE7B7", fontWeight: "800" },
  termLineErr: { color: "#FDA4AF" },
  termLineMeta: { color: "#94A3B8", fontStyle: "italic" },
  termLineAsk: { color: "#C4B5FD", fontWeight: "800", textAlign: "right", direction: "rtl" },
  termChips: { flexDirection: "row-reverse", flexWrap: "wrap", gap: 6, marginBottom: 8 },
  termChip: { borderWidth: 1, borderColor: "#27304D", borderRadius: 9, paddingHorizontal: 9, paddingVertical: 5, backgroundColor: "#0F1424" },
  termChipText: { color: "#A7F3D0", fontSize: 10, fontWeight: "700" },
  termActions: { flexDirection: "row-reverse", gap: 8 },
  termRun: { flex: 1, marginTop: 0 },
  termStop: { marginTop: 0, paddingHorizontal: 16, borderWidth: 1, borderColor: "#FDA4AF", backgroundColor: "#2A1220" },
  termStopText: { color: "#FDA4AF", fontSize: 12, fontWeight: "900" },
  rootHint: { color: "#CBD5E1", fontSize: 10, lineHeight: 17, textAlign: "right", marginTop: 5 },
  rootInput: { minHeight: 94, backgroundColor: "#0A0D1F", borderWidth: 1, borderColor: "#73511A", borderRadius: 12, color: "#F8FAFC", padding: 13, marginBottom: 10, fontSize: 12, lineHeight: 18, textAlignVertical: "top" },
  rootCard: { backgroundColor: "#0D1328", borderWidth: 1, borderColor: "#73511A", borderRadius: 12, padding: 10, marginTop: 8 },
  rootCardTop: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "center" },
  rootCardStatus: { color: "#FDE68A", fontSize: 10, fontWeight: "900" },
  rootCardRisk: { color: "#FBBF24", fontSize: 10, fontWeight: "800" },
  rootCardSummary: { color: "#F8FAFC", fontSize: 12, fontWeight: "800", textAlign: "right", marginTop: 7 },
  rootCardMeta: { color: "#CBD5E1", fontSize: 10, lineHeight: 17, textAlign: "right", marginTop: 5 },
  rootCardActions: { flexDirection: "row-reverse", alignItems: "center", gap: 15, marginTop: 10 },
  rootApprove: { color: "#99F6E4", fontSize: 10, fontWeight: "900" },
  integrationHeading: { color: "#93C5FD", fontSize: 12, fontWeight: "900", textAlign: "right", marginTop: 14, marginBottom: 8 },
  patchPreview: { color: "#D8B4FE", backgroundColor: "#090D1D", borderWidth: 1, borderColor: "#4C1D95", borderRadius: 9, padding: 9, marginTop: 8, fontSize: 10, lineHeight: 16, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", textAlign: "left" },
  authThread: { gap: 8, marginBottom: 13 },
  assistantRow: { flexDirection: "row" },
  secretLabel: { flexDirection: "row-reverse", alignItems: "center", gap: 6, marginBottom: 7 },
  secretLabelText: { color: "#C4B5FD", fontSize: 9, fontWeight: "900" },
  codeToolbar: { flexDirection: "row-reverse", gap: 8, marginBottom: 8 },
  codeAction: { flexDirection: "row-reverse", alignItems: "center", gap: 6, borderWidth: 1, borderColor: "#7F3F63", backgroundColor: "#241026", borderRadius: 10, paddingHorizontal: 11, paddingVertical: 7 },
  codeActionText: { color: "#F9A8D4", fontSize: 10, fontWeight: "900" },
  treeRow: { flexDirection: "row-reverse", alignItems: "center", gap: 7, paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: "#202A4A" },
  treeName: { flex: 1, color: "#E2E8F0", fontSize: 11, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", textAlign: "right" },
  treeSize: { color: "#64748B", fontSize: 9 },
  codeFileBox: { marginTop: 10 },
  aiProviderRow: { flexDirection: "row-reverse", gap: 7, marginBottom: 10 },
  languageChip: { borderWidth: 1, borderColor: "#334155", backgroundColor: "#11162B", borderRadius: 10, paddingHorizontal: 11, paddingVertical: 7 },
  languageActive: { borderColor: "#38BDF8", backgroundColor: "#0B2533" },
  languageText: { color: "#94A3B8", fontSize: 10, fontWeight: "800" },
  languageTextActive: { color: "#BAE6FD" },
});
