import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export const deviceSessions = mysqlTable("device_sessions", {
  sessionId: varchar("sessionId", { length: 64 }).primaryKey(),
  ownerOpenId: varchar("ownerOpenId", { length: 64 }).notNull(),
  deviceId: varchar("deviceId", { length: 128 }).notNull(),
  deviceName: varchar("deviceName", { length: 160 }).notNull(),
  platform: varchar("platform", { length: 32 }).notNull(),
  capabilities: text("capabilities").notNull(),
  consentTokenHash: varchar("consentTokenHash", { length: 128 }).notNull().unique(),
  status: mysqlEnum("status", ["pending", "active", "revoked", "expired"]).default("pending").notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  acceptedAt: timestamp("acceptedAt"),
  revokedAt: timestamp("revokedAt"),
});

export type DeviceSession = typeof deviceSessions.$inferSelect;
export type InsertDeviceSession = typeof deviceSessions.$inferInsert;

export const ownerPolicies = mysqlTable("owner_policies", {
  id: int("id").autoincrement().primaryKey(),
  ownerOpenId: varchar("ownerOpenId", { length: 64 }).notNull(),
  policyKey: varchar("policyKey", { length: 80 }).notNull(),
  label: varchar("label", { length: 160 }).notNull(),
  description: text("description").notNull(),
  enabled: int("enabled").default(1).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type OwnerPolicy = typeof ownerPolicies.$inferSelect;
export type InsertOwnerPolicy = typeof ownerPolicies.$inferInsert;

export const rootChangeRequests = mysqlTable("root_change_requests", {
  id: int("id").autoincrement().primaryKey(),
  ownerOpenId: varchar("ownerOpenId", { length: 64 }).notNull(),
  requestText: text("requestText").notNull(),
  summary: varchar("summary", { length: 500 }).notNull(),
  affectedFiles: text("affectedFiles").notNull(),
  planJson: text("planJson").notNull(),
  risk: mysqlEnum("risk", ["low", "medium", "high"]).notNull(),
  status: mysqlEnum("status", ["draft", "awaiting_approval", "approved", "validation_failed", "ready_to_publish", "published", "cancelled"]).default("awaiting_approval").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  approvedAt: timestamp("approvedAt"),
});

export type RootChangeRequest = typeof rootChangeRequests.$inferSelect;
export type InsertRootChangeRequest = typeof rootChangeRequests.$inferInsert;

export const rootAuditLogs = mysqlTable("root_audit_logs", {
  id: int("id").autoincrement().primaryKey(),
  ownerOpenId: varchar("ownerOpenId", { length: 64 }).notNull(),
  requestId: int("requestId").notNull(),
  action: varchar("action", { length: 80 }).notNull(),
  result: mysqlEnum("result", ["allowed", "denied", "failed"]).notNull(),
  details: text("details").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type RootAuditLog = typeof rootAuditLogs.$inferSelect;
export type InsertRootAuditLog = typeof rootAuditLogs.$inferInsert;

export const externalConnections = mysqlTable("external_connections", {
  id: int("id").autoincrement().primaryKey(),
  ownerOpenId: varchar("ownerOpenId", { length: 64 }).notNull(),
  label: varchar("label", { length: 120 }).notNull(),
  kind: mysqlEnum("kind", ["mysql", "postgres", "supabase", "rest_api"]).notNull(),
  host: varchar("host", { length: 255 }).notNull(),
  databaseName: varchar("databaseName", { length: 160 }),
  username: varchar("username", { length: 160 }),
  secretRef: varchar("secretRef", { length: 128 }).notNull(),
  sslRequired: int("sslRequired").default(1).notNull(),
  enabled: int("enabled").default(1).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ExternalConnection = typeof externalConnections.$inferSelect;
export type InsertExternalConnection = typeof externalConnections.$inferInsert;

export const apiKeyRefs = mysqlTable("api_key_refs", {
  id: int("id").autoincrement().primaryKey(),
  ownerOpenId: varchar("ownerOpenId", { length: 64 }).notNull(),
  provider: varchar("provider", { length: 120 }).notNull(),
  label: varchar("label", { length: 120 }).notNull(),
  secretRef: varchar("secretRef", { length: 128 }).notNull(),
  scopes: text("scopes").notNull(),
  fingerprint: varchar("fingerprint", { length: 32 }),
  status: mysqlEnum("status", ["unconfigured", "configured", "revoked"]).default("unconfigured").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ApiKeyRef = typeof apiKeyRefs.$inferSelect;
export type InsertApiKeyRef = typeof apiKeyRefs.$inferInsert;

export const fileChangeRequests = mysqlTable("file_change_requests", {
  id: int("id").autoincrement().primaryKey(),
  ownerOpenId: varchar("ownerOpenId", { length: 64 }).notNull(),
  filePath: varchar("filePath", { length: 200 }).notNull(),
  summary: varchar("summary", { length: 500 }).notNull(),
  patch: text("patch").notNull(),
  risk: mysqlEnum("risk", ["low", "medium", "high"]).notNull(),
  status: mysqlEnum("status", ["awaiting_approval", "approved", "applied", "failed", "cancelled"]).default("awaiting_approval").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  approvedAt: timestamp("approvedAt"),
});

export type FileChangeRequest = typeof fileChangeRequests.$inferSelect;
export type InsertFileChangeRequest = typeof fileChangeRequests.$inferInsert;

export const integrationAuditLogs = mysqlTable("integration_audit_logs", {
  id: int("id").autoincrement().primaryKey(),
  ownerOpenId: varchar("ownerOpenId", { length: 64 }).notNull(),
  entityType: varchar("entityType", { length: 40 }).notNull(),
  entityId: int("entityId").notNull(),
  action: varchar("action", { length: 80 }).notNull(),
  result: mysqlEnum("result", ["allowed", "denied", "failed"]).notNull(),
  details: text("details").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/**
 * Owner credential: the scrypt hash of the owner password.
 * The database is the source of truth; nothing but the hash is stored.
 */
export const ownerCredentials = mysqlTable("owner_credentials", {
  id: int("id").autoincrement().primaryKey(),
  label: varchar("label", { length: 40 }).default("primary").notNull().unique(),
  passwordHash: text("passwordHash").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type OwnerCredential = typeof ownerCredentials.$inferSelect;
export type InsertOwnerCredential = typeof ownerCredentials.$inferInsert;

/**
 * Pool of model API keys. The secret is write-only from the UI: the server
 * reads it only when calling the provider and never sends it back.
 * The pool rotates daily and fails over to the next key on errors.
 */
export const llmKeys = mysqlTable("llm_keys", {
  id: int("id").autoincrement().primaryKey(),
  label: varchar("label", { length: 80 }).notNull(),
  provider: varchar("provider", { length: 40 }).default("custom").notNull(),
  baseUrl: varchar("baseUrl", { length: 400 }).notNull(),
  model: varchar("model", { length: 120 }).notNull(),
  apiKey: text("apiKey").notNull(),
  enabled: int("enabled").default(1).notNull(),
  status: mysqlEnum("status", ["untested", "ok", "failing"]).default("untested").notNull(),
  lastError: varchar("lastError", { length: 400 }),
  lastUsedAt: timestamp("lastUsedAt"),
  lastCheckedAt: timestamp("lastCheckedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type LlmKey = typeof llmKeys.$inferSelect;
export type InsertLlmKey = typeof llmKeys.$inferInsert;

export const deviceAuditLogs = mysqlTable("device_audit_logs", {
  id: int("id").autoincrement().primaryKey(),
  sessionId: varchar("sessionId", { length: 64 }).notNull(),
  ownerOpenId: varchar("ownerOpenId", { length: 64 }).notNull(),
  deviceId: varchar("deviceId", { length: 128 }).notNull(),
  capability: varchar("capability", { length: 80 }).notNull(),
  action: varchar("action", { length: 255 }).notNull(),
  result: mysqlEnum("result", ["allowed", "denied"]).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/**
 * A Google account linked by the owner through OAuth. Tokens are encrypted
 * before they reach the database; the client only ever sees the email.
 */
export const googleAccounts = mysqlTable("google_accounts", {
  id: int("id").autoincrement().primaryKey(),
  googleSub: varchar("googleSub", { length: 128 }).notNull().unique(),
  email: varchar("email", { length: 320 }),
  name: varchar("name", { length: 160 }),
  picture: varchar("picture", { length: 800 }),
  refreshToken: text("refreshToken").notNull(),
  accessToken: text("accessToken"),
  accessExpiresAt: timestamp("accessExpiresAt"),
  scopes: text("scopes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type GoogleAccount = typeof googleAccounts.$inferSelect;
export type InsertGoogleAccount = typeof googleAccounts.$inferInsert;
