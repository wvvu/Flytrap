import { readFile } from "node:fs/promises";
import { ulid } from "ulid";
import cookie from "@fastify/cookie";
import csrf from "@fastify/csrf-protection";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import session from "@fastify/session";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import PostalMime from "postal-mime";
import { LABELS } from "../ai/types.js";
import { listPrompts, readPrompt, savePrompt } from "../ai/prompt.js";
import { probeAiKey } from "../ai/probe.js";
import { fallbackAiPool } from "../ai/pool.js";
import { ConfigError, type Config } from "../config.js";
import type { Codec } from "../compress.js";
import type { Db } from "../db/index.js";
import { findAttachment, listMessageAttachments } from "../db/repos/attachments.js";
import { listRecentAudit, writeAudit } from "../db/repos/audit.js";
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
  DEFAULT_PANEL_TITLE,
  presentAiPool,
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
} from "../db/repos/settings.js";
import { findMailboxHistory, listMailboxHistory, upsertMailboxHistory } from "../db/repos/mailbox-history.js";
import {
  countTrash,
  countUnread,
  deleteMessage,
  emptyMemberTrash,
  emptyTrash,
  getMessage,
  getMessageForMember,
  listMessages,
  markAllMessagesRead,
  markMessageRead,
  memberCanReadAttachment,
  overrideMemberMessageLabel,
  purgeMemberMessage,
  restoreMessage,
  trashMessage,
  type MemberScope,
} from "../db/repos/messages.js";
import {
  addUserAllocation,
  allowedMemberDomains,
  buildMemberRecipientSql,
  canSendFromAddress,
  countUserSentSince,
  createUser,
  deleteUser,
  findUserById,
  findUserByUsername,
  findUserForResetEmail,
  getUserDetail,
  listUserAllocations,
  listUsersWithDetails,
  readUserPreferences,
  readUserResetSeal,
  recordUserLogin,
  removeUserAllocation,
  revokeUserSessions,
  saveUserBlockedSenders,
  saveUserNamePreferences,
  saveUserResetSeal,
  suggestedFromAddresses,
  updateUser,
  updateUserPassword,
  upsertUserMailboxNote,
  UserError,
  type SessionPrincipal,
} from "../db/repos/users.js";
import { sha256 } from "../hash.js";
import { readRaw } from "../ingest/read-raw.js";
import { removeStoredFiles } from "../ingest/remove-stored.js";
import { normalizeAddress, OutboundError } from "../mail/address.js";
import { rfc822HeaderBlock } from "../mail/headers.js";
import { submitOutbox } from "../mail/submit.js";
import { PathEscapeError, resolveInside } from "../paths.js";
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
  loginOk,
  makeResetCode,
  passwordMatches,
  RESET_MAX_ATTEMPTS,
  RESET_RESEND_MS,
  resetCodeOk,
  sameAccount,
  sealResetCode,
} from "./password.js";
import { recentLogs } from "../log.js";
import { clearSessions, sqliteSessionStore } from "./session-store.js";
import { isPanelAsset, registerPanel } from "./static.js";

declare module "fastify" {
  interface Session {
    user?: string;
    userId?: string;
  }
  interface FastifyRequest {
    principal?: SessionPrincipal;
  }
}

const STATUSES = ["received", "authed", "parsed", "classified", "notified", "error"] as const;
const JOB_STATUSES = ["queued", "running", "done", "failed", "dead", "dismissed"] as const;
const DOMAIN_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const loginBody = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(512),
}).strict();

const notifySettingsBody = z.object({
  labels: z.array(z.string()).max(LABELS.length),
  minConfidence: z.number().min(0).max(1),
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

const aiTestBody = z.object({
  keyId: z.string().min(1).max(80).optional(),
  secret: z.string().min(8).max(512).optional(),
  model: z.string().min(1).max(80).optional(),
}).strict();

const readAllBody = z.object({
  target: z.enum(["inbox", "promo", "spam", "all"]).optional(),
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

const sendBody = z.object({
  from: z.string().min(3).max(254),
  to: z.array(z.string().min(3).max(254)).min(1).max(20),
  cc: z.array(z.string().min(3).max(254)).max(20).optional(),
  bcc: z.array(z.string().min(3).max(254)).max(20).optional(),
  subject: z.string().max(200).optional(),
  text: z.string().max(100_000).optional(),
  inReplyTo: z.string().max(300).optional(),
  references: z.array(z.string().max(300)).max(20).optional(),
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

const allocationInputSchema = z.object({
  pattern: z.string().min(3).max(320).optional(),
  kind: z.enum(["exact", "prefix", "domain"]).optional(),
  localpart: z.string().min(1).max(64).optional(),
  domain: z.string().min(1).max(253).optional(),
  canSend: z.boolean().optional(),
  notes: z.string().max(200).nullable().optional(),
}).strict();

const createUserBody = z.object({
  username: z.string().min(2).max(128),
  displayName: z.string().max(40).nullable().optional(),
  password: z.string().min(8).max(200),
  role: z.enum(["admin", "member"]).optional(),
  dailySendLimit: z.number().int().min(0).max(10_000).optional(),
  notes: z.string().max(300).nullable().optional(),
  allocations: z.array(allocationInputSchema).max(50).optional(),
}).strict();

const updateUserBody = z.object({
  displayName: z.string().max(40).nullable().optional(),
  role: z.enum(["admin", "member"]).optional(),
  dailySendLimit: z.number().int().min(0).max(10_000).optional(),
  notes: z.string().max(300).nullable().optional(),
  disabled: z.boolean().optional(),
}).strict();

const adminSetPasswordBody = z.object({
  next: z.string().min(8).max(200),
}).strict();

export interface ApiOptions {
  config: Config;
  db: Db;
  codec: Codec;
  log?: FastifyBaseLogger | boolean;
  now?: () => number;
  probeFetch?: typeof fetch;
}

export interface RunningApi {
  port: number;
  close: () => Promise<void>;
}

export async function buildApi(options: ApiOptions): Promise<FastifyInstance> {
  const now = options.now ?? Date.now;
  const app = Fastify(
    typeof options.log === "boolean"
      ? { logger: options.log, trustProxy: true }
      : options.log
        ? { loggerInstance: options.log, trustProxy: true }
        : { logger: false, trustProxy: true },
  );
  const { config, db, codec } = options;

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
    const payload: Record<string, string> = { error: errorName(status) };
    if (err instanceof HttpError && err.message && err.message !== errorName(status) && err.message !== "bad_request") {
      payload.reason = err.message;
    }
    return reply.code(status).send(payload);
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
    const principal = resolvePrincipal(request, db, config);
    if (!principal) {
      if (request.session.user) {
        await request.session.destroy().catch(() => {});
      }
      return reply.code(401).send({ error: "unauthorized" });
    }
    request.principal = principal;
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
    const inputUser = body.data.username.trim();
    const ownerMatched = loginOk(
      inputUser,
      body.data.password,
      config.apiUsername,
      config.apiPassword ?? "",
      readPasswordHash(db),
    );
    if (ownerMatched) {
      await request.session.regenerate();
      request.session.user = config.apiUsername;
      request.session.userId = "owner";
      writeAudit(db, { id: ulid(), at: now(), actor: config.apiUsername, action: "login" });
      return reply.send({ user: config.apiUsername });
    }

    const dbUser = findUserByUsername(db, inputUser);
    if (dbUser && dbUser.disabled_at === null && passwordMatches(body.data.password, dbUser.password_hash)) {
      const at = now();
      recordUserLogin(db, dbUser.id, at);
      await request.session.regenerate();
      request.session.user = dbUser.username;
      request.session.userId = dbUser.id;
      writeAudit(db, { id: ulid(), at, actor: dbUser.username, action: "login", detail: `role=${dbUser.role}` });
      return reply.send({ user: dbUser.username });
    }

    const actor = actorName(inputUser);
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor,
      action: "login_failed",
      detail: dbUser && dbUser.disabled_at !== null ? "disabled" : undefined,
    });
    throw new HttpError(401, "unauthorized");
  });

  app.post("/v1/password/forgot", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = resetRequestBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const email = normalizeAddress(body.data.email);
    if (!email) return reply.send({ ok: true });

    const ownerAccount = normalizeAddress(config.apiUsername);
    const at = now();
    const acceptDomains = readRuntimeSettings(db, {
      notifyLabels: config.notifyLabels,
      notifyMinConfidence: config.notifyMinConfidence,
      acceptDomains: config.acceptDomains,
    }).acceptDomains;
    const from = normalizeAddress(`noreply@${acceptDomains[0] ?? config.acceptDomains[0] ?? ""}`);

    if (ownerAccount && sameAccount(email, ownerAccount)) {
      const current = readResetSeal(db);
      const cooling =
        current &&
        current.attempts < RESET_MAX_ATTEMPTS &&
        at < current.expiresAt &&
        at < current.sentAt + RESET_RESEND_MS;
      if (!cooling && from) {
        const code = makeResetCode();
        try {
          await submitOutbox(
            { db, dataDir: config.mailDataDir, codec, acceptDomains: config.acceptDomains, now },
            {
              from,
              to: [email],
              subject: "登录验证码",
              text: `验证码 ${code}\n\n10 分钟内有效。\n`,
            },
          );
          saveResetSeal(db, sealResetCode(code, at), at);
          writeAudit(db, { id: ulid(), at, actor: email, action: "password_reset_sent" });
        } catch (err) {
          request.log.error({ err: err instanceof Error ? err.name : "password reset send failed" }, "password reset send failed");
        }
      }
      return reply.send({ ok: true });
    }

    const dbUser = findUserForResetEmail(db, email);
    if (dbUser && from) {
      const current = readUserResetSeal(dbUser);
      const cooling =
        current &&
        current.attempts < RESET_MAX_ATTEMPTS &&
        at < current.expiresAt &&
        at < current.sentAt + RESET_RESEND_MS;
      if (!cooling) {
        const code = makeResetCode();
        try {
          await submitOutbox(
            { db, dataDir: config.mailDataDir, codec, acceptDomains: config.acceptDomains, now },
            {
              from,
              to: [email],
              subject: "登录验证码",
              text: `验证码 ${code}\n\n10 分钟内有效。\n`,
            },
          );
          saveUserResetSeal(db, dbUser.id, sealResetCode(code, at), at);
          writeAudit(db, { id: ulid(), at, actor: dbUser.username, action: "password_reset_sent", target: email });
        } catch (err) {
          request.log.error({ err: err instanceof Error ? err.name : "password reset send failed" }, "password reset send failed");
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
    const ownerAccount = normalizeAddress(config.apiUsername);
    const at = now();

    if (email && ownerAccount && sameAccount(email, ownerAccount)) {
      const seal = readResetSeal(db);
      const verdict = seal ? resetCodeOk(body.data.code, seal, at) : { ok: false as const, seal: null };
      if (!verdict.ok) {
        if (verdict.seal) saveResetSeal(db, verdict.seal, at);
        else if (seal) clearResetSeal(db);
        writeAudit(db, { id: ulid(), at, actor: actorName(email), action: "password_reset_failed" });
        throw new HttpError(401, "unauthorized");
      }
      db.transaction(() => {
        savePasswordHash(db, hashPassword(body.data.next), at);
        clearResetSeal(db);
        clearSessions(db);
        writeAudit(db, { id: ulid(), at, actor: email, action: "password_reset" });
      })();
      return reply.send({ ok: true });
    }

    const dbUser = email ? findUserForResetEmail(db, email) : undefined;
    const seal = dbUser ? readUserResetSeal(dbUser) : null;
    const verdict = seal ? resetCodeOk(body.data.code, seal, at) : { ok: false as const, seal: null };
    if (!dbUser || !verdict.ok) {
      if (dbUser) {
        saveUserResetSeal(db, dbUser.id, verdict.ok ? null : verdict.seal, at);
        writeAudit(db, { id: ulid(), at, actor: dbUser.username, action: "password_reset_failed" });
      }
      throw new HttpError(401, "unauthorized");
    }
    db.transaction(() => {
      updateUserPassword(db, dbUser.id, hashPassword(body.data.next), at, true);
      writeAudit(db, { id: ulid(), at, actor: dbUser.username, action: "password_reset" });
    })();
    return reply.send({ ok: true });
  });

  app.post("/v1/logout", async (request, reply) => {
    const actor = request.principal?.username ?? request.session.user ?? "unknown";
    writeAudit(db, { id: ulid(), at: now(), actor, action: "logout" });
    await request.session.destroy();
    return reply.send({ ok: true });
  });

  app.get("/v1/me", async (request) => ({ user: request.principal!.username }));

  app.get("/v1/session", async (request) => {
    const principal = request.principal!;
    const admin = isAdminPrincipal(principal);
    const runtime = readRuntimeSettings(db, {
      notifyLabels: config.notifyLabels,
      notifyMinConfidence: config.notifyMinConfidence,
      acceptDomains: config.acceptDomains,
    });
    const sentLast24h = principal.kind === "user" ? countUserSentSince(db, principal.id, now() - 86_400_000) : 0;
    const canSend = admin
      ? true
      : principal.dailySendLimit > 0 && principal.allocations.some((a) => a.canSend);
    return {
      user: principal.username,
      userId: principal.id,
      role: principal.role,
      displayName: principal.displayName,
      isAdmin: admin,
      isOwner: principal.role === "owner",
      canSend,
      dailySendLimit: principal.dailySendLimit,
      sentLast24h,
      allocations: principal.allocations,
      suggestedFrom: admin
        ? runtime.acceptDomains.map((d) => `hello@${d}`)
        : suggestedFromAddresses(principal.allocations),
      allowedDomains: admin ? runtime.acceptDomains : allowedMemberDomains(principal.allocations),
    };
  });

  app.get("/v1/unread", async (request) => countUnread(db, memberScopeOf(request.principal!)));

  app.post("/v1/messages/read-all", async (request, reply) => {
    const body = readAllBody.safeParse(request.body ?? {});
    if (!body.success) throw new HttpError(400);
    const target = body.data.target ?? "inbox";
    const principal = request.principal!;
    const marked = markAllMessagesRead(db, target, now(), memberScopeOf(principal));
    if (marked > 0) {
      writeAudit(db, {
        id: ulid(),
        at: now(),
        actor: principal.username,
        action: "read_all",
        detail: `target=${target},count=${marked}`,
      });
    }
    return reply.send({ ok: true, count: marked });
  });

  app.get("/v1/messages", async (request) => {
    const query = readListQuery(request.query);
    const memberScope = memberScopeOf(request.principal!);
    const rows = listMessages(db, { ...query, limit: query.limit + 1, memberScope });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toListItem),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.received_at, last.id) : null,
    };
  });

  app.get("/v1/messages/:id", async (request) => toDetail(db, messageId(request), request.principal!));

  app.get("/v1/messages/:id/thread", async (request) => {
    const id = messageId(request);
    const letters = listThread(db, id, memberScopeOf(request.principal!));
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
    const message = requireScopedMessage(db, messageId(request), request.principal!);
    const parsed = parseJson(message.parsed);
    const text =
      parsed && typeof parsed === "object" && "text" in parsed && typeof parsed.text === "string"
        ? parsed.text
        : null;
    if (text === null) throw new HttpError(404, "not_found");
    return { text };
  });

  app.get("/v1/messages/:id/html", async (request) => {
    const message = requireScopedMessage(db, messageId(request), request.principal!);
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
    const message = requireScopedMessage(db, messageId(request), request.principal!);
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
    const message = requireScopedMessage(db, messageId(request), request.principal!);
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
    const id = messageId(request);
    const principal = request.principal!;
    requireScopedMessage(db, id, principal);
    const at = now();
    if (principal.role === "member") {
      db.prepare("UPDATE user_message_state SET manual_label = NULL, updated_at = ? WHERE user_id = ? AND message_id = ?").run(
        at,
        principal.id,
        id,
      );
    }
    const open = db
      .prepare(
        `SELECT id, status FROM jobs
         WHERE message_id = ? AND type = 'classify' AND status IN ('queued', 'running')`,
      )
      .all(id) as Array<{ id: string; status: string }>;
    const queued = open.find((row) => row.status === "queued");
    if (queued) {
      db.prepare("UPDATE jobs SET payload = ?, updated_at = ? WHERE id = ?").run(JSON.stringify({ force: true }), at, queued.id);
    } else {
      enqueueJob(db, { id: ulid(), type: "classify", messageId: id, payload: { force: true }, now: at });
    }
    writeAudit(db, { id: ulid(), at, actor: principal.username, action: "reclassify", target: id });
    return reply.code(202).send({ queued: true });
  });

  const labelOverrideBody = z.object({
    label: z.enum(["phish", "malware", "spam", "unsolicited-admin", "legit", "gray"]),
  }).strict();

  app.patch("/v1/messages/:id/label", async (request, reply) => {
    const id = messageId(request);
    const principal = request.principal!;
    const message = requireScopedMessage(db, id, principal);
    const body = labelOverrideBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);

    const at = now();
    const existingAi = parseJson(message.ai_result) as Record<string, unknown> | null;

    if (principal.role === "member") {
      const origLabel =
        typeof existingAi?.originalLabel === "string"
          ? existingAi.originalLabel
          : typeof existingAi?.label === "string"
            ? existingAi.label
            : null;
      const origConf =
        typeof existingAi?.originalConfidence === "number"
          ? existingAi.originalConfidence
          : typeof existingAi?.confidence === "number"
            ? existingAi.confidence
            : null;
      overrideMemberMessageLabel(db, principal.id, id, body.data.label, at);
      writeAudit(db, {
        id: ulid(),
        at,
        actor: principal.username,
        action: "override_label",
        target: id,
        detail: `scope=member,to=${body.data.label}`,
      });
      return reply.send({
        ok: true,
        id,
        label: body.data.label,
        originalLabel: origLabel,
        originalConfidence: origConf,
      });
    }

    const ai: Record<string, unknown> =
      existingAi && typeof existingAi === "object" && !Array.isArray(existingAi)
        ? { ...existingAi }
        : {};

    if (typeof ai.originalLabel !== "string" && typeof ai.label === "string") {
      ai.originalLabel = ai.label;
      ai.originalConfidence = typeof ai.confidence === "number" ? ai.confidence : null;
    }

    const prevLabel = typeof ai.label === "string" ? ai.label : "none";
    ai.schema = 1;
    if (typeof ai.prompt_id !== "string" || !ai.prompt_id) ai.prompt_id = "manual";
    if (typeof ai.model !== "string" || !ai.model) ai.model = "manual";
    if (typeof ai.provider !== "string" || !ai.provider) ai.provider = "manual";
    if (typeof ai.at !== "string" || !ai.at) ai.at = new Date(at).toISOString();
    if (typeof ai.confidence !== "number") ai.confidence = 1;
    if (typeof ai.summary !== "string" || !ai.summary) ai.summary = "已手动修改分类";
    if (!Array.isArray(ai.tags)) ai.tags = [];
    if (!Array.isArray(ai.signals)) ai.signals = [];
    ai.label = body.data.label;
    ai.manualOverride = true;
    ai.overrideActor = principal.username;
    ai.overrideAt = at;

    const updatedJson = JSON.stringify(ai);
    db.prepare("UPDATE messages SET ai_result = ?, status = 'classified', updated_at = ? WHERE id = ?")
      .run(updatedJson, at, id);

    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: principal.username,
      action: "override_label",
      target: id,
      detail: `from=${prevLabel},to=${body.data.label}`,
    });

    return reply.send({
      ok: true,
      id,
      label: body.data.label,
      originalLabel: ai.originalLabel ?? null,
      originalConfidence: ai.originalConfidence ?? null,
    });
  });

  app.post("/v1/messages/:id/read", async (request, reply) => {
    const id = messageId(request);
    const principal = request.principal!;
    requireScopedMessage(db, id, principal);
    markMessageRead(db, id, now(), memberScopeOf(principal));
    return reply.send({ ok: true });
  });

  app.post("/v1/messages/:id/trash", async (request, reply) => {
    const id = messageId(request);
    const principal = request.principal!;
    requireScopedMessage(db, id, principal);
    trashMessage(db, id, now(), memberScopeOf(principal));
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: principal.username,
      action: "trash",
      target: id,
    });
    return reply.send({ ok: true, id, trashed: true });
  });

  app.post("/v1/messages/:id/block", async (request, reply) => {
    const id = messageId(request);
    const principal = request.principal!;
    const message = requireScopedMessage(db, id, principal);
    const sender = message.from_addr || message.envelope_from;
    if (!sender) throw new HttpError(400);

    if (principal.role === "member") {
      let blockedSenders: string[];
      try {
        const current = readUserPreferences(db, principal.id).blockedSenders;
        blockedSenders = saveUserBlockedSenders(db, principal.id, current.concat(sender), now());
      } catch (err) {
        if (err instanceof UserError) throw new HttpError(400);
        throw err;
      }
      trashMessage(db, id, now(), memberScopeOf(principal));
      writeAudit(db, {
        id: ulid(),
        at: now(),
        actor: principal.username,
        action: "block_sender",
        target: id,
        detail: sender,
      });
      return reply.send({ ok: true, id, blockedSenders, trashed: true });
    }

    let blockedSenders;
    try {
      blockedSenders = saveBlockedSenders(db, readBlockedSenders(db).concat(sender), now());
    } catch (err) {
      if (err instanceof SettingsError) throw new HttpError(400);
      throw err;
    }
    trashMessage(db, id, now());
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: principal.username,
      action: "block_sender",
      target: id,
      detail: sender,
    });
    return reply.send({ ok: true, id, blockedSenders, trashed: true });
  });

  app.post("/v1/messages/:id/restore", async (request, reply) => {
    const id = messageId(request);
    const principal = request.principal!;
    requireScopedMessage(db, id, principal);
    restoreMessage(db, id, now(), memberScopeOf(principal));
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: principal.username,
      action: "restore",
      target: id,
    });
    return reply.send({ ok: true, id, trashed: false });
  });

  app.delete("/v1/messages/:id", async (request, reply) => {
    const id = messageId(request);
    const principal = request.principal!;
    requireScopedMessage(db, id, principal);

    if (principal.role === "member") {
      purgeMemberMessage(db, principal.id, id, now());
      writeAudit(db, {
        id: ulid(),
        at: now(),
        actor: principal.username,
        action: "member_purge",
        target: id,
      });
      return reply.send({ ok: true, id, deleted: true });
    }

    const purged = deleteMessage(db, id, now());
    if (!purged) throw new HttpError(404, "not_found");
    const failed = await removeStoredFiles(config.mailDataDir, purged.paths);
    if (failed.length > 0) request.log.warn({ failed: failed.length }, "stored files left on disk");
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: principal.username,
      action: "delete",
      target: id,
    });
    return reply.send({ ok: true, id, deleted: true });
  });

  app.post("/v1/messages/empty-trash", async (request, reply) => {
    const principal = request.principal!;
    if (principal.role === "member") {
      const count = emptyMemberTrash(db, memberScopeOf(principal)!, now());
      writeAudit(db, {
        id: ulid(),
        at: now(),
        actor: principal.username,
        action: "member_empty_trash",
        detail: `count=${count}`,
      });
      return reply.send({ ok: true, count });
    }

    const purged = emptyTrash(db, now());
    const failed = await removeStoredFiles(config.mailDataDir, purged.paths);
    if (failed.length > 0) request.log.warn({ failed: failed.length }, "stored files left on disk");
    const count = purged.count;
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: principal.username,
      action: "empty_trash",
      detail: `count=${count}`,
    });
    return reply.send({ ok: true, count });
  });

  app.get("/v1/trash/count", async (request) => ({
    count: countTrash(db, memberScopeOf(request.principal!)),
  }));

  app.get("/v1/attachments/:sha256", async (request, reply) => {
    const sha = attachmentId(request);
    const scope = memberScopeOf(request.principal!);
    if (scope && !memberCanReadAttachment(db, sha, scope)) {
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

  // --- Admin / System Queue & Prompt Endpoints ---

  app.get("/v1/jobs/summary", async (request) => {
    if (!isAdminPrincipal(request.principal!)) {
      return { dead: 0, failed: 0, retrying: 0, dismissed: 0, running: 0, open: 0 };
    }
    return failureSummary(db);
  });

  app.get("/v1/jobs/count", async (request) => {
    requireAdmin(request.principal!);
    const query = request.query as Record<string, unknown>;
    const status = optionalString(query.status) ?? "dead";
    if (!JOB_STATUSES.includes(status as JobStatus)) throw new HttpError(400);
    return { status, count: countJobsByStatus(db, status as JobStatus) };
  });

  app.get("/v1/jobs", async (request) => {
    requireAdmin(request.principal!);
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
    requireAdmin(request.principal!);
    const body = retryMessageBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const count = retryMessageJobs(db, body.data.messageId, now());
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: request.principal!.username,
      action: "retry_message_jobs",
      target: body.data.messageId,
      detail: `count=${count}`,
    });
    return reply.send({ ok: true, count });
  });

  app.post("/v1/jobs/:id/retry", async (request, reply) => {
    requireAdmin(request.principal!);
    const params = request.params as Record<string, string>;
    const id = params.id;
    if (!id) throw new HttpError(400);
    const ok = retryJob(db, id, now());
    if (!ok) throw new HttpError(404, "not_found");
    writeAudit(db, { id: ulid(), at: now(), actor: request.principal!.username, action: "retry_job", target: id });
    return reply.send({ ok: true, retried: id });
  });

  app.post("/v1/jobs/:id/dismiss", async (request, reply) => {
    requireAdmin(request.principal!);
    const params = request.params as Record<string, string>;
    const id = params.id;
    if (!id) throw new HttpError(400);
    const ok = dismissJob(db, id, now());
    if (!ok) throw new HttpError(404, "not_found");
    writeAudit(db, { id: ulid(), at: now(), actor: request.principal!.username, action: "dismiss_job", target: id });
    return reply.send({ ok: true, dismissed: id });
  });

  app.post("/v1/jobs/retry-all", async (request, reply) => {
    requireAdmin(request.principal!);
    const count = retryAllDeadJobs(db, now());
    writeAudit(db, { id: ulid(), at: now(), actor: request.principal!.username, action: "retry_all_dead", detail: `count=${count}` });
    return reply.send({ ok: true, count });
  });

  app.get("/v1/prompts", async (request) => {
    requireAdmin(request.principal!);
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
    requireAdmin(request.principal!);
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
    requireAdmin(request.principal!);
    const params = request.params as Record<string, string>;
    const id = params.id;
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new HttpError(400);
    const body = request.body as { content?: unknown };
    if (!body || typeof body.content !== "string" || body.content.trim().length === 0 || body.content.length > 100_000) {
      throw new HttpError(400);
    }
    savePrompt(config.promptsDir, id, body.content, db, now());
    writeAudit(db, { id: ulid(), at: now(), actor: request.principal!.username, action: "prompt_update", target: id });
    return reply.send({ ok: true, id });
  });

  app.get("/v1/ai/status", async (request) => {
    requireAdmin(request.principal!);
    return aiStatus(db, config);
  });

  app.get("/v1/settings", async (request) => {
    const principal = request.principal!;
    const runtime = readRuntimeSettings(db, {
      notifyLabels: config.notifyLabels,
      notifyMinConfidence: config.notifyMinConfidence,
      acceptDomains: config.acceptDomains,
    });

    if (principal.role === "member") {
      const prefs = readUserPreferences(db, principal.id);
      const allowed = allowedMemberDomains(principal.allocations);
      const domainNames: Record<string, string> = {};
      for (const dom of allowed) {
        if (runtime.domainNames[dom]) domainNames[dom] = runtime.domainNames[dom]!;
      }
      return {
        notifyLabels: [],
        notifyMinConfidence: runtime.notifyMinConfidence,
        acceptDomains: allowed,
        jobMaxAttempts: runtime.jobMaxAttempts,
        panelTitle: prefs.panelTitle || runtime.panelTitle || DEFAULT_PANEL_TITLE,
        labelNames: runtime.labelNames,
        domainNames,
        senderNames: prefs.senderNames,
        channels: { telegram: false, webhook: false },
        ai: { classifier: config.classifier, model: "", keyCount: 0 },
        aiPool: { models: [], keys: [], modelsFrom: "env", keysFrom: "env" },
        aiEnabled: readAiEnabled(db),
        aiThinking: readAiThinking(db),
        blockedSenders: prefs.blockedSenders,
        passwordSet: true,
      };
    }

    return {
      notifyLabels: runtime.notifyLabels,
      notifyMinConfidence: runtime.notifyMinConfidence,
      acceptDomains: runtime.acceptDomains,
      jobMaxAttempts: runtime.jobMaxAttempts,
      panelTitle: runtime.panelTitle,
      labelNames: runtime.labelNames,
      domainNames: runtime.domainNames,
      senderNames: runtime.senderNames,
      channels: {
        telegram: Boolean(config.telegramBotToken && config.telegramChatId),
        webhook: Boolean(config.notifyWebhookUrl),
      },
      ai: aiStatus(db, config),
      aiPool: presentAiPool(readEffectiveAiPool(db, fallbackAiPool(config))),
      aiEnabled: readAiEnabled(db),
      aiThinking: readAiThinking(db),
      blockedSenders: readBlockedSenders(db),
      passwordSet: principal.kind === "owner" ? readPasswordHash(db) !== null : true,
    };
  });

  app.put("/v1/settings/ai", async (request, reply) => {
    requireAdmin(request.principal!);
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
      actor: request.principal!.username,
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

  app.post("/v1/settings/ai/test", { config: { rateLimit: { max: 20, timeWindow: "5 minutes" } } }, async (request, reply) => {
    requireAdmin(request.principal!);
    const body = aiTestBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    if (!body.data.keyId && !body.data.secret) throw new HttpError(400);
    const result = await probeAiKey({
      config,
      db,
      keyId: body.data.keyId,
      secret: body.data.secret,
      model: body.data.model,
      fetchImpl: options.probeFetch,
    });
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: request.principal!.username,
      action: "ai_key_probe",
      detail: `ok=${result.ok} model=${result.model} ms=${result.latencyMs}`,
    });
    return reply.send(result);
  });

  app.put("/v1/settings/blocklist", async (request, reply) => {
    const body = blocklistBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const principal = request.principal!;

    if (principal.role === "member") {
      try {
        const blockedSenders = saveUserBlockedSenders(db, principal.id, body.data.addresses, now());
        writeAudit(db, {
          id: ulid(),
          at: now(),
          actor: principal.username,
          action: "member_blocklist",
          detail: `count=${blockedSenders.length}`,
        });
        return reply.send({ ok: true, blockedSenders });
      } catch (err) {
        if (err instanceof UserError) throw new HttpError(400);
        throw err;
      }
    }

    let blockedSenders;
    try {
      blockedSenders = saveBlockedSenders(db, body.data.addresses, now());
    } catch (err) {
      if (err instanceof SettingsError) throw new HttpError(400);
      throw err;
    }
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: principal.username,
      action: "settings_blocklist",
      detail: `count=${blockedSenders.length}`,
    });
    return reply.send({ ok: true, blockedSenders });
  });

  app.put("/v1/settings/password", async (request, reply) => {
    const body = passwordBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    if (body.data.next === "admin") throw new HttpError(400);
    const principal = request.principal!;

    if (principal.kind === "owner") {
      const currentOk = loginOk(
        config.apiUsername,
        body.data.current,
        config.apiUsername,
        config.apiPassword ?? "",
        readPasswordHash(db),
      );
      if (!currentOk) throw new HttpError(401, "unauthorized");
      savePasswordHash(db, hashPassword(body.data.next), now());
      clearResetSeal(db);
      writeAudit(db, {
        id: ulid(),
        at: now(),
        actor: principal.username,
        action: "password_change",
      });
      return reply.send({ ok: true });
    }

    const dbUser = findUserById(db, principal.id);
    if (!dbUser || !passwordMatches(body.data.current, dbUser.password_hash)) {
      throw new HttpError(401, "unauthorized");
    }
    updateUserPassword(db, dbUser.id, hashPassword(body.data.next), now(), false);
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: principal.username,
      action: "password_change",
    });
    return reply.send({ ok: true });
  });

  app.get("/v1/logs", async (request) => {
    requireAdmin(request.principal!);
    return { lines: recentLogs().map(redactLogLine) };
  });

  app.get("/v1/audit", async (request) => {
    requireAdmin(request.principal!);
    const query = request.query as Record<string, unknown>;
    const limitRaw = optionalString(query.limit);
    const limit = limitRaw && /^\d+$/.test(limitRaw) ? Number(limitRaw) : 80;
    return {
      items: listRecentAudit(db, limit).map((row) => ({
        id: row.id,
        at: iso(row.at),
        actor: row.actor,
        action: row.action,
        target: row.target,
        detail: parseJson(row.detail) ?? row.detail,
      })),
    };
  });

  app.put("/v1/settings/notify", async (request, reply) => {
    requireAdmin(request.principal!);
    const body = notifySettingsBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    let labels;
    try {
      labels = saveNotifySettings(db, body.data.labels, body.data.minConfidence, now());
    } catch (err) {
      if (err instanceof SettingsError) throw new HttpError(400);
      throw err;
    }
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: request.principal!.username,
      action: "settings_notify",
      detail: labels.join(",") || "none",
    });
    return reply.send({ ok: true, notifyLabels: labels, notifyMinConfidence: body.data.minConfidence });
  });

  app.put("/v1/settings/domains", async (request, reply) => {
    requireAdmin(request.principal!);
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
      actor: request.principal!.username,
      action: "settings_domains",
      detail: domains.join(","),
    });
    return reply.send({ ok: true, acceptDomains: domains });
  });

  app.get("/v1/dkim", async (request) => {
    const principal = request.principal!;
    const all = listDkimPublic(db);
    if (principal.role === "member") {
      const allowed = new Set(allowedMemberDomains(principal.allocations));
      return {
        items: all
          .filter((k) => allowed.has(k.domain))
          .map((k) => ({ domain: k.domain, selector: k.selector, algorithm: k.algorithm, dnsName: k.dnsName, txt: "", createdAt: k.createdAt })),
      };
    }
    return { items: all };
  });

  app.post("/v1/dkim", async (request, reply) => {
    requireAdmin(request.principal!);
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
      actor: request.principal!.username,
      action: "dkim_generate",
      target: `${saved.selector}._domainkey.${saved.domain}`,
      detail: saved.algorithm,
    });
    return reply.send({ ok: true, ...saved });
  });

  app.post("/v1/dkim/remove", async (request, reply) => {
    requireAdmin(request.principal!);
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
      actor: request.principal!.username,
      action: "dkim_remove",
      target: `${body.data.selector}._domainkey.${body.data.domain}`,
    });
    return reply.send({ ok: true });
  });

  app.get("/v1/outbox", async (request) => {
    const query = request.query as Record<string, unknown>;
    const limitRaw = optionalString(query.limit);
    let limit = 30;
    if (limitRaw !== undefined) {
      if (!/^\d+$/.test(limitRaw)) throw new HttpError(400);
      limit = Number(limitRaw);
      if (limit < 1 || limit > 100) throw new HttpError(400);
    }
    const principal = request.principal!;
    const userFilter = principal.role === "member" ? principal.id : undefined;
    return { items: listOutbox(db, limit, userFilter).map(presentOutbox) };
  });

  app.get("/v1/outbox/:id/raw", async (request, reply) => {
    const principal = request.principal!;
    const userFilter = principal.role === "member" ? principal.id : undefined;
    const row = getOutbox(db, messageId(request), userFilter);
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
    const principal = request.principal!;
    const userFilter = principal.role === "member" ? principal.id : undefined;
    const row = getOutbox(db, messageId(request), userFilter);
    if (!row) throw new HttpError(404, "not_found");
    let text = "";
    let headers = "";
    try {
      const bytes = await readRaw(config.mailDataDir, row.raw_path, codec, row.sha256);
      const email = await PostalMime.parse(bytes);
      text = email.text ?? "";
      if (text.length > 100_000) text = text.slice(0, 100_000);
      headers = rfc822HeaderBlock(bytes);
    } catch (err) {
      if (err instanceof PathEscapeError) throw new HttpError(404, "not_found");
    }
    return { ...presentOutbox(row), text, headers };
  });

  app.post("/v1/outbox/:id/retry", async (request, reply) => {
    const id = messageId(request);
    const principal = request.principal!;
    if (principal.role === "member") {
      const owned = getOutbox(db, id, principal.id);
      if (!owned) throw new HttpError(404, "not_found");
    }
    const ok = retryOutboxJob(db, id, now());
    if (!ok) throw new HttpError(404, "not_found");
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: principal.username,
      action: "send_retry",
      target: id,
    });
    return reply.send({ ok: true });
  });

  app.post("/v1/outbox", { config: { rateLimit: { max: 30, timeWindow: "10 minutes" } } }, async (request, reply) => {
    const body = sendBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const principal = request.principal!;
    const normalizedFrom = normalizeAddress(body.data.from);
    if (!normalizedFrom) throw new HttpError(400);

    if (principal.role === "member") {
      if (principal.dailySendLimit <= 0 || !canSendFromAddress(normalizedFrom, principal.allocations)) {
        throw new HttpError(403, "sender_not_allowed");
      }
      const sent24h = countUserSentSince(db, principal.id, now() - 86_400_000);
      if (sent24h >= principal.dailySendLimit) {
        throw new HttpError(429, "daily_quota_exceeded");
      }
    }

    try {
      const at = normalizedFrom.lastIndexOf("@");
      const local = normalizedFrom.slice(0, at);
      const dom = normalizedFrom.slice(at + 1);
      let fromName: string | undefined;

      if (principal.role === "member") {
        const prefs = readUserPreferences(db, principal.id);
        const personalBox = prefs.mailboxes.find((m) => m.domain === dom && m.localpart === local);
        fromName = personalBox?.displayName ?? principal.displayName ?? undefined;
      } else {
        const history = at > 0 ? findMailboxHistory(db, dom, local) : undefined;
        fromName = history?.display_name ?? principal.displayName ?? undefined;
      }

      const queued = await submitOutbox(
        { db, dataDir: config.mailDataDir, codec, acceptDomains: config.acceptDomains, now },
        {
          ...body.data,
          from: normalizedFrom,
          fromName,
          userId: principal.id,
        },
      );
      writeAudit(db, {
        id: ulid(),
        at: now(),
        actor: principal.username,
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
    requireAdmin(request.principal!);
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
      actor: request.principal!.username,
      action: "settings_jobs",
      detail: `maxAttempts=${maxAttempts}`,
    });
    return reply.send({ ok: true, jobMaxAttempts: maxAttempts });
  });

  app.put("/v1/settings/names", async (request, reply) => {
    const body = nameSettingsBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const principal = request.principal!;

    if (principal.role === "member") {
      try {
        const saved = saveUserNamePreferences(
          db,
          principal.id,
          { panelTitle: body.data.panelTitle, senderNames: body.data.senderNames },
          now(),
        );
        const runtime = readRuntimeSettings(db, {
          notifyLabels: config.notifyLabels,
          notifyMinConfidence: config.notifyMinConfidence,
          acceptDomains: config.acceptDomains,
        });
        writeAudit(db, {
          id: ulid(),
          at: now(),
          actor: principal.username,
          action: "member_names",
          detail: saved.panelTitle,
        });
        return reply.send({
          ok: true,
          panelTitle: saved.panelTitle,
          labelNames: runtime.labelNames,
          domainNames: {},
          senderNames: saved.senderNames,
        });
      } catch (err) {
        if (err instanceof UserError) throw new HttpError(400);
        throw err;
      }
    }

    let saved;
    try {
      saved = saveNameSettings(db, body.data, now());
    } catch (err) {
      if (err instanceof SettingsError || err instanceof ConfigError) throw new HttpError(400);
      throw err;
    }
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: principal.username,
      action: "settings_names",
      detail: saved.panelTitle,
    });
    return reply.send({ ok: true, ...saved });
  });

  app.get("/v1/stats", async (request) => {
    const start = utcDayStart(now());
    const scope = memberScopeOf(request.principal!);
    return {
      today: countLabels(db, start, scope),
      total: countLabels(db, null, scope),
      daily: dailySeries(db, start - 13 * 86_400_000, 14, scope),
    };
  });

  app.get("/v1/mailbox-history", async (request) => {
    const principal = request.principal!;
    const query = request.query as Record<string, unknown>;
    const domain = optionalString(query.domain)?.toLowerCase();
    const localpart = optionalString(query.localpart)?.toLowerCase();

    if (principal.role === "member") {
      const prefs = readUserPreferences(db, principal.id);
      const items = prefs.mailboxes
        .filter((m) => (!domain || m.domain === domain) && (!localpart || m.localpart === localpart))
        .map((m) => ({
          domain: m.domain,
          localpart: m.localpart,
          firstSeen: null,
          lastSeen: iso(m.updatedAt),
          source: "member",
          notes: m.notes,
          displayName: m.displayName,
        }));
      return { items };
    }

    return {
      items: listMailboxHistory(db, { domain, localpart }).map(toHistory),
    };
  });

  app.post("/v1/mailbox-history", async (request, reply) => {
    const body = historyBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const domain = body.data.domain.trim().toLowerCase().replace(/\.$/, "");
    const localpart = body.data.localpart.trim().toLowerCase();
    if (!DOMAIN_RE.test(domain) || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/.test(localpart)) {
      throw new HttpError(400);
    }
    const principal = request.principal!;

    if (principal.role === "member") {
      if (!canSendFromAddress(`${localpart}@${domain}`, principal.allocations) && !principal.allocations.some((a) => a.domain === domain)) {
        throw new HttpError(403, "forbidden");
      }
      try {
        upsertUserMailboxNote(
          db,
          principal.id,
          {
            domain,
            localpart,
            displayName: body.data.displayName,
            notes: body.data.notes ?? null,
          },
          now(),
        );
        return reply.code(201).send({ ok: true });
      } catch (err) {
        if (err instanceof UserError) throw new HttpError(400);
        throw err;
      }
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
      actor: principal.username,
      action: "mailbox_history_upsert",
      target: `${localpart}@${domain}`,
    });
    return reply.code(201).send({ ok: true });
  });

  // --- Multi-User Management Console API (Admin & Owner) ---

  app.get("/v1/users", async (request) => {
    const principal = request.principal!;
    requireAdmin(principal);
    return {
      owner: {
        username: config.apiUsername,
        role: "owner",
        passwordSet: readPasswordHash(db) !== null,
      },
      items: listUsersWithDetails(db, now()),
    };
  });

  app.post("/v1/users", async (request, reply) => {
    const principal = request.principal!;
    requireAdmin(principal);
    const body = createUserBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    if (body.data.password === "admin") throw new HttpError(400, "weak_password");
    const targetRole = body.data.role ?? "member";
    if (targetRole === "admin" && principal.role !== "owner") {
      throw new HttpError(403, "only_owner_can_grant_admin");
    }

    try {
      const created = createUser(db, {
        ownerUsername: config.apiUsername,
        username: body.data.username,
        displayName: body.data.displayName,
        passwordHash: hashPassword(body.data.password),
        role: targetRole,
        dailySendLimit: body.data.dailySendLimit,
        notes: body.data.notes,
        allocations: body.data.allocations,
        now: now(),
      });
      writeAudit(db, {
        id: ulid(),
        at: now(),
        actor: principal.username,
        action: "user_create",
        target: created.username,
        detail: `role=${created.role} allocs=${created.allocations.length}`,
      });
      return reply.code(201).send({ ok: true, user: presentUser(created) });
    } catch (err) {
      if (err instanceof UserError) throw new HttpError(err.code === "username_taken" || err.code === "allocation_conflict" ? 409 : 400, err.code);
      throw err;
    }
  });

  app.patch("/v1/users/:id", async (request, reply) => {
    const principal = request.principal!;
    requireAdmin(principal);
    const id = messageId(request);
    const target = findUserById(db, id);
    if (!target) throw new HttpError(404, "not_found");
    if (target.role === "admin" && principal.role !== "owner" && principal.id !== target.id) {
      throw new HttpError(403, "only_owner_can_manage_admin");
    }
    const body = updateUserBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    if (body.data.role === "admin" && principal.role !== "owner") {
      throw new HttpError(403, "only_owner_can_grant_admin");
    }
    if (body.data.disabled === true && principal.id === target.id) {
      throw new HttpError(400, "cannot_disable_self");
    }

    try {
      const updated = updateUser(db, id, {
        displayName: body.data.displayName,
        role: body.data.role,
        dailySendLimit: body.data.dailySendLimit,
        notes: body.data.notes,
        disabled: body.data.disabled,
        now: now(),
      });
      writeAudit(db, {
        id: ulid(),
        at: now(),
        actor: principal.username,
        action: "user_update",
        target: updated.username,
        detail: `role=${updated.role} disabled=${updated.disabled} limit=${updated.dailySendLimit}`,
      });
      return reply.send({ ok: true, user: presentUser(updated) });
    } catch (err) {
      if (err instanceof UserError) throw new HttpError(400, err.code);
      throw err;
    }
  });

  app.put("/v1/users/:id/password", async (request, reply) => {
    const principal = request.principal!;
    requireAdmin(principal);
    const id = messageId(request);
    const target = findUserById(db, id);
    if (!target) throw new HttpError(404, "not_found");
    if (target.role === "admin" && principal.role !== "owner" && principal.id !== target.id) {
      throw new HttpError(403, "only_owner_can_manage_admin");
    }
    const body = adminSetPasswordBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    if (body.data.next === "admin") throw new HttpError(400, "weak_password");

    updateUserPassword(db, id, hashPassword(body.data.next), now(), principal.id !== target.id);
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: principal.username,
      action: "user_password_reset",
      target: target.username,
    });
    return reply.send({ ok: true });
  });

  app.post("/v1/users/:id/sessions/revoke", async (request, reply) => {
    const principal = request.principal!;
    requireAdmin(principal);
    const id = messageId(request);
    const target = findUserById(db, id);
    if (!target) throw new HttpError(404, "not_found");
    if (target.role === "admin" && principal.role !== "owner") {
      throw new HttpError(403, "only_owner_can_manage_admin");
    }
    const count = revokeUserSessions(db, id);
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: principal.username,
      action: "user_sessions_revoke",
      target: target.username,
      detail: `count=${count}`,
    });
    return reply.send({ ok: true, count });
  });

  app.delete("/v1/users/:id", async (request, reply) => {
    const principal = request.principal!;
    requireAdmin(principal);
    const id = messageId(request);
    const target = findUserById(db, id);
    if (!target) throw new HttpError(404, "not_found");
    if (principal.id === target.id) throw new HttpError(400, "cannot_delete_self");
    if (target.role === "admin" && principal.role !== "owner") {
      throw new HttpError(403, "only_owner_can_manage_admin");
    }
    deleteUser(db, id);
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: principal.username,
      action: "user_delete",
      target: target.username,
    });
    return reply.send({ ok: true, deleted: true });
  });

  app.post("/v1/users/:id/mailboxes", async (request, reply) => {
    const principal = request.principal!;
    requireAdmin(principal);
    const id = messageId(request);
    const target = findUserById(db, id);
    if (!target) throw new HttpError(404, "not_found");
    if (target.role === "admin" && principal.role !== "owner" && principal.id !== target.id) {
      throw new HttpError(403, "only_owner_can_manage_admin");
    }
    const body = allocationInputSchema.safeParse(request.body);
    if (!body.success) throw new HttpError(400);

    try {
      const alloc = addUserAllocation(db, {
        userId: id,
        pattern: body.data.pattern,
        kind: body.data.kind,
        localpart: body.data.localpart,
        domain: body.data.domain,
        canSend: body.data.canSend,
        notes: body.data.notes,
        now: now(),
      });
      writeAudit(db, {
        id: ulid(),
        at: now(),
        actor: principal.username,
        action: "user_mailbox_add",
        target: target.username,
        detail: alloc.pattern,
      });
      const updated = getUserDetail(db, id, now())!;
      return reply.code(201).send({ ok: true, allocation: alloc, user: presentUser(updated) });
    } catch (err) {
      if (err instanceof UserError) {
        throw new HttpError(err.code === "allocation_conflict" ? 409 : 400, err.code);
      }
      throw err;
    }
  });

  app.delete("/v1/users/:id/mailboxes/:allocId", async (request, reply) => {
    const principal = request.principal!;
    requireAdmin(principal);
    const params = request.params as { id?: string; allocId?: string };
    const id = params.id ?? "";
    const allocId = params.allocId ?? "";
    if (!/^[\w-]+$/.test(id) || !/^[\w-]+$/.test(allocId)) throw new HttpError(404, "not_found");
    const target = findUserById(db, id);
    if (!target) throw new HttpError(404, "not_found");
    if (target.role === "admin" && principal.role !== "owner" && principal.id !== target.id) {
      throw new HttpError(403, "only_owner_can_manage_admin");
    }
    const removed = removeUserAllocation(db, id, allocId, now());
    if (!removed) throw new HttpError(404, "not_found");
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: principal.username,
      action: "user_mailbox_remove",
      target: target.username,
      detail: allocId,
    });
    const updated = getUserDetail(db, id, now())!;
    return reply.send({ ok: true, user: presentUser(updated) });
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

function resolvePrincipal(request: FastifyRequest, db: Db, config: Config): SessionPrincipal | null {
  const sessionUser = request.session.user;
  if (!sessionUser) return null;
  const sessionUserId = request.session.userId;

  if (sessionUserId === "owner" || (!sessionUserId && sessionUser === config.apiUsername)) {
    return {
      kind: "owner",
      id: "owner",
      username: config.apiUsername,
      displayName: null,
      role: "owner",
      dailySendLimit: -1,
      allocations: [],
    };
  }

  const row = sessionUserId ? findUserById(db, sessionUserId) : findUserByUsername(db, sessionUser);
  if (!row || row.disabled_at !== null) return null;
  const allocations = row.role === "member" ? listUserAllocations(db, row.id) : [];
  return {
    kind: "user",
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    dailySendLimit: row.daily_send_limit,
    allocations,
  };
}

function isAdminPrincipal(principal: SessionPrincipal): boolean {
  return principal.role === "owner" || principal.role === "admin";
}

function requireAdmin(principal: SessionPrincipal): void {
  if (!isAdminPrincipal(principal)) {
    throw new HttpError(403, "forbidden");
  }
}

function memberScopeOf(principal: SessionPrincipal): MemberScope | undefined {
  if (principal.role !== "member") return undefined;
  return { userId: principal.id, allocations: principal.allocations };
}

function presentUser(u: NonNullable<ReturnType<typeof getUserDetail>>) {
  return {
    ...u,
    disabledAt: u.disabledAt ? iso(u.disabledAt) : null,
    lastLoginAt: u.lastLoginAt ? iso(u.lastLoginAt) : null,
    createdAt: iso(u.createdAt),
    updatedAt: iso(u.updatedAt),
    allocations: u.allocations.map((a) => ({
      ...a,
      createdAt: iso(a.createdAt),
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
    userId: row.user_id,
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
  const path = url.split("?")[0] ?? url;
  return (
    path === "/healthz" ||
    path === "/v1/login" ||
    path === "/v1/csrf" ||
    path === "/v1/password/forgot" ||
    path === "/v1/password/reset" ||
    isPanelAsset(path)
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

function requireScopedMessage(db: Db, id: string, principal: SessionPrincipal) {
  const scope = memberScopeOf(principal);
  const message = scope ? getMessageForMember(db, id, scope) : getMessage(db, id);
  if (!message) throw new HttpError(404, "not_found");
  return message;
}

function readListQuery(query: unknown): {
  label?: string;
  status?: string;
  trashed?: boolean | "all";
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
  const q = optionalString(source.q);
  const from = optionalString(source.from);
  const domain = optionalString(source.domain);
  const since = optionalString(source.since);
  const until = optionalString(source.until);
  const limitRaw = optionalString(source.limit);
  const cursor = optionalString(source.cursor);
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
    label,
    status,
    trashed,
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
  return {
    id: row.id,
    sha256: row.sha256,
    receivedAt: iso(row.received_at),
    sizeBytes: row.size_bytes,
    envelopeFrom: row.envelope_from,
    envelopeTo: parseJson(row.envelope_to),
    messageId: row.message_id,
    subject: row.subject,
    from: row.from_addr,
    domains: parseJson(row.domains),
    status: row.status,
    label: ai.label,
    read: row.read_at != null,
    confidence: ai.confidence,
    summary: ai.summary,
    tags: ai.tags,
    manualOverride: ai.manualOverride,
    originalLabel: ai.originalLabel,
    originalConfidence: ai.originalConfidence,
    trashedAt: row.trashed_at ? iso(row.trashed_at) : null,
  };
}

function idList(raw: string | null): string[] {
  const value = parseJson(raw);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 20);
}

function toDetail(db: Db, id: string, principal: SessionPrincipal) {
  const message = requireScopedMessage(db, id, principal);
  return {
    id: message.id,
    sha256: message.sha256,
    receivedAt: iso(message.received_at),
    sizeBytes: message.size_bytes,
    status: message.status,
    error: publicError(message.error),
    envelopeFrom: message.envelope_from,
    envelopeTo: parseJson(message.envelope_to),
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
    aiResult: parseJson(message.ai_result),
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

function dailySeries(
  db: Db,
  startMs: number,
  days: number,
  memberScope?: MemberScope,
): Array<{ day: string; total: number; labels: Record<string, number> }> {
  let rows: Array<{ day_index: number; label: string; n: number }>;
  if (!memberScope) {
    rows = db
      .prepare(
        `SELECT (received_at / 86400000) AS day_index,
                COALESCE(json_extract(ai_result, '$.label'), 'unlabeled') AS label,
                COUNT(*) AS n
         FROM messages
         WHERE received_at >= ?
         GROUP BY 1, 2`,
      )
      .all(startMs) as Array<{ day_index: number; label: string; n: number }>;
  } else if (memberScope.allocations.length === 0) {
    rows = [];
  } else {
    const params: Record<string, string | number> = { startMs, userId: memberScope.userId };
    const rcptSql = buildMemberRecipientSql("m", memberScope.allocations, params);
    rows = db
      .prepare(
        `SELECT (m.received_at / 86400000) AS day_index,
                COALESCE(ums.manual_label, json_extract(m.ai_result, '$.label'), 'unlabeled') AS label,
                COUNT(*) AS n
         FROM messages m
         LEFT JOIN user_message_state ums ON ums.user_id = :userId AND ums.message_id = m.id
         WHERE m.received_at >= :startMs
           AND ums.purged_at IS NULL
           AND ${rcptSql}
         GROUP BY 1, 2`,
      )
      .all(params) as Array<{ day_index: number; label: string; n: number }>;
  }

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

function countLabels(db: Db, since: number | null, memberScope?: MemberScope): Record<string, number> {
  let rows: Array<{ label: string | null; n: number }>;
  if (!memberScope) {
    rows = (
      since === null
        ? db.prepare("SELECT json_extract(ai_result, '$.label') AS label, COUNT(*) AS n FROM messages GROUP BY 1").all()
        : db
            .prepare("SELECT json_extract(ai_result, '$.label') AS label, COUNT(*) AS n FROM messages WHERE received_at >= ? GROUP BY 1")
            .all(since)
    ) as Array<{ label: string | null; n: number }>;
  } else if (memberScope.allocations.length === 0) {
    rows = [];
  } else {
    const params: Record<string, string | number> = { userId: memberScope.userId };
    if (since !== null) params.since = since;
    const rcptSql = buildMemberRecipientSql("m", memberScope.allocations, params);
    const sinceClause = since !== null ? "AND m.received_at >= :since" : "";
    rows = db
      .prepare(
        `SELECT COALESCE(ums.manual_label, json_extract(m.ai_result, '$.label')) AS label,
                COUNT(*) AS n
         FROM messages m
         LEFT JOIN user_message_state ums ON ums.user_id = :userId AND ums.message_id = m.id
         WHERE ums.purged_at IS NULL
           AND ${rcptSql}
           ${sinceClause}
         GROUP BY 1`,
      )
      .all(params) as Array<{ label: string | null; n: number }>;
  }
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
