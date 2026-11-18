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
import PostalMime from "postal-mime";
import { z } from "zod";
import { fallbackAiPool } from "../ai/pool.js";
import { probeAiKey } from "../ai/probe.js";
import { listPrompts, readPrompt, savePrompt } from "../ai/prompt.js";
import { LABELS } from "../ai/types.js";
import type { Codec } from "../compress.js";
import { ConfigError, type Config } from "../config.js";
import type { Db } from "../db/index.js";
import { canViewerReadAttachment, findAttachment, listMessageAttachments } from "../db/repos/attachments.js";
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
import { findMailboxHistory, listMailboxHistory, upsertMailboxHistory } from "../db/repos/mailbox-history.js";
import {
  countTrash,
  countUnreadForViewer,
  deleteMessageForViewer,
  emptyTrashForViewer,
  getMessageForViewer,
  listMessages,
  markAllReadForViewer,
  markMessageReadForViewer,
  markMessageUnreadForViewer,
  restoreMessageForViewer,
  setManualLabelForViewer,
  trashMessageForViewer,
  type StoredMessage,
  type ViewerContext,
} from "../db/repos/messages.js";
import {
  canViewerAccessOutbox,
  countUserOutboxSince,
  getOutbox,
  listOutbox,
  listOutboxByIds,
} from "../db/repos/outbox.js";
import {
  clearResetSeal,
  presentAiPool,
  readAcceptDomains,
  readAiEnabled,
  readAiThinking,
  readBlockedSenders,
  readEffectiveAiPool,
  readNameSettings,
  readOwnerProfile,
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
  saveOwnerProfile,
  savePasswordHash,
  saveResetSeal,
  SettingsError,
} from "../db/repos/settings.js";
import { listThread } from "../db/repos/thread.js";
import {
  allocateMailbox,
  canMemberSendFrom,
  createUser,
  deleteUser,
  findSenderDisplayNameForUser,
  findUserByUsername,
  findUserForPasswordReset,
  findWinningAllocation,
  getUserById,
  hasAnyUsers,
  listUserMailboxes,
  listUsersWithDetails,
  OWNER_USER_ID,
  revokeMailbox,
  touchUserLogin,
  updateUser,
  updateUserMailbox,
  updateUserPassword,
  UserError,
} from "../db/repos/users.js";
import { sha256 } from "../hash.js";
import { readRaw } from "../ingest/read-raw.js";
import { removeStoredFiles } from "../ingest/remove-stored.js";
import { recentLogs } from "../log.js";
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
  loginOk,
  makeResetCode,
  passwordMatches,
  RESET_MAX_ATTEMPTS,
  RESET_RESEND_MS,
  resetCodeOk,
  sameAccount,
  sealResetCode,
} from "./password.js";
import { clearSessions, clearUserSessions, sqliteSessionStore } from "./session-store.js";
import { isPanelAsset, registerPanel } from "./static.js";

declare module "fastify" {
  interface Session {
    user?: string;
    userId?: string;
    role?: "admin" | "member";
  }
}

const APP_VERSION = readAppVersion();
const STATUSES = ["received", "authed", "parsed", "classified", "notified", "error"] as const;
const JOB_STATUSES = ["queued", "running", "done", "failed", "dead", "dismissed"] as const;
const DOMAIN_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const loginBody = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(512),
}).strict();

const profileBody = z.object({
  displayName: z.string().max(40).nullable().optional(),
  recoveryEmail: z.string().max(254).nullable().optional(),
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

const testKeyBody = z.object({
  id: z.string().min(1).max(80),
  model: z.string().max(80).optional(),
}).strict();

const readAllBody = z.object({
  label: z.string().max(32).optional(),
  domain: z.string().max(253).optional(),
  scope: z.string().max(80).optional(),
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

const createUserBody = z.object({
  username: z.string().min(2).max(128),
  password: z.string().min(8).max(200),
  displayName: z.string().max(40).nullable().optional(),
  recoveryEmail: z.string().max(254).nullable().optional(),
  role: z.enum(["admin", "member"]).optional(),
  quotaSendPerDay: z.number().int().min(0).max(10_000).optional(),
  notes: z.string().max(500).nullable().optional(),
  initialMailbox: z.object({
    localpart: z.string().min(1).max(64),
    domain: z.string().min(1).max(253),
    displayName: z.string().max(40).nullable().optional(),
    notes: z.string().max(500).nullable().optional(),
    canSend: z.boolean().optional(),
  }).strict().nullable().optional(),
}).strict();

const updateUserBody = z.object({
  displayName: z.string().max(40).nullable().optional(),
  recoveryEmail: z.string().max(254).nullable().optional(),
  role: z.enum(["admin", "member"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  quotaSendPerDay: z.number().int().min(0).max(10_000).optional(),
  notes: z.string().max(500).nullable().optional(),
}).strict();

const adminSetPasswordBody = z.object({
  next: z.string().min(8).max(200),
}).strict();

const allocateMailboxBody = z.object({
  localpart: z.string().min(1).max(64),
  domain: z.string().min(1).max(253),
  displayName: z.string().max(40).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
  canSend: z.boolean().optional(),
}).strict();

const updateMailboxBody = z.object({
  displayName: z.string().max(40).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
  canSend: z.boolean().optional(),
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

    if (!request.session.userId) {
      if (request.session.user === config.apiUsername) {
        request.session.userId = OWNER_USER_ID;
        request.session.role = "admin";
      } else {
        const found = findUserByUsername(db, request.session.user);
        if (!found || found.status !== "active") {
          await request.session.destroy();
          return reply.code(401).send({ error: "unauthorized" });
        }
        request.session.userId = found.id;
        request.session.role = found.role;
      }
    } else if (request.session.userId !== OWNER_USER_ID) {
      const found = getUserById(db, request.session.userId);
      if (!found || found.status !== "active") {
        await request.session.destroy();
        return reply.code(401).send({ error: "unauthorized" });
      }
      request.session.user = found.username;
      request.session.role = found.role;
    } else {
      request.session.role = "admin";
    }
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

    const typedUser = body.data.username.trim();
    const isOwnerMatch =
      typedUser === config.apiUsername ||
      (config.apiUsername.includes("@") && typedUser.toLowerCase() === config.apiUsername.toLowerCase());

    if (isOwnerMatch) {
      const ok = loginOk(
        config.apiUsername,
        body.data.password,
        config.apiUsername,
        config.apiPassword ?? "",
        readPasswordHash(db),
      );
      if (!ok) {
        writeAudit(db, { id: ulid(), at: now(), actor: actorName(typedUser), action: "login_failed" });
        throw new HttpError(401, "unauthorized");
      }
      await request.session.regenerate();
      request.session.user = config.apiUsername;
      request.session.userId = OWNER_USER_ID;
      request.session.role = "admin";
      writeAudit(db, { id: ulid(), at: now(), actor: config.apiUsername, action: "login" });
      return reply.send({ user: config.apiUsername });
    }

    const member = findUserByUsername(db, typedUser);
    if (!member || member.status !== "active" || !passwordMatches(body.data.password, member.password_hash)) {
      writeAudit(db, { id: ulid(), at: now(), actor: actorName(typedUser), action: "login_failed" });
      throw new HttpError(401, "unauthorized");
    }

    const at = now();
    touchUserLogin(db, member.id, at);
    await request.session.regenerate();
    request.session.user = member.username;
    request.session.userId = member.id;
    request.session.role = member.role;
    writeAudit(db, { id: ulid(), at, actor: member.username, action: "login" });
    return reply.send({ user: member.username });
  });

  app.post("/v1/password/forgot", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = resetRequestBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const email = normalizeAddress(body.data.email);
    if (email) {
      const targetId = resolveResetTargetId(db, config, email);
      if (targetId) {
        const at = now();
        const current = readResetSeal(db, targetId);
        const cooling =
          current &&
          current.attempts < RESET_MAX_ATTEMPTS &&
          at < current.expiresAt &&
          at < current.sentAt + RESET_RESEND_MS;
        if (!cooling) {
          const code = makeResetCode();
          const acceptList = readAcceptDomains(db, config.acceptDomains);
          const from = normalizeAddress(`noreply@${acceptList[0] ?? config.acceptDomains[0] ?? ""}`);
          if (from) {
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
              saveResetSeal(db, { ...sealResetCode(code, at), target: targetId }, at, targetId);
              writeAudit(db, { id: ulid(), at, actor: email, action: "password_reset_sent" });
            } catch (err) {
              request.log.error(
                { err: err instanceof Error ? err.name : "password reset send failed" },
                "password reset send failed",
              );
            }
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
    const at = now();
    const targetId = email ? resolveResetTargetId(db, config, email) : null;
    const seal = targetId ? readResetSeal(db, targetId) : null;
    const verdict = seal ? resetCodeOk(body.data.code, seal, at) : { ok: false as const, seal: null };
    if (!verdict.ok || !targetId) {
      if (targetId && !verdict.ok) {
        if (verdict.seal) saveResetSeal(db, verdict.seal, at, targetId);
        else if (seal) clearResetSeal(db, targetId);
        writeAudit(db, { id: ulid(), at, actor: actorName(email ?? ""), action: "password_reset_failed" });
      }
      throw new HttpError(401, "unauthorized");
    }

    if (targetId === OWNER_USER_ID) {
      db.transaction(() => {
        savePasswordHash(db, hashPassword(body.data.next), at);
        clearResetSeal(db, OWNER_USER_ID);
        clearSessions(db);
        writeAudit(db, { id: ulid(), at, actor: email ?? config.apiUsername, action: "password_reset" });
      })();
    } else {
      const user = getUserById(db, targetId);
      if (!user || user.status !== "active") throw new HttpError(401, "unauthorized");
      db.transaction(() => {
        updateUserPassword(db, targetId, hashPassword(body.data.next), at);
        clearResetSeal(db, targetId);
        clearUserSessions(db, targetId, user.username);
        writeAudit(db, { id: ulid(), at, actor: user.username, action: "password_reset" });
      })();
    }
    return reply.send({ ok: true });
  });

  app.post("/v1/logout", async (request, reply) => {
    const actor = request.session.user ?? "unknown";
    writeAudit(db, { id: ulid(), at: now(), actor, action: "logout" });
    await request.session.destroy();
    return reply.send({ ok: true });
  });

  app.get("/v1/me", async (request) => ({ user: request.session.user }));

  app.get("/v1/session", async (request) => {
    const userId = request.session.userId ?? OWNER_USER_ID;
    const role = request.session.role ?? "admin";
    const todayStart = utcDayStart(now());
    const acceptDomains = readAcceptDomains(db, config.acceptDomains);
    const dkimDomains = [...new Set(listDkimPublic(db).map((item) => item.domain))];

    if (userId === OWNER_USER_ID) {
      const profile = readOwnerProfile(db);
      return {
        user: config.apiUsername,
        userId: OWNER_USER_ID,
        role: "admin",
        displayName: profile.displayName,
        recoveryEmail: profile.recoveryEmail,
        quotaSendPerDay: null,
        sentToday: countUserOutboxSince(db, OWNER_USER_ID, todayStart),
        mailboxes: [],
        acceptDomains,
        dkimDomains,
        hasMembers: hasAnyUsers(db),
        version: APP_VERSION,
      };
    }

    const member = getUserById(db, userId);
    if (!member) throw new HttpError(401, "unauthorized");
    const mailboxes = listUserMailboxes(db, userId);
    const memberDomains = [...new Set(mailboxes.map((b) => b.domain))];

    return {
      user: member.username,
      userId: member.id,
      role: member.role,
      displayName: member.display_name,
      recoveryEmail: member.recovery_email,
      quotaSendPerDay: role === "admin" ? null : member.quota_send_per_day,
      sentToday: countUserOutboxSince(db, member.id, todayStart),
      mailboxes,
      acceptDomains: role === "admin" ? acceptDomains : memberDomains,
      dkimDomains: role === "admin" ? dkimDomains : dkimDomains.filter((d) => memberDomains.includes(d)),
      hasMembers: role === "admin" ? hasAnyUsers(db) : false,
      version: APP_VERSION,
    };
  });

  app.patch("/v1/account/profile", async (request, reply) => {
    const body = profileBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const userId = request.session.userId ?? OWNER_USER_ID;
    const at = now();
    try {
      if (userId === OWNER_USER_ID) {
        const saved = saveOwnerProfile(db, body.data, at);
        writeAudit(db, { id: ulid(), at, actor: request.session.user ?? "admin", action: "profile_update" });
        return reply.send({ ok: true, ...saved });
      }
      const updated = updateUser(
        db,
        userId,
        { displayName: body.data.displayName, recoveryEmail: body.data.recoveryEmail },
        at,
      );
      writeAudit(db, { id: ulid(), at, actor: updated.username, action: "profile_update" });
      return reply.send({ ok: true, displayName: updated.displayName, recoveryEmail: updated.recoveryEmail });
    } catch (err) {
      if (err instanceof SettingsError || err instanceof UserError) throw new HttpError(400);
      throw err;
    }
  });

  app.get("/v1/unread", async (request) => {
    const q = request.query as Record<string, unknown>;
    const scope = optionalString(q?.scope);
    const viewer = viewerOf(db, request, scope);
    return countUnreadForViewer(db, viewer);
  });

  app.get("/v1/messages", async (request) => {
    const query = readListQuery(request.query);
    const viewer = viewerOf(db, request, query.scope);
    const rows = listMessages(db, { ...query, limit: query.limit + 1, viewer });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toListItem),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.received_at, last.id) : null,
    };
  });

  app.post("/v1/messages/read-all", async (request, reply) => {
    const body = readAllBody.safeParse(request.body ?? {});
    if (!body.success) throw new HttpError(400);
    if (
      body.data.label &&
      body.data.label !== "not-legit" &&
      !LABELS.includes(body.data.label as (typeof LABELS)[number])
    ) {
      throw new HttpError(400);
    }
    const viewer = viewerOf(db, request, body.data.scope);
    const count = markAllReadForViewer(
      db,
      viewer,
      { label: body.data.label, domain: body.data.domain },
      now(),
    );
    return reply.send({ ok: true, count });
  });

  app.get("/v1/messages/:id", async (request) => {
    const q = request.query as Record<string, unknown>;
    const viewer = viewerOf(db, request, optionalString(q?.scope));
    return toDetail(db, messageId(request), viewer);
  });

  app.get("/v1/messages/:id/thread", async (request) => {
    const id = messageId(request);
    const q = request.query as Record<string, unknown>;
    const viewer = viewerOf(db, request, optionalString(q?.scope));
    const letters = listThread(db, id, viewer);
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
    const viewer = viewerOf(db, request, "allIfAdmin");
    const message = requireMessage(db, messageId(request), viewer);
    const parsed = parseJson(message.parsed);
    const text =
      parsed && typeof parsed === "object" && "text" in parsed && typeof parsed.text === "string"
        ? parsed.text
        : null;
    if (text === null) throw new HttpError(404, "not_found");
    return { text };
  });

  app.get("/v1/messages/:id/html", async (request) => {
    const viewer = viewerOf(db, request, "allIfAdmin");
    const message = requireMessage(db, messageId(request), viewer);
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
    const viewer = viewerOf(db, request, "allIfAdmin");
    const message = requireMessage(db, messageId(request), viewer);
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
    const viewer = viewerOf(db, request, "allIfAdmin");
    const message = requireMessage(db, messageId(request), viewer);
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
    const viewer = viewerOf(db, request, "allIfAdmin");
    requireMessage(db, id, viewer);
    const at = now();
    const open = db
      .prepare(
        `SELECT id, status FROM jobs
         WHERE message_id = ? AND type = 'classify' AND status IN ('queued', 'running')`,
      )
      .all(id) as Array<{ id: string; status: string }>;
    const queued = open.find((row) => row.status === "queued");
    if (queued) {
      db.prepare("UPDATE jobs SET payload = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify({ force: true }), at, queued.id);
    } else {
      enqueueJob(db, { id: ulid(), type: "classify", messageId: id, payload: { force: true }, now: at });
    }
    writeAudit(db, { id: ulid(), at, actor: request.session.user ?? "unknown", action: "reclassify", target: id });
    return reply.code(202).send({ queued: true });
  });

  const labelOverrideBody = z.object({
    label: z.enum(["phish", "malware", "spam", "unsolicited-admin", "legit", "gray"]),
  }).strict();

  app.patch("/v1/messages/:id/label", async (request, reply) => {
    const id = messageId(request);
    const viewer = viewerOf(db, request);
    requireMessage(db, id, request.session.role === "admin" ? viewerOf(db, request, "allIfAdmin") : viewer);
    const body = labelOverrideBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);

    const at = now();
    const actor = request.session.user ?? "admin";
    const result = setManualLabelForViewer(db, id, body.data.label, actor, viewer, at);

    writeAudit(db, {
      id: ulid(),
      at,
      actor,
      action: "override_label",
      target: id,
      detail: `from=${result.prevLabel},to=${body.data.label}`,
    });

    return reply.send({
      ok: true,
      id,
      label: body.data.label,
      originalLabel: result.originalLabel,
      originalConfidence: result.originalConfidence,
    });
  });

  app.post("/v1/messages/:id/read", async (request, reply) => {
    const id = messageId(request);
    const q = request.query as Record<string, unknown>;
    const viewer = viewerOf(db, request, optionalString(q?.scope));
    requireMessage(db, id, request.session.role === "admin" ? viewerOf(db, request, "allIfAdmin") : viewer);
    markMessageReadForViewer(db, id, viewer, now());
    return reply.send({ ok: true });
  });

  app.post("/v1/messages/:id/unread", async (request, reply) => {
    const id = messageId(request);
    const q = request.query as Record<string, unknown>;
    const viewer = viewerOf(db, request, optionalString(q?.scope));
    requireMessage(db, id, request.session.role === "admin" ? viewerOf(db, request, "allIfAdmin") : viewer);
    markMessageUnreadForViewer(db, id, viewer, now());
    return reply.send({ ok: true, id, read: false });
  });

  app.post("/v1/messages/:id/trash", async (request, reply) => {
    const id = messageId(request);
    const q = request.query as Record<string, unknown>;
    const viewer = viewerOf(db, request, optionalString(q?.scope));
    requireMessage(db, id, request.session.role === "admin" ? viewerOf(db, request, "allIfAdmin") : viewer);
    trashMessageForViewer(db, id, viewer, now());
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: request.session.user ?? "unknown",
      action: "trash",
      target: id,
    });
    return reply.send({ ok: true, id, trashed: true });
  });

  app.post("/v1/messages/:id/block", async (request, reply) => {
    const id = messageId(request);
    const userId = request.session.userId ?? OWNER_USER_ID;
    const viewer = viewerOf(db, request);
    const message = requireMessage(
      db,
      id,
      request.session.role === "admin" ? viewerOf(db, request, "allIfAdmin") : viewer,
    );
    const sender = message.from_addr || message.envelope_from;
    if (!sender) throw new HttpError(400);
    let blockedSenders: string[];
    try {
      blockedSenders = saveBlockedSenders(db, readBlockedSenders(db, userId).concat(sender), now(), userId);
    } catch (err) {
      if (err instanceof SettingsError) throw new HttpError(400);
      throw err;
    }
    trashMessageForViewer(db, id, viewer, now());
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: request.session.user ?? "unknown",
      action: "block_sender",
      target: id,
      detail: sender,
    });
    return reply.send({ ok: true, id, blockedSenders, trashed: true });
  });

  app.post("/v1/messages/:id/restore", async (request, reply) => {
    const id = messageId(request);
    const q = request.query as Record<string, unknown>;
    const viewer = viewerOf(db, request, optionalString(q?.scope));
    requireMessage(db, id, request.session.role === "admin" ? viewerOf(db, request, "allIfAdmin") : viewer);
    restoreMessageForViewer(db, id, viewer, now());
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: request.session.user ?? "unknown",
      action: "restore",
      target: id,
    });
    return reply.send({ ok: true, id, trashed: false });
  });

  app.delete("/v1/messages/:id", async (request, reply) => {
    const id = messageId(request);
    const q = request.query as Record<string, unknown>;
    const viewer = viewerOf(db, request, optionalString(q?.scope));
    requireMessage(db, id, request.session.role === "admin" ? viewerOf(db, request, "allIfAdmin") : viewer);
    const purged = deleteMessageForViewer(
      db,
      id,
      request.session.role === "admin" && !optionalString(q?.scope) ? viewerOf(db, request, "all") : viewer,
      now(),
    );
    if (!purged) throw new HttpError(404, "not_found");
    const failed = await removeStoredFiles(config.mailDataDir, purged.paths);
    if (failed.length > 0) request.log.warn({ failed: failed.length }, "stored files left on disk");
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: request.session.user ?? "unknown",
      action: "delete",
      target: id,
    });
    return reply.send({ ok: true, id, deleted: true });
  });

  app.post("/v1/messages/empty-trash", async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const viewer = viewerOf(db, request, optionalString(q?.scope));
    const purged = emptyTrashForViewer(db, viewer, now());
    const failed = await removeStoredFiles(config.mailDataDir, purged.paths);
    if (failed.length > 0) request.log.warn({ failed: failed.length }, "stored files left on disk");
    const count = purged.count;
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: request.session.user ?? "unknown",
      action: "empty_trash",
      detail: `count=${count}`,
    });
    return reply.send({ ok: true, count });
  });

  app.get("/v1/trash/count", async (request) => {
    const viewer = viewerOf(db, request);
    return { count: countTrash(db, viewer) };
  });

  app.get("/v1/attachments/:sha256", async (request, reply) => {
    const sha = attachmentId(request);
    const viewer = viewerOf(db, request);
    if (!canViewerReadAttachment(db, sha, viewer)) throw new HttpError(404, "not_found");
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
    requireAdmin(request);
    const body = retryMessageBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const count = retryMessageJobs(db, body.data.messageId, now());
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: request.session.user ?? "unknown",
      action: "retry_message_jobs",
      target: body.data.messageId,
      detail: `count=${count}`,
    });
    return reply.send({ ok: true, count });
  });

  app.post("/v1/jobs/:id/retry", async (request, reply) => {
    requireAdmin(request);
    const params = request.params as Record<string, string>;
    const id = params.id;
    if (!id) throw new HttpError(400);
    const ok = retryJob(db, id, now());
    if (!ok) throw new HttpError(404, "not_found");
    writeAudit(db, { id: ulid(), at: now(), actor: request.session.user ?? "unknown", action: "retry_job", target: id });
    return reply.send({ ok: true, retried: id });
  });

  app.post("/v1/jobs/:id/dismiss", async (request, reply) => {
    requireAdmin(request);
    const params = request.params as Record<string, string>;
    const id = params.id;
    if (!id) throw new HttpError(400);
    const ok = dismissJob(db, id, now());
    if (!ok) throw new HttpError(404, "not_found");
    writeAudit(db, { id: ulid(), at: now(), actor: request.session.user ?? "unknown", action: "dismiss_job", target: id });
    return reply.send({ ok: true, dismissed: id });
  });

  app.post("/v1/jobs/retry-all", async (request, reply) => {
    requireAdmin(request);
    const count = retryAllDeadJobs(db, now());
    writeAudit(db, { id: ulid(), at: now(), actor: request.session.user ?? "unknown", action: "retry_all_dead", detail: `count=${count}` });
    return reply.send({ ok: true, count });
  });

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
    requireAdmin(request);
    const params = request.params as Record<string, string>;
    const id = params.id;
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new HttpError(400);
    const body = request.body as { content?: unknown };
    if (!body || typeof body.content !== "string" || body.content.trim().length === 0 || body.content.length > 100_000) {
      throw new HttpError(400);
    }
    savePrompt(config.promptsDir, id, body.content, db, now());
    writeAudit(db, { id: ulid(), at: now(), actor: request.session.user ?? "unknown", action: "prompt_update", target: id });
    return reply.send({ ok: true, id });
  });

  app.get("/v1/ai/status", async (request) => {
    requireAdmin(request);
    return aiStatus(db, config);
  });

  app.get("/v1/settings", async (request) => {
    const userId = request.session.userId ?? OWNER_USER_ID;
    const role = request.session.role ?? "admin";
    if (role !== "admin") {
      const names = readNameSettings(db, userId);
      const boxes = listUserMailboxes(db, userId);
      const memberDomains = [...new Set(boxes.map((b) => b.domain))];
      return {
        role: "member",
        acceptDomains: memberDomains,
        panelTitle: names.panelTitle,
        labelNames: names.labelNames,
        domainNames: names.domainNames,
        senderNames: names.senderNames,
        blockedSenders: readBlockedSenders(db, userId),
        passwordSet: true,
        version: APP_VERSION,
      };
    }

    const runtime = readRuntimeSettings(
      db,
      {
        notifyLabels: config.notifyLabels,
        notifyMinConfidence: config.notifyMinConfidence,
        acceptDomains: config.acceptDomains,
      },
      userId,
    );
    return {
      role: "admin",
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
      blockedSenders: readBlockedSenders(db, userId),
      passwordSet: userId === OWNER_USER_ID ? readPasswordHash(db) !== null : true,
      version: APP_VERSION,
    };
  });

  app.put("/v1/settings/ai", async (request, reply) => {
    requireAdmin(request);
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
      actor: request.session.user ?? "unknown",
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

  app.post("/v1/settings/ai/test-key", async (request, reply) => {
    requireAdmin(request);
    const body = testKeyBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const pool = readEffectiveAiPool(db, fallbackAiPool(config));
    const targetKey = pool.keys.find((item) => item.id === body.data.id);
    if (!targetKey) throw new HttpError(404, "not_found");
    const defaultModel = config.classifier === "gemini" ? config.geminiModel : config.openaiModel ?? "";
    const chosenModel = body.data.model?.trim() || pool.models[0] || defaultModel;
    const probe = await probeAiKey({
      classifier: config.classifier,
      secret: targetKey.secret,
      model: chosenModel,
      geminiBaseUrl: config.geminiBaseUrl,
      openaiBaseUrl: config.openaiBaseUrl,
      fetchImpl: options.probeFetch,
    });
    return reply.send(probe);
  });

  app.put("/v1/settings/blocklist", async (request, reply) => {
    const body = blocklistBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const userId = request.session.userId ?? OWNER_USER_ID;
    let blockedSenders: string[];
    try {
      blockedSenders = saveBlockedSenders(db, body.data.addresses, now(), userId);
    } catch (err) {
      if (err instanceof SettingsError) throw new HttpError(400);
      throw err;
    }
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: request.session.user ?? "unknown",
      action: "settings_blocklist",
      detail: `count=${blockedSenders.length}`,
    });
    return reply.send({ ok: true, blockedSenders });
  });

  app.put("/v1/settings/password", async (request, reply) => {
    const body = passwordBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    if (body.data.next === "admin") throw new HttpError(400);
    const userId = request.session.userId ?? OWNER_USER_ID;
    const at = now();

    if (userId === OWNER_USER_ID) {
      const currentOk = loginOk(
        config.apiUsername,
        body.data.current,
        config.apiUsername,
        config.apiPassword ?? "",
        readPasswordHash(db),
      );
      if (!currentOk) throw new HttpError(401, "unauthorized");
      savePasswordHash(db, hashPassword(body.data.next), at);
      clearResetSeal(db, OWNER_USER_ID);
    } else {
      const user = getUserById(db, userId);
      if (!user || !passwordMatches(body.data.current, user.password_hash)) {
        throw new HttpError(401, "unauthorized");
      }
      updateUserPassword(db, userId, hashPassword(body.data.next), at);
      clearResetSeal(db, userId);
    }

    writeAudit(db, {
      id: ulid(),
      at,
      actor: request.session.user ?? "unknown",
      action: "password_change",
    });
    return reply.send({ ok: true });
  });

  app.get("/v1/logs", async (request) => {
    requireAdmin(request);
    return { lines: recentLogs().map(redactLogLine) };
  });

  app.put("/v1/settings/notify", async (request, reply) => {
    requireAdmin(request);
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
      actor: request.session.user ?? "unknown",
      action: "settings_notify",
      detail: labels.join(",") || "none",
    });
    return reply.send({ ok: true, notifyLabels: labels, notifyMinConfidence: body.data.minConfidence });
  });

  app.put("/v1/settings/domains", async (request, reply) => {
    requireAdmin(request);
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
      actor: request.session.user ?? "unknown",
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
    requireAdmin(request);
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
      actor: request.session.user ?? "unknown",
      action: "dkim_generate",
      target: `${saved.selector}._domainkey.${saved.domain}`,
      detail: saved.algorithm,
    });
    return reply.send({ ok: true, ...saved });
  });

  app.post("/v1/dkim/remove", async (request, reply) => {
    requireAdmin(request);
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
      actor: request.session.user ?? "unknown",
      action: "dkim_remove",
      target: `${body.data.selector}._domainkey.${body.data.domain}`,
    });
    return reply.send({ ok: true });
  });

  app.get("/v1/outbox", async (request) => {
    const query = request.query as Record<string, unknown>;
    const limitRaw = optionalString(query.limit);
    const scope = optionalString(query.scope);
    let limit = 30;
    if (limitRaw !== undefined) {
      if (!/^\d+$/.test(limitRaw)) throw new HttpError(400);
      limit = Number(limitRaw);
      if (limit < 1 || limit > 100) throw new HttpError(400);
    }
    const viewer = viewerOf(db, request, scope);
    return { items: listOutbox(db, limit, viewer).map(presentOutbox) };
  });

  app.get("/v1/outbox/:id/raw", async (request, reply) => {
    const row = getOutbox(db, messageId(request));
    if (!row || !canViewerAccessOutbox(row, viewerOf(db, request, "allIfAdmin"))) {
      throw new HttpError(404, "not_found");
    }
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
    const row = getOutbox(db, messageId(request));
    if (!row || !canViewerAccessOutbox(row, viewerOf(db, request, "allIfAdmin"))) {
      throw new HttpError(404, "not_found");
    }
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
    const row = getOutbox(db, id);
    if (!row || !canViewerAccessOutbox(row, viewerOf(db, request, "allIfAdmin"))) {
      throw new HttpError(404, "not_found");
    }
    const ok = retryOutboxJob(db, id, now());
    if (!ok) throw new HttpError(404, "not_found");
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: request.session.user ?? "unknown",
      action: "send_retry",
      target: id,
    });
    return reply.send({ ok: true });
  });

  app.post("/v1/outbox", { config: { rateLimit: { max: 30, timeWindow: "10 minutes" } } }, async (request, reply) => {
    const body = sendBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);

    const normalizedFrom = normalizeAddress(body.data.from);
    if (!normalizedFrom) throw new HttpError(400);

    const userId = request.session.userId ?? OWNER_USER_ID;
    const role = request.session.role ?? "admin";
    const currentNow = now();

    if (role !== "admin") {
      if (!canMemberSendFrom(db, userId, normalizedFrom)) {
        throw new HttpError(403, "forbidden");
      }
      const member = getUserById(db, userId);
      const dailyLimit = member?.quota_send_per_day ?? 100;
      const sentToday = countUserOutboxSince(db, userId, utcDayStart(currentNow));
      if (sentToday >= dailyLimit) {
        throw new HttpError(429, "rate_limited");
      }
    }

    try {
      let fromName = findSenderDisplayNameForUser(db, userId, normalizedFrom);
      if (!fromName && role === "admin") {
        const atIdx = normalizedFrom.lastIndexOf("@");
        const history =
          atIdx > 0
            ? findMailboxHistory(db, normalizedFrom.slice(atIdx + 1), normalizedFrom.slice(0, atIdx))
            : undefined;
        fromName = history?.display_name ?? readOwnerProfile(db).displayName ?? undefined;
      }

      const queued = await submitOutbox(
        { db, dataDir: config.mailDataDir, codec, acceptDomains: config.acceptDomains, now },
        { ...body.data, from: normalizedFrom, fromName, userId },
      );
      writeAudit(db, {
        id: ulid(),
        at: currentNow,
        actor: request.session.user ?? "unknown",
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
    requireAdmin(request);
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
      actor: request.session.user ?? "unknown",
      action: "settings_jobs",
      detail: `maxAttempts=${maxAttempts}`,
    });
    return reply.send({ ok: true, jobMaxAttempts: maxAttempts });
  });

  app.put("/v1/settings/names", async (request, reply) => {
    const body = nameSettingsBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const userId = request.session.userId ?? OWNER_USER_ID;
    let saved;
    try {
      saved = saveNameSettings(db, body.data, now(), userId);
    } catch (err) {
      if (err instanceof SettingsError || err instanceof ConfigError) throw new HttpError(400);
      throw err;
    }
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: request.session.user ?? "unknown",
      action: "settings_names",
      detail: saved.panelTitle,
    });
    return reply.send({ ok: true, ...saved });
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
    const role = request.session.role ?? "admin";
    const userId = request.session.userId ?? OWNER_USER_ID;
    if (role !== "admin") {
      const boxes = listUserMailboxes(db, userId);
      return {
        items: boxes.map((box) => ({
          id: box.id,
          domain: box.domain,
          localpart: box.localpart,
          firstSeen: iso(box.createdAt),
          lastSeen: null,
          source: "allocated",
          notes: box.notes,
          displayName: box.displayName,
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
    const body = historyBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const domain = body.data.domain.trim().toLowerCase().replace(/\.$/, "");
    const localpart = body.data.localpart.trim().toLowerCase();
    const role = request.session.role ?? "admin";
    const userId = request.session.userId ?? OWNER_USER_ID;

    if (role !== "admin") {
      const matched = findWinningAllocation(db, `${localpart}@${domain}`);
      if (!matched || matched.user_id !== userId) {
        throw new HttpError(403, "forbidden");
      }
      try {
        updateUserMailbox(db, userId, matched.id, {
          displayName: body.data.displayName,
          notes: body.data.notes,
        });
      } catch (err) {
        if (err instanceof UserError) throw new HttpError(400);
        throw err;
      }
      return reply.code(201).send({ ok: true });
    }

    if (!DOMAIN_RE.test(domain) || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/.test(localpart)) {
      throw new HttpError(400);
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
      actor: request.session.user ?? "unknown",
      action: "mailbox_history_upsert",
      target: `${localpart}@${domain}`,
    });
    return reply.code(201).send({ ok: true });
  });

  // --- Multi-User & Mailbox Allocation Admin Routes ---

  app.get("/v1/users", async (request) => {
    requireAdmin(request);
    return {
      items: listUsersWithDetails(db, utcDayStart(now())).map(presentPublicUser),
    };
  });

  app.post("/v1/users", async (request, reply) => {
    requireAdmin(request);
    const body = createUserBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    if (body.data.password === "admin") throw new HttpError(400);
    const at = now();
    try {
      const created = createUser(
        db,
        {
          username: body.data.username,
          passwordHash: hashPassword(body.data.password),
          displayName: body.data.displayName,
          recoveryEmail: body.data.recoveryEmail,
          role: body.data.role,
          quotaSendPerDay: body.data.quotaSendPerDay,
          notes: body.data.notes,
          reservedUsername: config.apiUsername,
          initialMailbox: body.data.initialMailbox ?? null,
        },
        at,
        utcDayStart(at),
      );
      writeAudit(db, {
        id: ulid(),
        at,
        actor: request.session.user ?? "admin",
        action: "user_create",
        target: created.username,
        detail: `role=${created.role} boxes=${created.mailboxes.length}`,
      });
      return reply.code(201).send({ ok: true, user: presentPublicUser(created) });
    } catch (err) {
      if (err instanceof UserError) {
        throw new HttpError(err.code === "conflict" ? 409 : 400);
      }
      throw err;
    }
  });

  app.patch("/v1/users/:id", async (request, reply) => {
    requireAdmin(request);
    const targetId = messageId(request);
    if (targetId === OWNER_USER_ID) throw new HttpError(400);
    const body = updateUserBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const at = now();
    try {
      const updated = updateUser(db, targetId, body.data, at, utcDayStart(at));
      if (body.data.status === "disabled") {
        clearUserSessions(db, targetId, updated.username);
      }
      writeAudit(db, {
        id: ulid(),
        at,
        actor: request.session.user ?? "admin",
        action: "user_update",
        target: updated.username,
        detail: `role=${updated.role} status=${updated.status}`,
      });
      return reply.send({ ok: true, user: presentPublicUser(updated) });
    } catch (err) {
      if (err instanceof UserError) {
        throw new HttpError(err.code === "not_found" ? 404 : 400);
      }
      throw err;
    }
  });

  app.put("/v1/users/:id/password", async (request, reply) => {
    requireAdmin(request);
    const targetId = messageId(request);
    const user = getUserById(db, targetId);
    if (!user) throw new HttpError(404, "not_found");
    const body = adminSetPasswordBody.safeParse(request.body);
    if (!body.success || body.data.next === "admin") throw new HttpError(400);
    const at = now();
    updateUserPassword(db, targetId, hashPassword(body.data.next), at);
    clearResetSeal(db, targetId);
    clearUserSessions(db, targetId, user.username);
    writeAudit(db, {
      id: ulid(),
      at,
      actor: request.session.user ?? "admin",
      action: "user_password_reset",
      target: user.username,
    });
    return reply.send({ ok: true });
  });

  app.delete("/v1/users/:id", async (request, reply) => {
    requireAdmin(request);
    const targetId = messageId(request);
    if (targetId === request.session.userId) throw new HttpError(400);
    const user = getUserById(db, targetId);
    if (!user) throw new HttpError(404, "not_found");
    clearUserSessions(db, targetId, user.username);
    deleteUser(db, targetId);
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: request.session.user ?? "admin",
      action: "user_delete",
      target: user.username,
    });
    return reply.send({ ok: true });
  });

  app.post("/v1/users/:id/mailboxes", async (request, reply) => {
    requireAdmin(request);
    const targetId = messageId(request);
    const body = allocateMailboxBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const at = now();
    try {
      const box = allocateMailbox(
        db,
        {
          userId: targetId,
          localpart: body.data.localpart,
          domain: body.data.domain,
          displayName: body.data.displayName,
          notes: body.data.notes,
          canSend: body.data.canSend,
        },
        at,
      );
      writeAudit(db, {
        id: ulid(),
        at,
        actor: request.session.user ?? "admin",
        action: "mailbox_allocate",
        target: box.address,
        detail: `user=${targetId}`,
      });
      return reply.code(201).send({ ok: true, mailbox: presentMailbox(box) });
    } catch (err) {
      if (err instanceof UserError) {
        if (err.code === "not_found") throw new HttpError(404, "not_found");
        if (err.code === "conflict") throw new HttpError(409);
        throw new HttpError(400);
      }
      throw err;
    }
  });

  app.patch("/v1/users/:id/mailboxes/:mailboxId", async (request, reply) => {
    const params = request.params as { id?: string; mailboxId?: string };
    const targetId = params.id ?? "";
    const mailboxId = params.mailboxId ?? "";
    if (!/^[\w-]+$/.test(targetId) || !/^[\w-]+$/.test(mailboxId)) {
      throw new HttpError(404, "not_found");
    }
    const body = updateMailboxBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const isAdmin = request.session.role === "admin";
    const isSelf = request.session.userId === targetId;
    if (!isAdmin && (!isSelf || body.data.canSend !== undefined)) {
      throw new HttpError(403, "forbidden");
    }
    try {
      const updated = updateUserMailbox(db, targetId, mailboxId, body.data);
      writeAudit(db, {
        id: ulid(),
        at: now(),
        actor: request.session.user ?? "unknown",
        action: "mailbox_update",
        target: updated.address,
      });
      return reply.send({ ok: true, mailbox: presentMailbox(updated) });
    } catch (err) {
      if (err instanceof UserError) {
        throw new HttpError(err.code === "not_found" ? 404 : 400);
      }
      throw err;
    }
  });

  app.delete("/v1/users/:id/mailboxes/:mailboxId", async (request, reply) => {
    requireAdmin(request);
    const params = request.params as { id?: string; mailboxId?: string };
    const targetId = params.id ?? "";
    const mailboxId = params.mailboxId ?? "";
    if (!/^[\w-]+$/.test(targetId) || !/^[\w-]+$/.test(mailboxId)) {
      throw new HttpError(404, "not_found");
    }
    const ok = revokeMailbox(db, targetId, mailboxId);
    if (!ok) throw new HttpError(404, "not_found");
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: request.session.user ?? "admin",
      action: "mailbox_revoke",
      target: mailboxId,
      detail: `user=${targetId}`,
    });
    return reply.send({ ok: true });
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

function requireAdmin(request: FastifyRequest): void {
  if (request.session.role !== "admin") {
    throw new HttpError(403, "forbidden");
  }
}

function viewerOf(db: Db, request: FastifyRequest, scopeHint?: string): ViewerContext {
  const userId = request.session.userId ?? OWNER_USER_ID;
  const role = request.session.role ?? "admin";
  if (role !== "admin") {
    return { userId, role: "member" };
  }
  if (scopeHint === "allIfAdmin" || scopeHint === "all") {
    return { userId, role: "admin", scope: "all" };
  }
  if (scopeHint && scopeHint.startsWith("user:")) {
    return { userId, role: "admin", scope: scopeHint };
  }
  if (userId !== OWNER_USER_ID && listUserMailboxes(db, userId).length === 0) {
    return { userId, role: "admin", scope: "all" };
  }
  return { userId, role: "admin", scope: "mine" };
}

function resolveResetTargetId(db: Db, config: Config, email: string): string | null {
  const ownerAccount = normalizeAddress(config.apiUsername);
  const ownerRecovery = readOwnerProfile(db).recoveryEmail;
  if ((ownerAccount && sameAccount(email, ownerAccount)) || (ownerRecovery && sameAccount(email, ownerRecovery))) {
    return OWNER_USER_ID;
  }
  const member = findUserForPasswordReset(db, email);
  return member ? member.id : null;
}

function presentMailbox(box: ReturnType<typeof listUserMailboxes>[number]) {
  return {
    id: box.id,
    userId: box.userId,
    localpart: box.localpart,
    domain: box.domain,
    address: box.address,
    displayName: box.displayName,
    notes: box.notes,
    canSend: box.canSend,
    dkimSigned: box.dkimSigned,
    createdAt: iso(box.createdAt),
  };
}

function presentPublicUser(user: ReturnType<typeof listUsersWithDetails>[number]) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    recoveryEmail: user.recoveryEmail,
    role: user.role,
    status: user.status,
    quotaSendPerDay: user.quotaSendPerDay,
    notes: user.notes,
    lastLoginAt: user.lastLoginAt === null ? null : iso(user.lastLoginAt),
    createdAt: iso(user.createdAt),
    updatedAt: iso(user.updatedAt),
    mailboxes: user.mailboxes.map(presentMailbox),
    stats: user.stats,
  };
}

function readAppVersion(): string {
  const fromEnv = process.env.APP_VERSION?.trim();
  if (fromEnv) return fromEnv;
  try {
    const pkg = JSON.parse(readFileSync(path.join(appRoot(), "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.8.0";
  } catch {
    return "0.8.0";
  }
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
    userId: row.user_id,
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
  const p = url.split("?")[0] ?? url;
  return (
    p === "/healthz" ||
    p === "/v1/login" ||
    p === "/v1/csrf" ||
    p === "/v1/password/forgot" ||
    p === "/v1/password/reset" ||
    isPanelAsset(p)
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

function requireMessage(db: Db, id: string, viewer?: ViewerContext): StoredMessage {
  const message = getMessageForViewer(db, id, viewer);
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
  scope?: string;
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
  const scope = optionalString(source.scope);
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
    scope,
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

function toDetail(db: Db, id: string, viewer?: ViewerContext) {
  const message = requireMessage(db, id, viewer);
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
    read: message.read_at != null,
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
): Array<{ day: string; total: number; labels: Record<string, number> }> {
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
      : db
          .prepare("SELECT json_extract(ai_result, '$.label') AS label, COUNT(*) AS n FROM messages WHERE received_at >= ? GROUP BY 1")
          .all(since)
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
