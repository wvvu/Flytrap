import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ulid } from "ulid";
import cookie from "@fastify/cookie";
import csrf from "@fastify/csrf-protection";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import session from "@fastify/session";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import { LABELS } from "../ai/types.js";
import { listPrompts, readPrompt, savePrompt } from "../ai/prompt.js";
import { fallbackAiPool } from "../ai/pool.js";
import { probeAiKey } from "../ai/probe.js";
import { ConfigError, type Config } from "../config.js";
import type { Codec } from "../compress.js";
import type { Db } from "../db/index.js";
import PostalMime from "postal-mime";
import { findAttachment, listMessageAttachments } from "../db/repos/attachments.js";
import { writeAudit } from "../db/repos/audit.js";
import { deleteDkimKey, listDkimPublic, saveDkimKey } from "../db/repos/dkim-keys.js";
import {
  countJobsByStatus,
  dismissJob,
  enqueueJob,
  failureSummary,
  listJobsWithDetails,
  outboxIdOf,
  retryAllDeadJobs,
  retryJob,
  retryMessageJobs,
  retryOutboxJob,
  wakeClassifyJobs,
  type JobStatus,
} from "../db/repos/jobs.js";
import { getOutbox, listOutbox, listOutboxByIds } from "../db/repos/outbox.js";
import { listThread } from "../db/repos/thread.js";
import {
  clearResetSeal,
  presentAiPool,
  readAcceptDomains,
  readAiEnabled,
  readAiThinking,
  readBlockedSenders,
  readEffectiveAiPool,
  readPasswordHash,
  readResetSeal,
  readRuntimeSettings,
  saveAcceptDomains,
  saveAiControls,
  saveAiPool,
  saveBlockedSenders,
  saveJobMaxAttempts,
  saveNameSettings,
  saveNotifySettings,
  savePasswordHash,
  saveResetSeal,
  SettingsError,
  type ResetSeal,
} from "../db/repos/settings.js";
import { listMailboxHistory, upsertMailboxHistory } from "../db/repos/mailbox-history.js";
import {
  batchMutateMessages,
  countTrash,
  countUnread,
  deleteMessage,
  emptyTrash,
  getMessageForUser,
  listMessages,
  markAllMessagesRead,
  markMessageRead,
  markMessageUnread,
  overrideMessageLabel,
  restoreMessage,
  setMessageStar,
  trashMessage,
  userHasAttachmentAccess,
  type StoredMessage,
} from "../db/repos/messages.js";
import {
  addUserMailbox,
  authorizeSendFrom,
  createUser,
  deleteUser,
  findUserById,
  findUserByUsername,
  findUserForPasswordReset,
  listUserMailboxes,
  listUsersWithStats,
  readUserPersonalSettings,
  removeUserMailbox,
  saveUserPersonalSettings,
  syncBootstrapAdmin,
  updateUser,
  updateUserMailbox,
  updateUserPassword,
  UserError,
  verifyUserLogin,
  type UserRow,
} from "../db/repos/users.js";
import { sha256 } from "../hash.js";
import { readRaw } from "../ingest/read-raw.js";
import { removeStoredFiles } from "../ingest/remove-stored.js";
import { normalizeAddress, OutboundError } from "../mail/address.js";
import { rfc822HeaderBlock } from "../mail/headers.js";
import { submitOutbox } from "../mail/submit.js";
import { appRoot, PathEscapeError, resolveInside } from "../paths.js";
import {
  actorName,
  contentDisposition,
  decodeCursor,
  encodeCursor,
  errorName,
  HttpError,
  iso,
  parseJson,
  publicError,
  safeMime,
} from "./http.js";
import {
  hashPassword,
  makeResetCode,
  RESET_MAX_ATTEMPTS,
  RESET_RESEND_MS,
  resetCodeOk,
  sameAccount,
  sealResetCode,
} from "./password.js";
import { recentLogs } from "../log.js";
import { clearSessions, deleteUserSessions, sqliteSessionStore } from "./session-store.js";
import { isPanelAsset, registerPanel } from "./static.js";

declare module "fastify" {
  interface Session {
    user?: string;
    userId?: string;
  }
  interface FastifyRequest {
    currentUser?: UserRow;
  }
}

const STATUSES = ["received", "authed", "parsed", "classified", "notified", "error"] as const;
const JOB_STATUSES = ["queued", "running", "done", "failed", "dead", "dismissed"] as const;
const DOMAIN_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const APP_VERSION_STR = readAppVersion();

function readAppVersion(): string {
  const envVer = process.env.APP_VERSION?.trim();
  if (envVer) return envVer;
  try {
    const pkg = JSON.parse(readFileSync(path.join(appRoot(), "package.json"), "utf8")) as { version?: string };
    return pkg.version ? `v${pkg.version}` : "v0.8.0";
  } catch {
    return "v0.8.0";
  }
}

const loginBody = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(512),
}).strict();

const profileUpdateBody = z.object({
  displayName: z.string().max(40).nullable().optional(),
  recoveryEmail: z.string().max(254).nullable().optional(),
  signature: z.string().max(1000).optional(),
}).strict();

const notifySettingsBody = z.object({
  labels: z.array(z.string()).max(LABELS.length),
  minConfidence: z.number().min(0).max(1),
  webhookUrl: z.string().max(500).optional(),
  webhookBearer: z.string().max(512).optional(),
}).strict();

const domainSettingsBody = z.object({
  domains: z.array(z.string().min(1).max(253)).min(1).max(50),
}).strict();

const jobSettingsBody = z.object({
  maxAttempts: z.number().int().min(1).max(20),
}).strict();

const nameSettingsBody = z.object({
  panelTitle: z.string().min(1).max(40),
  labelNames: z.record(z.string(), z.string().max(16)),
  domainNames: z.record(z.string(), z.string().max(24)),
  senderNames: z.array(z.object({
    address: z.string().min(3).max(254),
    name: z.string().min(1).max(40),
  }).strict()).max(200),
  signature: z.string().max(1000).optional(),
}).strict();

const retryMessageBody = z.object({
  messageId: z.string().regex(/^[\w-]+$/),
}).strict();

const aiSettingsBody = z.object({
  models: z.array(z.string().max(80)).max(8),
  keys: z.array(z.object({
    id: z.string().min(1).max(80).optional(),
    secret: z.string().min(8).max(512).optional(),
  }).strict()).max(20),
  enabled: z.boolean().optional(),
  thinking: z.enum(["off", "low", "medium", "high"]).optional(),
}).strict();

const aiTestKeyBody = z.object({
  id: z.string().min(1).max(80).optional(),
  secret: z.string().min(8).max(512).optional(),
  model: z.string().min(1).max(80).optional(),
}).strict();

const passwordBody = z.object({
  current: z.string().min(1).max(200),
  next: z.string().min(8).max(200),
}).strict();

const resetRequestBody = z.object({
  email: z.string().min(1).max(254),
}).strict();

const resetBody = z.object({
  email: z.string().min(1).max(254),
  code: z.string().min(1).max(16),
  next: z.string().min(8).max(200),
}).strict();

const blocklistBody = z.object({
  addresses: z.array(z.string().min(1).max(254)).max(500),
}).strict();

const starBody = z.object({
  starred: z.boolean(),
}).strict();

const readAllBody = z.object({
  view: z.enum(["inbox", "promo", "spam", "all"]).optional(),
  to: z.string().max(254).optional(),
}).strict();

const batchMessagesBody = z.object({
  ids: z.array(z.string().regex(/^[\w-]+$/)).min(1).max(100),
  action: z.enum(["read", "unread", "star", "unstar", "trash", "restore", "delete", "label"]),
  label: z.enum(LABELS).optional(),
}).strict();

const sendAttachmentSchema = z.object({
  filename: z.string().min(1).max(200),
  contentType: z.string().max(120).optional(),
  contentBase64: z.string().min(1).max(15_000_000),
}).strict();

const sendBody = z.object({
  from: z.string().min(3).max(254),
  to: z.array(z.string().min(3).max(254)).min(1).max(20),
  cc: z.array(z.string().min(3).max(254)).max(20).optional(),
  bcc: z.array(z.string().min(3).max(254)).max(20).optional(),
  subject: z.string().max(200).optional(),
  text: z.string().max(100_000).optional(),
  inReplyTo: z.string().max(300).optional(),
  references: z.array(z.string().max(300)).max(20).optional(),
  attachments: z.array(sendAttachmentSchema).max(5).optional(),
}).strict();

const dkimBody = z.object({
  domain: z.string().min(1).max(253),
  selector: z.string().min(1).max(63).optional(),
  algorithm: z.enum(["rsa", "ed25519"]).optional(),
}).strict();

const dkimRemoveBody = z.object({
  domain: z.string().min(1).max(253),
  selector: z.string().min(1).max(63),
}).strict();

const historyBody = z.object({
  domain: z.string().min(1).max(253),
  localpart: z.string().min(1).max(64),
  firstSeen: z.union([z.string(), z.number(), z.null()]).optional(),
  lastSeen: z.union([z.string(), z.number(), z.null()]).optional(),
  source: z.string().max(32).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
  displayName: z.string().max(40).nullable().optional(),
}).strict();

const createUserBody = z.object({
  username: z.string().min(2).max(128),
  password: z.string().min(8).max(200),
  displayName: z.string().max(40).nullable().optional(),
  recoveryEmail: z.string().max(254).nullable().optional(),
  role: z.enum(["admin", "member"]).optional(),
  catchAll: z.boolean().optional(),
  syncHistory: z.boolean().optional(),
  mailboxes: z.array(z.object({
    localpart: z.string().min(1).max(64),
    domain: z.string().min(1).max(253),
    displayName: z.string().max(40).nullable().optional(),
    canSend: z.boolean().optional(),
    note: z.string().max(200).nullable().optional(),
  }).strict()).max(30).optional(),
}).strict();

const updateUserBody = z.object({
  displayName: z.string().max(40).nullable().optional(),
  recoveryEmail: z.string().max(254).nullable().optional(),
  role: z.enum(["admin", "member"]).optional(),
  catchAll: z.boolean().optional(),
  disabled: z.boolean().optional(),
  password: z.string().min(8).max(200).optional(),
}).strict();

const createMailboxBody = z.object({
  localpart: z.string().min(1).max(64),
  domain: z.string().min(1).max(253),
  displayName: z.string().max(40).nullable().optional(),
  canSend: z.boolean().optional(),
  note: z.string().max(200).nullable().optional(),
  syncHistory: z.boolean().optional(),
}).strict();

const updateMailboxBody = z.object({
  displayName: z.string().max(40).nullable().optional(),
  canSend: z.boolean().optional(),
  note: z.string().max(200).nullable().optional(),
  syncHistory: z.boolean().optional(),
}).strict();

export interface ApiOptions {
  config: Config;
  db: Db;
  codec: Codec;
  log?: FastifyBaseLogger | boolean;
  now?: () => number;
  probeFetchImpl?: typeof fetch;
}

export interface RunningApi {
  port: number;
  close: () => Promise<void>;
}

export async function buildApi(options: ApiOptions): Promise<FastifyInstance> {
  const now = options.now ?? Date.now;
  const { config, db, codec } = options;

  syncBootstrapAdmin(db, { username: config.apiUsername, now: now() });

  const app = Fastify(
    typeof options.log === "boolean"
      ? { logger: options.log, trustProxy: true, bodyLimit: 16 * 1024 * 1024 }
      : options.log
        ? { loggerInstance: options.log, trustProxy: true, bodyLimit: 16 * 1024 * 1024 }
        : { logger: false, trustProxy: true, bodyLimit: 16 * 1024 * 1024 },
  );

  await app.register(helmet, {
    strictTransportSecurity: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:", "https:", "http:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameSrc: ["'self'"],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
  });
  await app.register(cookie);
  const sessionTtlMs = config.sessionDays * 24 * 60 * 60 * 1000;
  await app.register(session, {
    secret: config.sessionSecret ?? "",
    cookieName: "mail.sid",
    saveUninitialized: false,
    rolling: true,
    store: sqliteSessionStore(db, sessionTtlMs),
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: config.nodeEnv === "production",
      path: "/",
      maxAge: sessionTtlMs,
    },
  });
  await app.register(csrf, { sessionPlugin: "@fastify/session" });
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => new HttpError(429, "rate_limited"),
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: "not_found" });
  });
  app.setErrorHandler((err: unknown, request, reply) => {
    const error = err instanceof Error ? err : new Error("request failed");
    const statusCode =
      typeof err === "object" && err !== null && "statusCode" in err && typeof err.statusCode === "number"
        ? err.statusCode
        : 500;
    const status = statusCode >= 400 && statusCode < 600 ? statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error.name }, "request failed");
      return reply.code(500).send({ error: "internal_error" });
    }
    return reply.code(status).send({ error: errorName(status) });
  });

  app.addHook("onRequest", (request, reply, done) => {
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
      done();
      return;
    }
    app.csrfProtection(request, reply, done);
  });

  app.addHook("onRequest", async (request, reply) => {
    if (reply.sent || isPublic(request.url)) return;
    if (!request.session.user) return reply.code(401).send({ error: "unauthorized" });
    const account =
      (request.session.userId ? findUserById(db, request.session.userId) : undefined) ??
      findUserByUsername(db, request.session.user);
    if (!account || account.disabled_at !== null) {
      await request.session.destroy().catch(() => {});
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (!request.session.userId) {
      request.session.userId = account.id;
    }
    request.currentUser = account;
  });

  app.get("/healthz", async () => {
    db.prepare("SELECT 1").get();
    return { ok: true, roles: config.roles, db: "ok" };
  });

  app.get("/v1/csrf", async (_request, reply) => {
    return { token: reply.generateCsrf() };
  });

  app.post("/v1/login", { config: { rateLimit: { max: 5, timeWindow: "5 minutes" } } }, async (request, reply) => {
    const body = loginBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const at = now();
    const account = verifyUserLogin(
      db,
      body.data.username,
      body.data.password,
      config.apiUsername,
      config.apiPassword ?? "",
      at,
    );
    const actor = actorName(body.data.username);
    if (!account) {
      writeAudit(db, { id: ulid(), at, actor, action: "login_failed" });
      throw new HttpError(401, "unauthorized");
    }
    await request.session.regenerate();
    request.session.user = account.username;
    request.session.userId = account.id;
    writeAudit(db, { id: ulid(), at, actor: account.username, action: "login" });
    return reply.send({ user: account.username });
  });

  app.post("/v1/password/forgot", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = resetRequestBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const email = normalizeAddress(body.data.email);
    const target = email ? findUserForPasswordReset(db, email) : undefined;
    if (email && target) {
      const at = now();
      const isBootstrap = sameAccount(target.username.toLowerCase(), config.apiUsername.toLowerCase());
      const current = readUserResetSeal(db, target.id, isBootstrap);
      const cooling =
        current &&
        current.attempts < RESET_MAX_ATTEMPTS &&
        at < current.expiresAt &&
        at < current.sentAt + RESET_RESEND_MS;
      if (!cooling) {
        const code = makeResetCode();
        const domains = readAcceptDomains(db, config.acceptDomains);
        const from = normalizeAddress(`noreply@${domains[0] ?? config.acceptDomains[0] ?? ""}`);
        if (from) {
          try {
            await submitOutbox(
              { db, dataDir: config.mailDataDir, codec, acceptDomains: domains, now },
              {
                from,
                to: [email],
                subject: "登录验证码",
                text: `验证码 ${code}\n\n10 分钟内有效。\n`,
              },
            );
            writeUserResetSeal(db, target.id, isBootstrap, sealResetCode(code, at), at);
            writeAudit(db, { id: ulid(), at, actor: target.username, action: "password_reset_sent" });
          } catch (err) {
            request.log.error(
              { err: err instanceof Error ? err.name : "password reset send failed" },
              "password reset send failed",
            );
          }
        }
      }
    }
    return reply.send({ ok: true });
  });

  app.post("/v1/password/reset", { config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = resetBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    if (body.data.next === "admin") throw new HttpError(400);
    const email = normalizeAddress(body.data.email);
    const target = email ? findUserForPasswordReset(db, email) : undefined;
    const at = now();
    const isBootstrap = target ? sameAccount(target.username.toLowerCase(), config.apiUsername.toLowerCase()) : false;
    const seal = target ? readUserResetSeal(db, target.id, isBootstrap) : null;
    const verdict = seal ? resetCodeOk(body.data.code, seal, at) : { ok: false as const, seal: null };
    if (!target || !verdict.ok) {
      if (target && !verdict.ok) {
        if (verdict.seal) writeUserResetSeal(db, target.id, isBootstrap, verdict.seal, at);
        else if (seal) deleteUserResetSeal(db, target.id, isBootstrap);
        writeAudit(db, { id: ulid(), at, actor: actorName(target.username), action: "password_reset_failed" });
      }
      throw new HttpError(401, "unauthorized");
    }
    db.transaction(() => {
      updateUserPassword(db, target.id, body.data.next, at);
      if (isBootstrap) {
        savePasswordHash(db, hashPassword(body.data.next), at);
        clearResetSeal(db);
        clearSessions(db);
      } else {
        deleteUserResetSeal(db, target.id, false);
        deleteUserSessions(db, target.id, target.username);
      }
      writeAudit(db, { id: ulid(), at, actor: target.username, action: "password_reset" });
    })();
    return reply.send({ ok: true });
  });

  app.post("/v1/logout", async (request, reply) => {
    const actor = request.session.user ?? "unknown";
    writeAudit(db, { id: ulid(), at: now(), actor, action: "logout" });
    await request.session.destroy();
    return reply.send({ ok: true });
  });

  app.get("/v1/me", async (request) => ({ user: request.session.user }));

  app.get("/v1/profile", async (request) => {
    const user = requireUser(request);
    const personal = readUserPersonalSettings(user);
    return {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      recoveryEmail: user.recovery_email,
      role: user.role,
      catchAll: user.catch_all === 1,
      signature: personal.signature,
      mailboxes: listUserMailboxes(db, user.id).map((mb) => ({
        ...mb,
        createdAt: iso(mb.createdAt),
      })),
      acceptDomains: readAcceptDomains(db, config.acceptDomains),
      version: APP_VERSION_STR,
    };
  });

  app.put("/v1/profile", async (request, reply) => {
    const user = requireUser(request);
    const body = profileUpdateBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const at = now();
    try {
      if (body.data.displayName !== undefined || body.data.recoveryEmail !== undefined) {
        updateUser(db, user.id, {
          displayName: body.data.displayName,
          recoveryEmail: body.data.recoveryEmail,
          now: at,
        });
      }
      if (body.data.signature !== undefined) {
        saveUserPersonalSettings(db, user.id, { signature: body.data.signature }, at);
      }
    } catch (err) {
      if (err instanceof UserError) throw new HttpError(err.statusCode);
      throw err;
    }
    const fresh = findUserById(db, user.id)!;
    const personal = readUserPersonalSettings(fresh);
    writeAudit(db, { id: ulid(), at, actor: user.username, action: "profile_update" });
    return reply.send({
      ok: true,
      displayName: fresh.display_name,
      recoveryEmail: fresh.recovery_email,
      signature: personal.signature,
    });
  });

  app.get("/v1/unread", async (request) => {
    const query = request.query as Record<string, unknown>;
    const uid = resolveQueryScope(request, optionalString(query?.scope));
    return countUnread(db, uid);
  });

  app.get("/v1/messages", async (request) => {
    const query = readListQuery(request.query);
    const uid = resolveQueryScope(request, query.scope);
    const rows = listMessages(db, { ...query, userId: uid, limit: query.limit + 1 });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toListItem),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.received_at, last.id) : null,
    };
  });

  app.get("/v1/messages/:id", async (request) => {
    const query = request.query as Record<string, unknown>;
    const uid = resolveQueryScope(request, optionalString(query?.scope));
    return toDetail(db, messageId(request), uid);
  });

  app.get("/v1/messages/:id/thread", async (request) => {
    const user = requireUser(request);
    const query = request.query as Record<string, unknown>;
    const uid = resolveQueryScope(request, optionalString(query?.scope));
    const id = messageId(request);
    const letters = listThread(
      db,
      id,
      uid ? { userId: uid, includeUnownedOutbox: user.role === "admin" } : undefined,
    );
    if (!letters) throw new HttpError(404, "not_found");
    return {
      items: letters.map((item) => ({
        kind: item.kind,
        id: item.id,
        at: iso(item.at),
        from: item.from,
        subject: item.subject,
        current: item.kind === "in" && item.id === id,
      })),
    };
  });

  app.get("/v1/messages/:id/text", async (request) => {
    const query = request.query as Record<string, unknown>;
    const uid = resolveQueryScope(request, optionalString(query?.scope));
    const message = requireMessage(db, messageId(request), uid);
    const parsed = parseJson(message.parsed);
    const text =
      parsed && typeof parsed === "object" && "text" in parsed && typeof parsed.text === "string"
        ? parsed.text
        : null;
    if (text === null) throw new HttpError(404, "not_found");
    return { text };
  });

  app.get("/v1/messages/:id/html", async (request) => {
    const query = request.query as Record<string, unknown>;
    const uid = resolveQueryScope(request, optionalString(query?.scope));
    const message = requireMessage(db, messageId(request), uid);
    let bytes: Buffer;
    try {
      bytes = await readRaw(config.mailDataDir, message.raw_path, codec, message.sha256);
    } catch (err) {
      if (err instanceof PathEscapeError) throw new HttpError(404, "not_found");
      throw new HttpError(404, "not_found");
    }
    const email = await PostalMime.parse(bytes);
    return { html: email.html ?? "", subject: email.subject ?? "", headers: rfc822HeaderBlock(bytes) };
  });

  app.get("/v1/messages/:id/raw", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const uid = resolveQueryScope(request, optionalString(query?.scope));
    const message = requireMessage(db, messageId(request), uid);
    let bytes: Buffer;
    try {
      bytes = await readRaw(config.mailDataDir, message.raw_path, codec, message.sha256);
    } catch (err) {
      if (err instanceof PathEscapeError) throw new HttpError(404, "not_found");
      throw new HttpError(404, "not_found");
    }
    return reply
      .header("content-type", "message/rfc822")
      .header("content-disposition", contentDisposition(`${message.sha256}.eml`))
      .send(bytes);
  });

  app.get("/v1/messages/:id/headers", async (request) => {
    const query = request.query as Record<string, unknown>;
    const uid = resolveQueryScope(request, optionalString(query?.scope));
    const message = requireMessage(db, messageId(request), uid);
    let bytes: Buffer;
    try {
      bytes = await readRaw(config.mailDataDir, message.raw_path, codec, message.sha256);
    } catch (err) {
      if (err instanceof PathEscapeError) throw new HttpError(404, "not_found");
      throw new HttpError(404, "not_found");
    }
    return { headers: rfc822HeaderBlock(bytes) };
  });

  app.post("/v1/messages/:id/reclassify", async (request, reply) => {
    const user = requireUser(request);
    const id = messageId(request);
    requireMessage(db, id, user.role === "admin" ? undefined : user.id);
    const at = now();
    const open = db
      .prepare(
        `SELECT id, status FROM jobs
         WHERE message_id = ? AND type = 'classify' AND status IN ('queued', 'running')`,
      )
      .all(id) as Array<{ id: string; status: string }>;
    const queued = open.find((row) => row.status === "queued");
    if (queued) {
      db.prepare("UPDATE jobs SET payload = ?, updated_at = ? WHERE id = ?").run(
        JSON.stringify({ force: true }),
        at,
        queued.id,
      );
    } else {
      enqueueJob(db, { id: ulid(), type: "classify", messageId: id, payload: { force: true }, now: at });
    }
    if (user.role !== "admin") {
      db.prepare("UPDATE user_messages SET label_override = NULL WHERE user_id = ? AND message_id = ?").run(
        user.id,
        id,
      );
    }
    writeAudit(db, { id: ulid(), at, actor: user.username, action: "reclassify", target: id });
    return reply.code(202).send({ queued: true });
  });

  const labelOverrideBody = z.object({
    label: z.enum(["phish", "malware", "spam", "unsolicited-admin", "legit", "gray"]),
  }).strict();

  app.patch("/v1/messages/:id/label", async (request, reply) => {
    const user = requireUser(request);
    const id = messageId(request);
    requireMessage(db, id, user.role === "admin" ? undefined : user.id);
    const body = labelOverrideBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);

    const at = now();
    const res = overrideMessageLabel(db, {
      id,
      label: body.data.label,
      actor: user.username,
      now: at,
      userId: user.id,
      isAdmin: user.role === "admin",
    });

    writeAudit(db, {
      id: ulid(),
      at,
      actor: user.username,
      action: "override_label",
      target: id,
      detail: `from=${res.prevLabel},to=${body.data.label}`,
    });

    return reply.send({
      ok: true,
      id,
      label: body.data.label,
      originalLabel: res.originalLabel,
      originalConfidence: res.originalConfidence,
    });
  });

  app.post("/v1/messages/:id/read", async (request, reply) => {
    const user = requireUser(request);
    const id = messageId(request);
    const visible = getMessageForUser(db, id, user.id) ?? (user.role === "admin" ? getMessageForUser(db, id) : undefined);
    if (!visible) throw new HttpError(404, "not_found");
    markMessageRead(db, id, now(), getMessageForUser(db, id, user.id) ? user.id : undefined);
    return reply.send({ ok: true });
  });

  app.post("/v1/messages/:id/unread", async (request, reply) => {
    const user = requireUser(request);
    const id = messageId(request);
    const visible = getMessageForUser(db, id, user.id) ?? (user.role === "admin" ? getMessageForUser(db, id) : undefined);
    if (!visible) throw new HttpError(404, "not_found");
    markMessageUnread(db, id, getMessageForUser(db, id, user.id) ? user.id : undefined);
    return reply.send({ ok: true });
  });

  app.post("/v1/messages/:id/star", async (request, reply) => {
    const user = requireUser(request);
    const id = messageId(request);
    const body = starBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    requireMessage(db, id, user.id);
    setMessageStar(db, id, body.data.starred, now(), user.id);
    return reply.send({ ok: true, id, starred: body.data.starred });
  });

  app.post("/v1/messages/read-all", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const uid = resolveQueryScope(request, optionalString(query?.scope));
    const body = readAllBody.safeParse(request.body ?? {});
    if (!body.success) throw new HttpError(400);
    const count = markAllMessagesRead(db, {
      userId: uid,
      view: body.data.view ?? "inbox",
      to: body.data.to?.trim() || undefined,
      now: now(),
    });
    return reply.send({ ok: true, count });
  });

  app.post("/v1/messages/batch", async (request, reply) => {
    const user = requireUser(request);
    const query = request.query as Record<string, unknown>;
    const uid = resolveQueryScope(request, optionalString(query?.scope));
    const body = batchMessagesBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    if (body.data.action === "label" && !body.data.label) throw new HttpError(400);
    const at = now();
    const result = batchMutateMessages(db, {
      ids: body.data.ids,
      action: body.data.action,
      label: body.data.label,
      actor: user.username,
      now: at,
      userId: uid,
      isAdmin: user.role === "admin",
    });
    if (result.paths.length > 0) {
      const failed = await removeStoredFiles(config.mailDataDir, result.paths);
      if (failed.length > 0) request.log.warn({ failed: failed.length }, "stored files left on disk");
    }
    writeAudit(db, {
      id: ulid(),
      at,
      actor: user.username,
      action: `batch_${body.data.action}`,
      detail: `count=${result.count}`,
    });
    return reply.send({ ok: true, count: result.count });
  });

  app.post("/v1/messages/:id/trash", async (request, reply) => {
    const user = requireUser(request);
    const id = messageId(request);
    const own = getMessageForUser(db, id, user.id);
    if (!own && user.role !== "admin") throw new HttpError(404, "not_found");
    if (!own) requireMessage(db, id);
    const at = now();
    trashMessage(db, id, at, own ? user.id : undefined);
    writeAudit(db, { id: ulid(), at, actor: user.username, action: "trash", target: id });
    return reply.send({ ok: true, id, trashed: true });
  });

  app.post("/v1/messages/:id/block", async (request, reply) => {
    const user = requireUser(request);
    const id = messageId(request);
    const own = getMessageForUser(db, id, user.id);
    const message = own ?? (user.role === "admin" ? requireMessage(db, id) : undefined);
    if (!message) throw new HttpError(404, "not_found");
    const sender = message.from_addr || message.envelope_from;
    if (!sender) throw new HttpError(400);
    const at = now();

    let blockedSenders: string[];
    if (user.role === "admin") {
      try {
        blockedSenders = saveBlockedSenders(db, readBlockedSenders(db).concat(sender), at);
      } catch (err) {
        if (err instanceof SettingsError) throw new HttpError(400);
        throw err;
      }
      trashMessage(db, id, at, own ? user.id : undefined);
    } else {
      try {
        const current = readUserPersonalSettings(user).blockedSenders;
        const saved = saveUserPersonalSettings(db, user.id, { blockedSenders: current.concat(sender) }, at);
        blockedSenders = saved.blockedSenders;
      } catch (err) {
        if (err instanceof UserError) throw new HttpError(err.statusCode);
        throw err;
      }
      trashMessage(db, id, at, user.id);
    }

    writeAudit(db, {
      id: ulid(),
      at,
      actor: user.username,
      action: "block_sender",
      target: id,
      detail: sender,
    });
    return reply.send({ ok: true, id, blockedSenders, trashed: true });
  });

  app.post("/v1/messages/:id/restore", async (request, reply) => {
    const user = requireUser(request);
    const id = messageId(request);
    const own = getMessageForUser(db, id, user.id);
    if (!own && user.role !== "admin") throw new HttpError(404, "not_found");
    if (!own) requireMessage(db, id);
    const at = now();
    restoreMessage(db, id, at, own ? user.id : undefined);
    writeAudit(db, { id: ulid(), at, actor: user.username, action: "restore", target: id });
    return reply.send({ ok: true, id, trashed: false });
  });

  app.delete("/v1/messages/:id", async (request, reply) => {
    const user = requireUser(request);
    const id = messageId(request);
    const own = getMessageForUser(db, id, user.id);
    if (!own && user.role !== "admin") throw new HttpError(404, "not_found");
    if (!own) requireMessage(db, id);
    const at = now();
    const purged = deleteMessage(db, id, at, own ? user.id : undefined);
    if (!purged) throw new HttpError(404, "not_found");
    if (purged.paths.length > 0) {
      const failed = await removeStoredFiles(config.mailDataDir, purged.paths);
      if (failed.length > 0) request.log.warn({ failed: failed.length }, "stored files left on disk");
    }
    writeAudit(db, { id: ulid(), at, actor: user.username, action: "delete", target: id });
    return reply.send({ ok: true, id, deleted: true });
  });

  app.post("/v1/messages/empty-trash", async (request, reply) => {
    const user = requireUser(request);
    const query = request.query as Record<string, unknown>;
    const uid = resolveQueryScope(request, optionalString(query?.scope));
    const at = now();
    const purged = emptyTrash(db, at, uid);
    if (purged.paths.length > 0) {
      const failed = await removeStoredFiles(config.mailDataDir, purged.paths);
      if (failed.length > 0) request.log.warn({ failed: failed.length }, "stored files left on disk");
    }
    writeAudit(db, {
      id: ulid(),
      at,
      actor: user.username,
      action: "empty_trash",
      detail: `count=${purged.count}`,
    });
    return reply.send({ ok: true, count: purged.count });
  });

  app.get("/v1/trash/count", async (request) => {
    const query = request.query as Record<string, unknown>;
    const uid = resolveQueryScope(request, optionalString(query?.scope));
    return { count: countTrash(db, uid) };
  });

  app.get("/v1/attachments/:sha256", async (request, reply) => {
    const user = requireUser(request);
    const sha = attachmentId(request);
    if (user.role !== "admin" && !userHasAttachmentAccess(db, user.id, sha)) {
      throw new HttpError(404, "not_found");
    }
    const row = findAttachment(db, sha);
    if (!row) throw new HttpError(404, "not_found");
    let abs: string;
    try {
      abs = resolveInside(config.mailDataDir, row.path);
    } catch (err) {
      if (err instanceof PathEscapeError) throw new HttpError(404, "not_found");
      throw new HttpError(404, "not_found");
    }
    const bytes = await readFile(abs).catch(() => {
      throw new HttpError(404, "not_found");
    });
    if (sha256(bytes) !== sha) throw new HttpError(404, "not_found");
    return reply
      .header("content-type", safeMime(row.mime))
      .header("content-disposition", contentDisposition(sha))
      .send(bytes);
  });

  // --- Admin: Dead Letter Queue & Job Controls ---
  app.get("/v1/jobs/summary", async (request) => {
    requireAdmin(request);
    return failureSummary(db);
  });

  app.get("/v1/jobs/count", async (request) => {
    requireAdmin(request);
    const query = request.query as Record<string, unknown>;
    const status = optionalString(query.status) ?? "dead";
    if (!JOB_STATUSES.includes(status as JobStatus)) throw new HttpError(400);
    return { status, count: countJobsByStatus(db, status as JobStatus) };
  });

  app.get("/v1/jobs", async (request) => {
    requireAdmin(request);
    const query = request.query as Record<string, unknown>;
    const status = optionalString(query.status);
    const scope = optionalString(query.scope);
    const limit = typeof query.limit === "string" ? Number.parseInt(query.limit, 10) : undefined;
    if (scope && scope !== "open" && scope !== "retrying" && scope !== "stopped") throw new HttpError(400);
    if (status && !JOB_STATUSES.includes(status as JobStatus) && status !== "all") throw new HttpError(400);
    const rows = listJobsWithDetails(db, {
      status,
      scope: scope === "open" || scope === "retrying" || scope === "stopped" ? scope : null,
      limit,
    });
    const sent = new Map(
      listOutboxByIds(
        db,
        rows.flatMap((row) => {
          if (row.type !== "send") return [];
          const id = outboxIdOf(row.payload);
          return id ? [id] : [];
        }),
      ).map((row) => [row.id, row] as const),
    );
    return {
      items: rows.map((row) => {
        const letter = row.type === "send" ? sent.get(outboxIdOf(row.payload) ?? "") : undefined;
        return {
          id: row.id,
          type: row.type,
          messageId: row.message_id,
          messageSubject: row.message_subject ?? letter?.subject ?? null,
          messageFrom: row.message_from ?? letter?.from_addr ?? null,
          messageTo: row.message_to ? envelopeList(row.message_to) : envelopeList(letter?.to_addrs ?? null),
          status: row.status,
          attempts: row.attempts,
          maxAttempts: row.max_attempts,
          runAfter: iso(row.run_after),
          lastError: row.last_error,
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at),
        };
      }),
    };
  });

  app.post("/v1/jobs/retry-message", async (request, reply) => {
    const admin = requireAdmin(request);
    const body = retryMessageBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const count = retryMessageJobs(db, body.data.messageId, now());
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: admin.username,
      action: "retry_message_jobs",
      target: body.data.messageId,
      detail: `count=${count}`,
    });
    return reply.send({ ok: true, count });
  });

  app.post("/v1/jobs/:id/retry", async (request, reply) => {
    const admin = requireAdmin(request);
    const params = request.params as Record<string, string>;
    const id = params.id;
    if (!id) throw new HttpError(400);
    const ok = retryJob(db, id, now());
    if (!ok) throw new HttpError(404, "not_found");
    writeAudit(db, { id: ulid(), at: now(), actor: admin.username, action: "retry_job", target: id });
    return reply.send({ ok: true, retried: id });
  });

  app.post("/v1/jobs/:id/dismiss", async (request, reply) => {
    const admin = requireAdmin(request);
    const params = request.params as Record<string, string>;
    const id = params.id;
    if (!id) throw new HttpError(400);
    const ok = dismissJob(db, id, now());
    if (!ok) throw new HttpError(404, "not_found");
    writeAudit(db, { id: ulid(), at: now(), actor: admin.username, action: "dismiss_job", target: id });
    return reply.send({ ok: true, dismissed: id });
  });

  app.post("/v1/jobs/retry-all", async (request, reply) => {
    const admin = requireAdmin(request);
    const count = retryAllDeadJobs(db, now());
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: admin.username,
      action: "retry_all_dead",
      detail: `count=${count}`,
    });
    return reply.send({ ok: true, count });
  });

  // --- Admin: Users & Mailbox Delegation ---
  app.get("/v1/users", async (request) => {
    requireAdmin(request);
    return {
      items: listUsersWithStats(db).map(presentUserSummary),
    };
  });

  app.post("/v1/users", async (request, reply) => {
    const admin = requireAdmin(request);
    const body = createUserBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const at = now();
    let created;
    try {
      created = createUser(db, { ...body.data, now: at });
    } catch (err) {
      if (err instanceof UserError) throw new HttpError(err.statusCode);
      throw err;
    }
    writeAudit(db, {
      id: ulid(),
      at,
      actor: admin.username,
      action: "user_create",
      target: created.username,
      detail: `role=${created.role} mailboxes=${created.mailboxes.length}`,
    });
    return reply.code(201).send({ ok: true, user: presentUserSummary(created) });
  });

  app.patch("/v1/users/:id", async (request, reply) => {
    const admin = requireAdmin(request);
    const targetId = messageId(request);
    const body = updateUserBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const at = now();
    let result;
    try {
      result = updateUser(db, targetId, { ...body.data, now: at });
    } catch (err) {
      if (err instanceof UserError) throw new HttpError(err.statusCode);
      throw err;
    }
    if (result.revokeSessions) {
      deleteUserSessions(db, targetId, result.user.username);
    }
    if (
      body.data.password &&
      sameAccount(result.user.username.toLowerCase(), config.apiUsername.toLowerCase())
    ) {
      savePasswordHash(db, hashPassword(body.data.password), at);
    }
    writeAudit(db, {
      id: ulid(),
      at,
      actor: admin.username,
      action: "user_update",
      target: result.user.username,
      detail: `role=${result.user.role} disabled=${result.user.disabled}`,
    });
    return reply.send({ ok: true, user: presentUserSummary(result.user) });
  });

  app.delete("/v1/users/:id", async (request, reply) => {
    const admin = requireAdmin(request);
    const targetId = messageId(request);
    const target = findUserById(db, targetId);
    if (!target) throw new HttpError(404, "not_found");
    try {
      deleteUser(db, targetId, admin.id);
    } catch (err) {
      if (err instanceof UserError) throw new HttpError(err.statusCode);
      throw err;
    }
    deleteUserSessions(db, targetId, target.username);
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: admin.username,
      action: "user_delete",
      target: target.username,
    });
    return reply.send({ ok: true });
  });

  app.post("/v1/users/:id/mailboxes", async (request, reply) => {
    const admin = requireAdmin(request);
    const targetId = messageId(request);
    const body = createMailboxBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const at = now();
    let mailbox;
    try {
      mailbox = addUserMailbox(db, targetId, body.data, at);
    } catch (err) {
      if (err instanceof UserError) throw new HttpError(err.statusCode);
      throw err;
    }
    writeAudit(db, {
      id: ulid(),
      at,
      actor: admin.username,
      action: "user_mailbox_add",
      target: mailbox.address,
    });
    return reply.code(201).send({
      ok: true,
      mailbox: { ...mailbox, createdAt: iso(mailbox.createdAt) },
    });
  });

  app.patch("/v1/users/:id/mailboxes/:mailboxId", async (request, reply) => {
    const admin = requireAdmin(request);
    const params = request.params as { id?: unknown; mailboxId?: unknown };
    const targetId = typeof params.id === "string" && /^[\w-]+$/.test(params.id) ? params.id : "";
    const mailboxId = typeof params.mailboxId === "string" && /^[\w-]+$/.test(params.mailboxId) ? params.mailboxId : "";
    if (!targetId || !mailboxId) throw new HttpError(404, "not_found");
    const body = updateMailboxBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    let mailbox;
    try {
      mailbox = updateUserMailbox(db, targetId, mailboxId, body.data);
    } catch (err) {
      if (err instanceof UserError) throw new HttpError(err.statusCode);
      throw err;
    }
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: admin.username,
      action: "user_mailbox_update",
      target: mailbox.address,
    });
    return reply.send({
      ok: true,
      mailbox: { ...mailbox, createdAt: iso(mailbox.createdAt) },
    });
  });

  app.delete("/v1/users/:id/mailboxes/:mailboxId", async (request, reply) => {
    const admin = requireAdmin(request);
    const params = request.params as { id?: unknown; mailboxId?: unknown };
    const targetId = typeof params.id === "string" && /^[\w-]+$/.test(params.id) ? params.id : "";
    const mailboxId = typeof params.mailboxId === "string" && /^[\w-]+$/.test(params.mailboxId) ? params.mailboxId : "";
    if (!targetId || !mailboxId) throw new HttpError(404, "not_found");
    const removed = removeUserMailbox(db, targetId, mailboxId);
    if (!removed) throw new HttpError(404, "not_found");
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: admin.username,
      action: "user_mailbox_remove",
      target: mailboxId,
    });
    return reply.send({ ok: true });
  });

  // --- Admin: Prompts & AI ---
  app.get("/v1/prompts", async (request) => {
    requireAdmin(request);
    const list = listPrompts(config.promptsDir, db);
    return {
      items: list.map((item) => ({
        id: item.id,
        name: item.name,
      })),
      defaultPromptId: "classify-v1",
    };
  });

  app.get("/v1/prompts/:id", async (request) => {
    requireAdmin(request);
    const params = request.params as Record<string, string>;
    const id = params.id;
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new HttpError(400);
    try {
      const content = readPrompt(config.promptsDir, id, db);
      return { id, content };
    } catch {
      throw new HttpError(404, "not_found");
    }
  });

  app.put("/v1/prompts/:id", async (request, reply) => {
    const admin = requireAdmin(request);
    const params = request.params as Record<string, string>;
    const id = params.id;
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new HttpError(400);
    const body = request.body as { content?: unknown };
    if (!body || typeof body.content !== "string" || body.content.trim().length === 0 || body.content.length > 100_000) {
      throw new HttpError(400);
    }
    savePrompt(config.promptsDir, id, body.content, db, now());
    writeAudit(db, { id: ulid(), at: now(), actor: admin.username, action: "prompt_update", target: id });
    return reply.send({ ok: true, id });
  });

  app.get("/v1/ai/status", async (request) => {
    requireAdmin(request);
    return aiStatus(db, config);
  });

  app.post("/v1/settings/ai/test-key", { config: { rateLimit: { max: 20, timeWindow: "5 minutes" } } }, async (request, reply) => {
    const admin = requireAdmin(request);
    const body = aiTestKeyBody.safeParse(request.body ?? {});
    if (!body.success) throw new HttpError(400);
    const pool = readEffectiveAiPool(db, fallbackAiPool(config));
    let secret = body.data.secret?.trim() ?? "";
    if (!secret && body.data.id) {
      const found = pool.keys.find((item) => item.id === body.data.id);
      if (!found) throw new HttpError(404, "not_found");
      secret = found.secret;
    }
    if (!secret && pool.keys[0]) {
      secret = pool.keys[0].secret;
    }
    const fallbackModel = config.classifier === "gemini" ? config.geminiModel : config.openaiModel ?? "";
    const model = body.data.model?.trim() || pool.models[0] || fallbackModel;
    const probe = await probeAiKey({
      classifier: config.classifier,
      secret,
      allSecrets: pool.keys.map((item) => item.secret),
      model,
      geminiBaseUrl: config.geminiBaseUrl,
      openaiBaseUrl: config.openaiBaseUrl,
      fetchImpl: options.probeFetchImpl,
      now,
    });
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: admin.username,
      action: "ai_key_test",
      detail: `ok=${probe.ok} ms=${probe.latencyMs}`,
    });
    return reply.send(probe);
  });

  // --- Role-Aware Settings ---
  app.get("/v1/settings", async (request) => {
    const user = requireUser(request);
    const runtime = readRuntimeSettings(db, {
      notifyLabels: config.notifyLabels,
      notifyMinConfidence: config.notifyMinConfidence,
      acceptDomains: config.acceptDomains,
    });
    const personal = readUserPersonalSettings(user, {
      panelTitle: runtime.panelTitle,
      labelNames: runtime.labelNames,
    });

    if (user.role !== "admin") {
      return {
        role: "member" as const,
        panelTitle: personal.panelTitle,
        labelNames: personal.labelNames,
        domainNames: { ...runtime.domainNames, ...personal.domainNames },
        senderNames: personal.senderNames,
        blockedSenders: personal.blockedSenders,
        notifyLabels: personal.notifyLabels,
        notifyMinConfidence: personal.notifyMinConfidence,
        notifyWebhookUrl: personal.notifyWebhookUrl,
        signature: personal.signature,
        acceptDomains: runtime.acceptDomains,
        mailboxes: listUserMailboxes(db, user.id).map((mb) => ({ ...mb, createdAt: iso(mb.createdAt) })),
        version: APP_VERSION_STR,
      };
    }

    return {
      role: "admin" as const,
      notifyLabels: runtime.notifyLabels,
      notifyMinConfidence: runtime.notifyMinConfidence,
      acceptDomains: runtime.acceptDomains,
      jobMaxAttempts: runtime.jobMaxAttempts,
      panelTitle: runtime.panelTitle,
      labelNames: runtime.labelNames,
      domainNames: runtime.domainNames,
      senderNames: runtime.senderNames,
      signature: personal.signature,
      channels: {
        telegram: Boolean(config.telegramBotToken && config.telegramChatId),
        webhook: Boolean(config.notifyWebhookUrl),
      },
      ai: aiStatus(db, config),
      aiPool: presentAiPool(readEffectiveAiPool(db, fallbackAiPool(config))),
      aiEnabled: readAiEnabled(db),
      aiThinking: readAiThinking(db),
      blockedSenders: readBlockedSenders(db),
      passwordSet: readPasswordHash(db) !== null || user.password_hash !== "env",
      version: APP_VERSION_STR,
    };
  });

  app.put("/v1/settings/ai", async (request, reply) => {
    const admin = requireAdmin(request);
    const body = aiSettingsBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    let saved;
    try {
      saved = saveAiPool(db, body.data, fallbackAiPool(config).keys, now());
    } catch (err) {
      if (err instanceof SettingsError) throw new HttpError(400);
      throw err;
    }
    if (body.data.enabled !== undefined && body.data.thinking !== undefined) {
      saveAiControls(db, body.data.enabled, body.data.thinking, now());
    }
    if (readAiEnabled(db)) wakeClassifyJobs(db, now());
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: admin.username,
      action: "settings_ai",
      detail: `models=${saved.models.length} keys=${saved.keys.length}`,
    });
    return reply.send({
      ok: true,
      aiPool: saved,
      aiEnabled: readAiEnabled(db),
      aiThinking: readAiThinking(db),
    });
  });

  app.put("/v1/settings/blocklist", async (request, reply) => {
    const user = requireUser(request);
    const body = blocklistBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const at = now();
    let blockedSenders: string[];
    if (user.role === "admin") {
      try {
        blockedSenders = saveBlockedSenders(db, body.data.addresses, at);
      } catch (err) {
        if (err instanceof SettingsError) throw new HttpError(400);
        throw err;
      }
    } else {
      try {
        const saved = saveUserPersonalSettings(db, user.id, { blockedSenders: body.data.addresses }, at);
        blockedSenders = saved.blockedSenders;
      } catch (err) {
        if (err instanceof UserError) throw new HttpError(err.statusCode);
        throw err;
      }
    }
    writeAudit(db, {
      id: ulid(),
      at,
      actor: user.username,
      action: "settings_blocklist",
      detail: `count=${blockedSenders.length}`,
    });
    return reply.send({ ok: true, blockedSenders });
  });

  app.put("/v1/settings/password", async (request, reply) => {
    const user = requireUser(request);
    const body = passwordBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    if (body.data.next === "admin") throw new HttpError(400);
    const at = now();
    const currentOk = verifyUserLogin(
      db,
      user.username,
      body.data.current,
      config.apiUsername,
      config.apiPassword ?? "",
      at,
    );
    if (!currentOk) throw new HttpError(401, "unauthorized");
    const isBootstrap = sameAccount(user.username.toLowerCase(), config.apiUsername.toLowerCase());
    updateUserPassword(db, user.id, body.data.next, at);
    if (isBootstrap) {
      savePasswordHash(db, hashPassword(body.data.next), at);
      clearResetSeal(db);
    } else {
      deleteUserResetSeal(db, user.id, false);
    }
    writeAudit(db, {
      id: ulid(),
      at,
      actor: user.username,
      action: "password_change",
    });
    return reply.send({ ok: true });
  });

  app.get("/v1/logs", async (request) => {
    requireAdmin(request);
    return { lines: recentLogs().map(redactLogLine) };
  });

  app.put("/v1/settings/notify", async (request, reply) => {
    const user = requireUser(request);
    const body = notifySettingsBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const at = now();
    if (user.role === "admin") {
      let labels;
      try {
        labels = saveNotifySettings(db, body.data.labels, body.data.minConfidence, at);
      } catch (err) {
        if (err instanceof SettingsError) throw new HttpError(400);
        throw err;
      }
      writeAudit(db, {
        id: ulid(),
        at,
        actor: user.username,
        action: "settings_notify",
        detail: labels.join(",") || "none",
      });
      return reply.send({ ok: true, notifyLabels: labels, notifyMinConfidence: body.data.minConfidence });
    }

    try {
      const saved = saveUserPersonalSettings(
        db,
        user.id,
        {
          notifyLabels: body.data.labels,
          notifyMinConfidence: body.data.minConfidence,
          notifyWebhookUrl: body.data.webhookUrl,
          notifyWebhookBearer: body.data.webhookBearer,
        },
        at,
      );
      writeAudit(db, {
        id: ulid(),
        at,
        actor: user.username,
        action: "settings_notify_personal",
        detail: saved.notifyLabels.join(",") || "none",
      });
      return reply.send({
        ok: true,
        notifyLabels: saved.notifyLabels,
        notifyMinConfidence: saved.notifyMinConfidence,
        notifyWebhookUrl: saved.notifyWebhookUrl,
      });
    } catch (err) {
      if (err instanceof UserError) throw new HttpError(err.statusCode);
      throw err;
    }
  });

  app.put("/v1/settings/domains", async (request, reply) => {
    const admin = requireAdmin(request);
    const body = domainSettingsBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    let domains;
    try {
      domains = saveAcceptDomains(db, body.data.domains, now());
    } catch (err) {
      if (err instanceof ConfigError) throw new HttpError(400);
      throw err;
    }
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: admin.username,
      action: "settings_domains",
      detail: domains.join(","),
    });
    return reply.send({ ok: true, acceptDomains: domains });
  });

  app.get("/v1/dkim", async (request) => {
    requireAdmin(request);
    return { items: listDkimPublic(db) };
  });

  app.post("/v1/dkim", async (request, reply) => {
    const admin = requireAdmin(request);
    const body = dkimBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    let saved;
    try {
      saved = saveDkimKey(db, body.data.domain, body.data.selector, now(), body.data.algorithm);
    } catch (err) {
      if (err instanceof OutboundError) throw new HttpError(400);
      throw err;
    }
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: admin.username,
      action: "dkim_generate",
      target: `${saved.selector}._domainkey.${saved.domain}`,
      detail: saved.algorithm,
    });
    return reply.send({ ok: true, ...saved });
  });

  app.post("/v1/dkim/remove", async (request, reply) => {
    const admin = requireAdmin(request);
    const body = dkimRemoveBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    let removed = false;
    try {
      removed = deleteDkimKey(db, body.data.domain, body.data.selector);
    } catch (err) {
      if (err instanceof OutboundError) throw new HttpError(400);
      throw err;
    }
    if (!removed) throw new HttpError(404, "not_found");
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: admin.username,
      action: "dkim_remove",
      target: `${body.data.selector}._domainkey.${body.data.domain}`,
    });
    return reply.send({ ok: true });
  });

  // --- Outbox & Sending (Tenant-Scoped) ---
  app.get("/v1/outbox", async (request) => {
    const user = requireUser(request);
    const query = request.query as Record<string, unknown>;
    const limitRaw = optionalString(query.limit);
    const scopeParam = optionalString(query.scope);
    if (scopeParam === "all" && user.role !== "admin") throw new HttpError(403, "forbidden");
    let limit = 30;
    if (limitRaw !== undefined) {
      if (!/^\d+$/.test(limitRaw)) throw new HttpError(400);
      limit = Number(limitRaw);
      if (limit < 1 || limit > 100) throw new HttpError(400);
    }
    const outboxScope =
      scopeParam === "all" && user.role === "admin"
        ? undefined
        : { userId: user.id, includeUnowned: user.role === "admin" };
    return { items: listOutbox(db, limit, outboxScope).map(presentOutbox) };
  });

  app.get("/v1/outbox/:id/raw", async (request, reply) => {
    const user = requireUser(request);
    const outboxScope = user.role === "admin" ? undefined : { userId: user.id, includeUnowned: false };
    const row = getOutbox(db, messageId(request), outboxScope);
    if (!row) throw new HttpError(404, "not_found");
    let bytes: Buffer;
    try {
      bytes = await readRaw(config.mailDataDir, row.raw_path, codec, row.sha256);
    } catch (err) {
      if (err instanceof PathEscapeError) throw new HttpError(404, "not_found");
      throw new HttpError(404, "not_found");
    }
    return reply
      .header("content-type", "message/rfc822")
      .header("content-disposition", contentDisposition(`${row.sha256}.eml`))
      .send(bytes);
  });

  app.get("/v1/outbox/:id", async (request) => {
    const user = requireUser(request);
    const outboxScope = user.role === "admin" ? undefined : { userId: user.id, includeUnowned: false };
    const row = getOutbox(db, messageId(request), outboxScope);
    if (!row) throw new HttpError(404, "not_found");
    let text = "";
    let headers = "";
    let attachmentNames: string[] = [];
    try {
      const bytes = await readRaw(config.mailDataDir, row.raw_path, codec, row.sha256);
      const email = await PostalMime.parse(bytes);
      text = email.text ?? "";
      if (text.length > 100_000) text = text.slice(0, 100_000);
      headers = rfc822HeaderBlock(bytes);
      attachmentNames = email.attachments.map((att) => att.filename || "attachment");
    } catch (err) {
      if (err instanceof PathEscapeError) throw new HttpError(404, "not_found");
    }
    return { ...presentOutbox(row), text, headers, attachments: attachmentNames };
  });

  app.post("/v1/outbox/:id/retry", async (request, reply) => {
    const user = requireUser(request);
    const id = messageId(request);
    const outboxScope = user.role === "admin" ? undefined : { userId: user.id, includeUnowned: false };
    const row = getOutbox(db, id, outboxScope);
    if (!row) throw new HttpError(404, "not_found");
    const ok = retryOutboxJob(db, id, now());
    if (!ok) throw new HttpError(404, "not_found");
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: user.username,
      action: "send_retry",
      target: id,
    });
    return reply.send({ ok: true });
  });

  app.post("/v1/outbox", { config: { rateLimit: { max: 30, timeWindow: "10 minutes" } } }, async (request, reply) => {
    const user = requireUser(request);
    const body = sendBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const normalizedFrom = normalizeAddress(body.data.from);
    if (!normalizedFrom) throw new HttpError(400);
    const perm = authorizeSendFrom(db, user, normalizedFrom);
    if (!perm.allowed) throw new HttpError(403, "forbidden");

    try {
      const queued = await submitOutbox(
        { db, dataDir: config.mailDataDir, codec, acceptDomains: config.acceptDomains, now },
        {
          ...body.data,
          userId: user.id,
          from: perm.from,
          fromName: perm.fromName,
        },
      );
      writeAudit(db, {
        id: ulid(),
        at: now(),
        actor: user.username,
        action: "send_queue",
        target: queued.id,
        detail: `dkim=${queued.dkim} known=${queued.domainKnown}`,
      });
      return reply.code(202).send(queued);
    } catch (err) {
      if (err instanceof OutboundError) throw new HttpError(400);
      throw err;
    }
  });

  app.put("/v1/settings/jobs", async (request, reply) => {
    const admin = requireAdmin(request);
    const body = jobSettingsBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    let maxAttempts;
    try {
      maxAttempts = saveJobMaxAttempts(db, body.data.maxAttempts, now());
    } catch (err) {
      if (err instanceof SettingsError) throw new HttpError(400);
      throw err;
    }
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: admin.username,
      action: "settings_jobs",
      detail: `maxAttempts=${maxAttempts}`,
    });
    return reply.send({ ok: true, jobMaxAttempts: maxAttempts });
  });

  app.put("/v1/settings/names", async (request, reply) => {
    const user = requireUser(request);
    const body = nameSettingsBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const at = now();

    if (user.role === "admin") {
      let saved;
      try {
        saved = saveNameSettings(db, body.data, at);
        if (body.data.signature !== undefined) {
          saveUserPersonalSettings(db, user.id, { signature: body.data.signature }, at);
        }
      } catch (err) {
        if (err instanceof SettingsError || err instanceof ConfigError || err instanceof UserError) {
          throw new HttpError(400);
        }
        throw err;
      }
      writeAudit(db, {
        id: ulid(),
        at,
        actor: user.username,
        action: "settings_names",
        detail: saved.panelTitle,
      });
      return reply.send({ ok: true, ...saved });
    }

    try {
      const saved = saveUserPersonalSettings(
        db,
        user.id,
        {
          panelTitle: body.data.panelTitle,
          labelNames: body.data.labelNames,
          domainNames: body.data.domainNames,
          senderNames: body.data.senderNames,
          signature: body.data.signature,
        },
        at,
      );
      writeAudit(db, {
        id: ulid(),
        at,
        actor: user.username,
        action: "settings_names_personal",
        detail: saved.panelTitle,
      });
      return reply.send({
        ok: true,
        panelTitle: saved.panelTitle,
        labelNames: saved.labelNames,
        domainNames: saved.domainNames,
        senderNames: saved.senderNames,
        signature: saved.signature,
      });
    } catch (err) {
      if (err instanceof UserError) throw new HttpError(err.statusCode);
      throw err;
    }
  });

  app.get("/v1/stats", async (request) => {
    requireAdmin(request);
    const start = utcDayStart(now());
    return {
      today: countLabels(db, start),
      total: countLabels(db, null),
      daily: dailySeries(db, start - 13 * 86_400_000, 14),
    };
  });

  app.get("/v1/mailbox-history", async (request) => {
    const user = requireUser(request);
    if (user.role !== "admin") {
      const own = listUserMailboxes(db, user.id);
      return {
        items: own
          .filter((mb) => mb.localpart !== "*")
          .map((mb) => ({
            domain: mb.domain,
            localpart: mb.localpart,
            firstSeen: iso(mb.createdAt),
            lastSeen: null,
            source: "assigned",
            notes: mb.note,
            displayName: mb.displayName,
          })),
      };
    }

    const query = request.query as Record<string, unknown>;
    const domain = optionalString(query.domain);
    const localpart = optionalString(query.localpart);
    return {
      items: listMailboxHistory(db, {
        domain: domain?.toLowerCase(),
        localpart: localpart?.toLowerCase(),
      }).map(toHistory),
    };
  });

  app.post("/v1/mailbox-history", async (request, reply) => {
    const user = requireUser(request);
    const body = historyBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const domain = body.data.domain.trim().toLowerCase().replace(/\.$/, "");
    const localpart = body.data.localpart.trim().toLowerCase();
    if (!DOMAIN_RE.test(domain) || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/.test(localpart)) {
      throw new HttpError(400);
    }

    if (user.role !== "admin") {
      const own = listUserMailboxes(db, user.id).find(
        (mb) => mb.domain === domain && mb.localpart === localpart,
      );
      if (!own) throw new HttpError(403, "forbidden");
      try {
        updateUserMailbox(db, user.id, own.id, {
          displayName: body.data.displayName,
          note: body.data.notes,
        });
      } catch (err) {
        if (err instanceof UserError) throw new HttpError(err.statusCode);
        throw err;
      }
      return reply.code(201).send({ ok: true });
    }

    upsertMailboxHistory(db, {
      domain,
      localpart,
      firstSeen: optionalTime(body.data.firstSeen),
      lastSeen: optionalTime(body.data.lastSeen),
      source: body.data.source ?? null,
      notes: body.data.notes ?? null,
      displayName: body.data.displayName,
    });
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: user.username,
      action: "mailbox_history_upsert",
      target: `${localpart}@${domain}`,
    });
    return reply.code(201).send({ ok: true });
  });

  registerPanel(app);
  return app;
}

export async function startApi(options: ApiOptions): Promise<RunningApi> {
  const app = await buildApi(options);
  await app.listen({ host: options.config.apiHost, port: options.config.apiPort });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : options.config.apiPort;
  return { port, close: () => app.close() };
}

function requireUser(request: FastifyRequest): UserRow {
  if (!request.currentUser) throw new HttpError(401, "unauthorized");
  return request.currentUser;
}

function requireAdmin(request: FastifyRequest): UserRow {
  const user = requireUser(request);
  if (user.role !== "admin") throw new HttpError(403, "forbidden");
  return user;
}

function resolveQueryScope(request: FastifyRequest, scopeParam?: string): string | undefined {
  const user = requireUser(request);
  if (scopeParam === "all") {
    if (user.role !== "admin") throw new HttpError(403, "forbidden");
    return undefined;
  }
  return user.id;
}

function readUserResetSeal(db: Db, userId: string, isBootstrap: boolean): ResetSeal | null {
  if (isBootstrap) return readResetSeal(db);
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(`password_reset:${userId}`) as { value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    if (
      typeof parsed.salt !== "string" ||
      typeof parsed.hash !== "string" ||
      !Number.isFinite(parsed.expiresAt) ||
      !Number.isFinite(parsed.attempts) ||
      !Number.isFinite(parsed.sentAt)
    ) {
      return null;
    }
    return {
      salt: parsed.salt,
      hash: parsed.hash,
      expiresAt: parsed.expiresAt as number,
      attempts: parsed.attempts as number,
      sentAt: parsed.sentAt as number,
    };
  } catch {
    return null;
  }
}

function writeUserResetSeal(db: Db, userId: string, isBootstrap: boolean, seal: ResetSeal, now: number): void {
  if (isBootstrap) {
    saveResetSeal(db, seal, now);
    return;
  }
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(`password_reset:${userId}`, JSON.stringify(seal), now);
}

function deleteUserResetSeal(db: Db, userId: string, isBootstrap: boolean): void {
  if (isBootstrap) {
    clearResetSeal(db);
    return;
  }
  db.prepare("DELETE FROM settings WHERE key = ?").run(`password_reset:${userId}`);
}

function presentUserSummary(u: ReturnType<typeof listUsersWithStats>[number]) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    recoveryEmail: u.recoveryEmail,
    role: u.role,
    catchAll: u.catchAll,
    disabled: u.disabled,
    disabledAt: u.disabledAt ? iso(u.disabledAt) : null,
    lastLoginAt: u.lastLoginAt ? iso(u.lastLoginAt) : null,
    createdAt: iso(u.createdAt),
    messageCount: u.messageCount,
    unreadCount: u.unreadCount,
    sentCount: u.sentCount,
    mailboxes: u.mailboxes.map((mb) => ({
      ...mb,
      createdAt: iso(mb.createdAt),
    })),
  };
}

function redactLogLine(line: string): string {
  return line
    .replace(/([?&]key=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{10,}\b/g, "[redacted]");
}

function aiStatus(db: Db, config: Config): { classifier: string; model: string; keyCount: number } {
  if (config.classifier === "fake") return { classifier: "fake", model: "fake", keyCount: 0 };
  const pool = readEffectiveAiPool(db, fallbackAiPool(config));
  const fallbackModel = config.classifier === "gemini" ? config.geminiModel : config.openaiModel ?? "";
  return {
    classifier: config.classifier,
    model: pool.models[0] || fallbackModel,
    keyCount: pool.keys.length,
  };
}

function presentOutbox(row: NonNullable<ReturnType<typeof getOutbox>>) {
  return {
    id: row.id,
    from: row.from_addr,
    to: parseJson(row.to_addrs),
    subject: row.subject,
    status: row.status,
    domainKnown: row.domain_known === 1,
    dkim: row.dkim_selector ? "signed" : "none",
    selector: row.dkim_selector,
    error: row.error,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function envelopeList(raw: string | null): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string").join(", ");
    }
  } catch {
    return raw;
  }
  return raw;
}

function isPublic(url: string): boolean {
  const urlPath = url.split("?")[0] ?? url;
  return (
    urlPath === "/healthz" ||
    urlPath === "/v1/login" ||
    urlPath === "/v1/csrf" ||
    urlPath === "/v1/password/forgot" ||
    urlPath === "/v1/password/reset" ||
    isPanelAsset(urlPath)
  );
}

function messageId(request: FastifyRequest): string {
  const id = (request.params as { id?: unknown }).id;
  if (typeof id !== "string" || !/^[\w-]+$/.test(id)) throw new HttpError(404, "not_found");
  return id;
}

function attachmentId(request: FastifyRequest): string {
  const sha = (request.params as { sha256?: unknown }).sha256;
  if (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) throw new HttpError(404, "not_found");
  return sha;
}

function requireMessage(db: Db, id: string, userId?: string): StoredMessage {
  const message = getMessageForUser(db, id, userId);
  if (!message) throw new HttpError(404, "not_found");
  return message;
}

function readListQuery(query: unknown): {
  scope?: string;
  label?: string;
  status?: string;
  trashed?: boolean | "all";
  starred?: boolean;
  unread?: boolean;
  to?: string;
  q?: string;
  from?: string;
  domain?: string;
  since?: number;
  until?: number;
  limit: number;
  cursorAt?: number;
  cursorId?: string;
} {
  const source = query && typeof query === "object" ? (query as Record<string, unknown>) : {};
  const scope = optionalString(source.scope);
  const label = optionalString(source.label);
  const status = optionalString(source.status);
  const trashedRaw = optionalString(source.trashed);
  let trashed: boolean | "all" | undefined;
  if (trashedRaw === "true" || trashedRaw === "1") {
    trashed = true;
  } else if (trashedRaw === "all") {
    trashed = "all";
  } else if (trashedRaw === "false" || trashedRaw === "0") {
    trashed = false;
  }
  const starredRaw = optionalString(source.starred);
  const starred = starredRaw === "true" || starredRaw === "1" ? true : undefined;
  const unreadRaw = optionalString(source.unread);
  const unread = unreadRaw === "true" || unreadRaw === "1" ? true : undefined;
  const to = optionalString(source.to);
  const q = optionalString(source.q);
  const from = optionalString(source.from);
  const domain = optionalString(source.domain);
  const since = optionalString(source.since);
  const until = optionalString(source.until);
  const limitRaw = optionalString(source.limit);
  const cursor = optionalString(source.cursor);
  if (scope && scope !== "all" && scope !== "mine") throw new HttpError(400);
  if (label && label !== "not-legit" && !LABELS.includes(label as (typeof LABELS)[number])) throw new HttpError(400);
  if (status && !STATUSES.includes(status as (typeof STATUSES)[number])) throw new HttpError(400);
  if (q && q.length > 200) throw new HttpError(400);
  let limit = 50;
  if (limitRaw !== undefined) {
    if (!/^\d+$/.test(limitRaw)) throw new HttpError(400);
    limit = Number(limitRaw);
    if (limit < 1 || limit > 200) throw new HttpError(400);
  }
  let cursorAt: number | undefined;
  let cursorId: string | undefined;
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (!decoded) throw new HttpError(400);
    cursorAt = decoded.receivedAt;
    cursorId = decoded.id;
  }
  return {
    scope,
    label,
    status,
    trashed,
    starred,
    unread,
    to,
    q,
    from,
    domain,
    since: since === undefined ? undefined : parseTime(since),
    until: until === undefined ? undefined : parseTime(until),
    limit,
    cursorAt,
    cursorId,
  };
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new HttpError(400);
  return value;
}

function parseTime(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new HttpError(400);
  return ms;
}

function optionalTime(value: string | number | null | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") return parseTime(value);
  throw new HttpError(400);
}

function toListItem(row: ReturnType<typeof listMessages>[number]) {
  const ai = aiSummary(row.ai_result);
  const effectiveLabel = row.label_override ?? ai.label;
  const manualOverride = Boolean(row.label_override) || ai.manualOverride;
  const envTo = parseJson(row.envelope_to);
  const firstTo = Array.isArray(envTo) && typeof envTo[0] === "string" ? envTo[0] : null;
  return {
    id: row.id,
    sha256: row.sha256,
    receivedAt: iso(row.received_at),
    sizeBytes: row.size_bytes,
    envelopeFrom: row.envelope_from,
    envelopeTo: envTo,
    recipient: row.recipient_addr ?? firstTo,
    messageId: row.message_id,
    subject: row.subject,
    from: row.from_addr,
    domains: parseJson(row.domains),
    status: row.status,
    label: effectiveLabel,
    read: row.read_at != null,
    starred: row.starred_at != null,
    attachmentCount: parsedAttachmentCount(row.parsed),
    confidence: ai.confidence,
    summary: ai.summary,
    tags: ai.tags,
    manualOverride,
    originalLabel: ai.originalLabel ?? (row.label_override && ai.label && ai.label !== row.label_override ? ai.label : null),
    originalConfidence: ai.originalConfidence,
    trashedAt: row.trashed_at ? iso(row.trashed_at) : null,
  };
}

function parsedAttachmentCount(raw: string | null): number {
  const value = parseJson(raw);
  if (!value || typeof value !== "object") return 0;
  const count = (value as { attachmentCount?: unknown }).attachmentCount;
  return typeof count === "number" && count > 0 ? count : 0;
}

function idList(raw: string | null): string[] {
  const value = parseJson(raw);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 20);
}

function toDetail(db: Db, id: string, userId?: string) {
  const message = requireMessage(db, id, userId);
  let aiResult = parseJson(message.ai_result);
  if (message.label_override) {
    const base: Record<string, unknown> = aiResult && typeof aiResult === "object" && !Array.isArray(aiResult)
      ? { ...(aiResult as Record<string, unknown>) }
      : { schema: 1, summary: "已手动修改分类", confidence: 1, tags: [], signals: [] };
    if (typeof base.originalLabel !== "string" && typeof base.label === "string") {
      base.originalLabel = base.label;
    }
    base.label = message.label_override;
    base.manualOverride = true;
    aiResult = base;
  }
  return {
    id: message.id,
    sha256: message.sha256,
    receivedAt: iso(message.received_at),
    sizeBytes: message.size_bytes,
    status: message.status,
    error: publicError(message.error),
    envelopeFrom: message.envelope_from,
    envelopeTo: parseJson(message.envelope_to),
    recipient: message.recipient_addr ?? null,
    messageId: message.message_id,
    inReplyTo: message.in_reply_to,
    references: idList(message.ref_ids),
    subject: message.subject,
    from: message.from_addr,
    to: parseJson(message.to_addrs),
    domains: parseJson(message.domains),
    smtpMeta: parseJson(message.smtp_meta),
    authResult: parseJson(message.auth_result),
    parsed: parseJson(message.parsed),
    aiResult,
    read: message.read_at != null,
    starred: message.starred_at != null,
    trashedAt: message.trashed_at ? iso(message.trashed_at) : null,
    attachments: listMessageAttachments(db, id).map((row) => ({
      sha256: row.sha256,
      filename: row.filename,
      mime: row.mime,
      sizeBytes: row.size_bytes,
    })),
  };
}

function aiSummary(raw: string | null): {
  label: string | null;
  confidence: number | null;
  summary: string | null;
  tags: string[];
  manualOverride: boolean;
  originalLabel: string | null;
  originalConfidence: number | null;
} {
  const value = parseJson(raw);
  if (!value || typeof value !== "object") {
    return {
      label: null,
      confidence: null,
      summary: null,
      tags: [],
      manualOverride: false,
      originalLabel: null,
      originalConfidence: null,
    };
  }
  const record = value as Record<string, unknown>;
  return {
    label: typeof record.label === "string" ? record.label : null,
    confidence: typeof record.confidence === "number" ? record.confidence : null,
    summary: typeof record.summary === "string" ? record.summary : null,
    tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === "string") : [],
    manualOverride: record.manualOverride === true,
    originalLabel: typeof record.originalLabel === "string" ? record.originalLabel : null,
    originalConfidence: typeof record.originalConfidence === "number" ? record.originalConfidence : null,
  };
}

function dailySeries(db: Db, startMs: number, days: number): Array<{ day: string; total: number; labels: Record<string, number> }> {
  const rows = db
    .prepare(
      `SELECT (received_at / 86400000) AS day_index,
              COALESCE(json_extract(ai_result, '$.label'), 'unlabeled') AS label,
              COUNT(*) AS n
       FROM messages
       WHERE received_at >= ?
       GROUP BY 1, 2`,
    )
    .all(startMs) as Array<{ day_index: number; label: string; n: number }>;
  const byDay = new Map<string, Record<string, number>>();
  for (let i = 0; i < days; i += 1) {
    byDay.set(new Date(startMs + i * 86_400_000).toISOString().slice(0, 10), {});
  }
  for (const row of rows) {
    const day = new Date(row.day_index * 86_400_000).toISOString().slice(0, 10);
    const bucket = byDay.get(day);
    if (!bucket) continue;
    bucket[row.label] = row.n;
  }
  return [...byDay].map(([day, labels]) => ({
    day,
    total: Object.values(labels).reduce((sum, n) => sum + n, 0),
    labels,
  }));
}

function countLabels(db: Db, since: number | null): Record<string, number> {
  const rows = (
    since === null
      ? db.prepare("SELECT json_extract(ai_result, '$.label') AS label, COUNT(*) AS n FROM messages GROUP BY 1").all()
      : db.prepare("SELECT json_extract(ai_result, '$.label') AS label, COUNT(*) AS n FROM messages WHERE received_at >= ? GROUP BY 1").all(since)
  ) as Array<{ label: string | null; n: number }>;
  const out: Record<string, number> = {};
  for (const row of rows) out[row.label ?? "unlabeled"] = row.n;
  return out;
}

function toHistory(row: {
  domain: string;
  localpart: string;
  first_seen: number | null;
  last_seen: number | null;
  source: string | null;
  notes: string | null;
  display_name: string | null;
}) {
  return {
    domain: row.domain,
    localpart: row.localpart,
    firstSeen: row.first_seen === null ? null : iso(row.first_seen),
    lastSeen: row.last_seen === null ? null : iso(row.last_seen),
    source: row.source,
    notes: row.notes,
    displayName: row.display_name,
  };
}

function utcDayStart(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
