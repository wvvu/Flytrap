// DOM 元素引用集合：ES 模块以 defer 模式执行，加载时文档树已就绪。
export const appEl = document.querySelector("#app");
export const loginEl = document.querySelector("#login");
export const loginForm = document.querySelector("#login-form");
export const loginError = document.querySelector("#login-error");
export const logoutBtn = document.querySelector("#logout");
export const themeBtn = document.querySelector("#btn-theme");
export const themeIcon = document.querySelector("#theme-icon");

export const navInboxBtn = document.querySelector("#nav-inbox");
export const navStarredBtn = document.querySelector("#nav-starred");
export const navSendBtn = document.querySelector("#nav-send");
export const navSpamBtn = document.querySelector("#nav-spam");
export const navTrashBtn = document.querySelector("#nav-trash");
export const navUsersBtn = document.querySelector("#nav-users");
export const navSettingsBtn = document.querySelector("#nav-settings");
export const navDlqBtn = document.querySelector("#nav-dlq");
export const paletteBtn = document.querySelector("#btn-palette");
export const userChipBtn = document.querySelector("#btn-user-chip");
export const userAvatarEl = document.querySelector("#user-avatar");
export const userRoleDotEl = document.querySelector("#user-role-dot");

export const badgeInbox = document.querySelector("#badge-inbox");
export const badgeStarred = document.querySelector("#badge-starred");
export const badgeSpam = document.querySelector("#badge-spam");
export const badgeDlq = document.querySelector("#badge-dlq");

export const streamTitle = document.querySelector("#stream-title");
export const streamInboxHeader = document.querySelector("#stream-inbox-header");
export const streamStarredHeader = document.querySelector("#stream-starred-header");
export const streamSendHeader = document.querySelector("#stream-send-header");
export const streamSpamHeader = document.querySelector("#stream-spam-header");
export const streamTrashHeader = document.querySelector("#stream-trash-header");
export const streamUsersHeader = document.querySelector("#stream-users-header");
export const streamDlqHeader = document.querySelector("#stream-dlq-header");
export const streamSettingsHeader = document.querySelector("#stream-settings-header");

export const filtersForm = document.querySelector("#filters");
export const mailEmptyCopy = document.querySelector("#mail-empty-copy");
export const trashQueryInput = document.querySelector("#trash-q");
export const starredQueryInput = document.querySelector("#starred-q");
export const trashRefreshBtn = document.querySelector("#btn-trash-refresh");
export const starredRefreshBtn = document.querySelector("#btn-starred-refresh");
export const emptyTrashBtn = document.querySelector("#btn-empty-trash");
export const markAllReadBtn = document.querySelector("#btn-mark-all-read");
export const spamMarkReadBtn = document.querySelector("#btn-spam-mark-read");
export const inboxScopeSelect = document.querySelector("#inbox-scope-select");

export const batchBarEl = document.querySelector("#batch-bar");
export const batchCountEl = document.querySelector("#batch-count");

export const listEl = document.querySelector("#list");
export const noticeEl = document.querySelector("#notice");
export const queryInput = document.querySelector("#q");
export const labelInput = document.querySelector("#label");
export const filterSelect = document.querySelector("#filter-select");
export const refreshBtn = document.querySelector("#btn-refresh");
export const promoBtn = document.querySelector("#btn-promo");
export const spamRefreshBtn = document.querySelector("#btn-spam-refresh");
export const dlqRefreshBtn = document.querySelector("#btn-dlq-refresh");
export const retryAllBtn = document.querySelector("#btn-retry-all");

export const viewMail = document.querySelector("#view-mail");
export const viewDlq = document.querySelector("#view-dlq");
export const viewSend = document.querySelector("#view-send");
export const viewUsers = document.querySelector("#view-users");
export const viewSettings = document.querySelector("#view-settings");

export const failureDetailEl = document.querySelector("#failure-detail");
export const dlqEmptyEl = document.querySelector("#dlq-empty");
export const dlqNoticeEl = document.querySelector("#dlq-notice");
export const mailEmptyEl = document.querySelector("#mail-empty");
export const mailLoadingEl = document.querySelector("#mail-loading");
export const mailDetailEl = document.querySelector("#mail-detail");
export const backListBtn = document.querySelector("#btn-back-list");

export const toastEl = document.querySelector("#toast");
export const confirmModal = document.querySelector("#confirm-modal");
export const confirmText = document.querySelector("#confirm-text");
export const confirmOk = document.querySelector("#confirm-ok");
export const confirmCancel = document.querySelector("#confirm-cancel");

export const btnStarDetail = document.querySelector("#btn-star-detail");
export const headerAuthStrip = document.querySelector("#header-auth-strip");
export const detailSubject = document.querySelector("#detail-subject");
export const detailFrom = document.querySelector("#detail-from");
export const detailTo = document.querySelector("#detail-to");
export const detailTime = document.querySelector("#detail-time");
export const detailVerdictSelect = document.querySelector("#detail-verdict-select");
export const detailModelVerdict = document.querySelector("#detail-model-verdict");
export const detailSummary = document.querySelector("#detail-summary");
export const otpBanner = document.querySelector("#otp-banner");
export const otpCodeText = document.querySelector("#otp-code-text");
export const btnCopyOtp = document.querySelector("#btn-copy-otp");

export const verdictBar = document.querySelector("#verdict-bar");
export const verdictPercent = document.querySelector("#verdict-percent");
export const sectionSignals = document.querySelector("#section-signals");
export const signalsCountEl = document.querySelector("#signals-count");
export const signalsList = document.querySelector("#signals-list");
export const sectionUrls = document.querySelector("#section-urls");
export const sectionAttachments = document.querySelector("#section-attachments");
export const urlCountEl = document.querySelector("#url-count");
export const urlsList = document.querySelector("#urls-list");
export const attachmentsList = document.querySelector("#attachments-list");
export const attachmentCountEl = document.querySelector("#attachment-count");

export const sandboxWrap = document.querySelector("#sandbox-wrap");
export const mailSandbox = document.querySelector("#mail-sandbox");
export const plainTextBody = document.querySelector("#plain-text-body");
export const rawHeaders = document.querySelector("#raw-headers");
export const authChips = document.querySelector("#auth-chips");

export const btnTrashMail = document.querySelector("#btn-trash-mail");
export const btnReply = document.querySelector("#btn-reply");
export const btnReplyAll = document.querySelector("#btn-reply-all");
export const btnForward = document.querySelector("#btn-forward");
export const btnToggleUnread = document.querySelector("#btn-toggle-unread");
export const btnExpandReader = document.querySelector("#btn-expand-reader");
export const threadBox = document.querySelector("#thread-box");
export const threadList = document.querySelector("#thread-list");
export const btnBlockMail = document.querySelector("#btn-block-mail");
export const btnRestoreMail = document.querySelector("#btn-restore-mail");
export const btnDeleteMail = document.querySelector("#btn-delete-mail");
export const btnReclassify = document.querySelector("#btn-reclassify");
export const btnDownloadEml = document.querySelector("#btn-download-eml");
export const btnLoadImages = document.querySelector("#btn-load-images");

export const resetModal = document.querySelector("#reset-modal");
export const resetCodeStep = document.querySelector("#reset-code-step");
export const resetPasswordStep = document.querySelector("#reset-password-step");
export const resetError = document.querySelector("#reset-error");
export const resetDigits = [...document.querySelectorAll("#reset-digits input")];
export const btnResetResend = document.querySelector("#btn-reset-resend");

export const paletteModal = document.querySelector("#palette-modal");
export const paletteInput = document.querySelector("#palette-input");
export const paletteList = document.querySelector("#palette-list");
export const shortcutsModal = document.querySelector("#shortcuts-modal");
