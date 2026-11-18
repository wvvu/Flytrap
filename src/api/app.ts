import { readFile } from "node:fs/promises";
import { ulid } from "ulid";
import cookie from "@fastify/cookie";
import csrf from "@fastify/csrf-protection";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import session from "@fastify/session";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import { LABELS, type Label } from "../ai/types.js";
import { listPrompts, readPrompt, savePrompt } from "../ai/prompt.js";
import { probeAiKey } from "../ai/probe.js";
import { ConfigError, type Config } from "../config.js";
import type { Codec } from "../compress.js";
import type { Db } from "../db/index.js";
import PostalMime from "postal-mime";
import { findAttachment, listMessageAttachments } from "../db/repos/attachments.js";
import { listAuditLogs, writeAudit } from "../db/repos/audit.js";
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
import { fallbackAiPool } from "../ai/pool.js";
import {
  presentAiPool,
  readAiEnabled,
  readAiThinking,
  readBlockedSenders,
  readEffectiveAiPool,
  readPasswordHash,
  readResetSeal,
  saveAcceptDomains,
  saveAiControls,
  saveAiPool,
  saveBlockedSenders,
  saveJobMaxAttempts,
  saveNameSettings,
  saveNotifySettings,
  savePasswordHash,
  saveResetSeal,
  clearResetSeal,
  readRuntimeSettings,
  SettingsError,
} from "../db/repos/settings.js";
import { findMailboxHistory, listMailboxHistory, upsertMailboxHistory } from "../db/repos/mailbox-history.js";
import {
  countRoomBadges,
  countTrash,
  deleteMessage,
  emptyMemberTrash,
  emptyTrash,
  getMessageForViewer,
  listMessages,
  markAllMessagesRead,
  markMessageRead,
  markMessageUnread,
  restoreMessage,
  setMemberLabelOverride,
  setMessageStarred,
  softDeleteMemberMessage,
  trashMessage,
  type ViewerScope,
} from "../db/repos/messages.js";
import {
  addUserAllocation,
  allocationMatchesAddress,
  authenticateManagedUser,
  canMemberUseAddress,
  canMemberViewAttachment,
  countUserSentSince,
  createUser,
  deleteUser,
  findUserForPasswordReset,
  getUserById,
  listUserAllocations,
  listUsersWithStats,
  memberMessageMatchSql,
  OWNER_USER_ID,
  ownerPrincipal,
  presentAllocation,
  readUserBlockedSenders,
  readUserResetSeal,
  readUserSenderNames,
  removeUserAllocation,
  resolveSessionPrincipal,
  saveUserBlockedSenders,
  saveUserResetSeal,
  saveUserSenderNames,
  updateUser,
  updateUserAllocation,
  updateUserPassword,
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
import { clearSessions, clearUserSessions, sqliteSessionStore } from "./session-store.js";
import { isPanelAsset, registerPanel } from "./static.js";

declare module "fastify" {
  interface Session {
    user?: string;
    userId?: string;
    role?: "admin" | "member";
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
  panelTitle: z.string().min(1).max(40).optional(),
  labelNames: z.record(z.string(), z.string().max(16)).optional(),
  domainNames: z.record(z.string(), z.string().max(24)).optional(),
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

const aiProbeBody = z.object({
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

const starBody = z.object({
  starred: z.boolean(),
}).strict();

const markAllReadBody = z.object({
  scope: z.enum(["inbox", "promo", "spam", "all"]).optional(),
}).strict();

const batchMessagesBody = z.object({
  ids: z.array(z.string().regex(/^[\w-]+$/)).min(1).max(100),
  action: z.enum(["read", "unread", "star", "unstar", "trash", "restore", "delete", "label"]),
  label: z.enum(LABELS).optional(),
}).strict();

const allocationInputSchema = z.object({
  address: z.string().min(3).max(254).optional(),
  localpart: z.string().min(1).max(64).optional(),
  domain: z.string().min(1).max(253).optional(),
  canSend: z.boolean().optional(),
}).strict();

const createUserBody = z.object({
  username: z.string().min(2).max(128),
  displayName: z.string().max(40).nullable().optional(),
  password: z.string().min(8).max(200),
  role: z.enum(["admin", "member"]).optional(),
  quotaSendDay: z.number().int().min(0).max(100_000).optional(),
  notes: z.string().max(300).nullable().optional(),
  allocations: z.array(allocationInputSchema).max(50).optional(),
}).strict();

const updateUserBody = z.object({
  displayName: z.string().max(40).nullable().optional(),
  role: z.enum(["admin", "member"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  quotaSendDay: z.number().int().min(0).max(100_000).optional(),
  notes: z.string().max(300).nullable().optional(),
}).strict();

const adminResetPasswordBody = z.object({
  password: z.string().min(8).max(200),
}).strict();

const updateAllocBody = z.object({
  canSend: z.boolean(),
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
    const principal = resolveSessionPrincipal(db, config.apiUsername, request.session);
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
    // Preserve strict 5 attempts per 5 minutes for invalid attempts while allowing multi-user testing:
    // wait—test/api.test.ts tests "login is limited to five attempts in five minutes"! Keep max: 5!
    return handleLogin(request, reply);
  });

  async function handleLogin(request: FastifyRequest, reply: any) {
    const body = loginBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const at = now();
    let principal: SessionPrincipal | null = null;

    if (
      loginOk(
        body.data.username,
        body.data.password,
        config.apiUsername,
        config.apiPassword ?? "",
        readPasswordHash(db),
      )
    ) {
      principal = ownerPrincipal(config.apiUsername);
    } else {
      principal = authenticateManagedUser(db, body.data.username, body.data.password, at);
    }

    const actor = actorName(body.data.username);
    if (!principal) {
      writeAudit(db, { id: ulid(), at, actor, action: "login_failed" });
      throw new HttpError(401, "unauthorized");
    }
    await request.session.regenerate();
    request.session.user = principal.username;
    request.session.userId = principal.id;
    request.session.role = principal.role;
    writeAudit(db, { id: ulid(), at, actor: principal.username, action: "login", detail: `role=${principal.role}` });
    return reply.send({ user: principal.username });
  }

  app.post("/v1/password/forgot", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = resetRequestBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const email = normalizeAddress(body.data.email);
    const ownerAccount = normalizeAddress(config.apiUsername);
    const at = now();
    const activeDomains = readRuntimeSettings(db, {
      notifyLabels: config.notifyLabels,
      notifyMinConfidence: config.notifyMinConfidence,
      acceptDomains: config.acceptDomains,
    }).acceptDomains;

    if (email && ownerAccount && sameAccount(email, ownerAccount)) {
      const current = readResetSeal(db);
      const cooling =
        current &&
        current.attempts < RESET_MAX_ATTEMPTS &&
        at < current.expiresAt &&
        at < current.sentAt + RESET_RESEND_MS;
      if (!cooling) {
        const code = makeResetCode();
        const from = normalizeAddress(`noreply@${activeDomains[0] ?? config.acceptDomains[0] ?? ""}`);
        if (from) {
          try {
            await submitOutbox(
              { db, dataDir: config.mailDataDir, codec, acceptDomains: activeDomains, now },
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
            request.log.error(
              { err: err instanceof Error ? err.name : "password reset send failed" },
              "password reset send failed",
            );
          }
        }
      }
    } else if (email) {
      const managed = findUserForPasswordReset(db, email);
      if (managed) {
        const current = readUserResetSeal(managed);
        const cooling =
          current &&
          current.attempts < RESET_MAX_ATTEMPTS &&
          at < current.expiresAt &&
          at < current.sentAt + RESET_RESEND_MS;
        if (!cooling) {
          const code = makeResetCode();
          const from = normalizeAddress(`noreply@${activeDomains[0] ?? config.acceptDomains[0] ?? ""}`);
          if (from) {
            try {
              await submitOutbox(
                { db, dataDir: config.mailDataDir, codec, acceptDomains: activeDomains, now },
                {
                  from,
                  to: [email],
                  subject: "登录验证码",
                  text: `验证码 ${code}\n\n10 分钟内有效。\n`,
                },
              );
              saveUserResetSeal(db, managed.id, sealResetCode(code, at), at);
              writeAudit(db, { id: ulid(), at, actor: managed.username, action: "password_reset_sent" });
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

    const managed = email ? findUserForPasswordReset(db, email) : undefined;
    const seal = managed ? readUserResetSeal(managed) : null;
    const verdict = seal ? resetCodeOk(body.data.code, seal, at) : { ok: false as const, seal: null };
    if (!managed || !verdict.ok) {
      if (managed) {
        saveUserResetSeal(db, managed.id, verdict.ok ? null : verdict.seal, at);
        writeAudit(db, { id: ulid(), at, actor: actorName(managed.username), action: "password_reset_failed" });
      }
      throw new HttpError(401, "unauthorized");
    }
    try {
      db.transaction(() => {
        updateUserPassword(db, managed.id, body.data.next, at);
        clearUserSessions(db, { userId: managed.id, username: managed.username });
        writeAudit(db, { id: ulid(), at, actor: managed.username, action: "password_reset" });
      })();
    } catch (err) {
      if (err instanceof UserError) throw new HttpError(400);
      throw err;
    }
    return reply.send({ ok: true });
  });

  app.post("/v1/logout", async (request, reply) => {
    const actor = request.principal?.username ?? request.session.user ?? "unknown";
    writeAudit(db, { id: ulid(), at: now(), actor, action: "logout" });
    await request.session.destroy();
    return reply.send({ ok: true });
  });

  app.get("/v1/me", async (request) => ({ user: request.principal?.username ?? request.session.user }));

  app.get("/v1/session", async (request) => {
    const principal = requirePrincipal(request);
    const runtime = readRuntimeSettings(db, {
      notifyLabels: config.notifyLabels,
      notifyMinConfidence: config.notifyMinConfidence,
      acceptDomains: config.acceptDomains,
    });
    const since24h = now() - 86_400_000;
    const allocations =
      principal.role === "admin"
        ? runtime.acceptDomains.map((domain, idx) => ({
            id: `admin:${idx}`,
            localpart: "*",
            domain,
            pattern: `*@${domain}`,
            kind: "domain" as const,
            canSend: true,
            createdAt: 0,
          }))
        : listUserAllocations(db, principal.id).map(presentAllocation);
    const sentLast24h =
      principal.id === OWNER_USER_ID
        ? (
            db
              .prepare("SELECT COUNT(*) AS n FROM outbox WHERE (user_id IS NULL OR user_id = 'owner') AND created_at >= ?")
              .get(since24h) as { n: number }
          ).n
        : countUserSentSince(db, principal.id, since24h);
    return {
      id: principal.id,
      user: principal.username,
      displayName: principal.displayName,
      role: principal.role,
      isOwner: principal.isOwner,
      quotaSendDay: principal.quotaSendDay,
      sentLast24h,
      allocations,
    };
  });

  app.get("/v1/unread", async (request) => countRoomBadges(db, viewerOf(request)));

  app.get("/v1/messages", async (request) => {
    const principal = requirePrincipal(request);
    const query = readListQuery(request.query, principal);
    const rows = listMessages(db, { ...query, viewer: viewerOf(request), limit: query.limit + 1 });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toListItem),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.received_at, last.id) : null,
    };
  });

  app.post("/v1/messages/mark-all-read", async (request, reply) => {
    const body = markAllReadBody.safeParse(request.body ?? {});
    if (!body.success) throw new HttpError(400);
    const scope = body.data.scope ?? "inbox";
    const count = markAllMessagesRead(db, scope, now(), viewerOf(request));
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: actorOf(request),
      action: "mark_all_read",
      detail: `scope=${scope},count=${count}`,
    });
    return reply.send({ ok: true, count });
  });

  app.post("/v1/messages/batch", async (request, reply) => {
    const body = batchMessagesBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const { ids, action, label } = body.data;
    if (action === "label" && !label) throw new HttpError(400);
    const viewer = viewerOf(request);
    const at = now();
    const unlinkPaths: string[] = [];
    let count = 0;

    db.transaction(() => {
      for (const id of ids) {
        const message = getMessageForViewer(db, id, viewer);
        if (!message) continue;
        if (action === "read") {
          markMessageRead(db, id, at, viewer);
          count += 1;
        } else if (action === "unread") {
          markMessageUnread(db, id, at, viewer);
          count += 1;
        } else if (action === "star") {
          setMessageStarred(db, id, true, at, viewer);
          count += 1;
        } else if (action === "unstar") {
          setMessageStarred(db, id, false, at, viewer);
          count += 1;
        } else if (action === "trash") {
          trashMessage(db, id, at, viewer);
          count += 1;
        } else if (action === "restore") {
          restoreMessage(db, id, at, viewer);
          count += 1;
        } else if (action === "delete") {
          if (viewer.role === "member") {
            softDeleteMemberMessage(db, viewer.userId, id, at);
            count += 1;
          } else {
            const purged = deleteMessage(db, id, at);
            if (purged) {
              unlinkPaths.push(...purged.paths);
              count += 1;
            }
          }
        } else if (action === "label" && label) {
          applyLabelUpdate(db, message, label, actorOf(request), at, viewer);
          count += 1;
        }
      }
    })();

    if (unlinkPaths.length > 0) {
      const failed = await removeStoredFiles(config.mailDataDir, unlinkPaths);
      if (failed.length > 0) request.log.warn({ failed: failed.length }, "stored files left on disk");
    }

    writeAudit(db, {
      id: ulid(),
      at,
      actor: actorOf(request),
      action: `batch_${action}`,
      detail: `count=${count}`,
    });
    return reply.send({ ok: true, count });
  });

  app.get("/v1/messages/:id", async (request) => toDetail(db, messageId(request), viewerOf(request)));

  app.get("/v1/messages/:id/thread", async (request) => {
    const id = messageId(request);
    const letters = listThread(db, id, viewerOf(request));
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
    const message = requireMessage(db, messageId(request), viewerOf(request));
    const parsed = parseJson(message.parsed);
    const text =
      parsed && typeof parsed === "object" && "text" in parsed && typeof parsed.text === "string" ? parsed.text : null;
    if (text === null) throw new HttpError(404, "not_found");
    return { text };
  });

  app.get("/v1/messages/:id/html", async (request) => {
    const message = requireMessage(db, messageId(request), viewerOf(request));
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
    const message = requireMessage(db, messageId(request), viewerOf(request));
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
    const message = requireMessage(db, messageId(request), viewerOf(request));
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
    const viewer = viewerOf(request);
    requireMessage(db, id, viewer);
    const at = now();
    if (viewer.role === "member") {
      db.prepare("UPDATE user_message_state SET label_override = NULL, updated_at = ? WHERE user_id = ? AND message_id = ?").run(
        at,
        viewer.userId,
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
      db.prepare("UPDATE jobs SET payload = ?, updated_at = ? WHERE id = ?").run(
        JSON.stringify({ force: true }),
        at,
        queued.id,
      );
    } else {
      enqueueJob(db, { id: ulid(), type: "classify", messageId: id, payload: { force: true }, now: at });
    }
    writeAudit(db, { id: ulid(), at, actor: actorOf(request), action: "reclassify", target: id });
    return reply.code(202).send({ queued: true });
  });

  const labelOverrideBody = z.object({
    label: z.enum(["phish", "malware", "spam", "unsolicited-admin", "legit", "gray"]),
  }).strict();

  app.patch("/v1/messages/:id/label", async (request, reply) => {
    const id = messageId(request);
    const viewer = viewerOf(request);
    const message = requireMessage(db, id, viewer);
    const body = labelOverrideBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);

    const at = now();
    const outcome = applyLabelUpdate(db, message, body.data.label, actorOf(request), at, viewer);

    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: actorOf(request),
      action: "override_label",
      target: id,
      detail: `from=${outcome.prevLabel},to=${body.data.label}`,
    });

    return reply.send({
      ok: true,
      id,
      label: body.data.label,
      originalLabel: outcome.originalLabel,
      originalConfidence: outcome.originalConfidence,
    });
  });

  app.post("/v1/messages/:id/read", async (request, reply) => {
    const id = messageId(request);
    const viewer = viewerOf(request);
    requireMessage(db, id, viewer);
    markMessageRead(db, id, now(), viewer);
    return reply.send({ ok: true });
  });

  app.post("/v1/messages/:id/unread", async (request, reply) => {
    const id = messageId(request);
    const viewer = viewerOf(request);
    requireMessage(db, id, viewer);
    markMessageUnread(db, id, now(), viewer);
    return reply.send({ ok: true, id, read: false });
  });

  app.post("/v1/messages/:id/star", async (request, reply) => {
    const id = messageId(request);
    const viewer = viewerOf(request);
    const message = requireMessage(db, id, viewer);
    const parsed = starBody.safeParse(request.body ?? {});
    const nextStarred = parsed.success ? parsed.data.starred : message.starred_at == null;
    setMessageStarred(db, id, nextStarred, now(), viewer);
    return reply.send({ ok: true, id, starred: nextStarred });
  });

  app.post("/v1/messages/:id/trash", async (request, reply) => {
    const id = messageId(request);
    const viewer = viewerOf(request);
    requireMessage(db, id, viewer);
    trashMessage(db, id, now(), viewer);
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: actorOf(request),
      action: "trash",
      target: id,
    });
    return reply.send({ ok: true, id, trashed: true });
  });

  app.post("/v1/messages/:id/block", async (request, reply) => {
    const id = messageId(request);
    const viewer = viewerOf(request);
    const message = requireMessage(db, id, viewer);
    const sender = message.from_addr || message.envelope_from;
    if (!sender) throw new HttpError(400);
    let blockedSenders: string[];
    try {
      if (viewer.role === "member") {
        const current = readUserBlockedSenders(db, viewer.userId);
        blockedSenders = saveUserBlockedSenders(db, viewer.userId, current.concat(sender), now());
      } else {
        blockedSenders = saveBlockedSenders(db, readBlockedSenders(db).concat(sender), now());
      }
    } catch (err) {
      if (err instanceof SettingsError) throw new HttpError(400);
      throw err;
    }
    trashMessage(db, id, now(), viewer);
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: actorOf(request),
      action: "block_sender",
      target: id,
      detail: sender,
    });
    return reply.send({ ok: true, id, blockedSenders, trashed: true });
  });

  app.post("/v1/messages/:id/restore", async (request, reply) => {
    const id = messageId(request);
    const viewer = viewerOf(request);
    requireMessage(db, id, viewer);
    restoreMessage(db, id, now(), viewer);
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: actorOf(request),
      action: "restore",
      target: id,
    });
    return reply.send({ ok: true, id, trashed: false });
  });

  app.delete("/v1/messages/:id", async (request, reply) => {
    const id = messageId(request);
    const viewer = viewerOf(request);
    requireMessage(db, id, viewer);
    if (viewer.role === "member") {
      softDeleteMemberMessage(db, viewer.userId, id, now());
      writeAudit(db, {
        id: ulid(),
        at: now(),
        actor: actorOf(request),
        action: "member_delete",
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
      actor: actorOf(request),
      action: "delete",
      target: id,
    });
    return reply.send({ ok: true, id, deleted: true });
  });

  app.post("/v1/messages/empty-trash", async (request, reply) => {
    const viewer = viewerOf(request);
    if (viewer.role === "member") {
      const count = emptyMemberTrash(db, viewer.userId, now());
      writeAudit(db, {
        id: ulid(),
        at: now(),
        actor: actorOf(request),
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
      actor: actorOf(request),
      action: "empty_trash",
      detail: `count=${count}`,
    });
    return reply.send({ ok: true, count });
  });

  app.get("/v1/trash/count", async (request) => ({ count: countTrash(db, viewerOf(request)) }));

  app.get("/v1/attachments/:sha256", async (request, reply) => {
    const sha = attachmentId(request);
    const viewer = viewerOf(request);
    if (viewer.role === "member" && !canMemberViewAttachment(db, viewer.userId, sha)) {
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

  // --- Admin-only Operations: Jobs / DLQ, Prompts, Global Settings, DKIM, Users & Audit ---

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
      actor: actorOf(request),
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
    writeAudit(db, { id: ulid(), at: now(), actor: actorOf(request), action: "retry_job", target: id });
    return reply.send({ ok: true, retried: id });
  });

  app.post("/v1/jobs/:id/dismiss", async (request, reply) => {
    requireAdmin(request);
    const params = request.params as Record<string, string>;
    const id = params.id;
    if (!id) throw new HttpError(400);
    const ok = dismissJob(db, id, now());
    if (!ok) throw new HttpError(404, "not_found");
    writeAudit(db, { id: ulid(), at: now(), actor: actorOf(request), action: "dismiss_job", target: id });
    return reply.send({ ok: true, dismissed: id });
  });

  app.post("/v1/jobs/retry-all", async (request, reply) => {
    requireAdmin(request);
    const count = retryAllDeadJobs(db, now());
    writeAudit(db, { id: ulid(), at: now(), actor: actorOf(request), action: "retry_all_dead", detail: `count=${count}` });
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
    writeAudit(db, { id: ulid(), at: now(), actor: actorOf(request), action: "prompt_update", target: id });
    return reply.send({ ok: true, id });
  });

  app.get("/v1/ai/status", async (request) => {
    requireAdmin(request);
    return aiStatus(db, config);
  });

  app.post("/v1/settings/ai/test-key", { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } }, async (request, reply) => {
    requireAdmin(request);
    const body = aiProbeBody.safeParse(request.body ?? {});
    if (!body.success) throw new HttpError(400);
    const result = await probeAiKey(db, config, body.data, options.probeFetch ?? fetch);
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: actorOf(request),
      action: "ai_probe_key",
      detail: `ok=${result.ok} model=${result.model} ms=${result.latencyMs}`,
    });
    return reply.send(result);
  });

  app.get("/v1/settings", async (request) => {
    const principal = requirePrincipal(request);
    const runtime = readRuntimeSettings(db, {
      notifyLabels: config.notifyLabels,
      notifyMinConfidence: config.notifyMinConfidence,
      acceptDomains: config.acceptDomains,
    });
    if (principal.role === "member") {
      const allocs = listUserAllocations(db, principal.id).map(presentAllocation);
      const memberDomains = [...new Set(allocs.map((a) => a.domain))];
      const domainNames: Record<string, string> = {};
      for (const domain of memberDomains) {
        if (runtime.domainNames[domain]) domainNames[domain] = runtime.domainNames[domain]!;
      }
      return {
        panelTitle: runtime.panelTitle,
        labelNames: runtime.labelNames,
        domainNames,
        senderNames: readUserSenderNames(db, principal.id),
        acceptDomains: memberDomains,
        blockedSenders: readUserBlockedSenders(db, principal.id),
        passwordSet: true,
        role: "member",
        allocations: allocs,
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
      passwordSet: principal.isOwner ? readPasswordHash(db) !== null : true,
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
      actor: actorOf(request),
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
    const principal = requirePrincipal(request);
    const body = blocklistBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    let blockedSenders: string[];
    try {
      if (principal.role === "member") {
        blockedSenders = saveUserBlockedSenders(db, principal.id, body.data.addresses, now());
      } else {
        blockedSenders = saveBlockedSenders(db, body.data.addresses, now());
      }
    } catch (err) {
      if (err instanceof SettingsError) throw new HttpError(400);
      throw err;
    }
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: actorOf(request),
      action: "settings_blocklist",
      detail: `count=${blockedSenders.length}`,
    });
    return reply.send({ ok: true, blockedSenders });
  });

  app.put("/v1/settings/password", async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = passwordBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    if (body.data.next === "admin") throw new HttpError(400);

    if (principal.isOwner) {
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
    } else {
      const userRow = getUserById(db, principal.id);
      if (!userRow || !passwordMatches(body.data.current, userRow.password_hash)) {
        throw new HttpError(401, "unauthorized");
      }
      try {
        updateUserPassword(db, principal.id, body.data.next, now());
      } catch (err) {
        if (err instanceof UserError) throw new HttpError(400);
        throw err;
      }
    }

    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: actorOf(request),
      action: "password_change",
    });
    return reply.send({ ok: true });
  });

  app.get("/v1/logs", async (request) => {
    requireAdmin(request);
    return { lines: recentLogs().map(redactLogLine) };
  });

  app.get("/v1/audit", async (request) => {
    requireAdmin(request);
    const query = request.query as Record<string, unknown>;
    const actor = optionalString(query.actor);
    const action = optionalString(query.action);
    const limitRaw = optionalString(query.limit);
    let limit = 80;
    if (limitRaw !== undefined) {
      if (!/^\d+$/.test(limitRaw)) throw new HttpError(400);
      limit = Number(limitRaw);
    }
    return {
      items: listAuditLogs(db, { limit, actor, action }).map((row) => ({
        id: row.id,
        at: iso(row.at),
        actor: row.actor,
        action: row.action,
        target: row.target,
        detail: row.detail ? redactLogLine(row.detail) : null,
      })),
    };
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
      actor: actorOf(request),
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
      actor: actorOf(request),
      action: "settings_domains",
      detail: domains.join(","),
    });
    return reply.send({ ok: true, acceptDomains: domains });
  });

  app.get("/v1/dkim", async (request) => {
    const principal = requirePrincipal(request);
    const all = listDkimPublic(db);
    if (principal.role === "member") {
      const allowedDomains = new Set(listUserAllocations(db, principal.id).map((a) => a.domain));
      return {
        items: all
          .filter((item) => allowedDomains.has(item.domain))
          .map((item) => ({
            domain: item.domain,
            selector: item.selector,
            algorithm: item.algorithm,
            dnsName: item.dnsName,
            createdAt: item.createdAt,
          })),
      };
    }
    return { items: all };
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
      actor: actorOf(request),
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
      actor: actorOf(request),
      action: "dkim_remove",
      target: `${body.data.selector}._domainkey.${body.data.domain}`,
    });
    return reply.send({ ok: true });
  });

  // --- Multi-User & Allocation Management Endpoints (Admin Only) ---

  app.get("/v1/users", async (request) => {
    requireAdmin(request);
    const runtime = readRuntimeSettings(db, {
      notifyLabels: config.notifyLabels,
      notifyMinConfidence: config.notifyMinConfidence,
      acceptDomains: config.acceptDomains,
    });
    return {
      items: listUsersWithStats(db, config.apiUsername, runtime.acceptDomains, now()).map(presentUserSummary),
    };
  });

  app.post("/v1/users", async (request, reply) => {
    requireAdmin(request);
    const body = createUserBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    try {
      const created = createUser(db, config.apiUsername, body.data, now());
      writeAudit(db, {
        id: ulid(),
        at: now(),
        actor: actorOf(request),
        action: "user_create",
        target: created.username,
        detail: `role=${created.role} allocs=${created.allocations.length}`,
      });
      return reply.code(201).send({ ok: true, user: presentUserSummary(created) });
    } catch (err) {
      throw mapUserError(err);
    }
  });

  app.patch("/v1/users/:id", async (request, reply) => {
    const admin = requireAdmin(request);
    const targetId = userIdParam(request);
    const body = updateUserBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    if (targetId === admin.id && (body.data.status === "disabled" || body.data.role === "member")) {
      throw new HttpError(400);
    }
    try {
      const updated = updateUser(db, targetId, body.data, now());
      if (body.data.status === "disabled" || body.data.role !== undefined) {
        clearUserSessions(db, { userId: updated.id, username: updated.username });
      }
      writeAudit(db, {
        id: ulid(),
        at: now(),
        actor: actorOf(request),
        action: "user_update",
        target: updated.username,
        detail: `role=${updated.role} status=${updated.status} quota=${updated.quotaSendDay}`,
      });
      return reply.send({ ok: true, user: presentUserSummary(updated) });
    } catch (err) {
      throw mapUserError(err);
    }
  });

  app.put("/v1/users/:id/password", async (request, reply) => {
    requireAdmin(request);
    const targetId = userIdParam(request);
    const body = adminResetPasswordBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    try {
      const updated = updateUserPassword(db, targetId, body.data.password, now());
      clearUserSessions(db, { userId: updated.id, username: updated.username });
      writeAudit(db, {
        id: ulid(),
        at: now(),
        actor: actorOf(request),
        action: "user_password_reset",
        target: updated.username,
      });
      return reply.send({ ok: true });
    } catch (err) {
      throw mapUserError(err);
    }
  });

  app.delete("/v1/users/:id", async (request, reply) => {
    const admin = requireAdmin(request);
    const targetId = userIdParam(request);
    if (targetId === admin.id) throw new HttpError(400);
    try {
      const removed = deleteUser(db, targetId);
      clearUserSessions(db, { userId: removed.id, username: removed.username });
      writeAudit(db, {
        id: ulid(),
        at: now(),
        actor: actorOf(request),
        action: "user_delete",
        target: removed.username,
      });
      return reply.send({ ok: true, deleted: removed.id });
    } catch (err) {
      throw mapUserError(err);
    }
  });

  app.post("/v1/users/:id/allocations", async (request, reply) => {
    requireAdmin(request);
    const targetId = userIdParam(request);
    const body = allocationInputSchema.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    try {
      const alloc = addUserAllocation(db, targetId, body.data, now());
      writeAudit(db, {
        id: ulid(),
        at: now(),
        actor: actorOf(request),
        action: "user_alloc_add",
        target: targetId,
        detail: `${alloc.pattern} send=${alloc.canSend ? 1 : 0}`,
      });
      return reply.code(201).send({ ok: true, allocation: presentAllocIso(alloc) });
    } catch (err) {
      throw mapUserError(err);
    }
  });

  app.patch("/v1/users/:id/allocations/:allocId", async (request, reply) => {
    requireAdmin(request);
    const targetId = userIdParam(request);
    const allocId = allocIdParam(request);
    const body = updateAllocBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    try {
      const alloc = updateUserAllocation(db, targetId, allocId, body.data.canSend);
      writeAudit(db, {
        id: ulid(),
        at: now(),
        actor: actorOf(request),
        action: "user_alloc_update",
        target: targetId,
        detail: `${alloc.pattern} send=${alloc.canSend ? 1 : 0}`,
      });
      return reply.send({ ok: true, allocation: presentAllocIso(alloc) });
    } catch (err) {
      throw mapUserError(err);
    }
  });

  app.delete("/v1/users/:id/allocations/:allocId", async (request, reply) => {
    requireAdmin(request);
    const targetId = userIdParam(request);
    const allocId = allocIdParam(request);
    const removed = removeUserAllocation(db, targetId, allocId);
    if (!removed) throw new HttpError(404, "not_found");
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: actorOf(request),
      action: "user_alloc_remove",
      target: targetId,
      detail: allocId,
    });
    return reply.send({ ok: true });
  });

  // --- Outbox & Sending (Scoped per Member, Global for Admin) ---

  app.get("/v1/outbox", async (request) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const limitRaw = optionalString(query.limit);
    const memberFilter = principal.role === "admin" ? optionalString(query.userId) : undefined;
    let limit = 30;
    if (limitRaw !== undefined) {
      if (!/^\d+$/.test(limitRaw)) throw new HttpError(400);
      limit = Number(limitRaw);
      if (limit < 1 || limit > 100) throw new HttpError(400);
    }
    return { items: listOutbox(db, limit, viewerOf(request), memberFilter).map(presentOutbox) };
  });

  app.get("/v1/outbox/:id/raw", async (request, reply) => {
    const row = getOutbox(db, messageId(request), viewerOf(request));
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
    const row = getOutbox(db, messageId(request), viewerOf(request));
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
    const row = getOutbox(db, id, viewerOf(request));
    if (!row) throw new HttpError(404, "not_found");
    const ok = retryOutboxJob(db, id, now());
    if (!ok) throw new HttpError(404, "not_found");
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: actorOf(request),
      action: "send_retry",
      target: id,
    });
    return reply.send({ ok: true });
  });

  app.post("/v1/outbox", { config: { rateLimit: { max: 30, timeWindow: "10 minutes" } } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = sendBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);

    const normalizedFrom = normalizeAddress(body.data.from);
    if (!normalizedFrom) throw new HttpError(400);

    if (principal.role === "member") {
      if (!canMemberUseAddress(db, principal.id, normalizedFrom, true)) {
        throw new HttpError(403, "forbidden");
      }
      const sent24h = countUserSentSince(db, principal.id, now() - 86_400_000);
      if (sent24h >= principal.quotaSendDay) {
        throw new HttpError(429, "rate_limited");
      }
    }

    try {
      const at = normalizedFrom.lastIndexOf("@");
      const history =
        at > 0 ? findMailboxHistory(db, normalizedFrom.slice(at + 1), normalizedFrom.slice(0, at)) : undefined;
      const fromName = history?.display_name ?? principal.displayName ?? undefined;
      const queued = await submitOutbox(
        { db, dataDir: config.mailDataDir, codec, acceptDomains: config.acceptDomains, now },
        {
          ...body.data,
          fromName,
          userId: principal.id,
        },
      );
      writeAudit(db, {
        id: ulid(),
        at: now(),
        actor: actorOf(request),
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
      actor: actorOf(request),
      action: "settings_jobs",
      detail: `maxAttempts=${maxAttempts}`,
    });
    return reply.send({ ok: true, jobMaxAttempts: maxAttempts });
  });

  app.put("/v1/settings/names", async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = nameSettingsBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);

    if (principal.role === "member") {
      try {
        const senderNames = saveUserSenderNames(db, principal.id, body.data.senderNames, now());
        const runtime = readRuntimeSettings(db, {
          notifyLabels: config.notifyLabels,
          notifyMinConfidence: config.notifyMinConfidence,
          acceptDomains: config.acceptDomains,
        });
        writeAudit(db, {
          id: ulid(),
          at: now(),
          actor: actorOf(request),
          action: "member_settings_names",
          detail: `senders=${senderNames.length}`,
        });
        return reply.send({
          ok: true,
          panelTitle: runtime.panelTitle,
          labelNames: runtime.labelNames,
          domainNames: {},
          senderNames,
        });
      } catch (err) {
        if (err instanceof SettingsError) throw new HttpError(400);
        throw err;
      }
    }

    if (!body.data.panelTitle) throw new HttpError(400);
    let saved;
    try {
      saved = saveNameSettings(
        db,
        {
          panelTitle: body.data.panelTitle,
          labelNames: body.data.labelNames ?? {},
          domainNames: body.data.domainNames ?? {},
          senderNames: body.data.senderNames,
        },
        now(),
      );
    } catch (err) {
      if (err instanceof SettingsError || err instanceof ConfigError) throw new HttpError(400);
      throw err;
    }
    writeAudit(db, {
      id: ulid(),
      at: now(),
      actor: actorOf(request),
      action: "settings_names",
      detail: saved.panelTitle,
    });
    return reply.send({ ok: true, ...saved });
  });

  app.get("/v1/stats", async (request) => {
    const viewer = viewerOf(request);
    const start = utcDayStart(now());
    return {
      today: countLabels(db, start, viewer),
      total: countLabels(db, null, viewer),
      daily: dailySeries(db, start - 13 * 86_400_000, 14, viewer),
    };
  });

  app.get("/v1/mailbox-history", async (request) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const domain = optionalString(query.domain);
    const localpart = optionalString(query.localpart);
    const rows = listMailboxHistory(db, {
      domain: domain?.toLowerCase(),
      localpart: localpart?.toLowerCase(),
    });
    if (principal.role === "member") {
      const allocs = listUserAllocations(db, principal.id);
      return {
        items: rows
          .filter((row) => allocs.some((a) => allocationMatchesAddress(a, `${row.localpart}@${row.domain}`)))
          .map(toHistory),
      };
    }
    return {
      items: rows.map(toHistory),
    };
  });

  app.post("/v1/mailbox-history", async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = historyBody.safeParse(request.body);
    if (!body.success) throw new HttpError(400);
    const domain = body.data.domain.trim().toLowerCase().replace(/\.$/, "");
    const localpart = body.data.localpart.trim().toLowerCase();
    if (!DOMAIN_RE.test(domain) || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/.test(localpart)) {
      throw new HttpError(400);
    }
    const fullAddress = `${localpart}@${domain}`;
    if (principal.role === "member" && !canMemberUseAddress(db, principal.id, fullAddress, false)) {
      throw new HttpError(403, "forbidden");
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
      actor: actorOf(request),
      action: "mailbox_history_upsert",
      target: fullAddress,
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

function requirePrincipal(request: FastifyRequest): SessionPrincipal {
  if (!request.principal) throw new HttpError(401, "unauthorized");
  return request.principal;
}

function requireAdmin(request: FastifyRequest): SessionPrincipal {
  const principal = requirePrincipal(request);
  if (principal.role !== "admin") throw new HttpError(403, "forbidden");
  return principal;
}

function viewerOf(request: FastifyRequest): ViewerScope {
  const principal = requirePrincipal(request);
  return { userId: principal.id, role: principal.role };
}

function actorOf(request: FastifyRequest): string {
  return request.principal?.username ?? request.session.user ?? "unknown";
}

function mapUserError(err: unknown): Error {
  if (err instanceof UserError) {
    if (err.code === "not_found") return new HttpError(404, "not_found");
    if (err.code === "forbidden") return new HttpError(403, "forbidden");
    return new HttpError(400, "bad_request");
  }
  return err instanceof Error ? err : new Error("user error");
}

function presentAllocIso(alloc: ReturnType<typeof presentAllocation>) {
  return {
    id: alloc.id,
    localpart: alloc.localpart,
    domain: alloc.domain,
    pattern: alloc.pattern,
    kind: alloc.kind,
    canSend: alloc.canSend,
    createdAt: alloc.createdAt ? iso(alloc.createdAt) : null,
  };
}

function presentUserSummary(u: ReturnType<typeof listUsersWithStats>[number]) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    status: u.status,
    isOwner: u.isOwner,
    quotaSendDay: u.quotaSendDay,
    sentLast24h: u.sentLast24h,
    messageCount: u.messageCount,
    unreadCount: u.unreadCount,
    notes: u.notes,
    createdAt: u.createdAt ? iso(u.createdAt) : null,
    lastLoginAt: u.lastLoginAt ? iso(u.lastLoginAt) : null,
    allocations: u.allocations.map(presentAllocIso),
  };
}

function applyLabelUpdate(
  db: Db,
  message: NonNullable<ReturnType<typeof getMessageForViewer>>,
  nextLabel: Label,
  actor: string,
  at: number,
  viewer: ViewerScope,
): { prevLabel: string; originalLabel: string | null; originalConfidence: number | null } {
  const existingAi = parseJson(message.ai_result) as Record<string, unknown> | null;
  const origLabel =
    existingAi && typeof existingAi === "object" && typeof existingAi.originalLabel === "string"
      ? existingAi.originalLabel
      : existingAi && typeof existingAi === "object" && typeof existingAi.label === "string"
        ? existingAi.label
        : null;
  const origConf =
    existingAi && typeof existingAi === "object" && typeof existingAi.originalConfidence === "number"
      ? existingAi.originalConfidence
      : existingAi && typeof existingAi === "object" && typeof existingAi.confidence === "number"
        ? existingAi.confidence
        : null;

  if (viewer.role === "member") {
    const prevLabel = message.label_override ?? (existingAi && typeof existingAi.label === "string" ? existingAi.label : "none");
    setMemberLabelOverride(db, viewer.userId, message.id, nextLabel, at);
    return { prevLabel, originalLabel: origLabel, originalConfidence: origConf };
  }

  const ai: Record<string, unknown> =
    existingAi && typeof existingAi === "object" && !Array.isArray(existingAi) ? { ...existingAi } : {};

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
  ai.label = nextLabel;
  ai.manualOverride = true;
  ai.overrideActor = actor;
  ai.overrideAt = at;

  const updatedJson = JSON.stringify(ai);
  db.prepare("UPDATE messages SET ai_result = ?, status = 'classified', updated_at = ? WHERE id = ?").run(
    updatedJson,
    at,
    message.id,
  );

  return {
    prevLabel,
    originalLabel: typeof ai.originalLabel === "string" ? ai.originalLabel : null,
    originalConfidence: typeof ai.originalConfidence === "number" ? ai.originalConfidence : null,
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
  const fallbackModel = config.classifier === "gemini" ? config.geminiModel : (config.openaiModel ?? "");
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
    userId: row.user_id ?? null,
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

function userIdParam(request: FastifyRequest): string {
  const id = (request.params as { id?: unknown }).id;
  if (typeof id !== "string" || !/^[\w:-]+$/.test(id)) throw new HttpError(404, "not_found");
  return id;
}

function allocIdParam(request: FastifyRequest): string {
  const id = (request.params as { allocId?: unknown }).allocId;
  if (typeof id !== "string" || !/^[\w:-]+$/.test(id)) throw new HttpError(404, "not_found");
  return id;
}

function attachmentId(request: FastifyRequest): string {
  const sha = (request.params as { sha256?: unknown }).sha256;
  if (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) throw new HttpError(404, "not_found");
  return sha;
}

function requireMessage(db: Db, id: string, viewer: ViewerScope) {
  const message = getMessageForViewer(db, id, viewer);
  if (!message) throw new HttpError(404, "not_found");
  return message;
}

function readListQuery(
  query: unknown,
  principal: SessionPrincipal,
): {
  label?: string;
  status?: string;
  trashed?: boolean | "all";
  unread?: boolean;
  starred?: boolean;
  hasAttachments?: boolean;
  q?: string;
  from?: string;
  to?: string;
  domain?: string;
  memberId?: string;
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
  const unreadRaw = optionalString(source.unread);
  const unread = unreadRaw === "true" || unreadRaw === "1" ? true : unreadRaw === "false" || unreadRaw === "0" ? false : undefined;
  const starredRaw = optionalString(source.starred);
  const starred = starredRaw === "true" || starredRaw === "1" ? true : undefined;
  const attRaw = optionalString(source.hasAttachments);
  const hasAttachments = attRaw === "true" || attRaw === "1" ? true : undefined;

  const q = optionalString(source.q);
  const from = optionalString(source.from);
  const to = optionalString(source.to);
  const domain = optionalString(source.domain);
  const memberIdRaw = optionalString(source.memberId);
  const memberId = principal.role === "admin" && memberIdRaw && memberIdRaw !== OWNER_USER_ID ? memberIdRaw : undefined;
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
    unread,
    starred,
    hasAttachments,
    q,
    from,
    to,
    domain,
    memberId,
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
  const ai = aiSummary(row.ai_result, row.label_override);
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
    starred: row.starred_at != null,
    attachmentCount: row.attachment_count,
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

function toDetail(db: Db, id: string, viewer: ViewerScope) {
  const message = requireMessage(db, id, viewer);
  const rawAi = parseJson(message.ai_result);
  let aiResult = rawAi;
  if (viewer.role === "member" && message.label_override) {
    const base =
      rawAi && typeof rawAi === "object" && !Array.isArray(rawAi) ? { ...(rawAi as Record<string, unknown>) } : {};
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

function aiSummary(
  raw: string | null,
  memberOverride?: string | null,
): {
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
      label: memberOverride ?? null,
      confidence: null,
      summary: null,
      tags: [],
      manualOverride: Boolean(memberOverride),
      originalLabel: null,
      originalConfidence: null,
    };
  }
  const record = value as Record<string, unknown>;
  const rawLabel = typeof record.label === "string" ? record.label : null;
  if (memberOverride) {
    return {
      label: memberOverride,
      confidence: typeof record.confidence === "number" ? record.confidence : null,
      summary: typeof record.summary === "string" ? record.summary : null,
      tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === "string") : [],
      manualOverride: true,
      originalLabel: rawLabel,
      originalConfidence: typeof record.confidence === "number" ? record.confidence : null,
    };
  }
  return {
    label: rawLabel,
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
  viewer: ViewerScope,
): Array<{ day: string; total: number; labels: Record<string, number> }> {
  const rows =
    viewer.role === "member"
      ? (db
          .prepare(
            `SELECT (m.received_at / 86400000) AS day_index,
                    COALESCE(ums.label_override, json_extract(m.ai_result, '$.label'), 'unlabeled') AS label,
                    COUNT(*) AS n
             FROM messages m
             LEFT JOIN user_message_state ums ON ums.user_id = :viewerUserId AND ums.message_id = m.id
             WHERE m.received_at >= :startMs
               AND ums.deleted_at IS NULL
               AND ${memberMessageMatchSql("m", ":viewerUserId")}
             GROUP BY 1, 2`,
          )
          .all({ viewerUserId: viewer.userId, startMs }) as Array<{ day_index: number; label: string; n: number }>)
      : (db
          .prepare(
            `SELECT (received_at / 86400000) AS day_index,
                    COALESCE(json_extract(ai_result, '$.label'), 'unlabeled') AS label,
                    COUNT(*) AS n
             FROM messages
             WHERE received_at >= ?
             GROUP BY 1, 2`,
          )
          .all(startMs) as Array<{ day_index: number; label: string; n: number }>);

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

function countLabels(db: Db, since: number | null, viewer: ViewerScope): Record<string, number> {
  let rows: Array<{ label: string | null; n: number }>;
  if (viewer.role === "member") {
    const sinceSql = since === null ? "" : "AND m.received_at >= :since";
    rows = db
      .prepare(
        `SELECT COALESCE(ums.label_override, json_extract(m.ai_result, '$.label')) AS label,
                COUNT(*) AS n
         FROM messages m
         LEFT JOIN user_message_state ums ON ums.user_id = :viewerUserId AND ums.message_id = m.id
         WHERE ums.deleted_at IS NULL
           AND ${memberMessageMatchSql("m", ":viewerUserId")}
           ${sinceSql}
         GROUP BY 1`,
      )
      .all(since === null ? { viewerUserId: viewer.userId } : { viewerUserId: viewer.userId, since }) as Array<{
      label: string | null;
      n: number;
    }>;
  } else {
    rows = (
      since === null
        ? db.prepare("SELECT json_extract(ai_result, '$.label') AS label, COUNT(*) AS n FROM messages GROUP BY 1").all()
        : db
            .prepare("SELECT json_extract(ai_result, '$.label') AS label, COUNT(*) AS n FROM messages WHERE received_at >= ? GROUP BY 1")
            .all(since)
    ) as Array<{ label: string | null; n: number }>;
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
