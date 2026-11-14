import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenContainer } from "@/components/screen-container";
import { trpc } from "@/lib/trpc";
import { loadMessages } from "@/lib/zenox-storage";

type Tab = "gmail" | "drive";

export default function GoogleScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ google?: string; google_error?: string }>();
  const utils = trpc.useUtils();
  const status = trpc.google.status.useQuery(undefined, { retry: false });
  const [tab, setTab] = useState<Tab>("gmail");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [savingChat, setSavingChat] = useState(false);
  const [openMessageId, setOpenMessageId] = useState<string | null>(null);
  const [driveName, setDriveName] = useState("ZENOX-note.txt");
  const [driveText, setDriveText] = useState("");
  const [folderName, setFolderName] = useState("");
  const [renameName, setRenameName] = useState("");
  const [renameId, setRenameId] = useState<string | null>(null);
  const [shareEmail, setShareEmail] = useState("");
  const [shareId, setShareId] = useState<string | null>(null);

  const connected = Boolean(status.data?.connected);
  const configured = Boolean(status.data?.configured);

  const gmail = trpc.google.gmail.list.useQuery(
    { q: query.trim() || undefined, max: 12 },
    { enabled: connected && tab === "gmail", retry: false },
  );
  const drive = trpc.google.drive.list.useQuery(
    { q: query.trim() || undefined, max: 15 },
    { enabled: connected && tab === "drive", retry: false },
  );
  const sendMail = trpc.google.gmail.send.useMutation();
  const mailAction = trpc.google.gmail.action.useMutation();
  const message = trpc.google.gmail.get.useQuery(
    { id: openMessageId ?? "" },
    { enabled: Boolean(openMessageId), retry: false },
  );
  const saveText = trpc.google.drive.saveText.useMutation();
  const createFolder = trpc.google.drive.createFolder.useMutation();
  const updateDrive = trpc.google.drive.update.useMutation();
  const deleteDrive = trpc.google.drive.delete.useMutation();
  const shareDrive = trpc.google.drive.share.useMutation();
  const disconnect = trpc.google.disconnect.useMutation();

  useEffect(() => {
    if (params.google === "connected") {
      setNotice("تم ربط Gmail وDrive — الحساب جاهز للاستخدام.");
      void utils.google.status.invalidate();
    } else if (params.google_error) {
      setNotice(String(params.google_error));
    }
  }, [params.google, params.google_error, utils.google.status]);

  function connect() {
    if (Platform.OS !== "web") {
      setNotice("افتح ZENOX من المتصفح لإتمام ربط Google، ثم عُد للتطبيق.");
      return;
    }
    setNotice("");
    window.location.assign(`/api/google/start?return=${encodeURIComponent("/google")}`);
  }

  async function send() {
    setNotice("");
    try {
      await sendMail.mutateAsync({ to: to.trim(), subject: subject.trim(), body: body.trim() });
      setNotice("أُرسلت الرسالة من حسابك في Gmail.");
      setComposeOpen(false);
      setTo("");
      setSubject("");
      setBody("");
      await utils.google.gmail.list.invalidate();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "تعذر إرسال الرسالة.");
    }
  }

  async function saveChatToDrive() {
    if (savingChat) return;
    setSavingChat(true);
    setNotice("");
    try {
      const messages = (await loadMessages()) ?? [];
      if (!messages.length) {
        setNotice("لا توجد محادثة محفوظة بعد. ابدأ محادثة مع ZENOX ثم ارجع هنا.");
        return;
      }
      const text = messages
        .map((message) => `${message.role === "user" ? "أنت" : "ZENOX"}: ${message.text}`)
        .join("\n\n");
      const date = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      await saveText.mutateAsync({ name: `ZENOX-chat-${date}.txt`, text });
      setNotice("حُفظت المحادثة في Google Drive.");
      await utils.google.drive.list.invalidate();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "تعذر حفظ المحادثة في Drive.");
    } finally {
      setSavingChat(false);
    }
  }

  async function unlink() {
    await disconnect.mutateAsync();
    setNotice("فُصل حساب Google. يمكنك ربطه من جديد في أي وقت.");
    await utils.google.status.invalidate();
    await utils.google.gmail.list.invalidate();
    await utils.google.drive.list.invalidate();
  }

  async function actOnMessage(action: "read" | "unread" | "archive" | "unarchive" | "trash" | "untrash" | "delete") {
    if (!openMessageId) return;
    setNotice("");
    try {
      await mailAction.mutateAsync({ id: openMessageId, action });
      setNotice(action === "delete" ? "حُذفت الرسالة نهائيًا." : action === "trash" ? "نُقلت الرسالة إلى المهملات." : "تم تحديث الرسالة.");
      if (action === "delete" || action === "trash") setOpenMessageId(null);
      await utils.google.gmail.list.invalidate();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "تعذر تحديث الرسالة.");
    }
  }

  async function createNote() {
    if (!driveName.trim() || !driveText.trim()) {
      setNotice("اكتب اسم الملف ونصه أولًا.");
      return;
    }
    setNotice("");
    try {
      await saveText.mutateAsync({ name: driveName.trim(), text: driveText });
      setNotice("أُنشئ الملف في Google Drive.");
      setDriveText("");
      await utils.google.drive.list.invalidate();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "تعذر إنشاء الملف.");
    }
  }

  async function makeFolder() {
    if (!folderName.trim()) {
      setNotice("اكتب اسم المجلد أولًا.");
      return;
    }
    setNotice("");
    try {
      await createFolder.mutateAsync({ name: folderName.trim() });
      setNotice("أُنشئ المجلد في Google Drive.");
      setFolderName("");
      await utils.google.drive.list.invalidate();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "تعذر إنشاء المجلد.");
    }
  }

  async function renameFile() {
    if (!renameId || !renameName.trim()) {
      setNotice("اكتب الاسم الجديد أولًا.");
      return;
    }
    setNotice("");
    try {
      await updateDrive.mutateAsync({ id: renameId, name: renameName.trim() });
      setNotice("تغيّر اسم الملف.");
      setRenameId(null);
      setRenameName("");
      await utils.google.drive.list.invalidate();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "تعذر تغيير الاسم.");
    }
  }

  async function trashFile(id: string) {
    setNotice("");
    try {
      await updateDrive.mutateAsync({ id, trashed: true });
      setNotice("نُقل الملف إلى مهملات Drive.");
      await utils.google.drive.list.invalidate();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "تعذر نقل الملف للمهملات.");
    }
  }

  async function removeFile(id: string) {
    setNotice("");
    try {
      await deleteDrive.mutateAsync({ id });
      setNotice("حُذف الملف نهائيًا من Drive.");
      await utils.google.drive.list.invalidate();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "تعذر حذف الملف.");
    }
  }

  async function shareFile() {
    if (!shareId) return;
    setNotice("");
    try {
      await shareDrive.mutateAsync({ id: shareId, role: "reader", type: "user", emailAddress: shareEmail.trim() });
      setNotice("شاركت الملف بصلاحية قراءة.");
      setShareId(null);
      setShareEmail("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "تعذر مشاركة الملف.");
    }
  }

  function confirmDeleteFile(id: string) {
    if (Platform.OS === "web") {
      if (window.confirm("حذف الملف نهائيًا من Drive؟")) void removeFile(id);
      return;
    }
    Alert.alert("حذف نهائي", "سيُحذف الملف من Drive نهائيًا.", [
      { text: "إلغاء", style: "cancel" },
      { text: "حذف", style: "destructive", onPress: () => void removeFile(id) },
    ]);
  }

  function confirmDeleteMessage() {
    if (Platform.OS === "web") {
      if (window.confirm("حذف الرسالة نهائيًا من Gmail؟")) void actOnMessage("delete");
      return;
    }
    Alert.alert("حذف نهائي", "ستُحذف الرسالة من Gmail نهائيًا.", [
      { text: "إلغاء", style: "cancel" },
      { text: "حذف", style: "destructive", onPress: () => void actOnMessage("delete") },
    ]);
  }

  const activeList = tab === "gmail" ? gmail : drive;
  const listBusy = activeList.isFetching;

  return (
    <ScreenContainer style={styles.screen}>
      <ScrollView contentContainerStyle={[styles.container, { paddingTop: Math.max(insets.top, 20) }]} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <View style={styles.headerIcon}><Ionicons name="logo-google" size={22} color="#F8FAFC" /></View>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>ZENOX / GOOGLE</Text>
            <Text style={styles.title}>Gmail & Drive</Text>
            <Text style={styles.subtitle}>بريدك وملفاتك داخل التطبيق، بصلاحيتك أنت.</Text>
          </View>
        </View>

        {notice ? <View style={styles.notice}><Ionicons name="information-circle-outline" size={17} color="#67E8F9" /><Text style={styles.noticeText}>{notice}</Text></View> : null}

        {status.isLoading ? <View style={styles.loading}><ActivityIndicator color="#A78BFA" /><Text style={styles.muted}>أفحص اتصال Google…</Text></View> : null}

        {!status.isLoading && !configured ? (
          <View style={styles.panel}>
            <View style={styles.panelTop}><Ionicons name="construct-outline" size={20} color="#FBBF24" /><Text style={styles.panelTitle}>ربط Google يحتاج إعدادًا لمرة واحدة</Text></View>
            <Text style={styles.panelText}>التطبيق جاهز للربط، لكن مشروع Google Cloud لم يُضبط بعد. أنشئ OAuth Client من نوع Web application ثم أضف المفتاحين إلى أسرار المشروع.</Text>
            <View style={styles.steps}>
              <Text style={styles.step}>1. فعّل Gmail API وGoogle Drive API في Google Cloud Console.</Text>
              <Text style={styles.step}>2. أضف هذا العنوان في Authorized redirect URIs:</Text>
              <Text selectable style={styles.code}>{status.data?.redirectUri ?? "/api/google/callback"}</Text>
              <Text style={styles.step}>3. أضف <Text style={styles.inlineCode}>GOOGLE_CLIENT_ID</Text> و<Text style={styles.inlineCode}>GOOGLE_CLIENT_SECRET</Text> إلى أسرار الخادم، ثم أعد تشغيل الخدمة.</Text>
            </View>
            <Pressable style={styles.secondaryButton} onPress={() => void status.refetch()}><Ionicons name="refresh-outline" size={17} color="#C4B5FD" /><Text style={styles.secondaryText}>إعادة الفحص</Text></Pressable>
          </View>
        ) : null}

        {!status.isLoading && configured && !connected ? (
          <View style={styles.panel}>
            <View style={styles.panelTop}><Ionicons name="shield-checkmark-outline" size={20} color="#2DD4BF" /><Text style={styles.panelTitle}>اربط حسابك مرة واحدة</Text></View>
            <Text style={styles.panelText}>سأطلب التحكم الكامل في Gmail وDrive: قراءة الرسائل وإرسالها وأرشفتها وحذفها، وإدارة ملفات Drive ومجلداتها ومشاركتها. لا تُحفظ كلمة مرور Google أبدًا.</Text>
            <View style={styles.scopeRow}><Text style={styles.scope}>Gmail تحكم كامل</Text><Text style={styles.scope}>Gmail إرسال</Text><Text style={styles.scope}>Drive تحكم كامل</Text></View>
            <Pressable style={styles.primaryButton} onPress={connect}><Ionicons name="logo-google" size={18} color="#0A0D1F" /><Text style={styles.primaryText}>ربط Gmail وDrive</Text></Pressable>
            <Text style={styles.hint}>إن ظهرت رسالة «Google hasn’t verified this app»، اختر Advanced ثم المتابعة. أضف بريدك كـ Test user في مشروعك.</Text>
          </View>
        ) : null}

        {connected ? (
          <>
            <View style={styles.account}>
              <View style={styles.accountAvatar}><Ionicons name="mail" size={19} color="#0A0D1F" /></View>
              <View style={styles.accountCopy}><Text style={styles.accountEmail}>{status.data?.email}</Text><Text style={styles.accountState}>متصل · Gmail + Drive</Text></View>
              <Pressable onPress={() => void unlink()} style={styles.unlink}><Text style={styles.unlinkText}>فصل</Text></Pressable>
            </View>

            {status.data?.needsReconnect ? (
              <View style={styles.warning}>
                <View style={styles.panelTop}><Ionicons name="warning-outline" size={19} color="#FBBF24" /><Text style={styles.warningTitle}>أعد الربط مرة واحدة لتفعيل التحكم الكامل</Text></View>
                <Text style={styles.panelText}>الربط الحالي أُنجز بصلاحيات قديمة (أو انتهى رمزه). أعد الربط لمنح Gmail وDrive الصلاحيات الكاملة.</Text>
                <Pressable style={styles.secondaryButton} onPress={connect}><Ionicons name="refresh-outline" size={17} color="#C4B5FD" /><Text style={styles.secondaryText}>إعادة ربط Google</Text></Pressable>
              </View>
            ) : null}

            <View style={styles.segment}>
              <Pressable onPress={() => { setTab("gmail"); setQuery(""); }} style={[styles.segmentButton, tab === "gmail" && styles.segmentActive]}><Ionicons name="mail-outline" size={16} color={tab === "gmail" ? "#0A0D1F" : "#94A3B8"} /><Text style={[styles.segmentText, tab === "gmail" && styles.segmentTextActive]}>Gmail</Text></Pressable>
              <Pressable onPress={() => { setTab("drive"); setQuery(""); }} style={[styles.segmentButton, tab === "drive" && styles.segmentActive]}><Ionicons name="folder-open-outline" size={16} color={tab === "drive" ? "#0A0D1F" : "#94A3B8"} /><Text style={[styles.segmentText, tab === "drive" && styles.segmentTextActive]}>Drive</Text></Pressable>
            </View>

            <View style={styles.searchRow}>
              <TextInput value={query} onChangeText={setQuery} placeholder={tab === "gmail" ? "ابحث في البريد…" : "ابحث في الملفات…"} placeholderTextColor="#64748B" style={styles.search} textAlign="right" />
              <Pressable style={styles.searchIcon} onPress={() => void activeList.refetch()}><Ionicons name="refresh" size={17} color="#A78BFA" /></Pressable>
            </View>

            {tab === "gmail" ? (
              <>
                {openMessageId ? (
                  <View style={styles.panel}>
                    <View style={styles.panelTop}>
                      <Ionicons name="mail-open-outline" size={19} color="#67E8F9" />
                      <Text style={styles.panelTitle}>الرسالة</Text>
                      <Pressable onPress={() => setOpenMessageId(null)} style={styles.closeButton}><Ionicons name="close" size={17} color="#94A3B8" /></Pressable>
                    </View>
                    {message.isLoading ? <View style={styles.loading}><ActivityIndicator color="#A78BFA" /></View> : null}
                    {message.error ? <Text style={styles.error}>{message.error.message}</Text> : null}
                    {message.data ? (
                      <>
                        <Text style={styles.messageSubject}>{message.data.subject}</Text>
                        <Text style={styles.messageMeta}>من: {message.data.from || "—"}</Text>
                        <Text style={styles.messageMeta}>إلى: {message.data.to || "—"}</Text>
                        <ScrollView style={styles.messageBody} nestedScrollEnabled>
                          <Text selectable style={styles.messageText}>{message.data.text || "لا يوجد نص عادي في هذه الرسالة."}</Text>
                        </ScrollView>
                        <View style={styles.actionRow}>
                          <Pressable style={styles.smallAction} onPress={() => void actOnMessage(message.data?.unread ? "read" : "unread")} disabled={mailAction.isPending}><Ionicons name={message.data.unread ? "mail-open-outline" : "mail-unread-outline"} size={15} color="#67E8F9" /><Text style={styles.smallActionText}>{message.data.unread ? "مقروءة" : "غير مقروءة"}</Text></Pressable>
                          <Pressable style={styles.smallAction} onPress={() => void actOnMessage("archive")} disabled={mailAction.isPending}><Ionicons name="archive-outline" size={15} color="#C4B5FD" /><Text style={styles.smallActionText}>أرشفة</Text></Pressable>
                          <Pressable style={styles.smallAction} onPress={() => void actOnMessage("trash")} disabled={mailAction.isPending}><Ionicons name="trash-outline" size={15} color="#FBBF24" /><Text style={styles.smallActionText}>مهملات</Text></Pressable>
                          <Pressable style={styles.smallAction} onPress={confirmDeleteMessage} disabled={mailAction.isPending}><Ionicons name="close-circle-outline" size={15} color="#FDA4AF" /><Text style={[styles.smallActionText, styles.dangerText]}>حذف</Text></Pressable>
                          <Pressable style={styles.smallAction} onPress={() => void Linking.openURL(message.data?.url ?? "https://mail.google.com")}><Ionicons name="open-outline" size={15} color="#94A3B8" /><Text style={styles.smallActionText}>Gmail</Text></Pressable>
                        </View>
                      </>
                    ) : null}
                  </View>
                ) : null}

                <Pressable style={styles.composeButton} onPress={() => setComposeOpen((value) => !value)}><Ionicons name={composeOpen ? "close" : "create-outline"} size={17} color="#99F6E4" /><Text style={styles.composeText}>{composeOpen ? "إغلاق" : "رسالة جديدة"}</Text></Pressable>
                {composeOpen ? (
                  <View style={styles.panel}>
                    <TextInput value={to} onChangeText={setTo} placeholder="إلى: name@gmail.com" placeholderTextColor="#64748B" style={styles.input} autoCapitalize="none" keyboardType="email-address" textAlign="right" />
                    <TextInput value={subject} onChangeText={setSubject} placeholder="الموضوع" placeholderTextColor="#64748B" style={styles.input} textAlign="right" />
                    <TextInput value={body} onChangeText={setBody} placeholder="اكتب رسالتك…" placeholderTextColor="#64748B" style={[styles.input, styles.bodyInput]} multiline textAlign="right" />
                    <Pressable style={styles.primaryButton} onPress={() => void send()} disabled={sendMail.isPending}><Text style={styles.primaryText}>{sendMail.isPending ? "أرسل…" : "إرسال من Gmail"}</Text></Pressable>
                  </View>
                ) : null}
              </>
            ) : (
              <>
                <Pressable style={styles.composeButton} onPress={() => void saveChatToDrive()} disabled={savingChat}><Ionicons name="cloud-upload-outline" size={17} color="#99F6E4" /><Text style={styles.composeText}>{savingChat ? "أحفظ المحادثة…" : "احفظ المحادثة في Drive"}</Text></Pressable>

                <View style={styles.panel}>
                  <View style={styles.panelTop}><Ionicons name="add-circle-outline" size={18} color="#C4B5FD" /><Text style={styles.panelTitle}>إنشاء في Drive</Text></View>
                  <TextInput value={driveName} onChangeText={setDriveName} placeholder="اسم الملف مع الامتداد" placeholderTextColor="#64748B" style={styles.input} textAlign="right" />
                  <TextInput value={driveText} onChangeText={setDriveText} placeholder="نص الملف…" placeholderTextColor="#64748B" style={[styles.input, styles.bodyInput]} multiline textAlign="right" />
                  <Pressable style={styles.primaryButton} onPress={() => void createNote()} disabled={saveText.isPending}><Ionicons name="document-text-outline" size={17} color="#0A0D1F" /><Text style={styles.primaryText}>{saveText.isPending ? "أنشئ…" : "إنشاء ملف نصي"}</Text></Pressable>
                  <View style={styles.folderRow}>
                    <TextInput value={folderName} onChangeText={setFolderName} placeholder="اسم مجلد جديد" placeholderTextColor="#64748B" style={[styles.input, styles.folderInput]} textAlign="right" />
                    <Pressable style={styles.folderButton} onPress={() => void makeFolder()} disabled={createFolder.isPending}><Ionicons name="folder-open-outline" size={16} color="#99F6E4" /><Text style={styles.folderButtonText}>مجلد</Text></Pressable>
                  </View>
                </View>

                {renameId ? (
                  <View style={styles.panel}>
                    <View style={styles.panelTop}><Ionicons name="pencil-outline" size={18} color="#FBBF24" /><Text style={styles.panelTitle}>تغيير اسم الملف</Text><Pressable onPress={() => setRenameId(null)} style={styles.closeButton}><Ionicons name="close" size={17} color="#94A3B8" /></Pressable></View>
                    <TextInput value={renameName} onChangeText={setRenameName} placeholder="الاسم الجديد" placeholderTextColor="#64748B" style={styles.input} textAlign="right" />
                    <Pressable style={styles.primaryButton} onPress={() => void renameFile()} disabled={updateDrive.isPending}><Text style={styles.primaryText}>حفظ الاسم</Text></Pressable>
                  </View>
                ) : null}

                {shareId ? (
                  <View style={styles.panel}>
                    <View style={styles.panelTop}><Ionicons name="share-social-outline" size={18} color="#67E8F9" /><Text style={styles.panelTitle}>مشاركة الملف</Text><Pressable onPress={() => setShareId(null)} style={styles.closeButton}><Ionicons name="close" size={17} color="#94A3B8" /></Pressable></View>
                    <TextInput value={shareEmail} onChangeText={setShareEmail} placeholder="بريد الشخص" placeholderTextColor="#64748B" style={styles.input} autoCapitalize="none" keyboardType="email-address" textAlign="right" />
                    <Text style={styles.hint}>ستُمنح صلاحية القراءة فقط. يمكنك تغييرها لاحقًا من Google Drive.</Text>
                    <Pressable style={styles.primaryButton} onPress={() => void shareFile()} disabled={shareDrive.isPending}><Text style={styles.primaryText}>مشاركة للقراءة</Text></Pressable>
                  </View>
                ) : null}
              </>
            )}

            {listBusy ? <View style={styles.loading}><ActivityIndicator color="#A78BFA" /></View> : null}
            {!listBusy && activeList.error ? <Text style={styles.error}>{activeList.error.message}</Text> : null}
            {!listBusy && tab === "gmail" && !gmail.data?.length && !gmail.error ? <Text style={styles.muted}>لا توجد رسائل مطابقة.</Text> : null}
            {!listBusy && tab === "drive" && !drive.data?.length && !drive.error ? <Text style={styles.muted}>لا توجد ملفات مطابقة.</Text> : null}

            {tab === "gmail"
              ? (gmail.data ?? []).map((message) => (
                  <Pressable key={message.id} style={styles.item} onPress={() => setOpenMessageId(message.id)}>
                    <View style={styles.itemIcon}><Ionicons name={message.unread ? "mail-unread" : "mail-open-outline"} size={17} color={message.unread ? "#FBBF24" : "#67E8F9"} /></View>
                    <View style={styles.itemCopy}>
                      <Text style={styles.itemTitle} numberOfLines={1}>{message.subject}</Text>
                      <Text style={styles.itemMeta} numberOfLines={1}>{message.from}</Text>
                      <Text style={styles.itemSnippet} numberOfLines={2}>{message.snippet}</Text>
                    </View>
                  </Pressable>
                ))
              : (drive.data ?? []).map((file) => (
                  <View key={file.id} style={styles.fileItem}>
                    <Pressable style={styles.itemMain} onPress={() => void Linking.openURL(file.url)}>
                      <View style={styles.itemIcon}><Ionicons name={file.mimeType.includes("folder") ? "folder" : "document-text-outline"} size={17} color="#C4B5FD" /></View>
                      <View style={styles.itemCopy}>
                        <Text style={styles.itemTitle} numberOfLines={1}>{file.name}</Text>
                        <Text style={styles.itemMeta}>{file.modifiedTime ? new Date(file.modifiedTime).toLocaleString("ar-EG") : file.mimeType}</Text>
                      </View>
                    </Pressable>
                    <View style={styles.fileActions}>
                      <Pressable accessibilityLabel="فتح" onPress={() => void Linking.openURL(file.url)} style={styles.fileAction}><Ionicons name="open-outline" size={16} color="#94A3B8" /></Pressable>
                      <Pressable accessibilityLabel="تغيير الاسم" onPress={() => { setRenameId(file.id); setRenameName(file.name); }} style={styles.fileAction}><Ionicons name="pencil-outline" size={15} color="#FBBF24" /></Pressable>
                      <Pressable accessibilityLabel="مشاركة" onPress={() => { setShareId(file.id); setShareEmail(""); }} style={styles.fileAction}><Ionicons name="share-social-outline" size={15} color="#67E8F9" /></Pressable>
                      <Pressable accessibilityLabel="نقل إلى المهملات" onPress={() => void trashFile(file.id)} style={styles.fileAction}><Ionicons name="trash-outline" size={15} color="#FDA4AF" /></Pressable>
                      <Pressable accessibilityLabel="حذف نهائي" onPress={() => confirmDeleteFile(file.id)} style={styles.fileAction}><Ionicons name="close-circle-outline" size={16} color="#FDA4AF" /></Pressable>
                    </View>
                  </View>
                ))}
          </>
        ) : null}
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0A0D1F" },
  container: { paddingHorizontal: 18, paddingBottom: 36, gap: 12, maxWidth: 720, width: "100%", alignSelf: "center" },
  header: { flexDirection: "row-reverse", alignItems: "center", gap: 12, paddingVertical: 8 },
  headerIcon: { width: 48, height: 48, borderRadius: 16, backgroundColor: "#2563EB", alignItems: "center", justifyContent: "center" },
  headerCopy: { flex: 1 },
  eyebrow: { color: "#67E8F9", fontSize: 9, fontWeight: "900", letterSpacing: 1.4, textAlign: "right" },
  title: { color: "#F8FAFC", fontSize: 24, fontWeight: "900", textAlign: "right" },
  subtitle: { color: "#8190AD", fontSize: 11, marginTop: 3, textAlign: "right" },
  notice: { flexDirection: "row-reverse", alignItems: "flex-start", gap: 8, backgroundColor: "#0D2528", borderWidth: 1, borderColor: "#225E5B", borderRadius: 13, padding: 11 },
  noticeText: { flex: 1, color: "#99F6E4", fontSize: 11, lineHeight: 18, textAlign: "right" },
  loading: { alignItems: "center", gap: 8, paddingVertical: 26 },
  muted: { color: "#8190AD", fontSize: 11, textAlign: "center", paddingVertical: 12 },
  error: { color: "#FDA4AF", fontSize: 11, lineHeight: 18, textAlign: "right", padding: 10, backgroundColor: "#2A1118", borderRadius: 10 },
  panel: { backgroundColor: "#11162B", borderWidth: 1, borderColor: "#303B61", borderRadius: 18, padding: 15, gap: 11 },
  warning: { backgroundColor: "#241B0B", borderWidth: 1, borderColor: "#6B4E16", borderRadius: 15, padding: 14, gap: 10 },
  warningTitle: { flex: 1, color: "#FDE68A", fontSize: 12, fontWeight: "900", textAlign: "right" },
  closeButton: { width: 30, height: 30, borderRadius: 9, backgroundColor: "#0A0D1F", alignItems: "center", justifyContent: "center" },
  messageSubject: { color: "#F8FAFC", fontSize: 16, fontWeight: "900", textAlign: "right" },
  messageMeta: { color: "#8190AD", fontSize: 10, textAlign: "right" },
  messageBody: { maxHeight: 230, backgroundColor: "#0A0D1F", borderWidth: 1, borderColor: "#27304D", borderRadius: 11, padding: 11 },
  messageText: { color: "#D7DEEA", fontSize: 11, lineHeight: 19, textAlign: "right" },
  actionRow: { flexDirection: "row-reverse", flexWrap: "wrap", gap: 6 },
  smallAction: { flexDirection: "row-reverse", alignItems: "center", gap: 4, borderWidth: 1, borderColor: "#303B61", backgroundColor: "#0A0D1F", borderRadius: 9, paddingHorizontal: 8, paddingVertical: 6 },
  smallActionText: { color: "#C4B5FD", fontSize: 9, fontWeight: "800" },
  dangerText: { color: "#FDA4AF" },
  folderRow: { flexDirection: "row-reverse", alignItems: "center", gap: 7 },
  folderInput: { flex: 1 },
  folderButton: { flexDirection: "row-reverse", alignItems: "center", gap: 5, height: 44, borderWidth: 1, borderColor: "#225E5B", backgroundColor: "#0D2528", borderRadius: 10, paddingHorizontal: 10 },
  folderButtonText: { color: "#99F6E4", fontSize: 10, fontWeight: "800" },
  fileItem: { flexDirection: "row-reverse", alignItems: "center", gap: 7, backgroundColor: "#11162B", borderWidth: 1, borderColor: "#27304D", borderRadius: 13, padding: 9 },
  itemMain: { flex: 1, flexDirection: "row-reverse", alignItems: "center", gap: 10 },
  fileActions: { flexDirection: "row-reverse", alignItems: "center", gap: 2 },
  fileAction: { width: 27, height: 30, alignItems: "center", justifyContent: "center" },

  panelTop: { flexDirection: "row-reverse", alignItems: "center", gap: 8 },
  panelTitle: { flex: 1, color: "#F8FAFC", fontSize: 14, fontWeight: "900", textAlign: "right" },
  panelText: { color: "#A8B3C9", fontSize: 11, lineHeight: 19, textAlign: "right" },
  steps: { gap: 7 },
  step: { color: "#A8B3C9", fontSize: 11, lineHeight: 18, textAlign: "right" },
  code: { color: "#99F6E4", backgroundColor: "#0A0D1F", borderWidth: 1, borderColor: "#27304D", borderRadius: 9, padding: 9, fontSize: 10, textAlign: "left" },
  inlineCode: { color: "#C4B5FD", fontWeight: "800" },
  scopeRow: { flexDirection: "row-reverse", flexWrap: "wrap", gap: 6 },
  scope: { color: "#C4B5FD", backgroundColor: "#1B1538", borderWidth: 1, borderColor: "#47327D", borderRadius: 99, paddingHorizontal: 9, paddingVertical: 5, fontSize: 9, fontWeight: "800" },
  primaryButton: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 8, height: 48, backgroundColor: "#A78BFA", borderRadius: 12 },
  primaryText: { color: "#0A0D1F", fontSize: 13, fontWeight: "900" },
  secondaryButton: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 7, height: 43, borderWidth: 1, borderColor: "#47327D", borderRadius: 11, backgroundColor: "#151033" },
  secondaryText: { color: "#C4B5FD", fontSize: 12, fontWeight: "800" },
  hint: { color: "#64748B", fontSize: 9, lineHeight: 15, textAlign: "right" },
  account: { flexDirection: "row-reverse", alignItems: "center", gap: 10, backgroundColor: "#11162B", borderWidth: 1, borderColor: "#303B61", borderRadius: 15, padding: 12 },
  accountAvatar: { width: 38, height: 38, borderRadius: 12, backgroundColor: "#67E8F9", alignItems: "center", justifyContent: "center" },
  accountCopy: { flex: 1 },
  accountEmail: { color: "#F8FAFC", fontSize: 12, fontWeight: "800", textAlign: "right" },
  accountState: { color: "#2DD4BF", fontSize: 9, fontWeight: "700", marginTop: 3, textAlign: "right" },
  unlink: { borderWidth: 1, borderColor: "#5B2733", borderRadius: 9, paddingHorizontal: 10, paddingVertical: 6 },
  unlinkText: { color: "#FDA4AF", fontSize: 10, fontWeight: "800" },
  segment: { flexDirection: "row-reverse", gap: 5, backgroundColor: "#11162B", borderWidth: 1, borderColor: "#27304D", borderRadius: 12, padding: 4 },
  segmentButton: { flex: 1, flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 6, height: 36, borderRadius: 9 },
  segmentActive: { backgroundColor: "#A78BFA" },
  segmentText: { color: "#94A3B8", fontSize: 12, fontWeight: "800" },
  segmentTextActive: { color: "#0A0D1F" },
  searchRow: { flexDirection: "row-reverse", alignItems: "center", gap: 7 },
  search: { flex: 1, height: 44, backgroundColor: "#11162B", borderWidth: 1, borderColor: "#27304D", borderRadius: 11, paddingHorizontal: 12, color: "#F8FAFC", fontSize: 12 },
  searchIcon: { width: 44, height: 44, borderRadius: 11, backgroundColor: "#17113A", borderWidth: 1, borderColor: "#303B61", alignItems: "center", justifyContent: "center" },
  composeButton: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 7, height: 42, borderWidth: 1, borderColor: "#225E5B", backgroundColor: "#0D2528", borderRadius: 11 },
  composeText: { color: "#99F6E4", fontSize: 11, fontWeight: "800" },
  input: { height: 44, backgroundColor: "#0A0D1F", borderWidth: 1, borderColor: "#27304D", borderRadius: 10, paddingHorizontal: 11, color: "#F8FAFC", fontSize: 12 },
  bodyInput: { height: 100, paddingTop: 11, textAlignVertical: "top" },
  item: { flexDirection: "row-reverse", alignItems: "center", gap: 10, backgroundColor: "#11162B", borderWidth: 1, borderColor: "#27304D", borderRadius: 13, padding: 11 },
  itemIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: "#0A0D1F", alignItems: "center", justifyContent: "center" },
  itemCopy: { flex: 1 },
  itemTitle: { color: "#F8FAFC", fontSize: 12, fontWeight: "800", textAlign: "right" },
  itemMeta: { color: "#8190AD", fontSize: 9, marginTop: 3, textAlign: "right" },
  itemSnippet: { color: "#64748B", fontSize: 9, lineHeight: 14, marginTop: 3, textAlign: "right" },
});
