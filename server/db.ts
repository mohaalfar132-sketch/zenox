import { and, desc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { randomUUID } from "node:crypto";
import { apiKeyRefs, deviceAuditLogs, deviceSessions, externalConnections, fileChangeRequests, InsertApiKeyRef, InsertDeviceSession, InsertExternalConnection, InsertFileChangeRequest, InsertOwnerPolicy, InsertRootAuditLog, InsertRootChangeRequest, InsertUser, integrationAuditLogs, llmKeys, ownerCredentials, ownerPolicies, rootAuditLogs, rootChangeRequests, users } from "../drizzle/schema";
import { createConsentToken, hashConsentToken, type DeviceCapability } from "./device-policy";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch {
      console.warn("[Database] Failed to connect");
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId || (ENV.ownerEmail && user.email?.toLowerCase() === ENV.ownerEmail.toLowerCase())) {
      values.role = "admin";
      updateSet.role = "admin";
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user");
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function createDeviceSession(input: {
  ownerOpenId: string;
  deviceId: string;
  deviceName: string;
  platform: string;
  capabilities: DeviceCapability[];
  expiresAt: Date;
}) {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة لإنشاء جلسة الجهاز");

  const sessionId = `ds_${randomUUID()}`;
  const consentToken = createConsentToken();
  const values: InsertDeviceSession = {
    sessionId,
    ownerOpenId: input.ownerOpenId,
    deviceId: input.deviceId,
    deviceName: input.deviceName,
    platform: input.platform,
    capabilities: JSON.stringify(input.capabilities),
    consentTokenHash: hashConsentToken(consentToken),
    status: "pending",
    expiresAt: input.expiresAt,
  };
  await db.insert(deviceSessions).values(values);
  return { sessionId, consentToken, expiresAt: input.expiresAt };
}

export async function acceptDeviceSession(input: { consentToken: string; deviceId: string; deviceName: string; platform: string }) {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة لقبول جلسة الجهاز");

  const [session] = await db.select().from(deviceSessions).where(eq(deviceSessions.consentTokenHash, hashConsentToken(input.consentToken))).limit(1);
  if (!session || session.status !== "pending" || session.expiresAt.getTime() <= Date.now()) {
    throw new Error("طلب الموافقة غير صالح أو منتهٍ");
  }
  if (session.deviceId !== input.deviceId) throw new Error("الجهاز لا يطابق طلب الموافقة");

  await db.update(deviceSessions).set({ status: "active", deviceName: input.deviceName, platform: input.platform, acceptedAt: new Date() }).where(eq(deviceSessions.sessionId, session.sessionId));
  return { sessionId: session.sessionId, sessionToken: input.consentToken, ownerOpenId: session.ownerOpenId, capabilities: session.capabilities, expiresAt: session.expiresAt };
}

export async function authorizeDeviceAction(input: { sessionId: string; sessionToken: string; capability: DeviceCapability; action: string }) {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة للتحقق من جلسة الجهاز");

  const [session] = await db.select().from(deviceSessions).where(eq(deviceSessions.sessionId, input.sessionId)).limit(1);
  const valid = Boolean(session && session.status === "active" && session.expiresAt.getTime() > Date.now() && hashConsentToken(input.sessionToken) === session.consentTokenHash && JSON.parse(session.capabilities).includes(input.capability));
  if (!session) throw new Error("جلسة الجهاز غير موجودة");

  await db.insert(deviceAuditLogs).values({ sessionId: session.sessionId, ownerOpenId: session.ownerOpenId, deviceId: session.deviceId, capability: input.capability, action: input.action.slice(0, 255), result: valid ? "allowed" : "denied" });
  if (!valid) throw new Error("الصلاحية غير متاحة أو انتهت جلسة الجهاز");
  return { allowed: true as const, deviceId: session.deviceId };
}

export async function endDeviceSession(input: { sessionId: string; sessionToken: string }) {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة لإنهاء جلسة الجهاز");
  const [session] = await db.select().from(deviceSessions).where(eq(deviceSessions.sessionId, input.sessionId)).limit(1);
  const valid = Boolean(session && (session.status === "active" || session.status === "pending") && hashConsentToken(input.sessionToken) === session.consentTokenHash);
  if (!session || !valid) throw new Error("جلسة الجهاز غير صالحة أو منتهية");
  await db.update(deviceSessions).set({ status: "revoked", revokedAt: new Date() }).where(eq(deviceSessions.sessionId, session.sessionId));
  await db.insert(deviceAuditLogs).values({ sessionId: session.sessionId, ownerOpenId: session.ownerOpenId, deviceId: session.deviceId, capability: "device.session.end", action: "انتهى الجهاز من الجلسة", result: "allowed" });
  return { ended: true as const };
}

export async function revokeDeviceSession(ownerOpenId: string, sessionId: string) {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة لإلغاء جلسة الجهاز");
  await db.update(deviceSessions).set({ status: "revoked", revokedAt: new Date() }).where(and(eq(deviceSessions.sessionId, sessionId), eq(deviceSessions.ownerOpenId, ownerOpenId)));
  return { revoked: true as const };
}

export async function listDeviceSessions(ownerOpenId: string) {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة لعرض جلسات الأجهزة");
  return db.select({
    sessionId: deviceSessions.sessionId,
    deviceId: deviceSessions.deviceId,
    deviceName: deviceSessions.deviceName,
    platform: deviceSessions.platform,
    capabilities: deviceSessions.capabilities,
    status: deviceSessions.status,
    expiresAt: deviceSessions.expiresAt,
    createdAt: deviceSessions.createdAt,
    acceptedAt: deviceSessions.acceptedAt,
    revokedAt: deviceSessions.revokedAt,
  }).from(deviceSessions).where(eq(deviceSessions.ownerOpenId, ownerOpenId)).orderBy(desc(deviceSessions.createdAt)).limit(50);
}

export async function listOwnerPolicies(ownerOpenId: string) {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة لعرض الصلاحيات");
  return db.select().from(ownerPolicies).where(eq(ownerPolicies.ownerOpenId, ownerOpenId)).orderBy(desc(ownerPolicies.updatedAt));
}

export async function upsertOwnerPolicy(input: {
  ownerOpenId: string;
  id?: number;
  policyKey: string;
  label: string;
  description: string;
  enabled: boolean;
}) {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة لحفظ الصلاحية");
  const values: InsertOwnerPolicy = {
    ownerOpenId: input.ownerOpenId,
    policyKey: input.policyKey,
    label: input.label,
    description: input.description,
    enabled: input.enabled ? 1 : 0,
  };
  if (input.id) {
    await db.update(ownerPolicies).set({
      policyKey: values.policyKey,
      label: values.label,
      description: values.description,
      enabled: values.enabled,
    }).where(and(eq(ownerPolicies.id, input.id), eq(ownerPolicies.ownerOpenId, input.ownerOpenId)));
    return { id: input.id, updated: true as const };
  }
  const result = await db.insert(ownerPolicies).values(values);
  return { id: Number(result[0].insertId), created: true as const };
}

export async function deleteOwnerPolicy(ownerOpenId: string, id: number) {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة لحذف الصلاحية");
  await db.delete(ownerPolicies).where(and(eq(ownerPolicies.id, id), eq(ownerPolicies.ownerOpenId, ownerOpenId)));
  return { deleted: true as const };
}

export async function createRootChangeRequest(input: InsertRootChangeRequest) {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة لحفظ طلب Root Manager");
  const result = await db.insert(rootChangeRequests).values(input);
  return { id: Number(result[0].insertId) };
}

export async function listRootChangeRequests(ownerOpenId: string) {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة لعرض طلبات Root Manager");
  return db.select().from(rootChangeRequests).where(eq(rootChangeRequests.ownerOpenId, ownerOpenId)).orderBy(desc(rootChangeRequests.updatedAt)).limit(50);
}

export async function updateRootChangeRequest(ownerOpenId: string, id: number, status: "approved" | "cancelled", approvedAt?: Date) {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة لتحديث طلب Root Manager");
  const allowedCurrentStatuses = status === "approved" ? (["awaiting_approval"] as const) : (["awaiting_approval", "approved"] as const);
  const result = await db.update(rootChangeRequests).set({ status, approvedAt }).where(and(eq(rootChangeRequests.id, id), eq(rootChangeRequests.ownerOpenId, ownerOpenId), inArray(rootChangeRequests.status, allowedCurrentStatuses)));
  if (!result[0]?.affectedRows) throw new Error("طلب Root Manager غير موجود أو لا يسمح وضعه الحالي بهذا الانتقال");
  return { updated: true as const };
}

export async function addRootAuditLog(input: InsertRootAuditLog) {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة لتسجيل Root Manager");
  await db.insert(rootAuditLogs).values(input);
}

export async function listExternalConnections(ownerOpenId: string) {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة لعرض الاتصالات الخارجية");
  return db.select().from(externalConnections).where(eq(externalConnections.ownerOpenId, ownerOpenId)).orderBy(desc(externalConnections.updatedAt)).limit(50);
}

export async function getExternalConnection(ownerOpenId: string, id: number) {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة لقراءة الاتصال الخارجي");
  const [connection] = await db.select().from(externalConnections).where(and(eq(externalConnections.id, id), eq(externalConnections.ownerOpenId, ownerOpenId))).limit(1);
  if (!connection) throw new Error("الاتصال الخارجي غير موجود أو لا يخص هذا ZENOX");
  return connection;
}

export async function upsertExternalConnection(input: InsertExternalConnection & { id?: number }) {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة لحفظ الاتصال الخارجي");
  if (input.id) {
    await db.update(externalConnections).set({ label: input.label, kind: input.kind, host: input.host, databaseName: input.databaseName, username: input.username, secretRef: input.secretRef, sslRequired: input.sslRequired, enabled: input.enabled }).where(and(eq(externalConnections.id, input.id), eq(externalConnections.ownerOpenId, input.ownerOpenId)));
    return { id: input.id, updated: true as const };
  }
  const result = await db.insert(externalConnections).values(input);
  return { id: Number(result[0].insertId), created: true as const };
}

export async function deleteExternalConnection(ownerOpenId: string, id: number) {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة لحذف الاتصال الخارجي");
  await db.delete(externalConnections).where(and(eq(externalConnections.id, id), eq(externalConnections.ownerOpenId, ownerOpenId)));
  return { deleted: true as const };
}

export async function listApiKeyRefs(ownerOpenId: string) {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة لعرض مراجع المفاتيح");
  return db.select().from(apiKeyRefs).where(eq(apiKeyRefs.ownerOpenId, ownerOpenId)).orderBy(desc(apiKeyRefs.updatedAt)).limit(50);
}

export async function createApiKeyRef(input: InsertApiKeyRef) {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة لحفظ مرجع المفتاح");
  const result = await db.insert(apiKeyRefs).values(input);
  return { id: Number(result[0].insertId) };
}

export async function revokeApiKeyRef(ownerOpenId: string, id: number) {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة لإلغاء مرجع المفتاح");
  await db.update(apiKeyRefs).set({ status: "revoked" }).where(and(eq(apiKeyRefs.id, id), eq(apiKeyRefs.ownerOpenId, ownerOpenId)));
  return { revoked: true as const };
}

export async function listFileChangeRequests(ownerOpenId: string) {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة لعرض تعديلات الملفات");
  return db.select().from(fileChangeRequests).where(eq(fileChangeRequests.ownerOpenId, ownerOpenId)).orderBy(desc(fileChangeRequests.createdAt)).limit(50);
}

export async function createFileChangeRequest(input: InsertFileChangeRequest) {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة لحفظ تعديل الملف");
  const result = await db.insert(fileChangeRequests).values(input);
  return { id: Number(result[0].insertId) };
}

export async function updateFileChangeRequest(ownerOpenId: string, id: number, status: "approved" | "applied" | "failed" | "cancelled", approvedAt?: Date) {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة لتحديث تعديل الملف");
  const allowed = status === "approved" ? (["awaiting_approval"] as const) : (["awaiting_approval", "approved"] as const);
  const result = await db.update(fileChangeRequests).set({ status, approvedAt }).where(and(eq(fileChangeRequests.id, id), eq(fileChangeRequests.ownerOpenId, ownerOpenId), inArray(fileChangeRequests.status, allowed)));
  if (!result[0]?.affectedRows) throw new Error("تعديل الملف غير موجود أو لا يسمح وضعه الحالي بهذا الانتقال");
  return { updated: true as const };
}

export async function listLlmKeys() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(llmKeys).orderBy(llmKeys.id);
}

export async function addLlmKey(input: { label: string; provider: string; baseUrl: string; model: string; apiKey: string }) {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة لحفظ مفتاح النموذج");
  const result = await db.insert(llmKeys).values({
    label: input.label,
    provider: input.provider,
    baseUrl: input.baseUrl,
    model: input.model,
    apiKey: input.apiKey,
    enabled: 1,
    status: "untested",
  });
  return { id: Number(result[0].insertId) };
}

export async function deleteLlmKey(id: number) {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة");
  await db.delete(llmKeys).where(eq(llmKeys.id, id));
}

export async function setLlmKeyHealth(
  id: number,
  status: "untested" | "ok" | "failing",
  lastError: string | null,
) {
  const db = await getDb();
  if (!db) return;
  await db.update(llmKeys).set({ status, lastError, lastCheckedAt: new Date() }).where(eq(llmKeys.id, id));
}

export async function touchLlmKey(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(llmKeys).set({ lastUsedAt: new Date() }).where(eq(llmKeys.id, id));
}

export async function getLlmKey(id: number) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(llmKeys).where(eq(llmKeys.id, id)).limit(1);
  return rows[0] ?? null;
}

const OWNER_CREDENTIAL_LABEL = "primary";

/** Reads the owner password hash from the database. Null when absent or unreachable. */
export async function getOwnerCredentialHash(): Promise<{ hash: string; updatedAt: Date } | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    const rows = await db
      .select()
      .from(ownerCredentials)
      .where(eq(ownerCredentials.label, OWNER_CREDENTIAL_LABEL))
      .limit(1);
    const row = rows[0];
    return row ? { hash: row.passwordHash, updatedAt: row.updatedAt } : null;
  } catch {
    // Table not migrated yet or database unavailable: caller may fall back.
    return null;
  }
}

/** Creates or replaces the owner password hash in the database. */
export async function saveOwnerCredentialHash(hash: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة لحفظ كلمة مرور ZENOX");
  await db
    .insert(ownerCredentials)
    .values({ label: OWNER_CREDENTIAL_LABEL, passwordHash: hash })
    .onDuplicateKeyUpdate({ set: { passwordHash: hash } });
}

export async function listIntegrationAuditLogs(limit = 25) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(integrationAuditLogs)
    .orderBy(desc(integrationAuditLogs.createdAt))
    .limit(Math.min(Math.max(limit, 1), 60));
}

export async function addIntegrationAuditLog(input: typeof integrationAuditLogs.$inferInsert) {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات غير متاحة لتسجيل تكامل ZENOX");
  await db.insert(integrationAuditLogs).values(input);
}
