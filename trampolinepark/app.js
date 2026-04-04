const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyCypfI4iSfTdTZWBAm1p4OO2MfzHH4zjNU",
  authDomain:        "gemsprout1.firebaseapp.com",
  projectId:         "gemsprout1",
  storageBucket:     "gemsprout1.firebasestorage.app",
  messagingSenderId: "493782739457",
  appId:             "1:493782739457:web:64d2afa5766ee1b481ee00",
  measurementId:     "G-1WDH5Q2STT",
};

const TEST_BUILD_LABEL = 'Test v1.2';

const FAMILY_CODE_KEY   = 'gemsprout.familyCode';
const FAMILY_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/I/1

function genFamilyCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += FAMILY_CODE_CHARS[Math.floor(Math.random() * FAMILY_CODE_CHARS.length)];
  return code;
}

async function genUniqueFamilyCode() {
  let code, attempts = 0;
  do {
    code = genFamilyCode();
    try {
      const snap = await db.doc(`families/${code}`).get();
      if (!snap.exists) break;
    } catch (_) {
      break;
    }
  } while (++attempts < 10);
  return code;
}

function getFamilyCode() {
  try { return localStorage.getItem(FAMILY_CODE_KEY) || ''; } catch (_) { return ''; }
}

function setFamilyCode(code) {
  try { localStorage.setItem(FAMILY_CODE_KEY, code); } catch (_) {}
}

function applyTestBuildBadge() {
  const badge = document.getElementById('test-build-badge');
  if (badge) badge.textContent = TEST_BUILD_LABEL;
}

function getFamilyDoc() {
  let code = getFamilyCode();
  if (!code) { code = genFamilyCode(); setFamilyCode(code); }
  return `families/${code}`;
}

firebase.initializeApp(FIREBASE_CONFIG);
const auth    = firebase.auth();
const db      = firebase.firestore();
const storage = firebase.storage();
async function initPushNotifications(firebaseUser) {
  if (!isNative()) return; // push notifications only on device, not in browser
  try {
    const { FirebaseMessaging } = Capacitor.Plugins;
    if (!FirebaseMessaging) return;
    const permResult = await FirebaseMessaging.requestPermissions();
    if (permResult.receive !== 'granted') return;
    const tokenResult = await FirebaseMessaging.getToken();
    const token = tokenResult?.token;
    if (!token || !firebaseUser?.uid) return;
    await db.doc(`users/${firebaseUser.uid}`).set(
      { fcmTokens: firebase.firestore.FieldValue.arrayUnion(token) },
      { merge: true }
    );
    // Refresh token if it changes
    FirebaseMessaging.addListener('tokenReceived', async (event) => {
      if (!event?.token || !firebaseUser?.uid) return;
      await db.doc(`users/${firebaseUser.uid}`).set(
        { fcmTokens: firebase.firestore.FieldValue.arrayUnion(event.token) },
        { merge: true }
      ).catch(() => {});
    });
    // Foreground message: re-render immediately so the pending row appears without a tab switch
    FirebaseMessaging.addListener('notificationReceived', (event) => {
      const t = event?.notification?.data?.type;
      if ((t === 'approval_request' || t === 'spend_request') && S.currentUser?.role === 'parent') {
        renderCurrentView();
      }
    });
    // Notification tap: navigate to the overview tab (PIN gate handled separately)
    FirebaseMessaging.addListener('notificationActionPerformed', (event) => {
      const t = event?.notification?.data?.type;
      if (t === 'approval_request' || t === 'spend_request') {
        _handleApprovalNotificationTap();
      }
    });
    // Schedule interest day local notification now that permissions are confirmed
    scheduleInterestDayNotification();
  } catch(e) {
    console.warn('initPushNotifications error:', e);
  }
}

function _handleApprovalNotificationTap() {
  if (S.currentUser?.role === 'parent') {
    switchParentTab('home');
  } else if (document.getElementById('screen-pin')?.classList.contains('active')) {
    // App is at PIN gate; after successful unlock, land on overview
    S._afterPinNav = 'overview';
  }
  // Otherwise (profile picker / no session), the badge will be visible when they sign in
}

// Interest day local notification

function _getNextInterestDayDate() {
  const s = D.settings;
  const period = s.savingsInterestPeriod || 'monthly';
  const now = new Date();
  const d = new Date(now);
  d.setHours(9, 0, 0, 0);
  if (period === 'weekly') {
    const target = s.savingsInterestDay ?? 1;
    let daysUntil = (target - d.getDay() + 7) % 7;
    if (daysUntil === 0 && now >= d) daysUntil = 7;
    d.setDate(d.getDate() + daysUntil);
  } else {
    const dom = s.savingsInterestDayOfMonth || 1;
    d.setDate(dom);
    if (d <= now) { d.setMonth(d.getMonth() + 1); d.setDate(dom); }
  }
  return d;
}

async function syncAppBadge() {
  if (!isNative()) return;
  try {
    const { Badge } = Capacitor.Plugins;
    if (!Badge) return;
    const count = familyInboxCount();
    await Badge.set({ count });
  } catch(e) {}
}

async function _enableInterestDayReminder() {
  if (isNative()) {
    try {
      const { LocalNotifications } = Capacitor.Plugins;
      if (LocalNotifications) await LocalNotifications.requestPermissions().catch(() => {});
    } catch(e) {}
  }
  scheduleInterestDayNotification();
}

const RC_API_KEY     = 'appl_RquVpMOZtfpBzJLJButBHBFuolp';
const RC_ENTITLEMENT = 'pro';
let _rcPkgs         = { monthly: null, yearly: null };
let _rcSelectedPlan = 'yearly';

async function initRevenueCat() {
  if (!isNative()) { S.isPro = true; return; }
  try {
    const { Purchases } = Capacitor.Plugins;
    if (!Purchases) { S.isPro = true; return; }
    await Purchases.configure({ apiKey: RC_API_KEY, appUserID: getFamilyCode() });
    const { customerInfo } = await Purchases.getCustomerInfo();
    S.isPro = !!customerInfo.entitlements.active[RC_ENTITLEMENT];
  } catch(e) {
    console.warn('RevenueCat init error:', e);
    S.isPro = true;
  }
}

async function showPaywall() {
  showScreen('screen-auth');
  const el = document.getElementById('screen-auth');
  el.className = 'screen active';
  el.style.cssText = '';
  el.innerHTML = _paywallHTML();

  if (isNative()) {
    try {
      const { Purchases } = Capacitor.Plugins;
      if (Purchases) {
        const offerings = await Purchases.getOfferings();
        const pkgs = offerings?.current?.availablePackages || [];
        for (const pkg of pkgs) {
          if (pkg.packageType === 'MONTHLY') _rcPkgs.monthly = pkg;
          if (pkg.packageType === 'ANNUAL')  _rcPkgs.yearly  = pkg;
        }
      }
    } catch(e) {}
  }

  const mPrice = _rcPkgs.monthly?.product?.priceString || '$2.99';
  const yPrice = _rcPkgs.yearly?.product?.priceString  || '$24.99';
  const trialDays = _rcPkgs.yearly?.product?.introPrice?.periodNumberOfUnits
    || _rcPkgs.monthly?.product?.introPrice?.periodNumberOfUnits
    || 7;

  el.innerHTML = _paywallHTML(mPrice, yPrice, trialDays);
  _rcSelectPlan(_rcSelectedPlan); // apply selected state
}

function _paywallHTML(mPrice = '...', yPrice = '...', trialDays = 7) {
  const selPlan = _rcSelectedPlan;
  const mSel = selPlan === 'monthly';
  const ySel = selPlan === 'yearly';
  const cardBase = 'border-radius:14px;padding:14px 16px;cursor:pointer;transition:border 0.15s;';
  const mCard = cardBase + `border:2px solid ${mSel ? '#fff' : 'rgba(255,255,255,0.25)'};background:rgba(255,255,255,${mSel ? '0.15' : '0.07'})`;
  const yCard = cardBase + `border:2px solid ${ySel ? '#fff' : 'rgba(255,255,255,0.25)'};background:rgba(255,255,255,${ySel ? '0.15' : '0.07'})`;
  return `
  <div style="display:flex;flex-direction:column;height:100%;min-height:100vh;background:linear-gradient(160deg,#1a0533 0%,#3b1278 55%,#6C63FF 100%);overflow:auto">
    <div style="position:relative;text-align:center;padding:calc(env(safe-area-inset-top,20px) + 36px) 24px 20px">
      <button onclick="renderHome()" style="position:absolute;top:calc(env(safe-area-inset-top,20px) + 8px);left:16px;background:none;border:none;color:rgba(255,255,255,0.55);font-size:1.5rem;cursor:pointer;padding:4px;line-height:1"><i class="ph-duotone ph-x"></i></button>
      <img src="gemsproutpadded.png" style="width:76px;height:76px;border-radius:18px;box-shadow:0 8px 24px rgba(0,0,0,0.35)">
      <div style="color:#fff;font-size:1.75rem;font-weight:800;margin-top:14px;letter-spacing:-0.02em">GemSprout Pro</div>
      <div style="color:rgba(255,255,255,0.65);font-size:0.95rem;margin-top:6px">Family rhythms, savings, and growth across one home or two</div>
    </div>

    <div style="padding:0 24px;display:flex;flex-direction:column;gap:10px">
      ${[
        ['ph-check-circle','Daily rhythms with flexible parent approval and photo proof'],
        ['ph-bell-ringing','Push notifications when kids complete tasks'],
        ['ph-piggy-bank',  'Savings, matching, interest, and spend requests in one place'],
        ['ph-users',       'Built for modern families, including split-household rhythms'],
      ].map(([icon, text]) => `
        <div style="display:flex;align-items:center;gap:12px">
          <i class="ph-duotone ${icon}" style="color:#C4B5FD;font-size:1.3rem;flex-shrink:0"></i>
          <div style="color:rgba(255,255,255,0.88);font-size:0.9rem;line-height:1.4">${text}</div>
        </div>`).join('')}
    </div>

    <div style="padding:20px 24px 0;display:flex;gap:12px">
      <div id="rc-card-monthly" onclick="_rcSelectPlan('monthly')" style="${mCard};flex:1">
        <div style="color:rgba(255,255,255,0.65);font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em">Monthly</div>
        <div style="color:#fff;font-size:1.3rem;font-weight:800;margin-top:4px">${mPrice}</div>
        <div style="color:rgba(255,255,255,0.5);font-size:0.75rem;margin-top:2px">per month</div>
      </div>
      <div id="rc-card-yearly" onclick="_rcSelectPlan('yearly')" style="${yCard};flex:1;position:relative">
        <div style="position:absolute;top:-10px;left:50%;transform:translateX(-50%);background:#F97316;color:#fff;font-size:0.68rem;font-weight:800;padding:2px 10px;border-radius:999px;white-space:nowrap;text-transform:uppercase;letter-spacing:0.04em">Best Value</div>
        <div style="color:rgba(255,255,255,0.65);font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em">Yearly</div>
        <div style="color:#fff;font-size:1.3rem;font-weight:800;margin-top:4px">${yPrice}</div>
        <div style="color:rgba(255,255,255,0.5);font-size:0.75rem;margin-top:2px">per year</div>
      </div>
    </div>

    <div style="padding:20px 24px 0">
      <button onclick="rcStartTrial()" style="width:100%;padding:16px;border-radius:14px;border:none;background:#fff;color:#4C1D95;font-size:1rem;font-weight:800;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,0.25)">
        Start ${trialDays}-Day Free Trial
      </button>
      <div style="color:rgba(255,255,255,0.45);font-size:0.75rem;text-align:center;margin-top:8px;line-height:1.5">
        Free for ${trialDays} days, then auto-renews. Cancel any time in your iPhone settings.
      </div>
    </div>

    <div style="margin-top:auto;padding:20px 24px 36px;display:flex;justify-content:center;gap:20px">
      <button onclick="rcRestorePurchases()" style="background:none;border:none;color:rgba(255,255,255,0.55);font-size:0.82rem;cursor:pointer;padding:4px">Restore Purchases</button>
      <a href="privacy.html" style="color:rgba(255,255,255,0.55);font-size:0.82rem;text-decoration:none;padding:4px">Privacy</a>
    </div>
  </div>`;
}

function _rcSelectPlan(type) {
  _rcSelectedPlan = type;
  const mCard = document.getElementById('rc-card-monthly');
  const yCard = document.getElementById('rc-card-yearly');
  const cardBase = 'border-radius:14px;padding:14px 16px;cursor:pointer;transition:border 0.15s;flex:1;';
  if (mCard) mCard.style.cssText = cardBase + `border:2px solid ${type==='monthly'?'#fff':'rgba(255,255,255,0.25)'};background:rgba(255,255,255,${type==='monthly'?'0.15':'0.07'})`;
  if (yCard) yCard.style.cssText = cardBase + `border:2px solid ${type==='yearly'?'#fff':'rgba(255,255,255,0.25)'};background:rgba(255,255,255,${type==='yearly'?'0.15':'0.07'});position:relative`;
}

async function rcStartTrial() {
  if (!isNative()) return;
  const pkg = _rcSelectedPlan === 'monthly' ? _rcPkgs.monthly : _rcPkgs.yearly;
  if (!pkg) { toast('Could not load subscription options - try again'); return; }
  try {
    const { Purchases } = Capacitor.Plugins;
    const { customerInfo } = await Purchases.purchasePackage({ aPackage: pkg });
    S.isPro = !!customerInfo.entitlements.active[RC_ENTITLEMENT];
    if (S.isPro) {
      const member = getMember(getCurrentUserId());
      if (member) routeToView(member); else renderHome();
    }
  } catch(e) {
    if (!e.userCancelled) toast('Purchase failed - please try again');
  }
}

async function rcRestorePurchases() {
  if (!isNative()) return;
  try {
    showLoading();
    const { Purchases } = Capacitor.Plugins;
    const { customerInfo } = await Purchases.restorePurchases();
    S.isPro = !!customerInfo.entitlements.active[RC_ENTITLEMENT];
    if (S.isPro) {
      if (document.getElementById('settings-root')?.classList.contains('open')) {
        showScreen('screen-parent');
        renderSettings();
        toast('Subscription restored!');
        return;
      }
      const member = getMember(getCurrentUserId());
      if (member) routeToView(member); else renderHome();
    } else {
      await showPaywall();
      toast('No active subscription found');
    }
  } catch(e) {
    await showPaywall();
    toast('Restore failed - please try again');
  }
}

const APP_VERSION = '1.0';
const CHANGELOG_ENTRIES = [
  {
    version: '1.0',
    title: 'GemSprout 1.0',
    date: 'March 2026',
    items: [
      { icon: 'ph-check-circle',  color: '#16A34A', text: 'Task tracking with gem rewards' },
      { icon: 'ph-camera',        color: '#6B7280', text: 'Before & after photo proof' },
      { icon: 'ph-piggy-bank',    color: '#16A34A', text: 'Savings banking with interest' },
      { icon: 'ph-medal',         color: '#D97706', text: 'Badges, levels, and streaks' },
      { icon: 'ph-storefront',    color: '#7C3AED', text: 'Prize shop' },
      { icon: 'ph-calendar-star', color: '#7C3AED', text: 'Week in Review - celebrate your family\'s weekly wins every Sunday' },
      { icon: 'ph-sign-in',       color: '#16A34A', text: 'Sign in with Apple or Google - your family follows you to any device' },
      { icon: 'ph-house-line',    color: '#0E7490', text: 'Split household - streaks are protected on days kids are at their other home' },
    ],
  },
];
const CHANGELOG_SEEN_KEY = 'gemsprout.changelogSeen';

function showChangelog(markSeen = false) {
  if (markSeen) {
    try { localStorage.setItem(CHANGELOG_SEEN_KEY, APP_VERSION); } catch(_) {}
  }
  const entriesHtml = CHANGELOG_ENTRIES.map((entry, i) => `
    <div style="margin-bottom:${i < CHANGELOG_ENTRIES.length - 1 ? '18' : '0'}px">
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:8px">
        <span style="font-weight:800;color:#6C63FF">${entry.title}</span>
        <span style="font-size:0.78rem;color:var(--muted)">${entry.date}</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${entry.items.map(item => `
          <div style="display:flex;align-items:flex-start;gap:8px">
            <i class="ph-duotone ${item.icon}" style="color:${item.color};font-size:1rem;flex-shrink:0;margin-top:1px"></i>
            <div style="font-size:0.88rem;color:var(--text);line-height:1.4">${item.text}</div>
          </div>`).join('')}
      </div>
    </div>
    ${i < CHANGELOG_ENTRIES.length - 1 ? '<div style="height:1px;background:#F3F4F6;margin-bottom:18px"></div>' : ''}
  `).join('');
  showQuickActionModal(`
    <div style="text-align:center;margin-bottom:16px">
      <i class="ph-duotone ph-leaf" style="color:#16A34A;font-size:2.2rem"></i>
      <div class="modal-title" style="margin-top:6px">What's New in GemSprout</div>
    </div>
    ${entriesHtml}
    <div class="modal-actions" style="margin-top:16px">
      <button class="btn btn-primary" style="width:100%" onclick="closeModal()">Awesome!</button>
    </div>`);
}

function showChangelogIfNeeded() {
  try {
    const seen = localStorage.getItem(CHANGELOG_SEEN_KEY);
    if (seen === null) {
      localStorage.setItem(CHANGELOG_SEEN_KEY, APP_VERSION);
    } else if (seen !== APP_VERSION) {
      setTimeout(() => showChangelog(true), 1000);
    }
  } catch(_) {}
}

const WEEK_REVIEW_KEY = 'gemsprout.weekReviewShown';
const WEEK_REVIEW_SLIDE_MS = 10000;
const WEEK_REVIEW_PREVIEW_MODE = false;
const WEEK_REVIEW_PREVIEW_SLIDE_INDEX = 1;
const WEEK_REVIEW_PREVIEW_KID_COUNT = 0;
let _weekReviewStory = null;
let _weekReviewAudio = null;
let _weekReviewPreviewShown = false;

function _weekReviewTimingScale(kidCount) {
  const normalizedCount = Math.max(0, Math.floor(Number(kidCount) || 0));
  if (normalizedCount <= 2) return 1;
  const reductionSteps = Math.min(4, normalizedCount - 2);
  return Math.max(0.6, 1 - (reductionSteps * 0.1));
}

function _weekReviewScaledDelay(value, scale = 1) {
  const delay = Number(value) || 0;
  return Math.max(0, Number((delay * scale).toFixed(3)));
}

function _ordinalDay(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

function _formatWeekReviewDateRange(start, end, multiline = false) {
  const ms = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const sd = parseDateLocal(start);
  const ed = parseDateLocal(end);
  const startText = `${ms[sd.getMonth()]} ${_ordinalDay(sd.getDate())}`;
  const endText = `${ms[ed.getMonth()]} ${_ordinalDay(ed.getDate())}`;
  return multiline
    ? `${startText} -<br>${endText}`
    : `${startText} - ${endText}, ${ed.getFullYear()}`;
}

function _getWeekRange() {
  const todayStr = today();
  const d = parseDateLocal(todayStr);
  const dow = d.getDay();
  const end = new Date(d);
  end.setDate(d.getDate() - dow);         // back to most recent Sunday
  if (dow === 0) end.setDate(end.getDate() - 7); // on Sunday, show the last fully completed week
  const start = new Date(end);
  start.setDate(end.getDate() - 6);       // Monday before that
  return { start: formatDateLocal(start), end: formatDateLocal(end) };
}

function showWeekReviewIfNeeded() {
  const todayStr = today();
  const d = parseDateLocal(todayStr);
  if (d.getDay() !== 0) return; // only auto-show on Sunday
  try {
    if (localStorage.getItem(WEEK_REVIEW_KEY) === todayStr) return;
    localStorage.setItem(WEEK_REVIEW_KEY, todayStr);
  } catch(_) {}
  setTimeout(() => _showWeekReviewTeaser(), 1600);
}

function _showWeekReviewTeaser() {
  const kids = D.family.members.filter(m => m.role === 'kid' && !m.deleted);
  if (!kids.length) return;
  showQuickActionModal(`
    <div style="text-align:center;padding:8px 0 4px">
      <i class="ph-duotone ph-calendar-star" style="color:#7C3AED;font-size:3rem"></i>
      <div class="modal-title" style="margin-top:10px">Your Week in Review is ready!</div>
      <p style="color:var(--muted);font-size:0.88rem;line-height:1.5;margin:8px 0 20px">
        See how ${kids.length === 1 ? kids[0].name : 'your family'} did this week - gems earned, tasks completed, badges unlocked, and more.
      </p>
      <button class="btn btn-primary btn-full" onclick="closeModal();showWeekReview()">Let's see it!</button>
      <button class="btn btn-secondary btn-full" style="margin-top:8px" onclick="closeModal()">Maybe later</button>
      <div style="color:var(--muted);font-size:0.78rem;margin-top:14px">You can always find it on the Stats tab.</div>
    </div>`);
}

function showWeekReview() {
  const kids = D.family.members.filter(m => m.role === 'kid' && !m.deleted);
  if (!kids.length) return;

  const { start, end } = _getWeekRange();
  const weekHist  = (D.history || []).filter(h => h.date >= start && h.date <= end);
  const choreHist = weekHist.filter(h => h.type === 'chore' && !(h.title||'').startsWith('Streak bonus ('));
  const bonusHist = weekHist.filter(h => h.type === 'bonus');
  const badgeHist = weekHist.filter(h => h.type === 'badge');
  const savDepHist = weekHist.filter(h => h.type === 'savings_deposit');
  const savOn = D.settings.savingsEnabled !== false;
  const cur = D.settings.currency || '$';

  const totalDiamonds = choreHist.reduce((s, h) => s + (h.diamonds || 0), 0)
                      + bonusHist.reduce((s, h) => s + (h.diamonds || 0), 0);
  const totalChores = choreHist.length;
  const totalSaved  = savDepHist.reduce((s, h) => s + (h.dollars || 0), 0);
  const totalBadges = badgeHist.length;

  const choreCounts = {};
  choreHist.forEach(h => { choreCounts[h.title] = (choreCounts[h.title] || 0) + 1; });
  const topChore = Object.entries(choreCounts).sort((a, b) => b[1] - a[1])[0];

  const kidData = kids.map(kid => {
    const kChore   = choreHist.filter(h => h.memberId === kid.id);
    const kBonus   = bonusHist.filter(h => h.memberId === kid.id);
    const kBadge   = badgeHist.filter(h => h.memberId === kid.id);
    const kSavDep  = savDepHist.filter(h => h.memberId === kid.id);
    const kDiamonds = kChore.reduce((s, h) => s + (h.diamonds || 0), 0)
                    + kBonus.reduce((s, h) => s + (h.diamonds || 0), 0);
    const kSaved    = kSavDep.reduce((s, h) => s + (h.dollars || 0), 0);
    const kChoreCounts = {};
    kChore.forEach(h => { kChoreCounts[h.title] = (kChoreCounts[h.title] || 0) + 1; });
    const kTopChore = Object.entries(kChoreCounts).sort((a, b) => b[1] - a[1])[0];
    return { kid, diamonds: kDiamonds, chores: kChore.length, saved: kSaved, topChore: kTopChore, badges: kBadge, streak: kid.streak?.current || 0 };
  });

  const slides = _buildWeekReviewSlides({
    kidData, totalDiamonds, totalChores, totalSaved, totalBadges, topChore, start, end, savOn, cur
  });
  if (!slides.length) return;
  if (!WEEK_REVIEW_PREVIEW_MODE) _assignWeekReviewAudio(slides, start);

  const overlay = document.createElement('div');
  overlay.id = 'week-review-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;overflow:hidden;-webkit-overflow-scrolling:touch';
  document.body.appendChild(overlay);
  const previewIndex = WEEK_REVIEW_PREVIEW_MODE
    ? Math.max(0, Math.min(WEEK_REVIEW_PREVIEW_SLIDE_INDEX, slides.length - 1))
    : 0;
  const timingScale = _weekReviewTimingScale(kids.length);
  const slideMs = WEEK_REVIEW_SLIDE_MS;
  _weekReviewStory = { slides, index: previewIndex, timer: null, paused: WEEK_REVIEW_PREVIEW_MODE, remainingMs: slideMs, slideMs, timingScale, slideStartedAt: 0, audioSlideIndex: -1, lastAdvanceFromTimer: false };
  _renderWeekReviewStory();
}

function closeWeekReview() {
  if (_weekReviewStory?.timer) clearTimeout(_weekReviewStory.timer);
  _weekReviewStopAudio();
  _weekReviewStory = null;
  document.getElementById('week-review-overlay')?.remove();
}

function _buildWeekReviewSlides({ kidData, totalDiamonds, totalChores, totalSaved, totalBadges, topChore, start, end, savOn, cur }) {
  const slides = [];
  const dateRange = _formatWeekReviewDateRange(start, end);
  const coverDateRange = _formatWeekReviewDateRange(start, end, true);
  const familyCelebrationName = D.family?.name?.trim() || 'The Family';
  const timesLabel = (count) => {
    if (count === 1) return 'Once';
    if (count === 2) return 'Twice';
    return `${count} Times`;
  };
  const choresLabel = (count) => `${count} task${count === 1 ? '' : 's'}`;
  const badgeStatHTML = (count) => `${count} New<br>Badge${count === 1 ? '' : 's'}`;
  const previewChoreTitles = ['Put Clothes Away', 'Brush Teeth', 'Feed the Dog', 'Make Your Bed', 'Tidy Toys', 'Clear Dishes'];
  const previewCoverData = (() => {
    if (WEEK_REVIEW_PREVIEW_KID_COUNT <= 0) return kidData;
    const list = kidData.slice(0, WEEK_REVIEW_PREVIEW_KID_COUNT);
    if (list.length >= WEEK_REVIEW_PREVIEW_KID_COUNT) return list;
    while (list.length < WEEK_REVIEW_PREVIEW_KID_COUNT && kidData.length) {
      const source = kidData[list.length % kidData.length];
      list.push({
        ...source,
        kid: {
          ...source.kid,
          id: `${source.kid.id}-preview-${list.length}`,
          name: `${source.kid.name} ${list.length + 1}`
        }
      });
    }
    return list;
  })();
  const previewSlideRows = (() => {
    if (WEEK_REVIEW_PREVIEW_KID_COUNT <= 0) return null;
    return previewCoverData.map(({ kid }, idx) => ({
      kid,
      diamonds: 8 + (idx * 4),
      saved: idx % 2 === 0 ? ((idx + 1) * 0.5) : 0,
      chores: 2 + idx,
      topChore: [previewChoreTitles[idx % previewChoreTitles.length], (idx % 6) + 1]
    }));
  })();
  const previewBadgeRows = (() => {
    if (WEEK_REVIEW_PREVIEW_KID_COUNT <= 0) return null;
    const badgeSamples = [
      { title:'Early Bird', badgeIcon:'<i class="ph-duotone ph-sun-horizon" style="color:#F59E0B"></i>' },
      { title:'Spark Starter', badgeIcon:'<i class="ph-duotone ph-sparkle" style="color:#FDE68A"></i>' },
      { title:'Neat Nest', badgeIcon:'<i class="ph-duotone ph-house-line" style="color:#93C5FD"></i>' },
      { title:'Team Player', badgeIcon:'<i class="ph-duotone ph-users-three" style="color:#86EFAC"></i>' },
      { title:'Streak Builder', badgeIcon:'<i class="ph-duotone ph-fire" style="color:#FB923C"></i>' },
      { title:'Shiny Helper', badgeIcon:'<i class="ph-duotone ph-star" style="color:#F9A8D4"></i>' },
    ];
    return previewCoverData.slice(0, 6).map(({ kid }, idx) => {
      const count = idx + 1;
      return {
        name: kid.name,
        statHtml: badgeStatHTML(count),
        hideAvatar: true,
        badgesDisplay: badgeSamples.slice(0, count)
      };
    });
  })();
  const isEmpty = totalChores === 0;
  const introSub = isEmpty
    ? 'A softer week for your crew. Here is the story anyway.'
    : `${kidData.length === 1 ? kidData[0].kid.name : 'Your family'} wrapped up the week with tasks, savings, and a little momentum.`;
  slides.push({
    type: 'cover',
    gradient: 'linear-gradient(160deg,#3f6c5f 0%,#26443d 54%,#1b2f2a 100%)',
    label: 'Week in Review',
    icon: '<i class="ph-duotone ph-calendar-star" style="color:rgba(244,239,228,0.84);font-size:1rem"></i>',
    bigStat: coverDateRange,
    dateRangeText: dateRange,
    subStat: introSub,
    rows: previewCoverData.map(({ kid, chores }) => ({
      avatar: renderMemberAvatarHtml(kid, '<i class="ph-duotone ph-smiley" style="color:#5b6f67;font-size:1.35rem"></i>'),
      name: kid.name,
      stat: kid.role === 'kid' ? `${kid.diamonds || 0} total gems` : 'Parent profile',
      sub: chores > 0 ? `${chores} task${chores === 1 ? '' : 's'} this week` : 'Ready for next week'
    }))
  });

  if (totalDiamonds > 0) {
    const savingsSub = (savOn && totalSaved > 0) ? ` - ${cur}${totalSaved.toFixed(2)} saved` : '';
    slides.push({
      gradient: 'linear-gradient(160deg,#2f7f88 0%,#1f5f6a 54%,#173f49 100%)',
      label: 'Gems Earned',
      icon: '<i class="ph-duotone ph-diamond" style="color:rgba(244,239,228,0.82);font-size:0.9rem"></i>',
      bigStat: `${totalDiamonds} gems`,
      subStat: `earned by the whole family${savingsSub}`,
      rows: (previewSlideRows || kidData
      .filter(({ diamonds }) => diamonds > 0))
      .map(({ kid, diamonds, saved }) => {
        const sub = (savOn && saved > 0)
          ? `${cur}${saved.toFixed(2)} saved this week`
          : '';
        return { avatar: renderMemberAvatarHtml(kid, '<i class="ph-duotone ph-smiley" style="color:#5b6f67;font-size:1.35rem"></i>'), name: kid.name, sub, stat: `${diamonds} gems` };
      })
    });
  }

  if (totalChores > 0) {
    slides.push({
      gradient: 'linear-gradient(160deg,#d59d4d 0%,#bd7440 58%,#8a5133 100%)',
      label: 'Tasks Completed',
      icon: '<i class="ph-duotone ph-check-circle" style="color:rgba(255,248,238,0.82);font-size:0.9rem"></i>',
      bigStat: `${totalChores} tasks`,
      subStat: 'completed by the whole family',
      rows: (previewSlideRows || kidData
      .filter(({ chores }) => chores > 0))
      .map(({ kid, chores }) => {
        return { avatar: renderMemberAvatarHtml(kid, '<i class="ph-duotone ph-smiley" style="color:#5b6f67;font-size:1.35rem"></i>'), name: kid.name, stat: choresLabel(chores) };
      })
    });
  }

  if (topChore) {
    slides.push({
      gradient: 'linear-gradient(160deg,#8b7d4f 0%,#6e633f 56%,#4c442e 100%)',
      label: 'Top Task of the Week',
      icon: '<i class="ph-duotone ph-star" style="color:rgba(251,248,239,0.82);font-size:0.9rem"></i>',
      bigStat: topChore[0],
      subStat: `completed ${topChore[1]} time${topChore[1]!==1?'s':''} as a family`,
      rows: (previewSlideRows || kidData
      .filter(({ topChore: kt }) => kt))
      .map(({ kid, topChore: kt }) => ({
        avatar: renderMemberAvatarHtml(kid, '<i class="ph-duotone ph-smiley" style="color:#5b6f67;font-size:1.35rem"></i>'),
        name: kid.name,
        stat: kt[0],
        sub: timesLabel(kt[1])
      }))
    });
  }

  if (totalBadges > 0) {
    slides.push({
      gradient: 'linear-gradient(160deg,#c76f58 0%,#a85646 58%,#6f3832 100%)',
      label: 'Badges Earned',
      icon: '<i class="ph-duotone ph-medal" style="color:rgba(255,246,241,0.82);font-size:0.9rem"></i>',
      bigStat: `${totalBadges} badges`,
      subStat: 'earned by the whole family',
      rows: previewBadgeRows || kidData
      .filter(({ badges }) => badges.length > 0)
      .map(({ kid, badges }) => ({
        name: kid.name,
        statHtml: badgeStatHTML(badges.length),
        hideAvatar: true,
        badgesDisplay: badges.slice(0, 6).map(b => ({
          name: b.title || 'Badge',
          icon: b.badgeIcon || '<i class="ph-duotone ph-medal" style="color:#FDE68A"></i>'
        }))
      }))
    });
  }

  slides.push(isEmpty
    ? {
        type: 'finale',
        gradient: 'linear-gradient(160deg,#5b5f8f 0%,#44496f 58%,#2d3150 100%)',
        label: 'Next Week',
        icon: '<i class="ph-duotone ph-moon-stars" style="color:rgba(255,255,255,0.58);font-size:1rem"></i>',
        bigStat: 'Quiet week',
        subStat: 'Make it count next Sunday!',
        rows: []
      }
    : {
        type: 'finale',
        gradient: 'linear-gradient(160deg,#6f6aa8 0%,#534d85 58%,#35315a 100%)',
        label: 'Week in Review',
        icon: '<i class="ph-duotone ph-calendar-star" style="color:rgba(244,239,228,0.84);font-size:1rem"></i>',
        finaleIcon: '<i class="ph-duotone ph-plant" style="color:rgba(255,255,255,0.88)"></i>',
        finaleHeadline: 'Great job!',
        finaleMessage: "Let's keep growing!",
        bigStat: 'Great job!',
        subStat: familyCelebrationName,
        rows: []
      });

  return slides;
}

function _assignWeekReviewAudio(slides, weekSeed) {
  if (!Array.isArray(slides) || !slides.length) return;
  const base = 'assets/week-review-audio/';
  const middlePool = _weekReviewShuffle([
    `${base}2.wav`,
    `${base}3.wav`,
    `${base}4.wav`,
    `${base}5.wav`
  ], weekSeed || today());
  const middleSlides = slides.filter(slide => slide.type !== 'cover' && slide.type !== 'finale');
  slides.forEach((slide, index) => {
    if (index === 0 || index === slides.length - 1 || slide.type === 'cover' || slide.type === 'finale') {
      slide.audioSrc = `${base}1.wav`;
      return;
    }
    slide.audioSrc = middlePool.shift() || `${base}1.wav`;
  });
  middleSlides.forEach((slide, index) => {
    slide.audioSrc = slide.audioSrc || middlePool[index] || `${base}1.wav`;
  });
}

function _weekReviewShuffle(items, seed) {
  const list = items.slice();
  let h = 2166136261;
  for (const ch of String(seed || 'week-review')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  const rand = () => {
    h += 0x6D2B79F5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function _weekReviewSyncAudio() {
  if (WEEK_REVIEW_PREVIEW_MODE) return;
  const state = _weekReviewStory;
  const slide = state?.slides?.[state.index];
  if (!slide?.audioSrc) return;
  const resolvedSrc = new URL(slide.audioSrc, window.location.href).href;
  const changedSlide = state.audioSlideIndex !== state.index;
  if (!_weekReviewAudio) {
    _weekReviewAudio = new Audio(slide.audioSrc);
    _weekReviewAudio.preload = 'auto';
    _weekReviewAudio.loop = true;
    _weekReviewAudio.load();
  } else if (_weekReviewAudio.src !== resolvedSrc) {
    _weekReviewAudio.pause();
    _weekReviewAudio.src = slide.audioSrc;
    _weekReviewAudio.load();
  }

  if (changedSlide && _weekReviewAudio.currentTime > 0.05) {
    _weekReviewAudio.currentTime = 0;
  }
  state.audioSlideIndex = state.index;
  state.lastAdvanceFromTimer = false;

  if (state.paused) {
    _weekReviewAudio.pause();
    return;
  }
  if (changedSlide) _weekReviewAudio.currentTime = 0;
  _weekReviewAudio.play().catch(() => {
    const overlay = document.getElementById('week-review-overlay');
    if (!overlay) return;
    const retry = () => {
      if (_weekReviewStory?.paused) return;
      _weekReviewAudio?.play().catch(() => {});
    };
    overlay.addEventListener('pointerdown', retry, { once: true });
  });
}

function _weekReviewStopAudio() {
  if (!_weekReviewAudio) return;
  _weekReviewAudio.pause();
  _weekReviewAudio.currentTime = 0;
  _weekReviewAudio = null;
  if (_weekReviewStory) _weekReviewStory.audioSlideIndex = -1;
}

function _renderWeekReviewStory() {
  const overlay = document.getElementById('week-review-overlay');
  const state = _weekReviewStory;
  if (!overlay || !state) return;
  const slides = state.slides;
  const slide = slides[state.index];
  const progress = slides.map((_, i) => `
    <span class="wr-progress-track">
      <span class="wr-progress-fill${i === state.index ? ' active' : ''}${i < state.index ? ' done' : ''}" style="${i === state.index ? `animation-duration:${WEEK_REVIEW_SLIDE_MS}ms` : ''}"></span>
    </span>`).join('');
  const rowsHtml = (slide.rows || []).map((row, i) => _weekReviewRowHTML(row, i)).join('');

  return `
    <style>
      #week-review-overlay {
        background:
          radial-gradient(circle at top left, rgba(232,199,106,0.16), transparent 24%),
          radial-gradient(circle at top right, rgba(95,143,99,0.14), transparent 26%),
          linear-gradient(180deg, #26443d 0%, #355d4f 34%, #e9ddc8 34%, #f4efe4 100%);
        color: #273229;
        font-family: "Avenir Next", "Trebuchet MS", "Segoe UI", system-ui, sans-serif;
        touch-action: manipulation;
      }
      #week-review-overlay.wr-paused .wr-progress-fill.active,
      #week-review-overlay.wr-paused .wr-reveal {
        animation-play-state: paused;
      }
      @keyframes wr-scene-in {
        from { opacity:0; transform:translateY(20px) scale(0.985); }
        to   { opacity:1; transform:translateY(0) scale(1); }
      }
      @keyframes wr-progress {
        from { transform: scaleX(0); }
        to { transform: scaleX(1); }
      }
      @keyframes wr-reveal {
        from { opacity: 1; transform: translate3d(var(--wr-from-x, 0px), var(--wr-from-y, 18px), 0) scale(1); }
        to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
      }
      .wr-reveal-from-bottom { --wr-from-x:0px; --wr-from-y:calc(100vh + 120px); }
      .wr-reveal-from-bottom-card { --wr-from-x:0px; --wr-from-y:calc(100vh + 160px); }
      .wr-reveal-from-left { --wr-from-x:calc(-100vw - 160px); --wr-from-y:0px; }
      .wr-reveal-from-right { --wr-from-x:calc(100vw + 160px); --wr-from-y:0px; }
      .wr-shell {
        max-width: 520px;
        margin: 0 auto;
        min-height: 100dvh;
        padding: env(safe-area-inset-top,20px) 16px calc(env(safe-area-inset-bottom, 0px) + 18px);
        display: flex;
        flex-direction: column;
        position: relative;
      }
      .wr-top {
        padding: 4px 0 10px;
      }
      .wr-progress-row {
        display: flex;
        gap: 6px;
        margin-bottom: 16px;
      }
      .wr-progress-track {
        flex: 1;
        height: 4px;
        border-radius: 999px;
        overflow: hidden;
        background: rgba(255,253,248,0.24);
      }
      .wr-progress-fill {
        display: block;
        width: 100%;
        height: 100%;
        transform-origin: left center;
        transform: scaleX(0);
        background: rgba(255,248,239,0.92);
        border-radius: inherit;
      }
      .wr-progress-fill.done {
        transform: scaleX(1);
      }
      .wr-progress-fill.active {
        animation: wr-progress linear forwards;
      }
      .wr-head {
        padding: 8px 0 8px;
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }
      .wr-title {
        color: #fff8ef;
        font-size: 1.28rem;
        font-weight: 900;
        letter-spacing: -0.03em;
      }
      .wr-date {
        color: rgba(244,239,228,0.62);
        font-size: 0.82rem;
        margin-top: 4px;
      }
      .wr-close {
        background: rgba(255,253,248,0.14);
        border: 1px solid rgba(255,253,248,0.18);
        color: rgba(255,248,239,0.78);
        width: 38px;
        height: 38px;
        border-radius: 999px;
        cursor: pointer;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 10px 18px rgba(15,29,25,0.14);
      }
      .wr-scene {
        position: relative;
        flex: 1;
        display: flex;
        align-items: stretch;
        min-height: 0;
      }
      .wr-tap {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 24%;
        z-index: 5;
      }
      .wr-tap-left { left: 0; }
      .wr-tap-right { right: 0; }
      .wr-slide {
        position: relative;
        width: 100%;
        display: flex;
        flex-direction: column;
        justify-content: center;
        animation: wr-scene-in 0.45s cubic-bezier(0.22,1,0.36,1) both;
      }
      .wr-card {
        border-radius: 30px;
        padding: 34px 24px 22px;
        box-shadow: 0 18px 40px rgba(34, 28, 20, 0.14);
        min-height: min(76dvh, 720px);
        display: flex;
        flex-direction: column;
        justify-content: center;
      }
      .wr-reveal {
        opacity: 0;
        animation: wr-reveal 0.55s cubic-bezier(0.22,1,0.36,1) forwards;
        animation-delay: var(--wr-delay, 0s);
      }
      .wr-card-label {
        display: flex;
        align-items: center;
        gap: 7px;
        font-size: 0.72rem;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: rgba(255,248,239,0.64);
        margin-bottom: 14px;
      }
      .wr-card-big {
        font-size: clamp(3rem,14vw,5rem);
        font-weight: 900;
        color: #fff9f1;
        line-height: 0.95;
        letter-spacing: -0.05em;
        margin-bottom: 8px;
        text-wrap: balance;
      }
      .wr-card-sub {
        font-size: 0.9rem;
        color: rgba(255,246,238,0.68);
        line-height: 1.45;
        max-width: 24rem;
      }
      .wr-kid-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-top: 6px;
      }
      .wr-kid-row {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 11px 14px;
        background: rgba(255,253,248,0.18);
        border: 1px solid rgba(255,253,248,0.16);
        border-radius: 18px;
        backdrop-filter: blur(8px);
      }
      .wr-kid-avatar {
        width: 42px;
        height: 42px;
        border-radius: 14px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: rgba(255,250,243,0.78);
        color: #31453e;
        font-size: 1.55rem;
        line-height: 1;
        flex-shrink: 0;
        overflow: hidden;
      }
      .wr-kid-name {
        font-weight: 800;
        color: #fff9f1;
        font-size: 0.95rem;
      }
      .wr-kid-sub {
        font-size: 0.79rem;
        color: rgba(255,246,238,0.62);
        margin-top: 2px;
        line-height: 1.35;
      }
      .wr-kid-stat {
        font-weight: 900;
        color: #fff9f1;
        font-size: 1.04rem;
        white-space: nowrap;
      }
      .wr-finale {
        text-align: center;
        align-items: center;
      }
      .wr-finale .wr-card-sub {
        max-width: 18rem;
        text-align: center;
      }
      .wr-finale-icon {
        font-size: 3.2rem;
        color: rgba(255,255,255,0.58);
        margin-bottom: 18px;
      }
      .wr-cover-chip-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 20px;
      }
      .wr-cover-chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 9px 12px;
        border-radius: 999px;
        background: rgba(255,253,248,0.16);
        border: 1px solid rgba(255,253,248,0.16);
        color: rgba(255,248,239,0.9);
        font-size: 0.8rem;
        font-weight: 700;
      }
      .wr-bottom-note {
        text-align: center;
        color: rgba(255,255,255,0.78);
        font-size: 0.84rem;
        font-weight: 700;
        padding-top: 14px;
      }
      @media (max-width: 640px) {
        .wr-card {
          min-height: calc(100dvh - env(safe-area-inset-top,20px) - env(safe-area-inset-bottom,0px) - 104px);
          padding: 30px 22px 20px;
        }
        .wr-card-big {
          font-size: clamp(2.8rem, 13vw, 4.5rem);
        }
      }
    </style>
    <div class="wr-shell">
      <div class="wr-top">
        <div class="wr-progress-row">${progress}</div>
        <div class="wr-head">
          <div>
            <div class="wr-title">Week in Review</div>
            <div class="wr-date">${slides.length > 1 ? `Story ${state.index + 1} of ${slides.length} · ` : ''}${slide.type === 'cover' ? 'This past week' : dateRange}</div>
          </div>
          <button onclick="closeWeekReview()" class="wr-close"><i class="ph-duotone ph-x" style="font-size:1.1rem"></i></button>
        </div>
      </div>
      <div class="wr-scene">
        <button class="wr-tap wr-tap-left" aria-label="Previous story" onpointerdown="return handleWeekReviewPress('prev', event)" onpointerup="handleWeekReviewRelease('prev')" onpointercancel="handleWeekReviewRelease('prev')" onpointerleave="handleWeekReviewRelease('prev')" onclick="return handleWeekReviewTap('prev', event)"></button>
        <button class="wr-tap wr-tap-right" aria-label="Next story" onpointerdown="return handleWeekReviewPress('next', event)" onpointerup="handleWeekReviewRelease('next')" onpointercancel="handleWeekReviewRelease('next')" onpointerleave="handleWeekReviewRelease('next')" onclick="return handleWeekReviewTap('next', event)"></button>
        <div class="wr-slide" onpointerdown="return handleWeekReviewCardPress(event)" onpointerup="handleWeekReviewCardRelease()" onpointercancel="handleWeekReviewCardRelease()" onpointerleave="handleWeekReviewCardRelease()">
          <div class="wr-card ${slide.type === 'finale' ? 'wr-finale' : ''}" style="background:${slide.gradient}">
            ${slide.type === 'finale' ? `<div class="wr-finale-icon wr-reveal" style="--wr-delay:1s">${slide.icon}</div>` : ''}
            <div class="wr-card-label wr-reveal" style="--wr-delay:1s">${slide.icon}${slide.label}</div>
            <div class="wr-card-big wr-reveal" style="--wr-delay:2s">${slide.bigStat}</div>
            <div class="wr-card-sub wr-reveal" style="--wr-delay:3s">${slide.subStat}</div>
            ${slide.type === 'cover' ? `
              <div class="wr-cover-chip-row">
                <div class="wr-cover-chip wr-reveal" style="--wr-delay:4s"><i class="ph-duotone ph-diamond" style="font-size:1rem"></i> ${totalDiamonds} gems</div>
                <div class="wr-cover-chip wr-reveal" style="--wr-delay:5.1s"><i class="ph-duotone ph-piggy-bank" style="font-size:1rem"></i> ${cur}${totalSaved.toFixed(2)} saved</div>
                <div class="wr-cover-chip wr-reveal" style="--wr-delay:6.2s"><i class="ph-duotone ph-medal" style="font-size:1rem"></i> ${totalBadges} badges</div>
              </div>
            ` : ''}
            ${(slide.rows || []).length ? `<div class="wr-kid-list">${rowsHtml}</div>` : ''}
          </div>
        </div>
      </div>
      ${slide.type === 'finale' ? `<div class="wr-bottom-note wr-reveal" style="--wr-delay:4.8s">Tap anywhere to close or let the story finish.</div>` : ''}
    </div>`;
}

function _weekReviewRowHTML(row, idx) {
  const delay = Number(row.delay ?? (3 + idx));
  const previewAttr = WEEK_REVIEW_PREVIEW_MODE ? ' data-preview="1"' : '';
  const badgesDisplay = Array.isArray(row.badgesDisplay) ? row.badgesDisplay.slice(0, 6) : [];
  const hasBadgeGrid = badgesDisplay.length > 0;
  const motionClass = row.motionClass ? ` ${row.motionClass}` : '';
  return `
    <div class="wr-kid-row${hasBadgeGrid ? ' wr-kid-row-badge' : ''}${row.hideAvatar ? ' wr-kid-row-no-avatar' : ''}${motionClass} wr-reveal"${previewAttr} style="--wr-delay:${delay}s">
      ${row.hideAvatar ? '' : `<span class="wr-kid-avatar">${row.avatar}</span>`}
      <div class="wr-kid-copy">
        <div class="wr-kid-name">${esc(row.name)}</div>
        ${row.statHtml ? `<div class="wr-kid-stat">${row.statHtml}</div>` : row.stat ? `<div class="wr-kid-stat">${row.stat}</div>` : ''}
        ${row.sub ? `<div class="wr-kid-sub">${row.sub}</div>` : ''}
      </div>
      ${hasBadgeGrid ? `
        <div class="wr-kid-badge-grid wr-kid-badge-grid-count-${Math.min(badgesDisplay.length, 6)}">
          ${badgesDisplay.map((badge, badgeIdx) => `
            <div class="wr-kid-badge-item${badgeIdx === badgesDisplay.length - 1 && (badgesDisplay.length === 3 || badgesDisplay.length === 5) ? ' wr-kid-badge-item-center' : ''}">
              <div class="wr-kid-badge-icon">${badge.icon || ''}</div>
              <div class="wr-kid-badge-name">${esc(badge.name || 'Badge')}</div>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>`;
}

function _weekReviewStartTimer() {
  if (!_weekReviewStory) return;
  if (_weekReviewStory.timer) clearTimeout(_weekReviewStory.timer);
  const slideMs = _weekReviewStory.slideMs || WEEK_REVIEW_SLIDE_MS;
  const delay = Math.max(150, _weekReviewStory.remainingMs || slideMs);
  _weekReviewStory.slideStartedAt = Date.now();
  _weekReviewStory.timer = setTimeout(() => _weekReviewNext(true), delay);
}

function _weekReviewNext(fromTimer = false) {
  const state = _weekReviewStory;
  if (!state) return;
  if (state.index >= state.slides.length - 1) {
    closeWeekReview();
    return;
  }
  state.index += 1;
  state.remainingMs = state.slideMs || WEEK_REVIEW_SLIDE_MS;
  state.paused = false;
  state.lastAdvanceFromTimer = !!fromTimer;
  _renderWeekReviewStory();
}

function _weekReviewPrev() {
  const state = _weekReviewStory;
  if (!state) return;
  if (state.index <= 0) {
    state.remainingMs = state.slideMs || WEEK_REVIEW_SLIDE_MS;
    state.paused = false;
    state.lastAdvanceFromTimer = false;
    _renderWeekReviewStory();
    return;
  }
  state.index -= 1;
  state.remainingMs = state.slideMs || WEEK_REVIEW_SLIDE_MS;
  state.paused = false;
  state.lastAdvanceFromTimer = false;
  _renderWeekReviewStory();
}

function _weekReviewPause() {
  const state = _weekReviewStory;
  if (!state || state.paused) return;
  state.paused = true;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (state.slideStartedAt) {
    const elapsed = Date.now() - state.slideStartedAt;
    state.remainingMs = Math.max(150, (state.remainingMs || state.slideMs || WEEK_REVIEW_SLIDE_MS) - elapsed);
  }
  document.getElementById('week-review-overlay')?.classList.add('wr-paused');
  _weekReviewUpdatePauseButton();
  _weekReviewAudio?.pause();
}

function _weekReviewResume() {
  const state = _weekReviewStory;
  if (!state || !state.paused) return;
  state.paused = false;
  document.getElementById('week-review-overlay')?.classList.remove('wr-paused');
  _weekReviewUpdatePauseButton();
  _weekReviewAudio?.play().catch(() => {});
  _weekReviewStartTimer();
}

function _weekReviewTogglePause() {
  if (_weekReviewStory?.paused) {
    _weekReviewResume();
  } else {
    _weekReviewPause();
  }
}

function _weekReviewUpdatePauseButton() {
  const btn = document.querySelector('#week-review-overlay .wr-pause-btn');
  const icon = btn?.querySelector('i');
  if (!btn || !icon) return;
  const paused = !!_weekReviewStory?.paused;
  btn.setAttribute('aria-label', paused ? 'Resume story' : 'Pause story');
  icon.className = `ph-duotone ${paused ? 'ph-play' : 'ph-pause'}`;
}

function _weekReviewListClass(count) {
  if (count >= 6) return ' wr-kid-list-count-6 wr-kid-list-compact';
  if (count === 5) return ' wr-kid-list-count-5 wr-kid-list-compact';
  if (count === 4) return ' wr-kid-list-count-4';
  if (count === 3) return ' wr-kid-list-count-3';
  return '';
}

function _weekReviewCardBodyHTML(slide, { previewAttr = '', totalDiamonds = '0', totalSaved = '$0.00', totalBadges = '0' } = {}) {
  const timingScale = _weekReviewStory?.timingScale || 1;
  const rowCount = (slide.rows || []).length;
  const listClass = _weekReviewListClass(rowCount);
  const isTwoColumn = rowCount >= 3;
  const rowMotionClass = isTwoColumn
    ? (idx => (idx % 2 === 0 ? 'wr-reveal-from-left' : 'wr-reveal-from-right'))
    : (() => 'wr-reveal-from-bottom-card');
  const rowDelayBase = slide.type === 'cover' ? 4 : 3;
  const rowsHtml = (slide.rows || []).map((row, i) => _weekReviewRowHTML({
    ...row,
    delay: _weekReviewScaledDelay(rowDelayBase + i, timingScale),
    motionClass: row.motionClass || rowMotionClass(i),
  }, i)).join('');
  const gemCount = Number(totalDiamonds) || 0;
  const savingsAmount = Number(String(totalSaved).replace(/[^0-9.-]/g, '')) || 0;
  const badgeCount = Number(totalBadges) || 0;
  const labelDelay = 0;
  const isCover = slide.type === 'cover';
  const isFinale = slide.type === 'finale';
  const headerDelay = isFinale ? null : _weekReviewScaledDelay(1, timingScale);
  const subDelay = isCover ? _weekReviewScaledDelay(2, timingScale) : (isFinale ? null : _weekReviewScaledDelay(1, timingScale));
  const finaleMessageHTML = slide.finaleMessage
    ? `<div class="wr-finale-message wr-reveal wr-reveal-from-right"${previewAttr} style="--wr-delay:${_weekReviewScaledDelay(1, timingScale)}s">${slide.finaleMessage}</div>`
    : '';
  const coverChips = [];
  if (gemCount > 0) {
    coverChips.push(`<div class="wr-cover-chip wr-reveal wr-reveal-from-left"${previewAttr} style="--wr-delay:${subDelay}s"><i class="ph-duotone ph-diamond" style="font-size:1rem"></i> ${totalDiamonds} gems</div>`);
  }
  if (savingsAmount > 0) {
    coverChips.push(`<div class="wr-cover-chip wr-reveal wr-reveal-from-bottom-card"${previewAttr} style="--wr-delay:${subDelay}s"><i class="ph-duotone ph-piggy-bank" style="font-size:1rem"></i> ${totalSaved} saved</div>`);
  }
  if (badgeCount > 0) {
    coverChips.push(`<div class="wr-cover-chip wr-reveal wr-reveal-from-bottom-card"${previewAttr} style="--wr-delay:${subDelay}s"><i class="ph-duotone ph-medal" style="font-size:1rem"></i> ${totalBadges} badges</div>`);
  }
  return `
    <div class="wr-card ${slide.type === 'finale' ? 'wr-finale' : ''}${slide.noLabel ? ' wr-card-no-label' : ''}" style="background:${slide.gradient}">
      <div class="wr-card-label"${previewAttr}>${slide.icon}${slide.label}</div>
      <div class="wr-card-body">
        ${slide.type === 'finale' ? `
          <div class="wr-finale-stage-one">
            <div class="wr-finale-icon wr-reveal wr-reveal-from-left"${previewAttr} style="--wr-delay:${_weekReviewScaledDelay(labelDelay, timingScale)}s">${slide.finaleIcon || slide.icon}</div>
            <div class="wr-card-big wr-reveal wr-reveal-from-left"${previewAttr} style="--wr-delay:${_weekReviewScaledDelay(labelDelay, timingScale)}s">${slide.finaleHeadline || slide.bigStat || ''}</div>
          </div>
          <div class="wr-finale-stage-two">
            ${finaleMessageHTML}
            <div class="wr-card-sub wr-reveal wr-reveal-from-right"${previewAttr} style="--wr-delay:${_weekReviewScaledDelay(1, timingScale)}s">${slide.subStat}</div>
          </div>
        ` : `
          <div class="wr-card-big wr-reveal wr-reveal-from-left"${previewAttr} style="--wr-delay:${headerDelay}s">${slide.bigStat}</div>
          <div class="wr-card-sub wr-reveal wr-reveal-from-left"${previewAttr} style="--wr-delay:${subDelay}s">${slide.subStat}</div>
        `}
        ${slide.type === 'cover' && coverChips.length ? `<div class="wr-cover-chip-row">${coverChips.join('')}</div>` : ''}
        ${(slide.rows || []).length ? `<div class="wr-kid-list${listClass}">${rowsHtml}</div>` : ''}
      </div>
    </div>`;
}

function _weekReviewApplyUniformCardHeight(overlay, slides, totals) {
  const state = _weekReviewStory;
  if (!overlay || !state || !slides?.length) return;
  const existing = Number(state.cardHeight || 0);
  if (existing > 0) {
    overlay.style.setProperty('--wr-card-uniform-height', `${existing}px`);
    return;
  }
  const measureHost = document.createElement('div');
  measureHost.className = 'wr-measure-host';
  measureHost.setAttribute('aria-hidden', 'true');
  measureHost.innerHTML = slides.map(slide => `<div class="wr-slide wr-measure-slide">${_weekReviewCardBodyHTML(slide, {
    previewAttr: ' data-preview="1"',
    totalDiamonds: totals.totalDiamonds,
    totalSaved: totals.totalSaved,
    totalBadges: totals.totalBadges,
  })}</div>`).join('');
  overlay.appendChild(measureHost);
  const measured = [...measureHost.querySelectorAll('.wr-card')]
    .map(card => Math.ceil(card.getBoundingClientRect().height))
    .filter(Boolean);
  measureHost.remove();
  if (!measured.length) return;
  const maxHeight = Math.max(...measured);
  state.cardHeight = maxHeight;
  overlay.style.setProperty('--wr-card-uniform-height', `${maxHeight}px`);
}

function _renderWeekReviewStory() {
  const overlay = document.getElementById('week-review-overlay');
  if (!overlay || !_weekReviewStory) return;
  overlay.innerHTML = _weekReviewHTML(_weekReviewStory.slides, _weekReviewStory.index);
  const slides = _weekReviewStory.slides || [];
  const totalDiamonds = slides.find(s => s.label === 'Gems Earned')?.bigStat?.split(' ')[0] || '0';
  const totalSaved = (() => {
    const s = slides.find(s => s.label === 'Gems Earned')?.subStat || '';
    const m = s.match(/-\s([^ ]+\d[\d.,]*)\s+saved/);
    return m ? m[1] : `${D.settings.currency || '$'}0.00`;
  })();
  const totalBadges = slides.find(s => s.label === 'Badges Earned')?.bigStat || '0';
  _weekReviewApplyUniformCardHeight(overlay, slides, { totalDiamonds, totalSaved, totalBadges });
}

function _weekReviewHTML(slides, currentIndex) {
  const state = _weekReviewStory;
  if (!state) return '';
  state.index = currentIndex;
  const totalDiamonds = slides.find(s => s.label === 'Gems Earned')?.bigStat?.split(' ')[0] || '0';
  const totalSaved = (() => {
    const s = slides.find(s => s.label === 'Gems Earned')?.subStat || '';
    const m = s.match(/-\s([^ ]+\d[\d.,]*)\s+saved/);
    return m ? m[1] : `${D.settings.currency || '$'}0.00`;
  })();
  const totalBadges = slides.find(s => s.label === 'Badges Earned')?.bigStat || '0';
  const dateRange = slides[0]?.dateRangeText || '';
  const slide = slides[currentIndex];
  const slideMs = state.slideMs || WEEK_REVIEW_SLIDE_MS;
  const revealDuration = Math.max(0.42, 0.7 * (state.timingScale || 1));
  const headerDate = slide.type === 'cover' ? 'This past week' : dateRange;
  const previewAttr = WEEK_REVIEW_PREVIEW_MODE ? ' data-preview="1"' : '';
  const progress = slides.map((_, i) => `
    <span class="wr-progress-track">
      <span class="wr-progress-fill${i === currentIndex ? ' active' : ''}${i < currentIndex ? ' done' : ''}"${previewAttr} style="${i === currentIndex ? `animation-duration:${slideMs}ms` : ''}"></span>
    </span>`).join('');
  return `
    <style>
      #week-review-overlay {
        background:
          radial-gradient(circle at top left, rgba(232,199,106,0.16), transparent 24%),
          radial-gradient(circle at top right, rgba(95,143,99,0.14), transparent 26%),
          linear-gradient(180deg, #26443d 0%, #355d4f 34%, #e9ddc8 34%, #f4efe4 100%);
        color: #273229;
        font-family: "Avenir Next", "Trebuchet MS", "Segoe UI", system-ui, sans-serif;
        touch-action: manipulation;
      }
      @keyframes wr-scene-in {
        from { opacity:0; transform:translateY(20px) scale(0.985); }
        to   { opacity:1; transform:translateY(0) scale(1); }
      }
      @keyframes wr-progress {
        from { transform: scaleX(0); }
        to { transform: scaleX(1); }
      }
      @keyframes wr-reveal {
        from { opacity: 1; transform: translate3d(var(--wr-from-x, 0px), var(--wr-from-y, 18px), 0) scale(1); }
        to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
      }
      .wr-reveal-from-bottom { --wr-from-x:0px; --wr-from-y:calc(100vh + 120px); }
      .wr-reveal-from-bottom-card { --wr-from-x:0px; --wr-from-y:calc(100vh + 160px); }
      .wr-reveal-from-left { --wr-from-x:calc(-100vw - 160px); --wr-from-y:0px; }
      .wr-reveal-from-right { --wr-from-x:calc(100vw + 160px); --wr-from-y:0px; }
      .wr-shell {
        max-width: 520px;
        margin: 0 auto;
        min-height: 100dvh;
        padding: env(safe-area-inset-top,20px) 16px calc(env(safe-area-inset-bottom, 0px) + 18px);
        display: flex;
        flex-direction: column;
        user-select: none;
        -webkit-user-select: none;
      }
      .wr-top { padding: 4px 0 10px; }
      .wr-progress-row { display:flex; gap:6px; margin-bottom:16px; }
      .wr-progress-track { flex:1; height:4px; border-radius:999px; overflow:hidden; background:rgba(255,253,248,0.24); }
      .wr-progress-fill { display:block; width:100%; height:100%; transform-origin:left center; transform:scaleX(0); background:rgba(255,248,239,0.92); border-radius:inherit; }
      .wr-progress-fill.done, .wr-progress-fill[data-preview="1"].active { transform:scaleX(1); }
      .wr-progress-fill.active { animation: wr-progress linear forwards; }
      .wr-head { padding:8px 0 8px; display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
      .wr-title { color:#fff8ef; font-size:1.28rem; font-weight:900; letter-spacing:-0.03em; }
      .wr-date { color:rgba(244,239,228,0.62); font-size:0.82rem; margin-top:4px; }
      .wr-head-actions { display:flex; align-items:center; gap:8px; }
      .wr-close { background:rgba(255,253,248,0.14); border:1px solid rgba(255,253,248,0.18); color:rgba(255,248,239,0.78); width:38px; height:38px; border-radius:999px; cursor:pointer; flex-shrink:0; display:flex; align-items:center; justify-content:center; box-shadow:0 10px 18px rgba(15,29,25,0.14); }
      .wr-scene { position:relative; flex:1; display:flex; align-items:center; min-height:0; }
      .wr-tap { position:absolute; top:0; bottom:0; width:24%; z-index:5; border:none; background:transparent; user-select:none; -webkit-user-select:none; -webkit-touch-callout:none; touch-action:manipulation; }
      .wr-tap-left { left:0; }
      .wr-tap-right { right:0; }
      .wr-slide { position:relative; width:100%; display:flex; flex-direction:column; justify-content:center; animation:wr-scene-in 0.45s cubic-bezier(0.22,1,0.36,1) both; }
      .wr-card { width:100%; border-radius:30px; padding:26px 24px 26px; box-shadow:0 18px 40px rgba(34, 28, 20, 0.14); min-height:var(--wr-card-uniform-height, clamp(460px, 62dvh, 620px)); height:var(--wr-card-uniform-height, auto); display:flex; flex-direction:column; justify-content:flex-start; user-select:none; -webkit-user-select:none; }
      .wr-reveal { opacity:1; --wr-from-x:0px; --wr-from-y:0px; transform:translate3d(var(--wr-from-x), var(--wr-from-y), 0) scale(1); will-change:transform; animation: wr-reveal ${revealDuration}s cubic-bezier(0.16,1,0.3,1) both; animation-delay: var(--wr-delay, 0s); }
      .wr-reveal[data-preview="1"] { opacity:1; animation:none; transform:none; }
      #week-review-overlay.wr-paused .wr-progress-fill.active,
      #week-review-overlay.wr-paused .wr-reveal { animation-play-state: paused !important; }
      .wr-card-label { display:flex; align-items:center; gap:8px; font-size:0.86rem; font-weight:900; text-transform:uppercase; letter-spacing:0.12em; color:rgba(255,248,239,0.64); margin-bottom:20px; }
      .wr-card-no-label .wr-card-label { display:none; }
      .wr-card-body { flex:1; display:flex; flex-direction:column; justify-content:center; gap:18px; padding-bottom:10px; }
      .wr-card-big { font-size:clamp(3.4rem,15vw,5.6rem); font-weight:900; color:#fff9f1; line-height:0.92; letter-spacing:-0.05em; margin-bottom:16px; text-wrap:balance; }
      .wr-card-sub { font-size:1.18rem; color:rgba(255,246,238,0.78); line-height:1.5; max-width:28rem; }
      .wr-kid-list { display:flex; flex-direction:column; gap:16px; margin-top:14px; overflow:hidden; }
      .wr-kid-list-count-3,
      .wr-kid-list-count-4,
      .wr-kid-list-count-5,
      .wr-kid-list-count-6 { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); align-items:stretch; }
      .wr-kid-list-count-3 .wr-kid-row:last-child,
      .wr-kid-list-count-5 .wr-kid-row:last-child { grid-column:1 / -1; width:min(48%, 220px); justify-self:center; }
      .wr-kid-list-compact { gap:12px; margin-top:28px; }
      .wr-kid-row { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; padding:20px 18px 18px; min-height:138px; text-align:center; background:rgba(255,253,248,0.18); border:1px solid rgba(255,253,248,0.16); border-radius:22px; backdrop-filter:blur(8px); }
      .wr-kid-row-badge { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; text-align:left; gap:14px; }
      .wr-kid-row-no-avatar { grid-template-columns:minmax(0,1fr) auto; }
      .wr-kid-list-compact .wr-kid-row { min-height:112px; padding:14px 12px 13px; gap:8px; border-radius:18px; }
      .wr-kid-avatar { width:54px; height:54px; border-radius:18px; display:inline-flex; align-items:center; justify-content:center; background:rgba(255,250,243,0.78); color:#31453e; font-size:1.9rem; line-height:1; flex-shrink:0; overflow:hidden; }
      .wr-kid-list-compact .wr-kid-avatar { width:44px; height:44px; border-radius:15px; font-size:1.52rem; }
      .wr-kid-copy { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; min-height:96px; }
      .wr-kid-row-badge .wr-kid-copy { align-items:flex-start; text-align:left; }
      .wr-kid-name { font-weight:900; color:#fff9f1; font-size:1.12rem; line-height:1.1; }
      .wr-kid-stat { font-weight:900; color:#fff9f1; font-size:1.12rem; line-height:1.15; }
      .wr-kid-sub { font-size:0.92rem; color:rgba(255,246,238,0.72); line-height:1.35; }
      .wr-kid-row-badge .wr-kid-name { margin-bottom:8px; }
      .wr-kid-row-badge .wr-kid-stat { line-height:1.05; }
      .wr-kid-badge-grid { display:grid; justify-items:center; align-content:center; gap:8px 10px; min-width:88px; }
      .wr-kid-badge-grid-count-1 { grid-template-columns:1fr; }
      .wr-kid-badge-grid-count-2 { grid-template-columns:1fr; }
      .wr-kid-badge-grid-count-3,
      .wr-kid-badge-grid-count-4,
      .wr-kid-badge-grid-count-5,
      .wr-kid-badge-grid-count-6 { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .wr-kid-badge-item { display:flex; flex-direction:column; align-items:center; gap:6px; text-align:center; }
      .wr-kid-badge-item-center { grid-column:1 / -1; }
      .wr-kid-badge-icon { width:52px; height:52px; border-radius:16px; display:flex; align-items:center; justify-content:center; background:rgba(255,250,243,0.84); color:#4b5563; font-size:1.55rem; line-height:1; }
      .wr-kid-badge-name { font-size:0.76rem; font-weight:700; line-height:1.2; color:rgba(255,246,238,0.74); text-wrap:balance; }
      .wr-kid-list-compact .wr-kid-copy { gap:4px; }
      .wr-kid-list-compact .wr-kid-name,
      .wr-kid-list-compact .wr-kid-stat { font-size:0.96rem; }
      .wr-kid-list-compact .wr-kid-sub { font-size:0.8rem; line-height:1.28; }
      .wr-finale { text-align:center; align-items:stretch; }
      .wr-finale .wr-card-body { align-items:center; text-align:center; justify-content:center; padding-top:8px; padding-bottom:18px; }
      .wr-finale .wr-card-big { margin-bottom:0; }
      .wr-finale .wr-card-sub { max-width:18rem; text-align:center; margin-top:18px; }
      .wr-finale-stage-one,
      .wr-finale-stage-two { display:flex; flex-direction:column; align-items:center; width:100%; }
      .wr-finale-stage-two { margin-top:16px; }
      .wr-finale-icon { width:100%; display:flex; align-items:center; justify-content:center; font-size:8.4rem; color:rgba(255,255,255,0.72); margin:-104px 0 -16px; line-height:1; }
      .wr-finale-icon i { display:block; font-size:1em !important; line-height:1; transform:translateY(-36px); }
      .wr-finale-message { font-size:clamp(2.2rem,10vw,3.35rem); font-weight:900; color:#fff9f1; line-height:1.04; letter-spacing:-0.04em; }
      .wr-finale .wr-card-sub { transform:translateY(0); margin-top:12px; }
      .wr-cover-chip-row { display:flex; flex-wrap:nowrap; justify-content:center; gap:8px; margin-top:8px; width:100%; }
      .wr-cover-chip { display:inline-flex; align-items:center; justify-content:center; gap:6px; flex:0 0 auto; width:112px; min-width:112px; padding:9px 10px; border-radius:999px; background:rgba(255,253,248,0.16); border:1px solid rgba(255,253,248,0.16); color:rgba(255,248,239,0.9); font-size:0.72rem; font-weight:700; white-space:nowrap; }
      .wr-measure-host { position:absolute; inset:0; pointer-events:none; visibility:hidden; z-index:-1; overflow:hidden; }
      .wr-measure-slide { position:absolute; inset:0; display:flex; align-items:center; }
      .wr-measure-host .wr-card { min-height:0 !important; height:auto !important; }
      .wr-bottom-note { position:absolute; left:16px; right:16px; bottom:calc(env(safe-area-inset-bottom, 0px) + 8px); text-align:center; color:rgba(255,255,255,0.78); font-size:0.84rem; font-weight:700; }
      @media (max-width: 640px) {
        .wr-reveal-from-bottom { --wr-from-y: calc(100vh + 96px); }
        .wr-reveal-from-bottom-card { --wr-from-y: calc(100vh + 120px); }
        .wr-reveal-from-left { --wr-from-x: calc(-100vw - 120px); }
        .wr-reveal-from-right { --wr-from-x: calc(100vw + 120px); }
        .wr-card { min-height: var(--wr-card-uniform-height, clamp(430px, 58dvh, 560px)); height:var(--wr-card-uniform-height, auto); padding:24px 22px 24px; }
        .wr-card-label { font-size: 0.82rem; }
        .wr-card-body { gap: 16px; padding-bottom: 8px; }
        .wr-card-big { font-size: clamp(3.1rem, 14vw, 4.9rem); }
        .wr-card-sub { font-size: 1.12rem; }
        .wr-kid-list { gap: 14px; margin-top: 10px; }
        .wr-kid-row { min-height: 130px; padding: 18px 16px 16px; gap: 11px; }
        .wr-kid-row-badge { gap: 12px; }
        .wr-kid-avatar { width: 50px; height: 50px; font-size: 1.75rem; }
        .wr-kid-copy { gap: 5px; min-height: 88px; }
        .wr-kid-name, .wr-kid-stat { font-size: 1.04rem; }
        .wr-kid-sub { font-size: 0.88rem; }
        .wr-kid-badge-grid { min-width: 72px; gap: 6px 8px; }
        .wr-kid-badge-icon { width: 44px; height: 44px; border-radius: 14px; font-size: 1.28rem; }
        .wr-kid-badge-name { font-size: 0.68rem; }
        .wr-finale .wr-card-body { padding-top: 2px; padding-bottom: 22px; }
        .wr-finale-stage-two { margin-top: 12px; }
        .wr-finale-icon { font-size: 9.4rem; margin: -112px 0 -20px; }
        .wr-finale-icon i { transform: translateY(-44px); }
        .wr-finale-message { font-size: clamp(2rem, 9vw, 3rem); }
        .wr-finale .wr-card-sub { margin-top: 10px; transform: translateY(0); }
        .wr-kid-list-count-3 .wr-kid-row:last-child,
        .wr-kid-list-count-5 .wr-kid-row:last-child { width:min(48%, 190px); }
        .wr-kid-list-compact { gap: 10px; margin-top: 24px; }
        .wr-kid-list-compact .wr-kid-row { min-height: 104px; padding: 12px 10px; gap: 7px; }
        .wr-kid-list-compact .wr-kid-row-badge { gap: 8px; }
        .wr-kid-list-compact .wr-kid-avatar { width: 38px; height: 38px; font-size: 1.3rem; border-radius: 13px; }
        .wr-kid-list-compact .wr-kid-copy { gap: 3px; min-height: 72px; }
        .wr-kid-list-compact .wr-kid-name, .wr-kid-list-compact .wr-kid-stat { font-size: 0.88rem; }
        .wr-kid-list-compact .wr-kid-sub { font-size: 0.74rem; }
        .wr-kid-list-compact .wr-kid-badge-grid { min-width: 56px; gap: 4px 6px; }
        .wr-kid-list-compact .wr-kid-badge-icon { width: 36px; height: 36px; border-radius: 12px; font-size: 1.05rem; }
        .wr-kid-list-compact .wr-kid-badge-name { font-size: 0.62rem; }
        .wr-cover-chip-row { gap: 6px; }
        .wr-cover-chip { width: 104px; min-width: 104px; padding: 8px 6px; font-size: 0.65rem; gap: 4px; }
        .wr-bottom-note { left: 18px; right: 18px; bottom: calc(env(safe-area-inset-bottom, 0px) + 6px); font-size: 0.76rem; }
      }
    </style>
    <div class="wr-shell">
      <div class="wr-top">
        <div class="wr-progress-row">${progress}</div>
        <div class="wr-head">
          <div>
            <div class="wr-title">Week in Review</div>
            <div class="wr-date">${headerDate}</div>
          </div>
          <div class="wr-head-actions">
            <button onclick="_weekReviewTogglePause()" class="wr-close wr-pause-btn" aria-label="${state.paused ? 'Resume story' : 'Pause story'}"><i class="ph-duotone ${state.paused ? 'ph-play' : 'ph-pause'}" style="font-size:1rem"></i></button>
            <button onclick="closeWeekReview()" class="wr-close" aria-label="Close week in review"><i class="ph-duotone ph-x" style="font-size:1.1rem"></i></button>
          </div>
        </div>
      </div>
      <div class="wr-scene">
        <button class="wr-tap wr-tap-left" aria-label="Previous story" onpointerdown="return handleWeekReviewPress('prev', event)" onpointerup="handleWeekReviewRelease('prev')" onpointercancel="handleWeekReviewRelease('prev')" onpointerleave="handleWeekReviewRelease('prev')" onclick="return handleWeekReviewTap('prev', event)"></button>
        <button class="wr-tap wr-tap-right" aria-label="Next story" onpointerdown="return handleWeekReviewPress('next', event)" onpointerup="handleWeekReviewRelease('next')" onpointercancel="handleWeekReviewRelease('next')" onpointerleave="handleWeekReviewRelease('next')" onclick="return handleWeekReviewTap('next', event)"></button>
        <div class="wr-slide" onpointerdown="return handleWeekReviewCardPress(event)" onpointerup="handleWeekReviewCardRelease()" onpointercancel="handleWeekReviewCardRelease()" onpointerleave="handleWeekReviewCardRelease()">
          ${_weekReviewCardBodyHTML(slide, { previewAttr, totalDiamonds, totalSaved, totalBadges })}
        </div>
      </div>
      ${slide.type === 'finale' ? `<div class="wr-bottom-note wr-reveal wr-reveal-from-bottom" style="--wr-delay:3s">Tap anywhere to close or let the story finish.</div>` : ''}
    </div>`;
}

function _renderWeekReviewStory() {
  const overlay = document.getElementById('week-review-overlay');
  if (!overlay || !_weekReviewStory) return;
  overlay.innerHTML = _weekReviewHTML(_weekReviewStory.slides, _weekReviewStory.index);
  const slides = _weekReviewStory.slides || [];
  const totalDiamonds = slides.find(s => s.label === 'Gems Earned')?.bigStat?.split(' ')[0] || '0';
  const totalSaved = (() => {
    const s = slides.find(s => s.label === 'Gems Earned')?.subStat || '';
    const m = s.match(/-\s([^ ]+\d[\d.,]*)\s+saved/);
    return m ? m[1] : `${D.settings.currency || '$'}0.00`;
  })();
  const totalBadges = slides.find(s => s.label === 'Badges Earned')?.bigStat || '0';
  _weekReviewApplyUniformCardHeight(overlay, slides, { totalDiamonds, totalSaved, totalBadges });
  overlay.classList.toggle('wr-paused', !!_weekReviewStory.paused);
  _weekReviewSyncAudio();
  if (_weekReviewStory.paused) {
    if (_weekReviewStory.timer) {
      clearTimeout(_weekReviewStory.timer);
      _weekReviewStory.timer = null;
    }
    return;
  }
  _weekReviewStartTimer();
}

function _offerInterestDayReminder() {
  // Only prompt the first time savings interest is enabled (if not already set)
  if (D.settings.interestDayNotify !== undefined) return;
  showQuickActionModal(`
    <div class="modal-title"><i class="ph-duotone ph-bell-ringing" style="color:#6C63FF;font-size:1.2rem;vertical-align:middle"></i> Interest Day Reminder</div>
    <p style="font-size:0.88rem;color:var(--muted);line-height:1.6;margin-bottom:16px">
      Would you like a reminder on interest day to have your kids open the app and claim their savings interest?
    </p>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="saveSetting('interestDayNotify',false);closeModal()">No thanks</button>
      <button class="btn btn-primary" onclick="saveSetting('interestDayNotify',true);_enableInterestDayReminder();closeModal()">Yes, remind me</button>
    </div>`);
}

async function scheduleInterestDayNotification() {
  if (!isNative()) return;
  const { LocalNotifications } = Capacitor.Plugins;
  if (!LocalNotifications) return;
  await LocalNotifications.cancel({ notifications: [{ id: 1001 }] }).catch(() => {});
  if (D.settings.interestDayNotify === false ||
      !D.settings.savingsInterestEnabled ||
      D.settings.savingsEnabled === false) return;
  const kids = (D.family?.members || []).filter(m => m.role === 'kid' && !m.deleted && (m.savings || 0) > 0);
  if (kids.length === 0) return;
  const at = _getNextInterestDayDate();
  if (at <= new Date()) return;
  await LocalNotifications.schedule({
    notifications: [{
      id: 1001,
      title: 'Interest Day! Time to claim savings',
      body: 'Have your kids open GemSprout to claim their savings interest',
      schedule: { at },
      badge: 0,
    }]
  }).catch(e => console.warn('scheduleInterestDayNotification error:', e));
}

const APP_UNLOCK_KEY    = 'gemsprout.appUnlocked';
const CURRENT_USER_KEY  = 'gemsprout.currentUserId';
const PARENT_AUTH_KEY   = 'gemsprout.parentAuthUid';
const PARENT_AUTH_PROVIDER_KEY = 'gemsprout.parentAuthProvider';

function getParentAuthUid() {
  try { return localStorage.getItem(PARENT_AUTH_KEY) || null; } catch { return null; }
}

function setParentAuthUid(uid) {
  try {
    if (uid) localStorage.setItem(PARENT_AUTH_KEY, uid);
    else localStorage.removeItem(PARENT_AUTH_KEY);
  } catch {}
}

function isParentSignedIn() {
  return !!getParentAuthUid();
}

function _isRecentParentAuthForMember(member) {
  const recent = S._recentParentAuth;
  if (!recent || !recent.uid || !member) return false;
  const ageMs = Date.now() - recent.at;
  if (ageMs > 2 * 60 * 1000) return false;
  const email = recent.email || '';
  const providers = member.authProviders || [];
  return member.authUid === recent.uid || providers.some(p => p.uid === recent.uid || (email && p.email?.toLowerCase() === email));
}

function ensureParentAuth(member, onSuccess) {
  if (!member || member.role !== 'parent') return true;
  if (isParentSignedIn()) return true;
  if (_isRecentParentAuthForMember(member)) {
    setParentAuthUid(S._recentParentAuth.uid);
    return true;
  }
  showParentSignIn(member.id, onSuccess);
  return false;
}

async function signInWithGoogle() {
  try {
    if (isNative()) {
      const { FirebaseAuthentication } = Capacitor.Plugins;
      const result = await FirebaseAuthentication.signInWithGoogle();
      const credential = firebase.auth.GoogleAuthProvider.credential(result.credential?.idToken);
      const userCredential = await auth.signInWithCredential(credential);
      subscribeToFirestore(); // re-establish listener under new auth token
      return userCredential.user;
    } else {
      const provider = new firebase.auth.GoogleAuthProvider();
      await auth.signInWithPopup(provider);
      return auth.currentUser;
    }
  } catch(e) {
    if (e.code !== 'auth/cancelled-popup-request' && e.message !== 'Sign in cancelled.') {
      console.warn('Google sign-in failed:', e.message);
    }
    return null;
  }
}

function _authProviderIcon() {
  let pid;
  try { pid = localStorage.getItem(PARENT_AUTH_PROVIDER_KEY); } catch {}
  if (!pid) pid = auth.currentUser?.providerData?.[0]?.providerId;
  if (pid === 'google.com') return '<img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" style="width:22px;height:22px;flex-shrink:0">';
  if (pid === 'apple.com')  return '<svg width="22" height="22" viewBox="0 0 24 24" fill="#000" style="flex-shrink:0" xmlns="http://www.w3.org/2000/svg"><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701z"/></svg>';
  return '<i class="ph-duotone ph-user-circle" style="font-size:1.3rem;flex-shrink:0"></i>';
}

async function signInWithApple() {
  try {
    if (isNative()) {
      const { FirebaseAuthentication } = Capacitor.Plugins;
      const result = await FirebaseAuthentication.signInWithApple();
      const provider = new firebase.auth.OAuthProvider('apple.com');
      const credential = provider.credential({
        idToken: result.credential?.idToken,
        rawNonce: result.credential?.nonce,
      });
      const userCredential = await auth.signInWithCredential(credential);
      subscribeToFirestore(); // re-establish listener under new auth token
      return userCredential.user;
    } else {
      const provider = new firebase.auth.OAuthProvider('apple.com');
      await auth.signInWithPopup(provider);
      return auth.currentUser;
    }
  } catch(e) {
    if (e.message !== 'Sign in cancelled.') {
      console.warn('Apple sign-in failed:', e.message);
    }
    return null;
  }
}

async function signOutParent() {
  try {
    await auth.signOut();
  } catch(e) {
    console.warn('Sign out error:', e.message);
  } finally {
    setParentAuthUid(null);
  }
}

async function linkParentAuth(firebaseUser, memberId, overrideProviderId) {
  setParentAuthUid(firebaseUser.uid);
  try {
    const pid = overrideProviderId || firebaseUser.providerData?.[0]?.providerId;
    if (pid) localStorage.setItem(PARENT_AUTH_PROVIDER_KEY, pid);
  } catch {}
  const member = getMember(memberId);
  if (!member) return;
  if (!member.authUid) member.authUid = firebaseUser.uid;
  if (!member.authProviders) member.authProviders = [];
  const pid   = overrideProviderId || firebaseUser.providerData?.[0]?.providerId || 'unknown';
  const email = firebaseUser.email || firebaseUser.providerData?.[0]?.email || '';
  const entry = { providerId: pid, uid: firebaseUser.uid, email };
  const idx = member.authProviders.findIndex(p => p.providerId === pid);
  if (idx >= 0) member.authProviders[idx] = entry; else member.authProviders.push(entry);
  member.authUids = member.authProviders.map(p => p.uid); // for future Firestore array-contains queries
  saveData();
  db.doc(`users/${firebaseUser.uid}`).set({ familyCode: getFamilyCode(), uid: firebaseUser.uid, email: (firebaseUser.email || '').toLowerCase() }, { merge: true })
    .catch(e => console.warn('users doc write failed:', e));
  initPushNotifications(firebaseUser);
  syncAppBadge();
}

function setAppUnlocked(v) {
  try { localStorage.setItem(APP_UNLOCK_KEY, v ? '1' : '0'); } catch (_) {}
}

function isAppUnlocked() {
  try { return localStorage.getItem(APP_UNLOCK_KEY) === '1'; }
  catch (_) { return false; }
}

function setCurrentUserId(id) {
  try {
    if (id) localStorage.setItem(CURRENT_USER_KEY, id);
    else localStorage.removeItem(CURRENT_USER_KEY);
  } catch (_) {}
}

function getCurrentUserId() {
  try { return localStorage.getItem(CURRENT_USER_KEY) || ''; }
  catch (_) { return ''; }
}

function showAppPin() {
  if (!D.settings || !D.settings.parentPin) {
    setAppUnlocked(true);
    renderHome();
    return;
  }
  setAppUnlocked(false);
  showScreen('screen-pin');
  S.pinBuffer = '';
  S.pinMode   = 'app';
  document.getElementById('pin-content').innerHTML = `
    <img class="pin-avatar" src="gemsproutpadded.png">
    <div class="pin-title">GemSprout</div>
    <div class="pin-sub">Enter parent PIN to continue</div>
    <div class="pin-dots" id="pin-dots">
      <div class="pin-dot" id="pd0"></div>
      <div class="pin-dot" id="pd1"></div>
      <div class="pin-dot" id="pd2"></div>
      <div class="pin-dot" id="pd3"></div>
    </div>
    <div class="pin-grid">
      ${[1,2,3,4,5,6,7,8,9,'',0,'Del'].map(k => `
        <button class="pin-key${k===''?' hidden':''}" onclick="pinKey('${k}')">${k}</button>
      `).join('')}
    </div>
    <div id="pin-error" class="pin-error hidden"></div>
    ${getBiometricCredentialId() ? `<button class="btn btn-secondary mt-16" style="width:min(360px,calc(100vw - 48px))" onclick="tryBiometricUnlock()"><i class="ph-duotone ph-fingerprint" style="font-size:1rem;vertical-align:middle"></i> Use ${getBiometricLabel()}</button>` : ''}`;
  clearTimeout(S._biometricTimer);
  if (getBiometricCredentialId()) {
    S._biometricTimer = setTimeout(() => tryBiometricUnlock(), 400);
  }
}

function goHome() {
  clearScrollMemory();
  resetPrimaryTabs();
  S._activeViewUserId = '';
  S._activeViewRole = '';
  S.currentUser = null;
  setCurrentUserId('');
  renderHome();
}

function signOutAndGoHome() {
  const wasParent = S.currentUser?.role === 'parent';
  clearScrollMemory();
  resetPrimaryTabs();
  S._activeViewUserId = '';
  S._activeViewRole = '';
  S.currentUser = null;
  setCurrentUserId('');
  setParentAuthUid(null);
  try { localStorage.removeItem(PARENT_AUTH_PROVIDER_KEY); } catch {}
  if (wasParent) signOutParent().finally(() => {
    auth.signInAnonymously().catch(() => {});
    renderHome();
  });
  else showAppPin();
}

'use strict';

const AVATARS = [
                 '<i class="ph-duotone ph-smiley" style="color:#F59E0B"></i>',
                 '<i class="ph-duotone ph-cat" style="color:#EC4899"></i>',
                 '<i class="ph-duotone ph-dog" style="color:#8B5CF6"></i>',
                 '<i class="ph-duotone ph-rabbit" style="color:#10B981"></i>',
                 '<i class="ph-duotone ph-bird" style="color:#3B82F6"></i>',
                 '<i class="ph-duotone ph-star" style="color:#F59E0B"></i>',
                 '<i class="ph-duotone ph-rocket-launch" style="color:#6C63FF"></i>',
                 '<i class="ph-duotone ph-heart" style="color:#EF4444"></i>',
                 '<i class="ph-duotone ph-crown" style="color:#F59E0B"></i>',
                 '<i class="ph-duotone ph-flower" style="color:#EC4899"></i>',
                 '<i class="ph-duotone ph-football" style="color:#F97316"></i>',
                 '<i class="ph-duotone ph-basketball" style="color:#FB923C"></i>',
                 '<i class="ph-duotone ph-soccer-ball" style="color:#22C55E"></i>',
                 '<i class="ph-duotone ph-baseball" style="color:#0EA5E9"></i>',
                 '<i class="ph-duotone ph-game-controller" style="color:#8B5CF6"></i>',
                 '<i class="ph-duotone ph-pizza" style="color:#F97316"></i>',
                 '<i class="ph-duotone ph-ice-cream" style="color:#EC4899"></i>',
                 '<i class="ph-duotone ph-cookie" style="color:#92400E"></i>',
                 '<i class="ph-duotone ph-moon-stars" style="color:#6366F1"></i>',
                 '<i class="ph-duotone ph-sun" style="color:#FACC15"></i>',
                 '<i class="ph-duotone ph-rainbow" style="color:#14B8A6"></i>',
                 '<i class="ph-duotone ph-planet" style="color:#3B82F6"></i>',
                 '<i class="ph-duotone ph-acorn" style="color:#A16207"></i>',
                 '<i class="ph-duotone ph-tree" style="color:#16A34A"></i>',
                 '<i class="ph-duotone ph-bug" style="color:#84CC16"></i>',
                 '<i class="ph-duotone ph-fish" style="color:#06B6D4"></i>',
                 '<i class="ph-duotone ph-balloon" style="color:#D97706"></i>',
                 '<i class="ph-duotone ph-lightning" style="color:#F59E0B"></i>',
                 '<i class="ph-duotone ph-sparkle" style="color:#EC4899"></i>',
                 '<i class="ph-duotone ph-medal" style="color:#7C3AED"></i>'
];

const COLORS  = ['#6C63FF','#FF6584','#43D9AD','#FFD93D','#6BCB77',
                 '#FF9A3C','#4ECDC4','#45B7D1','#E91E63','#9C27B0'];

function _applyAvatarColor(html, color) {
  if (!html || !color || /\.(png|jpe?g|gif|webp)$/i.test(html)) return html;
  if (html.includes('style=')) {
    if (/color\s*:\s*[^;"']+/i.test(html)) {
      return html.replace(/color\s*:\s*[^;"']+/i, `color:${color}`);
    }
    return html.replace(/style=(['"])(.*?)\1/i, (m, q, style) => `style=${q}${style};color:${color}${q}`);
  }
  return html.replace(/^<i\b/i, `<i style="color:${color}"`);
}

// Returns displayable HTML for an avatar value (emoji or image path)
function renderAvatarHtml(a, fallback = '<i class="ph-duotone ph-smiley" style="color:#9CA3AF"></i>', colorOverride = '') {
  const src = a || fallback;
  if (!src) return fallback;
  if (/\.(png|jpe?g|gif|webp)$/i.test(src)) return `<img src="${src}" class="avatar-img">`;
  return colorOverride ? _applyAvatarColor(src, colorOverride) : src;
}

function renderMemberAvatarHtml(member, fallback = '<i class="ph-duotone ph-smiley" style="color:#9CA3AF"></i>') {
  if (!member) return fallback;
  const defaultFallback = member.role === 'parent'
    ? '<i class="ph-duotone ph-user-circle" style="color:#9CA3AF"></i>'
    : fallback;
  return renderAvatarHtml(member.avatar, defaultFallback, member.avatarColor || member.color || '');
}

const ICONS = {
  home:     `<svg viewBox="0 0 28 28" fill="none" width="1em" height="1em"><path d="M14 4L3 13h3v10h6v-6h4v6h6V13h3L14 4z" fill="#6C63FF" fill-opacity=".18" stroke="#6C63FF" stroke-width="1.8" stroke-linejoin="round"/><rect x="11.5" y="17" width="5" height="6" rx="1.2" fill="#6C63FF" opacity=".5"/></svg>`,
  chores:   `<svg viewBox="0 0 28 28" fill="none" width="1em" height="1em"><rect x="6" y="5" width="16" height="20" rx="3" fill="#6BCB77" fill-opacity=".18" stroke="#6BCB77" stroke-width="1.8"/><rect x="10" y="3.5" width="8" height="4" rx="2" fill="#6BCB77"/><line x1="10" y1="12" x2="18" y2="12" stroke="#6BCB77" stroke-width="1.6" stroke-linecap="round"/><line x1="10" y1="16" x2="18" y2="16" stroke="#6BCB77" stroke-width="1.6" stroke-linecap="round"/><polyline points="10,21.5 12.5,24 18,18" stroke="#6BCB77" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`,
  diamond:  `<i class="ph-duotone ph-diamond" style="color:#6C63FF"></i>`,
  shop:     `<svg viewBox="0 0 28 28" fill="none" width="1em" height="1em"><path d="M6 11h16l-1.5 15H7.5L6 11z" fill="#FFD93D" fill-opacity=".28" stroke="#FF9A3C" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 11V8.5C10 5.9 11.8 4 14 4s4 1.9 4 4.5V11" stroke="#FF9A3C" stroke-width="1.9" stroke-linecap="round" fill="none"/><line x1="9.5" y1="18.5" x2="18.5" y2="18.5" stroke="#FF9A3C" stroke-width="1.5" stroke-linecap="round" opacity=".6"/></svg>`,
  team:     `<svg viewBox="0 0 28 28" fill="none" width="1em" height="1em"><path d="M9 4h10v12c0 2.8-2.2 5-5 5s-5-2.2-5-5V4z" fill="#FFD93D" fill-opacity=".3" stroke="#FFD93D" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 8H5v4c0 2.2 1.8 4 4 4" stroke="#FFD93D" stroke-width="1.8" stroke-linecap="round" fill="none"/><path d="M19 8h4v4c0 2.2-1.8 4-4 4" stroke="#FFD93D" stroke-width="1.8" stroke-linecap="round" fill="none"/><line x1="14" y1="21" x2="14" y2="24" stroke="#FFD93D" stroke-width="1.8" stroke-linecap="round"/><line x1="10" y1="24" x2="18" y2="24" stroke="#FFD93D" stroke-width="2.2" stroke-linecap="round"/></svg>`,
  stats:    `<svg viewBox="0 0 28 28" fill="none" width="1em" height="1em"><circle cx="14" cy="14" r="9.5" fill="#45B7D1" fill-opacity=".16" stroke="#45B7D1" stroke-width="1.8"/><path d="M14 4.5a9.5 9.5 0 0 1 8.86 6.06L14 14V4.5z" fill="#45B7D1" fill-opacity=".85"/><path d="M14 14l-5.9 7.44A9.5 9.5 0 0 1 4.5 14H14z" fill="#45B7D1" fill-opacity=".38"/><circle cx="14" cy="14" r="2.3" fill="#45B7D1"/></svg>`,
  prizes:   `<svg viewBox="0 0 28 28" fill="none" width="1em" height="1em"><rect x="4" y="13" width="20" height="11" rx="2" fill="#FF6584" fill-opacity=".18" stroke="#FF6584" stroke-width="1.8"/><rect x="4" y="9" width="20" height="5" rx="2" fill="#FF6584" fill-opacity=".3" stroke="#FF6584" stroke-width="1.8"/><line x1="14" y1="9" x2="14" y2="24" stroke="#FF6584" stroke-width="1.8"/><path d="M14 9c-1-2.5-4.5-4-5.5-1.5S11 10.5 14 9z" fill="#FF6584"/><path d="M14 9c1-2.5 4.5-4 5.5-1.5S17 10.5 14 9z" fill="#FF6584"/><circle cx="14" cy="9" r="1.6" fill="#FF6584"/></svg>`,
  plans:    `<svg viewBox="0 0 28 28" fill="none" width="1em" height="1em"><rect x="4" y="7" width="20" height="18" rx="3" fill="#43D9AD" fill-opacity=".18" stroke="#43D9AD" stroke-width="1.8"/><line x1="4" y1="13" x2="24" y2="13" stroke="#43D9AD" stroke-width="1.8"/><line x1="9" y1="4" x2="9" y2="10" stroke="#43D9AD" stroke-width="1.8" stroke-linecap="round"/><line x1="19" y1="4" x2="19" y2="10" stroke="#43D9AD" stroke-width="1.8" stroke-linecap="round"/><rect x="7.5" y="16" width="3.5" height="3.5" rx=".8" fill="#43D9AD" opacity=".8"/><rect x="12.5" y="16" width="3.5" height="3.5" rx=".8" fill="#43D9AD" opacity=".5"/><rect x="17.5" y="16" width="3.5" height="3.5" rx=".8" fill="#43D9AD" opacity=".5"/><rect x="7.5" y="20.5" width="3.5" height="3.5" rx=".8" fill="#43D9AD" opacity=".35"/></svg>`,
  settings: `<svg viewBox="0 0 28 28" fill="none" width="1em" height="1em"><line x1="4" y1="8" x2="24" y2="8" stroke="#FF9A3C" stroke-width="1.8" stroke-linecap="round" opacity=".35"/><line x1="4" y1="14" x2="24" y2="14" stroke="#FF9A3C" stroke-width="1.8" stroke-linecap="round" opacity=".35"/><line x1="4" y1="20" x2="24" y2="20" stroke="#FF9A3C" stroke-width="1.8" stroke-linecap="round" opacity=".35"/><circle cx="10" cy="8" r="3.2" fill="#FF9A3C"/><circle cx="18" cy="14" r="3.2" fill="#FF9A3C"/><circle cx="10" cy="20" r="3.2" fill="#FF9A3C"/></svg>`,
  family:   `<svg viewBox="0 0 28 28" fill="none" width="1em" height="1em"><circle cx="9.5" cy="8.5" r="3.5" fill="#FF6584" fill-opacity=".3" stroke="#FF6584" stroke-width="1.7"/><circle cx="18.5" cy="8.5" r="3.5" fill="#FF6584" fill-opacity=".3" stroke="#FF6584" stroke-width="1.7"/><path d="M2 24c0-4.2 3.4-7.5 7.5-7.5" stroke="#FF6584" stroke-width="1.7" stroke-linecap="round" fill="none" opacity=".5"/><path d="M11 24c0-4.2 3.4-7.5 7.5-7.5S26 19.8 26 24" stroke="#FF6584" stroke-width="1.7" stroke-linecap="round" fill="none"/></svg>`,
  today:    `<svg viewBox="0 0 28 28" fill="none" width="1em" height="1em"><rect x="4" y="7" width="20" height="18" rx="3" fill="#43D9AD" fill-opacity=".18" stroke="#43D9AD" stroke-width="1.8"/><line x1="4" y1="13" x2="24" y2="13" stroke="#43D9AD" stroke-width="1.8"/><line x1="9" y1="4" x2="9" y2="10" stroke="#43D9AD" stroke-width="1.8" stroke-linecap="round"/><line x1="19" y1="4" x2="19" y2="10" stroke="#43D9AD" stroke-width="1.8" stroke-linecap="round"/><circle cx="14" cy="19.5" r="4" fill="#43D9AD" opacity=".8"/></svg>`,
  levels:   `<svg viewBox="0 0 28 28" fill="none" width="1em" height="1em"><rect x="3" y="19" width="5" height="6" rx="1.2" fill="#6C63FF" fill-opacity=".25" stroke="#6C63FF" stroke-width="1.6"/><rect x="10" y="14" width="5" height="11" rx="1.2" fill="#6C63FF" fill-opacity=".5" stroke="#6C63FF" stroke-width="1.6"/><rect x="17" y="9" width="5" height="16" rx="1.2" fill="#6C63FF" stroke="#6C63FF" stroke-width="1.6"/><path d="M19.5 3l.9 1.9 2.1.4-1.5 1.4.4 2-1.9-1-1.9 1 .4-2L16.5 5.3l2.1-.4L19.5 3z" fill="#FFD93D" stroke="#D97706" stroke-width=".6" stroke-linejoin="round"/></svg>`,
};

const _ICON_NAMES = 'acorn,address-book,address-book-tabs,air-traffic-control,airplane,airplane-in-flight,airplane-landing,airplane-takeoff,airplane-taxiing,airplane-tilt,airplay,alarm,alien,align-bottom,align-bottom-simple,align-center-horizontal,align-center-horizontal-simple,align-center-vertical,align-center-vertical-simple,align-left,align-left-simple,align-right,align-right-simple,align-top,align-top-simple,amazon-logo,ambulance,anchor,anchor-simple,android-logo,angle,angular-logo,aperture,app-store-logo,app-window,apple-logo,apple-podcasts-logo,approximate-equals,archive,armchair,arrow-arc-left,arrow-arc-right,arrow-bend-double-up-left,arrow-bend-double-up-right,arrow-bend-down-left,arrow-bend-down-right,arrow-bend-left-down,arrow-bend-left-up,arrow-bend-right-down,arrow-bend-right-up,arrow-bend-up-left,arrow-bend-up-right,arrow-circle-down,arrow-circle-down-left,arrow-circle-down-right,arrow-circle-left,arrow-circle-right,arrow-circle-up,arrow-circle-up-left,arrow-circle-up-right,arrow-clockwise,arrow-counter-clockwise,arrow-down,arrow-down-left,arrow-down-right,arrow-elbow-down-left,arrow-elbow-down-right,arrow-elbow-left,arrow-elbow-left-down,arrow-elbow-left-up,arrow-elbow-right,arrow-elbow-right-down,arrow-elbow-right-up,arrow-elbow-up-left,arrow-elbow-up-right,arrow-fat-down,arrow-fat-left,arrow-fat-line-down,arrow-fat-line-left,arrow-fat-line-right,arrow-fat-line-up,arrow-fat-lines-down,arrow-fat-lines-left,arrow-fat-lines-right,arrow-fat-lines-up,arrow-fat-right,arrow-fat-up,arrow-left,arrow-line-down,arrow-line-down-left,arrow-line-down-right,arrow-line-left,arrow-line-right,arrow-line-up,arrow-line-up-left,arrow-line-up-right,arrow-right,arrow-square-down,arrow-square-down-left,arrow-square-down-right,arrow-square-in,arrow-square-left,arrow-square-out,arrow-square-right,arrow-square-up,arrow-square-up-left,arrow-square-up-right,arrow-u-down-left,arrow-u-down-right,arrow-u-left-down,arrow-u-left-up,arrow-u-right-down,arrow-u-right-up,arrow-u-up-left,arrow-u-up-right,arrow-up,arrow-up-left,arrow-up-right,arrows-clockwise,arrows-counter-clockwise,arrows-down-up,arrows-horizontal,arrows-in,arrows-in-cardinal,arrows-in-line-horizontal,arrows-in-line-vertical,arrows-in-simple,arrows-left-right,arrows-merge,arrows-out,arrows-out-cardinal,arrows-out-line-horizontal,arrows-out-line-vertical,arrows-out-simple,arrows-split,arrows-vertical,article,article-medium,article-ny-times,asclepius,asterisk,asterisk-simple,at,atom,avocado,axe,baby,baby-carriage,backpack,backspace,bag,bag-simple,balloon,bandaids,bank,barbell,barcode,barn,barricade,baseball,baseball-cap,baseball-helmet,basket,basketball,bathtub,battery-charging,battery-charging-vertical,battery-empty,battery-full,battery-high,battery-low,battery-medium,battery-plus,battery-plus-vertical,battery-vertical-empty,battery-vertical-full,battery-vertical-high,battery-vertical-low,battery-vertical-medium,battery-warning,battery-warning-vertical,beach-ball,beanie,bed,beer-bottle,beer-stein,behance-logo,bell,bell-ringing,bell-simple,bell-simple-ringing,bell-simple-slash,bell-simple-z,bell-slash,bell-z,belt,bezier-curve,bicycle,binary,binoculars,biohazard,bird,blueprint,bluetooth,bluetooth-connected,bluetooth-slash,bluetooth-x,boat,bomb,bone,book,book-bookmark,book-open,book-open-text,book-open-user,bookmark,bookmark-simple,bookmarks,bookmarks-simple,books,boot,boules,bounding-box,bowl-food,bowl-steam,bowling-ball,box-arrow-down,box-arrow-up,boxing-glove,brackets-angle,brackets-curly,brackets-round,brackets-square,brain,brandy,bread,bridge,briefcase,briefcase-metal,broadcast,broom,browser,browsers,bug,bug-beetle,bug-droid,building,building-apartment,building-office,buildings,bulldozer,bus,butterfly,cable-car,cactus,cake,calculator,calendar,calendar-blank,calendar-check,calendar-dot,calendar-dots,calendar-heart,calendar-minus,calendar-plus,calendar-slash,calendar-star,calendar-x,call-bell,camera,camera-plus,camera-rotate,camera-slash,campfire,car,car-battery,car-profile,car-simple,cardholder,cards,cards-three,caret-circle-double-down,caret-circle-double-left,caret-circle-double-right,caret-circle-double-up,caret-circle-down,caret-circle-left,caret-circle-right,caret-circle-up,caret-circle-up-down,caret-double-down,caret-double-left,caret-double-right,caret-double-up,caret-down,caret-left,caret-line-down,caret-line-left,caret-line-right,caret-line-up,caret-right,caret-up,caret-up-down,carrot,cash-register,cassette-tape,castle-turret,cat,cell-signal-full,cell-signal-high,cell-signal-low,cell-signal-medium,cell-signal-none,cell-signal-slash,cell-signal-x,cell-tower,certificate,chair,chalkboard,chalkboard-simple,chalkboard-teacher,champagne,charging-station,chart-bar,chart-bar-horizontal,chart-donut,chart-line,chart-line-down,chart-line-up,chart-pie,chart-pie-slice,chart-polar,chart-scatter,chat,chat-centered,chat-centered-dots,chat-centered-slash,chat-centered-text,chat-circle,chat-circle-dots,chat-circle-slash,chat-circle-text,chat-dots,chat-slash,chat-teardrop,chat-teardrop-dots,chat-teardrop-slash,chat-teardrop-text,chat-text,chats,chats-circle,chats-teardrop,check,check-circle,check-fat,check-square,check-square-offset,checkerboard,checks,cheers,cheese,chef-hat,cherries,church,cigarette,cigarette-slash,circle,circle-dashed,circle-half,circle-half-tilt,circle-notch,circles-four,circles-three,circles-three-plus,circuitry,city,clipboard,clipboard-text,clock,clock-afternoon,clock-clockwise,clock-countdown,clock-counter-clockwise,clock-user,closed-captioning,cloud,cloud-arrow-down,cloud-arrow-up,cloud-check,cloud-fog,cloud-lightning,cloud-moon,cloud-rain,cloud-slash,cloud-snow,cloud-sun,cloud-warning,cloud-x,clover,club,coat-hanger,coda-logo,code,code-block,code-simple,codepen-logo,codesandbox-logo,coffee,coffee-bean,coin,coin-vertical,coins,columns,columns-plus-left,columns-plus-right,command,compass,compass-rose,compass-tool,computer-tower,confetti,contactless-payment,control,cookie,cooking-pot,copy,copy-simple,copyleft,copyright,corners-in,corners-out,couch,court-basketball,cow,cowboy-hat,cpu,crane,crane-tower,credit-card,cricket,crop,cross,crosshair,crosshair-simple,crown,crown-cross,crown-simple,cube,cube-focus,cube-transparent,currency-btc,currency-circle-dollar,currency-cny,currency-dollar,currency-dollar-simple,currency-eth,currency-eur,currency-gbp,currency-inr,currency-jpy,currency-krw,currency-kzt,currency-ngn,currency-rub,cursor,cursor-click,cursor-text,cylinder,database,desk,desktop,desktop-tower,detective,dev-to-logo,device-mobile,device-mobile-camera,device-mobile-slash,device-mobile-speaker,device-rotate,device-tablet,device-tablet-camera,device-tablet-speaker,devices,diamond,diamonds-four,dice-five,dice-four,dice-one,dice-six,dice-three,dice-two,disc,disco-ball,discord-logo,divide,dna,dog,door,door-open,dot,dot-outline,dots-nine,dots-six,dots-six-vertical,dots-three,dots-three-circle,dots-three-circle-vertical,dots-three-outline,dots-three-outline-vertical,dots-three-vertical,download,download-simple,dress,dresser,dribbble-logo,drone,drop,drop-half,drop-half-bottom,drop-simple,drop-slash,dropbox-logo,ear,ear-slash,egg,egg-crack,eject,eject-simple,elevator,empty,engine,envelope,envelope-open,envelope-simple,envelope-simple-open,equalizer,equals,eraser,escalator-down,escalator-up,exam,exclamation-mark,exclude,exclude-square,export,eye,eye-closed,eye-slash,eyedropper,eyedropper-sample,eyeglasses,eyes,face-mask,facebook-logo,factory,faders,faders-horizontal,fallout-shelter,fan,farm,fast-forward,fast-forward-circle,feather,fediverse-logo,figma-logo,file,file-archive,file-arrow-down,file-arrow-up,file-audio,file-c,file-c-sharp,file-cloud,file-code,file-cpp,file-css,file-csv,file-dashed,file-doc,file-html,file-image,file-ini,file-jpg,file-js,file-jsx,file-lock,file-magnifying-glass,file-md,file-minus,file-pdf,file-plus,file-png,file-ppt,file-py,file-rs,file-sql,file-svg,file-text,file-ts,file-tsx,file-txt,file-video,file-vue,file-x,file-xls,file-zip,files,film-reel,film-script,film-slate,film-strip,fingerprint,fingerprint-simple,finn-the-human,fire,fire-extinguisher,fire-simple,fire-truck,first-aid,first-aid-kit,fish,fish-simple,flag,flag-banner,flag-banner-fold,flag-checkered,flag-pennant,flame,flashlight,flask,flip-horizontal,flip-vertical,floppy-disk,floppy-disk-back,flow-arrow,flower,flower-lotus,flower-tulip,flying-saucer,folder,folder-dashed,folder-lock,folder-minus,folder-open,folder-plus,folder-simple,folder-simple-dashed,folder-simple-lock,folder-simple-minus,folder-simple-plus,folder-simple-star,folder-simple-user,folder-star,folder-user,folders,football,football-helmet,footprints,fork-knife,four-k,frame-corners,framer-logo,function,funnel,funnel-simple,funnel-simple-x,funnel-x,game-controller,garage,gas-can,gas-pump,gauge,gavel,gear,gear-fine,gear-six,gender-female,gender-intersex,gender-male,gender-neuter,gender-nonbinary,gender-transgender,ghost,gif,gift,git-branch,git-commit,git-diff,git-fork,git-merge,git-pull-request,github-logo,gitlab-logo,gitlab-logo-simple,globe,globe-hemisphere-east,globe-hemisphere-west,globe-simple,globe-simple-x,globe-stand,globe-x,goggles,golf,goodreads-logo,google-cardboard-logo,google-chrome-logo,google-drive-logo,google-logo,google-photos-logo,google-play-logo,google-podcasts-logo,gps,gps-fix,gps-slash,gradient,graduation-cap,grains,grains-slash,graph,graphics-card,greater-than,greater-than-or-equal,grid-four,grid-nine,guitar,hair-dryer,hamburger,hammer,hand,hand-arrow-down,hand-arrow-up,hand-coins,hand-deposit,hand-eye,hand-fist,hand-grabbing,hand-heart,hand-palm,hand-peace,hand-pointing,hand-soap,hand-swipe-left,hand-swipe-right,hand-tap,hand-waving,hand-withdraw,handbag,handbag-simple,hands-clapping,hands-praying,handshake,hard-drive,hard-drives,hard-hat,hash,hash-straight,head-circuit,headlights,headphones,headset,heart,heart-break,heart-half,heart-straight,heart-straight-break,heartbeat,hexagon,high-definition,high-heel,highlighter,highlighter-circle,hockey,hoodie,horse,hospital,hourglass,hourglass-high,hourglass-low,hourglass-medium,hourglass-simple,hourglass-simple-high,hourglass-simple-low,hourglass-simple-medium,house,house-line,house-simple,hurricane,ice-cream,identification-badge,identification-card,image,image-broken,image-square,images,images-square,infinity,info,instagram-logo,intersect,intersect-square,intersect-three,intersection,invoice,island,jar,jar-label,jeep,joystick,kanban,key,key-return,keyboard,keyhole,knife,ladder,ladder-simple,lamp,lamp-pendant,laptop,lasso,lastfm-logo,layout,leaf,lectern,lego,lego-smiley,less-than,less-than-or-equal,letter-circle-h,letter-circle-p,letter-circle-v,lifebuoy,lightbulb,lightbulb-filament,lighthouse,lightning,lightning-a,lightning-slash,line-segment,line-segments,line-vertical,link,link-break,link-simple,link-simple-break,link-simple-horizontal,link-simple-horizontal-break,linkedin-logo,linktree-logo,linux-logo,list,list-bullets,list-checks,list-dashes,list-heart,list-magnifying-glass,list-numbers,list-plus,list-star,lock,lock-key,lock-key-open,lock-laminated,lock-laminated-open,lock-open,lock-simple,lock-simple-open,lockers,log,magic-wand,magnet,magnet-straight,magnifying-glass,magnifying-glass-minus,magnifying-glass-plus,mailbox,map-pin,map-pin-area,map-pin-line,map-pin-plus,map-pin-simple,map-pin-simple-area,map-pin-simple-line,map-trifold,markdown-logo,marker-circle,martini,mask-happy,mask-sad,mastodon-logo,math-operations,matrix-logo,medal,medal-military,medium-logo,megaphone,megaphone-simple,member-of,memory,messenger-logo,meta-logo,meteor,metronome,microphone,microphone-slash,microphone-stage,microscope,microsoft-excel-logo,microsoft-outlook-logo,microsoft-powerpoint-logo,microsoft-teams-logo,microsoft-word-logo,minus,minus-circle,minus-square,money,money-wavy,monitor,monitor-arrow-up,monitor-play,moon,moon-stars,moped,moped-front,mosque,motorcycle,mountains,mouse,mouse-left-click,mouse-middle-click,mouse-right-click,mouse-scroll,mouse-simple,music-note,music-note-simple,music-notes,music-notes-minus,music-notes-plus,music-notes-simple,navigation-arrow,needle,network,network-slash,network-x,newspaper,newspaper-clipping,not-equals,not-member-of,not-subset-of,not-superset-of,notches,note,note-blank,note-pencil,notebook,notepad,notification,notion-logo,nuclear-plant,number-circle-eight,number-circle-five,number-circle-four,number-circle-nine,number-circle-one,number-circle-seven,number-circle-six,number-circle-three,number-circle-two,number-circle-zero,number-eight,number-five,number-four,number-nine,number-one,number-seven,number-six,number-square-eight,number-square-five,number-square-four,number-square-nine,number-square-one,number-square-seven,number-square-six,number-square-three,number-square-two,number-square-zero,number-three,number-two,number-zero,numpad,nut,ny-times-logo,octagon,office-chair,onigiri,open-ai-logo,option,orange,orange-slice,oven,package,paint-brush,paint-brush-broad,paint-brush-household,paint-bucket,paint-roller,palette,panorama,pants,paper-plane,paper-plane-right,paper-plane-tilt,paperclip,paperclip-horizontal,parachute,paragraph,parallelogram,park,password,path,patreon-logo,pause,pause-circle,paw-print,paypal-logo,peace,pen,pen-nib,pen-nib-straight,pencil,pencil-circle,pencil-line,pencil-ruler,pencil-simple,pencil-simple-line,pencil-simple-slash,pencil-slash,pentagon,pentagram,pepper,percent,person,person-arms-spread,person-simple,person-simple-bike,person-simple-circle,person-simple-hike,person-simple-run,person-simple-ski,person-simple-snowboard,person-simple-swim,person-simple-tai-chi,person-simple-throw,person-simple-walk,perspective,phone,phone-call,phone-disconnect,phone-incoming,phone-list,phone-outgoing,phone-pause,phone-plus,phone-slash,phone-transfer,phone-x,phosphor-logo,pi,piano-keys,picnic-table,picture-in-picture,piggy-bank,pill,ping-pong,pint-glass,pinterest-logo,pinwheel,pipe,pipe-wrench,pix-logo,pizza,placeholder,planet,plant,play,play-circle,play-pause,playlist,plug,plug-charging,plugs,plugs-connected,plus,plus-circle,plus-minus,plus-square,poker-chip,police-car,polygon,popcorn,popsicle,potted-plant,power,prescription,presentation,presentation-chart,printer,prohibit,prohibit-inset,projector-screen,projector-screen-chart,pulse,push-pin,push-pin-simple,push-pin-simple-slash,push-pin-slash,puzzle-piece,qr-code,question,question-mark,queue,quotes,rabbit,racquet,radical,radio,radio-button,radioactive,rainbow,rainbow-cloud,ranking,read-cv-logo,receipt,receipt-x,record,rectangle,rectangle-dashed,recycle,reddit-logo,repeat,repeat-once,replit-logo,resize,rewind,rewind-circle,road-horizon,robot,rocket,rocket-launch,rows,rows-plus-bottom,rows-plus-top,rss,rss-simple,rug,ruler,sailboat,scales,scan,scan-smiley,scissors,scooter,screencast,screwdriver,scribble,scribble-loop,scroll,seal,seal-check,seal-percent,seal-question,seal-warning,seat,seatbelt,security-camera,selection,selection-all,selection-background,selection-foreground,selection-inverse,selection-plus,selection-slash,shapes,share,share-fat,share-network,shield,shield-check,shield-checkered,shield-chevron,shield-plus,shield-slash,shield-star,shield-warning,shipping-container,shirt-folded,shooting-star,shopping-bag,shopping-bag-open,shopping-cart,shopping-cart-simple,shovel,shower,shrimp,shuffle,shuffle-angular,shuffle-simple,sidebar,sidebar-simple,sigma,sign-in,sign-out,signature,signpost,sim-card,siren,sketch-logo,skip-back,skip-back-circle,skip-forward,skip-forward-circle,skull,skype-logo,slack-logo,sliders,sliders-horizontal,slideshow,smiley,smiley-angry,smiley-blank,smiley-meh,smiley-melting,smiley-nervous,smiley-sad,smiley-sticker,smiley-wink,smiley-x-eyes,snapchat-logo,sneaker,sneaker-move,snowflake,soccer-ball,sock,solar-panel,solar-roof,sort-ascending,sort-descending,soundcloud-logo,spade,sparkle,speaker-hifi,speaker-high,speaker-low,speaker-none,speaker-simple-high,speaker-simple-low,speaker-simple-none,speaker-simple-slash,speaker-simple-x,speaker-slash,speaker-x,speedometer,sphere,spinner,spinner-ball,spinner-gap,spiral,split-horizontal,split-vertical,spotify-logo,spray-bottle,square,square-half,square-half-bottom,square-logo,square-split-horizontal,square-split-vertical,squares-four,stack,stack-minus,stack-overflow-logo,stack-plus,stack-simple,stairs,stamp,standard-definition,star,star-and-crescent,star-four,star-half,star-of-david,steam-logo,steering-wheel,steps,stethoscope,sticker,stool,stop,stop-circle,storefront,strategy,stripe-logo,student,subset-of,subset-proper-of,subtitles,subtitles-slash,subtract,subtract-square,subway,suitcase,suitcase-rolling,suitcase-simple,sun,sun-dim,sun-horizon,sunglasses,superset-of,superset-proper-of,swap,swatches,swimming-pool,sword,synagogue,syringe,t-shirt,table,tabs,tag,tag-chevron,tag-simple,target,taxi,tea-bag,telegram-logo,television,television-simple,tennis-ball,tent,terminal,terminal-window,test-tube,text-a-underline,text-aa,text-align-center,text-align-justify,text-align-left,text-align-right,text-b,text-columns,text-h,text-h-five,text-h-four,text-h-one,text-h-six,text-h-three,text-h-two,text-indent,text-italic,text-outdent,text-strikethrough,text-subscript,text-superscript,text-t,text-t-slash,text-underline,textbox,thermometer,thermometer-cold,thermometer-hot,thermometer-simple,threads-logo,three-d,thumbs-down,thumbs-up,ticket,tidal-logo,tiktok-logo,tilde,timer,tip-jar,tipi,tire,toggle-left,toggle-right,toilet,toilet-paper,toolbox,tooth,tornado,tote,tote-simple,towel,tractor,trademark,trademark-registered,traffic-cone,traffic-sign,traffic-signal,train,train-regional,train-simple,tram,translate,trash,trash-simple,tray,tray-arrow-down,tray-arrow-up,treasure-chest,tree,tree-evergreen,tree-palm,tree-structure,tree-view,trend-down,trend-up,triangle,triangle-dashed,trolley,trolley-suitcase,trophy,truck,truck-trailer,tumblr-logo,twitch-logo,twitter-logo,umbrella,umbrella-simple,union,unite,unite-square,upload,upload-simple,usb,user,user-check,user-circle,user-circle-check,user-circle-dashed,user-circle-gear,user-circle-minus,user-circle-plus,user-focus,user-gear,user-list,user-minus,user-plus,user-rectangle,user-sound,user-square,user-switch,users,users-four,users-three,van,vault,vector-three,vector-two,vibrate,video,video-camera,video-camera-slash,video-conference,vignette,vinyl-record,virtual-reality,virus,visor,voicemail,volleyball,wall,wallet,warehouse,warning,warning-circle,warning-diamond,warning-octagon,washing-machine,watch,wave-sawtooth,wave-sine,wave-square,wave-triangle,waveform,waveform-slash,waves,webcam,webcam-slash,webhooks-logo,wechat-logo,whatsapp-logo,wheelchair,wheelchair-motion,wifi-high,wifi-low,wifi-medium,wifi-none,wifi-slash,wifi-x,wind,windmill,windows-logo,wine,wrench,x,x-circle,x-logo,x-square,yarn,yin-yang,youtube-logo'.split(',');
const _FEATURED = [
  'broom','trash','washing-machine','spray-bottle','toilet','bathtub','recycle','shovel',
  'fork-knife','cooking-pot','egg','orange-slice','hamburger','chef-hat','cookie','bowl-food',
  'tooth','shower','hand-soap','bed','t-shirt','hoodie','sneaker','coat-hanger',
  'backpack','books','pencil','graduation-cap','calculator','exam','book-open','notebook',
  'heartbeat','bicycle','person-simple-run','basketball','soccer-ball','football','barbell','swimming-pool',
  // Garden / pets
  'dog','paw-print','plant','flower','leaf','tree','fish','potted-plant',
  // Home / maintenance
  'house','wrench','hammer','key','toolbox','paint-roller','plug','lightbulb',
  // Prizes / achievements
  'star','trophy','medal','gift','crown','sparkle','confetti','balloon',
  // Entertainment / fun
  'game-controller','music-notes','film-strip','ice-cream','pizza','popcorn','guitar','headphones',
  // General
  'heart','check-circle','clock','calendar','flag','bell','rocket','users',
];
const _ICON_SYNONYMS = {
  'water':      ['drop','waves','swimming-pool','fish','anchor','wave-sine','wave-square','bathtub','shower','toilet','washing-machine'],
  'swim':       ['swimming-pool','person-simple-swim','waves','drop'],
  'run':        ['person-simple-run','sneaker','sneaker-move','footprints'],
  'walk':       ['person-simple-walk','footprints','boot'],
  'bike':       ['bicycle','person-simple-bike','motorcycle','moped'],
  'sleep':      ['bed','moon','moon-stars','zzz','hourglass'],
  'eat':        ['fork-knife','hamburger','pizza','bowl-food','cooking-pot','chef-hat','bread','carrot','apple'],
  'food':       ['fork-knife','hamburger','pizza','bowl-food','cooking-pot','chef-hat','bread','carrot','apple','cherry','cheese','cake','ice-cream'],
  'drink':      ['cup','beer-stein','wine','coffee','tea-bag','drop','pint-glass','martini'],
  'clean':      ['broom','shower','washing-machine','spray-bottle','trash','soap','towel','toilet','bucket'],
  'school':     ['graduation-cap','book','books','pencil','backpack','chalkboard','notebook','ruler'],
  'study':      ['graduation-cap','book','books','pencil','notebook','brain','lightbulb'],
  'sport':      ['trophy','medal','basketball','soccer-ball','football','tennis-ball','baseball','ping-pong','golf','volleyball','bowling-ball','swimming-pool','bicycle'],
  'win':        ['trophy','medal','star','crown','confetti','seal-check','ribbon'],
  'award':      ['trophy','medal','star','crown','seal-check','certificate','ribbon','gift'],
  'money':      ['currency-dollar','piggy-bank','coins','coin','wallet','cash-register','bank','hand-coins','tip-jar'],
  'happy':      ['smiley','confetti','heart','sparkle','star','sun','rainbow'],
  'sad':        ['smiley-sad','smiley-meh','smiley-nervous','drop','cloud-rain'],
  'angry':      ['smiley-angry','fire','lightning','warning'],
  'love':       ['heart','heart-straight','hand-heart','rose','flower'],
  'flower':     ['flower','flower-lotus','flower-tulip','leaf','plant','potted-plant','tree','park'],
  'animal':     ['cat','dog','bird','fish','cow','rabbit','paw-print','horse','butterfly','bee'],
  'pet':        ['cat','dog','paw-print','fish','bird'],
  'music':      ['music-note','music-notes','headphones','guitar','piano-keys','vinyl-record','speaker-high'],
  'art':        ['palette','paint-brush','pencil','paint-roller','pen-nib'],
  'game':       ['game-controller','joystick','chess','puzzle-piece','dice-five','poker-chip'],
  'phone':      ['device-mobile','phone','chat','chat-circle'],
  'computer':   ['laptop','desktop','monitor','device-tablet','code'],
  'home':       ['house','house-line','couch','armchair','bed','lamp','key'],
  'work':       ['briefcase','desk','office-chair','toolbox','wrench','hammer'],
  'health':     ['heart','heartbeat','first-aid','first-aid-kit','pill','stethoscope','hospital','shield-check'],
  'nature':     ['leaf','tree','flower','sun','cloud','rainbow','mountain','park','plant'],
  'weather':    ['sun','cloud','cloud-rain','cloud-snow','cloud-lightning','snowflake','wind','rainbow','umbrella'],
  'time':       ['clock','hourglass','calendar','timer','alarm'],
  'travel':     ['airplane','car','bus','train','boat','map-pin','globe','suitcase'],
  'clothes':    ['shirt','pants','dress','shoe','sneaker','hoodie','coat-hanger','sock'],
  'read':       ['book','book-open','newspaper','magazine','bookmark'],
  'write':      ['pencil','pen','pen-nib','notepad','notebook','note'],
  'cook':       ['cooking-pot','chef-hat','fork-knife','oven','fire','bowl-food'],
  'play':       ['game-controller','playground','balloon','confetti','puzzle-piece','music-note'],
  'outside':    ['sun','tree','park','footprints','bicycle','mountains','leaf','campfire'],
  'friend':     ['users','users-three','handshake','chat-circle','heart'],
  'family':     ['users','house','heart','baby','person'],
  'baby':       ['baby','baby-carriage','pacifier','teddy-bear'],
  'grow':       ['plant','leaf','tree','flower','trend-up','rocket'],
  'star':       ['star','star-four','star-half','shooting-star','sparkle','seal'],
  'fire':       ['fire','fire-simple','flame','campfire','lightning'],
  'ice':        ['snowflake','ice-cream','thermometer-cold'],
};

const ICON_MAP = [
  ..._FEATURED,
  ..._ICON_NAMES.filter(n => !_FEATURED.includes(n)),
].map(n => {
  const base = n.replace(/-/g, ' ');
  // Collect any extra synonym keywords for this icon
  const extra = Object.entries(_ICON_SYNONYMS)
    .filter(([, names]) => names.includes(n))
    .map(([term]) => term)
    .join(' ');
  return { n, k: extra ? `${base} ${extra}` : base };
});
// Legacy alias so any remaining EMOJI_MAP references don't crash
const EMOJI_MAP = ICON_MAP;

const DEFAULT_CHORES = [
  { title:'Make My Bed',       icon:'bed',          iconColor:'#43D9AD', gems:10, frequency:'daily'  },
  { title:'Brush Teeth',       icon:'tooth',        iconColor:'#45B7D1', gems:5,  frequency:'daily'  },
  { title:'Put Toys Away',     icon:'house',        iconColor:'#6C63FF', gems:10, frequency:'daily'  },
  { title:'Set the Table',     icon:'fork-knife',   iconColor:'#FF9A3C', gems:10, frequency:'daily'  },
  { title:'Clear the Table',   icon:'broom',        iconColor:'#6BCB77', gems:10, frequency:'daily'  },
  { title:'Take Out Trash',    icon:'trash',        iconColor:'#6BCB77', gems:15, frequency:'weekly' },
  { title:'Do Homework',       icon:'books',        iconColor:'#45B7D1', gems:20, frequency:'daily'  },
  { title:'Put Clothes Away',  icon:'t-shirt',      iconColor:'#FF6584', gems:10, frequency:'daily'  },
  { title:'Feed the Pet',      icon:'paw-print',    iconColor:'#FF9A3C', gems:15, frequency:'daily'  },
  { title:'Help with Laundry', icon:'washing-machine',iconColor:'#43D9AD',gems:20, frequency:'weekly'},
];

const DEFAULT_PRIZES = [
  { title:'Movie Night Pick',        icon:'film-strip',  iconColor:'#6C63FF', cost:100, type:'individual' },
  { title:'30 min Extra Screen Time',icon:'television',  iconColor:'#45B7D1', cost:50,  type:'individual' },
  { title:'Stay Up 30 min Late',     icon:'moon',        iconColor:'#6C63FF', cost:75,  type:'individual' },
  { title:'Choose Dinner',           icon:'fork-knife',  iconColor:'#FF9A3C', cost:75,  type:'individual' },
  { title:'Small Toy or Book',       icon:'gift',        iconColor:'#FF6584', cost:250, type:'individual' },
  { title:'Family Ice Cream Night',  icon:'ice-cream',   iconColor:'#FFD93D', cost:400, type:'family'     },
  { title:'Family Movie Night',      icon:'film-strip',  iconColor:'#6C63FF', cost:500, type:'family'     },
  { title:'Bowling Night',           icon:'trophy',      iconColor:'#FFD93D', cost:800, type:'family'     },
];

const WEEKDAY_OPTIONS = [
  { value:0, label:'Sun' },
  { value:1, label:'Mon' },
  { value:2, label:'Tue' },
  { value:3, label:'Wed' },
  { value:4, label:'Thu' },
  { value:5, label:'Fri' },
  { value:6, label:'Sat' },
];

const ALL_DAYS = WEEKDAY_OPTIONS.map(day => day.value);

let D = {};          // the live data object (mirrors localStorage)
let S = {            // UI state (not persisted)
  isPro:                true,  // true until RevenueCat confirms otherwise (fail open)
  currentUser:          null,
  kidTab:               'chores',
  parentTab:            'home',
  setupStep:            0,
  setupMembers:         [],   // unified non-parent members during setup
  pinBuffer:            '',
  pinMode:              'app', // 'app' = gate to member picker | 'parent' = gate to parent view
  syncStatus:           'idle', // 'idle' | 'syncing' | 'ok' | 'error'
  lastLocalSave:        0,
  _afterPinNav:         null,
  _authPromptShown:      false,
  _pinPromptShown:       false,
  _parentSignInCallback: null,
  _recentParentAuth:     null,
  settingsPage:          'main', // 'main' | 'account' | 'notifications'
  _scrollMemory:         {},
  _activeViewUserId:     '',
  _activeViewRole:       '',
  _testOnboarding:       null,
};

function getMainScrollerForCurrentView() {
  if (S.currentUser?.role === 'parent') return document.getElementById('parent-content');
  if (S.currentUser?.role === 'kid') return document.getElementById('kid-content');
  return document.querySelector('.screen.active .main-content');
}

function getScrollMemoryKey() {
  if (S.currentUser?.role === 'parent') return `parent:${S.currentUser.id}:${S.parentTab}`;
  if (S.currentUser?.role === 'kid') return `kid:${S.currentUser.id}:${S.kidTab}`;
  const activeScreenId = document.querySelector('.screen.active')?.id || '';
  return activeScreenId ? `screen:${activeScreenId}` : '';
}

function rememberCurrentScrollPosition() {
  const scroller = getMainScrollerForCurrentView();
  const key = getScrollMemoryKey();
  if (!scroller || !key) return;
  S._scrollMemory[key] = Math.max(0, Math.round(scroller.scrollTop || 0));
}

function restoreCurrentScrollPosition(fallbackTop = 0) {
  const scroller = getMainScrollerForCurrentView();
  const key = getScrollMemoryKey();
  if (!scroller) return;
  const top = key && Object.prototype.hasOwnProperty.call(S._scrollMemory, key)
    ? S._scrollMemory[key]
    : fallbackTop;
  requestAnimationFrame(() => {
    scroller.scrollTop = Math.max(0, top || 0);
  });
}

function clearScrollMemory() {
  S._scrollMemory = {};
}

function resetPrimaryTabs() {
  S.kidTab = 'chores';
  S.parentTab = 'home';
}

document.addEventListener('scroll', (e) => {
  if (!(e.target instanceof HTMLElement)) return;
  if (!e.target.classList.contains('main-content')) return;
  rememberCurrentScrollPosition();
}, { passive: true, capture: true });

function defaultData() {
  return {
    v: 3,
    setup: false,
    settings: {
      parentPin:        '',
      autoApprove:      false,
      hideUnavailable:  false,
      tooltipBounceEnabled: true,
      diamondsPerDollar:  10,
      currency:         '$',
      lastSync:         null,
      familyTimezone:   '',
      // Leveling / streaks
      levelingEnabled:  true,
      streakEnabled:    true,
      comboEnabled:     true,
      comboOverrides:   {},
      streakBonus3:     1,
      streakBonus7:     3,
      streakBonus14:    5,
      streakBonus30:    10,
      // Not Listening
      notListeningSecs: 60,
      notListeningEnabled: true,
      // Savings
      savingsEnabled:          true,
      savingsMatchingEnabled:  false,
      savingsMatchPercent:     50,
      savingsInterestEnabled:  false,
      savingsInterestRate:     5,
      savingsInterestPeriod:   'monthly',
    },
    family: { name:'Our Family', members:[] },
    chores:     [],
    prizes:     [],
    teamGoals:       [],
    teamGoalInboxDismissed: [],
    history:         [],
    savingsRequests: [],
    declineNotifications: [],
  };
}

const LS_KEY = 'gemsprout_v2';
let firestoreUnsub = null;

function loadData() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    D = normalizeData(raw ? JSON.parse(raw) : defaultData());
  } catch(e) {
    D = normalizeData(defaultData());
  }
}

function saveData() {
  if (S._testOnboarding?.active) return;
  S.lastLocalSave = Date.now();
  if (D.settings) D.settings.lastSync = Date.now();
  if (D.declineNotifications?.length > 20) D.declineNotifications = D.declineNotifications.slice(-20);
  syncGemAliases();
  try { localStorage.setItem(LS_KEY, JSON.stringify(D)); } catch(e) {}
  if (S.currentUser?.role === 'kid') savePendingSnapshot(S.currentUser.id);
  if (S.currentUser?.id) {
    const fresh = getMember(S.currentUser.id);
    if (fresh) S.currentUser = fresh;
  }
  renderCurrentView();
  pushToFirestore();
}

async function pushToFirestore() {
  if (S._testOnboarding?.active) return;
  try {
    await db.doc(getFamilyDoc()).set(D);
  } catch(e) {
    console.warn('Firestore write error:', e);
  }
}

function getPendingEntryKeys(data, memberId) {
  const keys = new Set();
  if (!memberId || !data?.chores) return keys;
  data.chores.forEach(chore => {
    normalizeCompletionEntries(chore.completions?.[memberId]).forEach(e => {
      if (e.status === 'pending') keys.add(`${chore.id}:${e.id}`);
    });
  });
  return keys;
}

function savePendingSnapshot(memberId) {
  if (!memberId) return;
  const keys = getPendingEntryKeys(D, memberId);
  try {
    if (keys.size > 0) localStorage.setItem(`_pend_${memberId}`, JSON.stringify([...keys]));
    else localStorage.removeItem(`_pend_${memberId}`);
  } catch(e) {}
}

function loadPendingSnapshot(memberId) {
  try {
    const raw = localStorage.getItem(`_pend_${memberId}`);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}

function clearPendingSnapshot(memberId) {
  try { localStorage.removeItem(`_pend_${memberId}`); } catch(e) {}
}

function markBonusesSeen(memberId) {
  const ids = (D.history || [])
    .filter(h => h.memberId === memberId && h.type === 'bonus')
    .map(h => h.id);
  try { localStorage.setItem(`_seenBonus_${memberId}`, JSON.stringify(ids)); } catch(e) {}
}

function getSeenBonusIds(memberId) {
  try {
    const raw = localStorage.getItem(`_seenBonus_${memberId}`);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}

function checkForNewBonuses(member, isWhileAway = false) {
  const seenIds = getSeenBonusIds(member.id);
  const newBonuses = (D.history || []).filter(h =>
    h.memberId === member.id &&
    h.type === 'bonus' &&
    h.title !== 'Daily Combo Bonus!' &&
    !seenIds.has(h.id) &&
    (h.gems || 0) > 0
  );
  if (newBonuses.length === 0) return;
  markBonusesSeen(member.id);
  const fresh = getMember(member.id);
  if (fresh) S.currentUser = fresh;
  const tiny = isTiny(member);
  const total = newBonuses.reduce((s, b) => s + (b.gems || 0), 0);
  const titleHtml = isWhileAway
    ? '<i class="ph-duotone ph-moon-stars" style="color:#7C3AED"></i> While you were away...'
    : '<i class="ph-duotone ph-sparkle" style="color:#7C3AED"></i> Bonus Gems!';
  const subText = newBonuses.length === 1
    ? newBonuses[0].title
    : `${newBonuses.length} bonuses: ${newBonuses.map(b => b.title).join(', ')}`;
  showCelebration({
    icon:     '<i class="ph-duotone ph-star" style="color:#F59E0B;font-size:3rem"></i>',
    title:    titleHtml,
    sub:      subText,
    gems: total,
    tts:      tiny ? `You got ${total} bonus gems! ${subText}` : null,
    onClose:  () => { renderKidDiamonds(); renderKidHeader(); renderKidNav(); },
  });
}

function markSavingsSeen(memberId) {
  const ids = (D.history || [])
    .filter(h => h.memberId === memberId && h.type === 'savings_deposit')
    .map(h => h.id);
  try { localStorage.setItem(`_seenSavings_${memberId}`, JSON.stringify(ids)); } catch(e) {}
}

function getSeenSavingsIds(memberId) {
  try {
    const raw = localStorage.getItem(`_seenSavings_${memberId}`);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}

function checkForNewSavingsDeposits(member, isWhileAway = false) {
  const seenIds = getSeenSavingsIds(member.id);
  const newDeposits = (D.history || []).filter(h =>
    h.memberId === member.id &&
    h.type === 'savings_deposit' &&
    !seenIds.has(h.id) &&
    (h.dollars || 0) > 0
  );
  if (newDeposits.length === 0) return;
  markSavingsSeen(member.id);
  const fresh = getMember(member.id);
  if (fresh) S.currentUser = fresh;
  const tiny = isTiny(member);
  const cur   = D.settings.currency || '$';
  const total = newDeposits.reduce((s, d) => s + (d.dollars || 0), 0);
  const titleHtml = isWhileAway
    ? '<i class="ph-duotone ph-moon-stars" style="color:#16A34A"></i> While you were away...'
    : '<i class="ph-duotone ph-piggy-bank" style="color:#16A34A"></i> Savings Deposit!';
  const subText = newDeposits.length === 1
    ? newDeposits[0].title
    : `${newDeposits.length} deposits: ${newDeposits.map(d => d.title).join(', ')}`;
  showCelebration({
    icon:    '<i class="ph-duotone ph-piggy-bank" style="color:#16A34A;font-size:3rem"></i>',
    title:   titleHtml,
    sub:     subText,
    dollars: total,
    cur,
    tts:     tiny ? `Your savings went up ${cur}${total.toFixed(2)}! ${subText}` : null,
    onClose: () => { renderKidDiamonds(); renderKidHeader(); renderKidNav(); },
  });
}

function markSpendOutcomesSeen(memberId) {
  const ids = (D.savingsRequests || [])
    .filter(r => r.memberId === memberId && r.status !== 'pending')
    .map(r => r.id);
  try { localStorage.setItem(`_seenSpend_${memberId}`, JSON.stringify(ids)); } catch(e) {}
}

function getSeenSpendOutcomeIds(memberId) {
  try {
    const raw = localStorage.getItem(`_seenSpend_${memberId}`);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}

function checkForSavingsRequestOutcomes(member, isWhileAway = false) {
  const seenIds = getSeenSpendOutcomeIds(member.id);
  const unseen  = (D.savingsRequests || []).filter(r =>
    r.memberId === member.id && r.status !== 'pending' && !seenIds.has(r.id)
  );
  if (unseen.length === 0) return;
  markSpendOutcomesSeen(member.id);
  const cur     = D.settings.currency || '$';
  const fresh   = getMember(member.id);
  if (fresh) S.currentUser = fresh;
  const tiny    = isTiny(member);
  const approved = unseen.filter(r => r.status === 'approved');
  const denied   = unseen.filter(r => r.status === 'denied');
  approved.forEach(r => {
    const newBal = getMember(member.id)?.savings || 0;
    const sub = r.reason
      ? `"${r.reason}" for ${cur}${r.amount.toFixed(2)} approved`
      : `${cur}${r.amount.toFixed(2)} approved`;
    showCelebration({
      icon:       '<i class="ph-duotone ph-shopping-bag" style="color:#16A34A;font-size:3rem"></i>',
      title:      isWhileAway
        ? '<i class="ph-duotone ph-moon-stars" style="color:#6C63FF"></i> While you were away...'
        : '<i class="ph-duotone ph-check-circle" style="color:#16A34A"></i> Spend Approved!',
      sub:        `${sub}. Balance: ${cur}${newBal.toFixed(2)}`,
      noAnimation: true,
      tts:        tiny ? `Your grown-up said yes! You can spend ${cur}${r.amount.toFixed(2)}. You now have ${cur}${newBal.toFixed(2)} left in savings.` : null,
      onClose:    () => { renderKidDiamonds(); renderKidHeader(); renderKidNav(); },
    });
  });
  denied.forEach(r => {
    const sub = r.reason ? `"${r.reason}" for ${cur}${r.amount.toFixed(2)}` : `${cur}${r.amount.toFixed(2)}`;
    showCelebration({
      icon:       '<i class="ph-duotone ph-smiley-sad" style="color:#9CA3AF;font-size:3rem"></i>',
      title:      isWhileAway
        ? '<i class="ph-duotone ph-moon-stars" style="color:#6B7280"></i> While you were away...'
        : '<i class="ph-duotone ph-x-circle" style="color:#9CA3AF"></i> Not This Time',
      sub:        `Your spend request for ${sub} wasn't approved.`,
      noAnimation: true,
      btnLabel:   'Okay',
      tts:        tiny ? `Your grown-up said not right now for spending ${cur}${r.amount.toFixed(2)}.` : null,
      onClose:    () => {},
    });
  });
}

function markBadgesSeen(memberId) {
  const ids = (D.history || [])
    .filter(h => h.memberId === memberId && h.type === 'badge')
    .map(h => h.id);
  try { localStorage.setItem(`_seenBadge_${memberId}`, JSON.stringify(ids)); } catch(e) {}
}

function getSeenBadgeIds(memberId) {
  try {
    const raw = localStorage.getItem(`_seenBadge_${memberId}`);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}

function checkForNewBadges(member, isWhileAway = false) {
  const seenIds = getSeenBadgeIds(member.id);
  const newBadges = (D.history || []).filter(h =>
    h.memberId === member.id &&
    h.type === 'badge' &&
    !seenIds.has(h.id)
  );
  if (newBadges.length === 0) return;
  markBadgesSeen(member.id);
  const tiny = isTiny(member);
  const titleHtml = isWhileAway
    ? '<i class="ph-duotone ph-moon-stars" style="color:#7C3AED"></i> While you were away...'
    : '<i class="ph-duotone ph-medal" style="color:#7C3AED"></i> New Badge!';
  newBadges.forEach(h => {
    const rawIcon = h.badgeIcon || '<i class="ph-duotone ph-medal" style="color:#7C3AED"></i>';
    const displayIcon = rawIcon.includes('<')
      ? rawIcon.replace(/font-size:[^;'"]+/g, 'font-size:3rem')
      : `<span style="font-size:3rem">${rawIcon}</span>`;
    showCelebration({
      icon:      displayIcon,
      title:     titleHtml,
      sub:       h.title + (h.choreTitle ? ` ? ${h.choreTitle}` : ''),
      badgeIcon: rawIcon,
      tts:       tiny ? `You earned a new badge! ${h.title}!` : null,
    });
  });
}

function _getSeenDeclineIds() {
  try { return new Set(JSON.parse(localStorage.getItem('gemsprout.seenDeclines') || '[]')); } catch { return new Set(); }
}
function _markDeclineIdSeen(id) {
  const s = _getSeenDeclineIds(); s.add(id);
  try { localStorage.setItem('gemsprout.seenDeclines', JSON.stringify([...s])); } catch {}
}

function checkForDeclineNotifications(member, isWhileAway = false) {
  if (!D.declineNotifications) return;
  const seenIds = _getSeenDeclineIds();
  const pending = D.declineNotifications.filter(n => n.memberId === member.id && !seenIds.has(n.id));
  if (pending.length === 0) return;
  pending.forEach(n => _markDeclineIdSeen(n.id));
  const tiny = isTiny(member);
  pending.forEach(n => {
    const titleHtml = isWhileAway
      ? '<i class="ph-duotone ph-moon-stars" style="color:#EF4444"></i> While you were away...'
      : '<i class="ph-duotone ph-x-circle" style="color:#EF4444"></i> Task Declined';
    showCelebration({
      icon:        renderIcon(n.choreIcon, n.choreIconColor, 'font-size:3rem') || '<i class="ph-duotone ph-x-circle" style="color:#EF4444;font-size:3rem"></i>',
      title:       titleHtml,
      sub:         n.reason ? `"${esc(n.choreTitle)}" was declined: ${esc(n.reason)}` : `"${esc(n.choreTitle)}" was declined`,
      noAnimation: true,
      btnLabel:    'OK',
      tts:         tiny ? `Your task was declined.${n.reason ? ' Reason: ' + n.reason : ''}` : null,
      onClose:     () => { renderKidChores(); renderKidHeader(); renderKidNav(); },
    });
  });
}

function checkForApprovalCelebration(prevPendingKeys, member, isWhileAway = false) {
  let totalNewDiamonds = 0;
  const approvedChores = [];
  let anyBeforeApproved = false;
  D.chores.forEach(chore => {
    normalizeCompletionEntries(chore.completions?.[member.id]).forEach(e => {
      if (!prevPendingKeys.has(`${chore.id}:${e.id}`)) return;
      if (e.entryType === 'before' && e.status === 'approved') {
        anyBeforeApproved = true; // will show a softer toast, not confetti
      }
      if (e.entryType !== 'before' && e.status === 'done') {
        totalNewDiamonds += chore.gems;
        if (!approvedChores.find(c => c.id === chore.id)) approvedChores.push(chore);
      }
    });
  });
  // Soft notification when a before-photo gets the green light (no gems yet)
  if (anyBeforeApproved && totalNewDiamonds === 0) {
    showCelebration({
      icon:       '<i class="ph-duotone ph-check-circle" style="color:#16A34A;font-size:3rem"></i>',
      title:      'You\'re good to go! <i class="ph-duotone ph-check-circle" style="color:#16A34A"></i>',
      sub:        'Your parent approved it - time to do the task!',
      noAnimation: true,
      btnLabel:   'Let\'s do it!',
      onClose:    () => renderKidChores(),
    });
    return;
  }
  if (totalNewDiamonds <= 0) return;
  // Update S.currentUser gems from fresh data
  const fresh = getMember(member.id);
  if (fresh) S.currentUser = fresh;
  const tiny = isTiny(member);
  const subLine = approvedChores.length === 1
    ? `"${approvedChores[0].title}" approved!`
    : `${approvedChores.length} tasks approved!`;
  if (isWhileAway) {
    showCelebration({
      icon:     '<i class="ph-duotone ph-envelope" style="color:#7C3AED;font-size:3rem"></i>',
      title:    tiny ? '<i class="ph-duotone ph-moon-stars" style="color:#7C3AED"></i> While you were away...' : '<i class="ph-duotone ph-moon-stars" style="color:#7C3AED"></i> While you were away...',
      sub:      `Your parent approved ${subLine.replace(' approved!','')} and you earned gems!`,
      gems: totalNewDiamonds,
      tts:      tiny ? `Welcome back! While you were away, your grown-up approved your task and you earned ${totalNewDiamonds} gems!` : null,
      onClose:  () => { renderKidChores(); renderKidHeader(); renderKidNav(); },
    });
  } else {
    showCelebration({
      icon:     renderIcon(approvedChores[0]?.icon, approvedChores[0]?.iconColor, 'font-size:3rem') || '<i class="ph-duotone ph-confetti" style="color:#F97316;font-size:3rem"></i>',
      title:    tiny ? '<i class="ph-duotone ph-confetti" style="color:#F97316"></i> Your parent said YES!' : '<i class="ph-duotone ph-check-circle" style="color:#16A34A"></i> Task Approved!',
      sub:      subLine,
      gems: totalNewDiamonds,
      tts:      tiny ? `Amazing! Your grown-up approved your task! You earned ${totalNewDiamonds} gems!` : null,
      onClose:  () => { renderKidChores(); renderKidHeader(); renderKidNav(); },
    });
  }
}

function subscribeToFirestore(onFirstLoad) {
  if (firestoreUnsub) firestoreUnsub();
  const _subDoc = getFamilyDoc();
  let firstSnapshot = true;
  firestoreUnsub = db.doc(_subDoc).onSnapshot(snap => {
    if (S._testOnboarding?.active) {
      if (firstSnapshot) {
        firstSnapshot = false;
        if (typeof onFirstLoad === 'function') onFirstLoad();
      }
      return;
    }
    let _didUpdate = false;
    if (snap.exists) {
      const incoming = snap.data();
      const normalizedIncoming = normalizeData(incoming);
      const incomingSync = Number(normalizedIncoming.settings?.lastSync || 0);
      const localSync = Number(D.settings?.lastSync || 0);
      const incomingMissingSync = !incomingSync && !!localSync;
      const isOlderThanLocal = !!localSync && (!incomingSync || incomingSync < localSync);
      const isStaleEcho = !firstSnapshot && ((Date.now() - S.lastLocalSave) < 1500 || isOlderThanLocal);
      if (!incomingMissingSync && !isOlderThanLocal && !isStaleEcho && JSON.stringify(normalizedIncoming) !== JSON.stringify(D)) {
        _didUpdate = true;
        // Capture what was pending before the update (for approval celebration)
        const prevPending = S.currentUser ? getPendingEntryKeys(D, S.currentUser.id) : new Set();
        D = normalizedIncoming;
        try { localStorage.setItem(LS_KEY, JSON.stringify(D)); } catch(e) {}
        // Refresh S.currentUser so renderKidHeader (and all renders) reflect latest gems/data
        if (S.currentUser) {
          const _freshUser = getMember(S.currentUser.id);
          if (_freshUser) S.currentUser = _freshUser;
        }
        // Trigger celebration if kid is viewing and chores got approved
        if (!firstSnapshot && prevPending.size > 0 && S.currentUser?.role === 'kid') {
          checkForApprovalCelebration(prevPending, S.currentUser);
        }
        // Trigger celebration for new manual bonus gems, savings deposits, spend outcomes, or declines
        if (!firstSnapshot && S.currentUser?.role === 'kid') {
          checkForNewBonuses(S.currentUser, false);
          checkForNewSavingsDeposits(S.currentUser, false);
          checkForSavingsRequestOutcomes(S.currentUser, false);
          checkForDeclineNotifications(S.currentUser, false);
        }
      }
    }
    if (firstSnapshot) {
      firstSnapshot = false;
      // Check for approvals that happened while the app was closed
      if (S.currentUser?.role === 'kid') {
        const savedKeys = loadPendingSnapshot(S.currentUser.id);
        if (savedKeys.size > 0) checkForApprovalCelebration(savedKeys, S.currentUser, true);
        clearPendingSnapshot(S.currentUser.id);
        savePendingSnapshot(S.currentUser.id);
        checkForNewBonuses(S.currentUser, true); // check for manual bonuses while away
        checkForNewSavingsDeposits(S.currentUser, true); // check for savings deposits while away
        checkForSavingsRequestOutcomes(S.currentUser, true); // check for spend request outcomes while away
        checkForNewBadges(S.currentUser, true); // check for badge awards while away
        checkForDeclineNotifications(S.currentUser, true); // check for declines while away
      }
      if (typeof onFirstLoad === 'function') onFirstLoad();
      else if (_didUpdate) renderCurrentView();
    } else if (_didUpdate) {
      renderCurrentView();
      if (S.currentUser?.role === 'kid') checkForNewBadges(S.currentUser, false);
    }
  }, err => {
    console.warn('Firestore listener error:', err);
    if (firstSnapshot) {
      firstSnapshot = false;
      if (typeof onFirstLoad === 'function') onFirstLoad();
    }
  });
}

function todayDisplay() {
  return new Date().toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2,7);
}

function today() {
  const tz = D?.settings?.familyTimezone;
  if (tz) return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  return formatDateLocal(new Date());
}

function parseDateLocal(str) {
  const [year, month, day] = str.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function formatDateLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDaysToDate(str, days) {
  const date = parseDateLocal(str);
  date.setDate(date.getDate() + days);
  return formatDateLocal(date);
}

function addMonthsToDate(str, months) {
  const date = parseDateLocal(str);
  date.setMonth(date.getMonth() + months, 1);
  return formatDateLocal(date);
}

function startOfWeekDate(str) {
  const date = parseDateLocal(str);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return formatDateLocal(date);
}

function weekStart() {
  const d   = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day===0 ? -6 : 1);
  d.setDate(diff);
  return formatDateLocal(d);
}

function nowMinutes() {
  const date = new Date();
  return date.getHours() * 60 + date.getMinutes();
}

function timeToMinutes(value) {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [hours, minutes] = value.split(':').map(Number);
  return (hours * 60) + minutes;
}

function normalizeCompletionEntry(entry) {
  const validStatuses = ['pending', 'approved', 'done'];
  return {
    id:        entry?.id        || genId(),
    status:    validStatuses.includes(entry?.status) ? entry.status : 'done',
    date:      entry?.date      || today(),
    createdAt: entry?.createdAt || Date.now(),
    slotId:    entry?.slotId    || null,
    photoUrl:  entry?.photoUrl  || null,
    entryType: entry?.entryType === 'before' ? 'before'
             : entry?.entryType === 'after'  ? 'after'
             : null,
  };
}

function normalizeCompletionEntries(value) {
  if (Array.isArray(value)) return value.map(normalizeCompletionEntry);
  if (value && typeof value === 'object' && ('status' in value || 'date' in value)) {
    return [normalizeCompletionEntry(value)];
  }
  return [];
}

function normalizeSlots(slots) {
  if (!Array.isArray(slots) || slots.length === 0) return null;
  return slots.map(s => ({
    id:    s.id    || genId(),
    label: s.label || '',
    start: typeof s.start === 'string' ? s.start : '',
    end:   typeof s.end   === 'string' ? s.end   : '',
  }));
}

function normalizeChore(chore) {
  const rewardValue = Number(chore?.diamonds ?? chore?.gems ?? 0) || 0;
  const legacyFrequency = chore?.frequency || 'daily';
  const legacyPeriod = legacyFrequency === 'weekly' ? 'week' : legacyFrequency === 'once' ? 'once' : 'day';
  const schedule = chore?.schedule || {};
  const period = ['day','week','once'].includes(schedule.period) ? schedule.period : legacyPeriod;
  const targetCount = Math.max(1, parseInt(schedule.targetCount ?? chore?.repeatCount ?? 1, 10) || 1);
  const daysOfWeek = Array.isArray(schedule.daysOfWeek) && schedule.daysOfWeek.length
    ? schedule.daysOfWeek.map(Number).filter(day => ALL_DAYS.includes(day))
    : ALL_DAYS.slice();
  const windows = {};
  const sourceWindows = schedule.windows && typeof schedule.windows === 'object' ? schedule.windows : {};
  Object.keys(sourceWindows).forEach(key => {
    const day = Number(key);
    if (!ALL_DAYS.includes(day)) return;
    const start = typeof sourceWindows[key]?.start === 'string' ? sourceWindows[key].start : '';
    const end = typeof sourceWindows[key]?.end === 'string' ? sourceWindows[key].end : '';
    if (start || end) windows[day] = { start, end };
  });
  const slots = normalizeSlots(schedule.slots);

  const completions = {};
  Object.entries(chore?.completions || {}).forEach(([memberId, entries]) => {
    completions[memberId] = normalizeCompletionEntries(entries);
  });

  const title = chore?.title || '';
  const choreBadges = Array.isArray(chore?.badges) ? chore.badges :
    !chore?.id ? (() => { const preset = CHORE_BADGE_PRESETS[title]; return preset ? preset.map(b => ({ id: genId(), ...b })) : []; })() : [];

  return {
    ...chore,
    diamonds: rewardValue,
    gems: rewardValue,
    frequency: period,
    repeatCount: targetCount,
    icon: chore?.icon || 'broom',
    iconColor: chore?.iconColor || '#6BCB77',
    photoMode: (['after','before_after'].includes(chore?.photoMode) ? chore.photoMode
             : chore?.requiresPhoto === true ? 'after' : 'none'),
    assignedTo: Array.isArray(chore?.assignedTo) ? chore.assignedTo : [],
    description: chore?.description || '',
    completions,
    badges: choreBadges,
    schedule: {
      period,
      targetCount,
      daysOfWeek: period === 'once' ? [] : daysOfWeek,
      windows,
      slots,
    },
  };
}

function normalizeMember(m) {
  if (!m || typeof m !== 'object') return m;
  const balance = Number(m.diamonds ?? m.gems ?? 0) || 0;
  const earned = Number(m.totalEarned ?? 0) || 0;
  m.diamonds = balance;
  m.gems = balance;
  m.totalEarned = earned;
  if (!m.streak) m.streak = { current: 0, best: 0, lastDate: null };
  if (!m.comboStreak) m.comboStreak = { current: 0, best: 0, lastDate: null };
  if (!m.splitHousehold) m.splitHousehold = { enabled: false, cycle: Array(14).fill(true), referenceMonday: getMostRecentMonday(), overrides: {} };
  if (!m.splitHousehold.overrides) m.splitHousehold.overrides = {};
  if (!Array.isArray(m.splitHousehold.cycle) || m.splitHousehold.cycle.length !== 14) m.splitHousehold.cycle = Array(14).fill(true);
  if (!Array.isArray(m.badges)) m.badges = [];
  if (typeof m.color === 'undefined' || !m.color) m.color = COLORS[0];
  if (typeof m.avatarColor === 'undefined' || !m.avatarColor) m.avatarColor = m.color;
  if (typeof m.xp === 'undefined') m.xp = m.totalEarned || 0;
  if (typeof m.comboBonusDate === 'undefined') m.comboBonusDate = null;
  if (typeof m.savingsGifted === 'undefined') m.savingsGifted = 0;
  if (typeof m.savingsMatched === 'undefined') m.savingsMatched = 0;
  if (typeof m.savingsInterest === 'undefined') m.savingsInterest = 0;
  if (typeof m.nlTodaySecs === 'undefined') m.nlTodaySecs = 0;
  if (typeof m.nlDate === 'undefined') m.nlDate = null;
  if (typeof m.nlLifetimeSecs === 'undefined') m.nlLifetimeSecs = 0;
  if (typeof m.nlPendingSecs === 'undefined') m.nlPendingSecs = 0;
  return m;
}

function reduceSavingsBuckets(member, amount) {
  if (!member || amount <= 0) return;
  normalizeMember(member);
  let remaining = parseFloat(amount.toFixed(2));
  ['savingsGifted', 'savingsMatched', 'savingsInterest'].forEach(key => {
    if (remaining <= 0) return;
    const current = parseFloat((member[key] || 0).toFixed(2));
    if (current <= 0) return;
    const applied = Math.min(current, remaining);
    member[key] = parseFloat((current - applied).toFixed(2));
    remaining = parseFloat((remaining - applied).toFixed(2));
  });
}

function syncGemAliases() {
  if (!D || typeof D !== 'object') return;
  (D.family?.members || []).forEach(m => {
    const balance = Number(m?.diamonds ?? m?.gems ?? 0) || 0;
    m.diamonds = balance;
    m.gems = balance;
  });
  (D.chores || []).forEach(chore => {
    const reward = Number(chore?.diamonds ?? chore?.gems ?? 0) || 0;
    chore.diamonds = reward;
    chore.gems = reward;
  });
  (D.history || []).forEach(h => {
    const delta = Number(h?.diamonds ?? h?.gems ?? 0) || 0;
    h.diamonds = delta;
    h.gems = delta;
  });
}

function normalizeData(data) {
  const normalized = data && typeof data === 'object' ? data : defaultData();
  normalized.settings = { ...defaultData().settings, ...(normalized.settings || {}) };
  normalized.family = normalized.family || { name:'Our Family', members:[] };
  normalized.family.members = Array.isArray(normalized.family.members)
    ? normalized.family.members.map(normalizeMember)
    : [];
  normalized.chores = Array.isArray(normalized.chores) ? normalized.chores.map(c => normalizeChore(c)) : [];
  normalized.prizes = Array.isArray(normalized.prizes)
    ? normalized.prizes.map(p => ({ icon:'gift', iconColor:'#FF6584', ...p }))
    : [];
  normalized.history         = Array.isArray(normalized.history)         ? normalized.history         : [];
  normalized.savingsRequests = Array.isArray(normalized.savingsRequests) ? normalized.savingsRequests : [];
  normalized.teamGoals = Array.isArray(normalized.teamGoals)
    ? normalized.teamGoals.map(g => ({ icon: 'trophy', iconColor: '#FFD93D', ...g }))
    : [];
  normalized.teamGoalInboxDismissed = Array.isArray(normalized.teamGoalInboxDismissed) ? normalized.teamGoalInboxDismissed : [];
  normalized.v = 3;
  D = normalized;
  syncGemAliases();
  return normalized;
}

function getChoreSchedule(chore) {
  return chore?.schedule || normalizeChore(chore).schedule;
}

function getChoreTimeWindow(chore, dayIndex) {
  const schedule = getChoreSchedule(chore);
  return schedule.windows?.[dayIndex] || { start:'', end:'' };
}

function formatDaysOfWeek(daysOfWeek) {
  if (!Array.isArray(daysOfWeek) || !daysOfWeek.length) return 'no days selected';
  if (daysOfWeek.length === 7) return 'every day';
  return WEEKDAY_OPTIONS.filter(day => daysOfWeek.includes(day.value)).map(day => day.label).join(', ');
}

function formatTime12(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}

function formatTimeWindow(window) {
  if (!window || (!window.start && !window.end)) return 'any time';
  if (window.start && window.end) return `${formatTime12(window.start)} - ${formatTime12(window.end)}`;
  if (window.start) return `after ${formatTime12(window.start)}`;
  return `before ${formatTime12(window.end)}`;
}

function formatSlotLabel(slot) {
  if (!slot) return '';
  const rawLabel = typeof slot.label === 'string' ? slot.label.trim() : '';
  if (!rawLabel) return formatTimeWindow({ start: slot.start, end: slot.end });
  const rangeMatch = rawLabel.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (rangeMatch) {
    return `${formatTime12(rangeMatch[1])} - ${formatTime12(rangeMatch[2])}`;
  }
  const singleMatch = rawLabel.match(/^(\d{1,2}:\d{2})$/);
  if (singleMatch) {
    return formatTime12(singleMatch[1]);
  }
  return rawLabel;
}

function isWithinTimeWindow(window, minutes) {
  if (!window || (!window.start && !window.end)) return true;
  const start = timeToMinutes(window.start);
  const end = timeToMinutes(window.end);
  if (start == null && end == null) return true;
  if (start != null && end != null) {
    if (start <= end) return minutes >= start && minutes <= end;
    return minutes >= start || minutes <= end;
  }
  if (start != null) return minutes >= start;
  return minutes <= end;
}

function choreScheduleSummary(chore) {
  const schedule = getChoreSchedule(chore);
  if (schedule.period === 'once') return 'one-time';
  if (schedule.slots && schedule.slots.length > 0) {
    const countLabel = `${schedule.slots.length}x per day`;
    const slotLabels = schedule.slots.map(s => formatTimeWindow({start:s.start, end:s.end})).join(' & ');
    return `${countLabel} / ${formatDaysOfWeek(schedule.daysOfWeek)} / ${slotLabels}`;
  }
  const countLabel = schedule.period === 'week'
    ? `${schedule.targetCount}x per week`
    : `${schedule.targetCount}x per day`;
  const daysLabel = formatDaysOfWeek(schedule.daysOfWeek);
  const uniqueWindows = schedule.daysOfWeek
    .map(day => formatTimeWindow(getChoreTimeWindow(chore, day)))
    .filter((label, index, arr) => arr.indexOf(label) === index);
  const timeLabel = uniqueWindows.length === 1 ? uniqueWindows[0] : 'custom hours';
  return `${countLabel} / ${daysLabel} / ${timeLabel}`;
}

function parentChoreMetaSummary(chore) {
  const schedule = getChoreSchedule(chore);
  if (schedule.period === 'once') return 'one-time';
  const countLabel = schedule.slots && schedule.slots.length > 0
    ? `${schedule.slots.length}x per day`
    : schedule.period === 'week'
      ? `${schedule.targetCount}x per week`
      : `${schedule.targetCount}x per day`;
  return `${countLabel}\n${formatDaysOfWeek(schedule.daysOfWeek)}`;
}

function choreMetaChips(chore) {
  const schedule = getChoreSchedule(chore);
  const chip = (text, bg, color) =>
    `<span style="display:inline-flex;align-items:center;background:${bg};color:${color};border-radius:999px;padding:2px 8px;font-size:0.7rem;font-weight:700;white-space:nowrap">${text}</span>`;
  const chips = [];
  chips.push(chip(`<i class="ph-duotone ph-diamond" style="font-size:0.8rem;vertical-align:middle"></i> ${chore.diamonds}`, '#FEF9C3', '#92400E'));
  if (schedule.period === 'once') {
    chips.push(chip('one-time', '#F3F4F6', '#4B5563'));
    return chips.join('');
  }
  const freq = schedule.period === 'week'
    ? `${schedule.targetCount}x/wk`
    : `${schedule.targetCount}x/day`;
  chips.push(chip(freq, '#EFF6FF', '#1D4ED8'));
  chips.push(chip(formatDaysOfWeek(schedule.daysOfWeek), '#F3F4F6', '#374151'));
  if (schedule.slots && schedule.slots.length > 0) {
    schedule.slots.forEach(s => {
      const label = formatSlotLabel(s);
      if (label && label !== 'any time') chips.push(chip(esc(label), '#F0FDF4', '#166534'));
    });
  } else {
    const uniqueWindows = schedule.daysOfWeek
      .map(day => formatTimeWindow(getChoreTimeWindow(chore, day)))
      .filter((v, i, a) => a.indexOf(v) === i);
    const timeLabel = uniqueWindows.length === 1 ? uniqueWindows[0] : 'custom hours';
    if (timeLabel !== 'any time') chips.push(chip(esc(timeLabel), '#F0FDF4', '#166534'));
  }
  return chips.join('');
}

function getRelevantCompletionEntries(chore, memberId, dateStr = today()) {
  const entries = normalizeCompletionEntries(chore?.completions?.[memberId]);
  const schedule = getChoreSchedule(chore);
  if (schedule.period === 'once') return entries;
  if (schedule.period === 'week') {
    const start = startOfWeekDate(dateStr);
    const end = addDaysToDate(start, 6);
    return entries.filter(entry => entry.date >= start && entry.date <= end);
  }
  return entries.filter(entry => entry.date === dateStr);
}

function getChoreProgress(chore, memberId, dateStr = today()) {
  const schedule = getChoreSchedule(chore);
  const allEntries = normalizeCompletionEntries(chore?.completions?.[memberId]);
  const dayIndex = parseDateLocal(dateStr).getDay();
  const now = nowMinutes();

  if (schedule.slots && schedule.slots.length > 0 && schedule.period !== 'once') {
    const scheduledToday = schedule.daysOfWeek.includes(dayIndex);
    if (!scheduledToday) {
      return {
        schedule, entries: allEntries, isSlotMode: true,
        doneCount: 0, pendingCount: 0, completedCount: 0,
        targetCount: 0, remainingCount: 0,
        scheduledToday: false, availableNow: false,
        window: null, status: 'unavailable', availabilityText: `Available on ${formatDaysOfWeek(schedule.daysOfWeek)}`,
        canSubmit: false, slotStatuses: [],
      };
    }
    const todayEntries = allEntries.filter(e => e.date === dateStr);
    const slotStatuses = schedule.slots.map(slot => {
      const entry = todayEntries.find(e => e.slotId === slot.id);
      const inWindow = isWithinTimeWindow({start: slot.start, end: slot.end}, now);
      let slotStatus;
      if (entry?.status === 'done')    slotStatus = 'done';
      else if (entry?.status === 'pending') slotStatus = 'pending';
      else if (inWindow)               slotStatus = 'available';
      else                             slotStatus = 'waiting';
      return { slot, entry, inWindow, status: slotStatus };
    });
    const doneCount      = slotStatuses.filter(s => s.status === 'done').length;
    const pendingCount   = slotStatuses.filter(s => s.status === 'pending').length;
    const completedCount = doneCount + pendingCount;
    const targetCount    = schedule.slots.length;
    const canSubmit      = slotStatuses.some(s => s.status === 'available');
    let status = doneCount >= targetCount ? 'done'
      : pendingCount > 0 && completedCount >= targetCount ? 'pending'
      : completedCount > 0 ? 'partial'
      : 'none';
    return {
      schedule, entries: allEntries, isSlotMode: true,
      doneCount, pendingCount, completedCount, targetCount,
      remainingCount: Math.max(0, targetCount - completedCount),
      scheduledToday: true, availableNow: canSubmit,
      window: null, status, availabilityText: '',
      canSubmit, slotStatuses,
    };
  }

  const entries = getRelevantCompletionEntries(chore, memberId, dateStr);
  const doneCount = entries.filter(entry => entry.status === 'done').length;
  const pendingCount = entries.filter(entry => entry.status === 'pending').length;
  const completedCount = doneCount + pendingCount;
  const scheduledToday = schedule.period === 'once' ? true : schedule.daysOfWeek.includes(dayIndex);
  const window = getChoreTimeWindow(chore, dayIndex);
  const availableNow = schedule.period === 'once' ? true : scheduledToday && isWithinTimeWindow(window, now);
  const targetCount = schedule.period === 'once' ? 1 : (scheduledToday ? schedule.targetCount : 0);
  const remainingCount = Math.max(0, targetCount - completedCount);
  let status = 'none';
  let availabilityText = '';

  if (schedule.period === 'once') {
    if (doneCount > 0) status = 'done';
    else if (pendingCount > 0) status = 'pending';
  } else if (!scheduledToday) {
    status = 'unavailable';
    availabilityText = `Available on ${formatDaysOfWeek(schedule.daysOfWeek)}`;
  } else if (doneCount >= targetCount) {
    status = 'done';
  } else if (completedCount >= targetCount && pendingCount > 0) {
    status = 'pending';
  } else if (completedCount > 0) {
    status = 'partial';
  } else {
    status = 'none';
  }
  if (!availabilityText && schedule.period !== 'once' && !availableNow) {
    availabilityText = `Available ${formatTimeWindow(window)}`;
  }
  return {
    schedule, entries, isSlotMode: false,
    doneCount, pendingCount, completedCount, targetCount, remainingCount,
    scheduledToday, availableNow, window, status, availabilityText,
    canSubmit: schedule.period === 'once'
      ? completedCount < 1
      : scheduledToday && availableNow && remainingCount > 0,
  };
}

function fmtDate(str) {
  if (!str) return '';
  const [y,m,d] = str.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[+m-1]} ${+d}`;
}

function fmtDmds(n) { return `${n} gems`; }

function getMember(id) {
  return D.family.members.find(m => m.id === id);
}

function isTiny(member) {
  if (!member) return false;
  if (member.displayMode) return member.displayMode === 'tiny';
  // legacy fallback
  return member.mode === 'tiny';
}

function isBirthday(member) {
  if (!member || !member.birthday) return false;
  const [mm, dd] = member.birthday.split('-').map(Number);
  const now = new Date();
  return now.getMonth() + 1 === mm && now.getDate() === dd;
}

function pendingApprovals() {
  const arr = [];
  for (const chore of D.chores) {
    for (const mid of Object.keys(chore.completions || {})) {
      // Use getRelevantCompletionEntries so stale pending entries from previous
      // days/weeks don't surface as ghost approvals for the wrong period.
      getRelevantCompletionEntries(chore, mid).forEach(entry => {
        if (entry.status === 'pending') arr.push({ chore, memberId: mid, entry });
      });
    }
  }
  return arr;
}

function pendingSpendRequests() {
  return (D.savingsRequests || []).filter(r => r.status === 'pending');
}

function readyTeamGoalInboxItems() {
  const dismissed = new Set(Array.isArray(D.teamGoalInboxDismissed) ? D.teamGoalInboxDismissed : []);
  return (D.teamGoals || [])
    .filter(goal => {
      if (!goal?.id || dismissed.has(goal.id)) return false;
      const target = goal.targetPoints || 0;
      const total = Object.values(goal.contributions || {}).reduce((a, b) => a + b, 0);
      return target > 0 && total >= target;
    })
    .map(goal => ({
      goal,
      total: Object.values(goal.contributions || {}).reduce((a, b) => a + b, 0),
      target: goal.targetPoints || 0,
    }));
}

function familyInboxCount() {
  return pendingApprovals().length + pendingSpendRequests().length + inProgressChores().length + readyTeamGoalInboxItems().length;
}

function dismissTeamGoalInboxItem(goalId) {
  if (!goalId) return;
  if (!Array.isArray(D.teamGoalInboxDismissed)) D.teamGoalInboxDismissed = [];
  if (!D.teamGoalInboxDismissed.includes(goalId)) D.teamGoalInboxDismissed.push(goalId);
  saveData();
  renderParentHeader();
  renderParentNav();
  renderParentHome();
  syncAppBadge();
}

function inProgressChores() {
  // Chores where a before-photo was approved and the kid is actively working (needs_after phase)
  const arr = [];
  for (const chore of D.chores) {
    if (chore.photoMode !== 'before_after') continue;
    for (const mid of (chore.assignedTo || [])) {
      const phase = getChorePhotoPhase(chore, mid);
      if (phase?.phase === 'needs_after') arr.push({ chore, memberId: mid });
    }
  }
  return arr;
}

function choreStatus(chore, memberId) {
  return getChoreProgress(chore, memberId).status;
}

// Returns the current before/after photo phase for a chore+member combo.
// phase values: 'needs_before' | 'before_pending' | 'needs_after' | 'after_pending' | 'complete' | null (no photo mode)
function getChorePhotoPhase(chore, memberId, dateStr = today()) {
  const mode = chore?.photoMode;
  if (!mode || mode === 'none') return null;

  const entries = normalizeCompletionEntries(chore.completions?.[memberId])
    .filter(e => e.date === dateStr);

  if (mode === 'after') {
    const afterEntry = entries.find(e => e.entryType === 'after' || e.entryType === null);
    if (!afterEntry)                        return { phase: 'needs_after',   entryType: 'after', canRequest: false, canComplete: true  };
    if (afterEntry.status === 'pending')    return { phase: 'after_pending', entryType: 'after', canRequest: false, canComplete: false };
    if (afterEntry.status === 'done')       return { phase: 'complete',      entryType: 'after', canRequest: false, canComplete: false };
    return                                         { phase: 'needs_after',   entryType: 'after', canRequest: false, canComplete: true  };
  }

  // before_after mode
  const beforeEntry = entries.find(e => e.entryType === 'before');
  const afterEntry  = entries.find(e => e.entryType === 'after');

  if (!beforeEntry)
    return { phase: 'needs_before',   entryType: 'before', canRequest: true,  canComplete: false };
  if (beforeEntry.status === 'pending')
    return { phase: 'before_pending', entryType: 'before', canRequest: false, canComplete: false,
             errorMsg: 'Already submitted - waiting for parent to OK the start.' };
  if (beforeEntry.status === 'approved') {
    if (!afterEntry)
      return { phase: 'needs_after',   entryType: 'after',  canRequest: false, canComplete: true  };
    if (afterEntry.status === 'pending')
      return { phase: 'after_pending', entryType: 'after',  canRequest: false, canComplete: false };
    if (afterEntry.status === 'done')
      return { phase: 'complete',      entryType: 'after',  canRequest: false, canComplete: false };
    return   { phase: 'needs_after',   entryType: 'after',  canRequest: false, canComplete: true  };
  }
  return { phase: 'needs_before', entryType: 'before', canRequest: true, canComplete: false };
}

function doCompleteChore(choreId, memberId, slotId = null, photoUrl = null, entryType = null) {
  const chore  = D.chores.find(c => c.id === choreId);
  const member = getMember(memberId);
  if (!chore || !member) return null;
  const progress = getChoreProgress(chore, memberId);

  if (progress.isSlotMode) {
    const slotStatus = progress.slotStatuses?.find(s => s.slot.id === slotId);
    if (!slotStatus) return { error: 'Slot not found.' };
    if (slotStatus.status === 'done')    return { error: 'Already done for this time!' };
    if (slotStatus.status === 'pending') return { error: 'Already submitted - waiting for approval.' };
    if (slotStatus.status === 'waiting') return { error: slotStatus.slot.start ? `Available ${formatTimeWindow({start:slotStatus.slot.start, end:slotStatus.slot.end})}` : 'Not available yet.' };
  } else if (chore.photoMode === 'before_after') {
    // Validate phase transition
    const phase = getChorePhotoPhase(chore, memberId);
    if (entryType === 'before' && phase.phase !== 'needs_before') return { error: phase.errorMsg || 'Already requested.' };
    if (entryType === 'after'  && phase.phase !== 'needs_after')  return { error: phase.errorMsg || 'Not ready to submit completion yet.' };
  } else {
    if (!progress.canSubmit) {
      return { error: progress.remainingCount === 0 ? 'This task is already fully submitted for now.' : (progress.availabilityText || 'This task is not available right now.') };
    }
  }

  // Auto-here: completing a chore while marked away means they're actually home.
  const _todayStr = today();
  normalizeMember(member);
  if (!isMemberHereOnDate(member, _todayStr)) {
    member.splitHousehold.overrides[_todayStr] = true;
  }

  if (!chore.completions) chore.completions = {};
  chore.completions[memberId] = normalizeCompletionEntries(chore.completions[memberId]);

  // For 'before' entries, always require parent approval (never auto-approve the start phase)
  const isBefore = entryType === 'before';
  const autoApprove = !isBefore && D.settings.autoApprove;

  const completion = {
    id:        genId(),
    status:    autoApprove ? 'done' : 'pending',
    date:      today(),
    createdAt: Date.now(),
    slotId:    slotId    || null,
    photoUrl:  photoUrl  || null,
    entryType: entryType || null,
  };
  chore.completions[memberId].push(completion);

  // Gems only awarded for completion (after/null) entries, not before-photo requests
  if (autoApprove) {
    member.gems      = (member.gems      || 0) + chore.gems;
    member.totalEarned = (member.totalEarned || 0) + chore.gems;
    addHistory('chore', memberId, chore.title, chore.gems);
    checkAfterDiamondsAwarded(member, chore.gems);
    checkChoreBadges(chore, memberId);
    saveData();
    return { approved: true, gems: chore.gems };
  } else {
    saveData();
    // Notify parents when a kid submits a chore needing approval (fire-and-forget)
    if (S.currentUser?.role === 'kid' && D.settings.notifyChoreApproval !== false) {
      try {
        firebase.functions().httpsCallable('sendApprovalNotification')({
          familyCode: getFamilyCode(),
          kidName:    member.name || 'A kid',
          choreTitle: chore.title || 'a chore',
          isBefore:   !!isBefore,
          pendingCount: familyInboxCount(),
        }).catch(() => {});
      } catch(e) {}
    }
    return { approved: false, isBefore };
  }
}

function doApproveChore(choreId, memberId, entryId) {
  const chore  = D.chores.find(c => c.id === choreId);
  const member = getMember(memberId);
  if (!chore || !member) return;
  chore.completions[memberId] = normalizeCompletionEntries(chore.completions[memberId]);
  const entry = chore.completions[memberId].find(item => item.id === entryId);
  if (!entry) return;

  entry.photoUrl = null;

  if (entry.entryType === 'before') {
    entry.status = 'approved';
  } else {
    entry.status = 'done';
    member.gems      = (member.gems      || 0) + chore.gems;
    member.totalEarned = (member.totalEarned || 0) + chore.gems;
    addHistory('chore', memberId, chore.title, chore.gems);
    checkAfterDiamondsAwarded(member, chore.gems);
    checkChoreBadges(chore, memberId);
    // Auto-here: approving a chore means the kid must be home
    const _t = today();
    normalizeMember(member);
    if (!isMemberHereOnDate(member, _t)) {
      member.splitHousehold.overrides[_t] = true;
    }
  }
  saveData();
}

function doRejectChore(choreId, memberId, entryId, reason = '') {
  const chore = D.chores.find(c => c.id === choreId);
  if (!chore) return;
  chore.completions[memberId] = normalizeCompletionEntries(chore.completions[memberId]).filter(entry => entry.id !== entryId);
  if (!chore.completions[memberId].length) delete chore.completions[memberId];
  addHistory('decline', memberId, chore.title, 0);
  if (!D.declineNotifications) D.declineNotifications = [];
  D.declineNotifications.push({
    id: genId(),
    memberId,
    choreTitle: chore.title,
    choreIcon: chore.icon || '',
    choreIconColor: chore.iconColor || '',
    reason: reason || '',
    date: today(),
    seen: false,
  });
  saveData();
}

function doRedeemPrize(prizeId, memberId) {
  const prize  = D.prizes.find(p => p.id === prizeId);
  const member = getMember(memberId);
  if (!prize || !member) return false;
  if ((member.gems||0) < prize.cost) return false;
  member.gems -= prize.cost;
  addHistory('prize', memberId, prize.title, -prize.cost);
  if (!prize.redemptions) prize.redemptions = [];
  prize.redemptions.push({ memberId, date:today() });
  saveData();
  return true;
}

function goalTotal(goal) {
  if (!goal) return 0;
  return Object.values(goal.contributions||{}).reduce((a,b)=>a+b,0);
}

function doContributeToGoal(memberId, goalId, gems) {
  const member = getMember(memberId);
  const goal = D.teamGoals?.find(g => g.id === goalId);
  if (!member || !goal) return { ok: false, reason: 'missing' };
  const owned = member.gems || 0;
  const target = goal.targetPoints || 0;
  const total = Object.values(goal.contributions || {}).reduce((a, b) => a + b, 0);
  const remaining = Math.max(0, target - total);
  const requested = Math.max(0, parseInt(gems, 10) || 0);
  const applied = Math.min(requested, owned, remaining);
  if (requested <= 0) return { ok: false, reason: 'invalid' };
  if (applied <= 0) return { ok: false, reason: remaining <= 0 ? 'complete' : 'insufficient', requested, owned, remaining };
  member.gems -= applied;
  goal.contributions = goal.contributions || {};
  goal.contributions[memberId] = (goal.contributions[memberId]||0) + applied;
  addHistory('goal', memberId, goal.title, -applied);
  saveData();
  return {
    ok: true,
    requested,
    applied,
    refund: Math.max(0, requested - applied),
    owned,
    remaining,
    reason: requested > remaining ? 'goal_cap' : requested > owned ? 'owned_cap' : null,
  };
}

function addHistory(type, memberId, title, gems, extra = {}) {
  D.history.unshift({ id:genId(), type, memberId, title, gems, date:today(), ...extra });
}

function historyIcon(h) {
  if (h.type === 'chore') {
    if ((h.title||'').startsWith('Streak bonus')) return '<i class="ph-duotone ph-fire" style="color:#F97316"></i>';
    return '<i class="ph-duotone ph-check-circle" style="color:#16A34A"></i>';
  }
  if (h.type === 'prize')   return '<i class="ph-duotone ph-gift" style="color:#1D4ED8"></i>';
  if (h.type === 'penalty') {
    if (isUndoHistoryEntry(h.title)) return '<i class="ph-duotone ph-arrow-u-up-left" style="color:#6B7280"></i>';
    return '<i class="ph-duotone ph-speaker-slash" style="color:#991B1B"></i>';
  }
  if (h.type === 'bonus') {
    if ((h.title||'').includes('Combo')) return '<i class="ph-duotone ph-lightning" style="color:#F59E0B"></i>';
    return '<i class="ph-duotone ph-sparkle" style="color:#7C3AED"></i>';
  }
  if (h.type === 'level')   return '<i class="ph-duotone ph-trophy" style="color:#D97706"></i>';
  if (h.type === 'badge')   return '<i class="ph-duotone ph-medal" style="color:#7C3AED"></i>';
  if (h.type === 'goal')    return '<i class="ph-duotone ph-target" style="color:#0E7490"></i>';
  if (h.type === 'savings') return '<i class="ph-duotone ph-piggy-bank" style="color:#16A34A"></i>';
  if (h.type === 'decline') return '<i class="ph-duotone ph-x-circle" style="color:#9CA3AF"></i>';
  return '<i class="ph-duotone ph-circle" style="color:#9CA3AF"></i>';
}

function historyBadge(h) {
  if (h.type === 'chore') {
    if ((h.title||'').startsWith('Streak bonus')) return { color:'#c2410c', bg:'#FFF7ED' };
    return { color:'#166534', bg:'#DCFCE7' };
  }
  if (h.type === 'prize')   return { color:'#1e40af', bg:'#DBEAFE' };
  if (h.type === 'penalty') {
    if (isUndoHistoryEntry(h.title)) return { color:'#991b1b', bg:'#FEE2E2' };
    return { color:'#991b1b', bg:'#FEE2E2' };
  }
  if (h.type === 'bonus')   return (h.title||'').includes('Combo') ? { color:'#b45309', bg:'#FEF3C7' } : { color:'#4c1d95', bg:'#EDE9FE' };
  if (h.type === 'level')   return { color:'#4c1d95', bg:'#EDE9FE' };
  if (h.type === 'badge')   return { color:'#6b21a8', bg:'#F5F3FF' };
  if (h.type === 'goal')    return { color:'#0e7490', bg:'#ECFEFF' };
  if (h.type === 'savings') return { color:'#166534', bg:'#DCFCE7' };
  if (h.type === 'decline') return { color:'#6b7280', bg:'#F3F4F6' };
  return { color:'#374151', bg:'#F9FAFB' };
}

function isUndoHistoryEntry(title = '') {
  const plainTitle = String(title || '').replace(/<[^>]+>/g, '').trim().toLowerCase();
  return plainTitle.includes('undo:') || plainTitle.includes('removed:');
}

function cleanActivityTitle(title = '') {
  return String(title || '')
    .replace(/<[^>]+>/g, '')
    .replace(/^.*?(?:Undo:|Removed:)\s*/iu, 'Undo: ')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim();
}

function renderActivityRow(h) {
  const mem = getMember(h.memberId);
  const badge = historyBadge(h);
  const icon = historyIcon(h);
  const delta = Number(h.gems || 0);
  const deltaClass = delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'neutral';
  const metaBits = [];

  if (mem) metaBits.push(`${renderMemberAvatarHtml(mem)} ${esc(mem.name)}`);
  else metaBits.push('Former member');

  if (h.choreTitle) metaBits.push(esc(h.choreTitle));
  metaBits.push(fmtDate(h.date));

  return `<div class="activity-row">
    <span class="activity-badge" style="background:${badge.bg};color:${badge.color}">${icon}</span>
    <div class="activity-body">
      <div class="activity-title">${esc(cleanActivityTitle(h.title))}</div>
      <div class="activity-meta">${metaBits.join(' <span class="activity-dot">&middot;</span> ')}</div>
    </div>
    ${delta !== 0 ? `<div class="activity-delta ${deltaClass}">
      <span class="activity-delta-value">${delta > 0 ? `+${delta}` : `${delta}`}</span>
      <span class="activity-delta-unit">gems</span>
    </div>` : ''}
  </div>`;
}

const DEFAULT_LEVELS = [
  { level:1, name:'Rookie',  icon:'<i class="ph-duotone ph-leaf" style="color:#22C55E"></i>',         minXp:0    },
  { level:2, name:'Helper',  icon:'<i class="ph-duotone ph-diamond" style="color:#3B82F6"></i>',       minXp:50   },
  { level:3, name:'Gem', icon:'<i class="ph-duotone ph-diamond" style="color:#7C3AED"></i>',       minXp:150  },
  { level:4, name:'Champ',   icon:'<i class="ph-duotone ph-trophy" style="color:#D97706"></i>',        minXp:300  },
  { level:5, name:'Legend',  icon:'<i class="ph-duotone ph-fire" style="color:#EF4444"></i>',          minXp:500  },
  { level:6, name:'Hero',    icon:'<i class="ph-duotone ph-shield-star" style="color:#6C63FF"></i>',   minXp:800  },
  { level:7, name:'Master',  icon:'<i class="ph-duotone ph-crown" style="color:#D97706"></i>',         minXp:1200 },
];

const CHORE_BADGE_PRESETS = {
  'Brush Your Teeth': [
    { count:10, name:'Junior Dentist', icon:'<i class="ph-duotone ph-tooth" style="color:#38BDF8"></i>' },
    { count:25, name:'Strong Chomper', icon:'<i class="ph-duotone ph-smiley" style="color:#F59E0B"></i>' },
    { count:50, name:'Dental Surgeon', icon:'<i class="ph-duotone ph-sparkle" style="color:#8B5CF6"></i>' }
  ],
  'Take A Shower': [
    { count:10, name:'Getting Soapy', icon:'<i class="ph-duotone ph-drop" style="color:#38BDF8"></i>' },
    { count:25, name:'Bubble Boy', icon:'<i class="ph-duotone ph-cloud" style="color:#60A5FA"></i>' },
    { count:50, name:'Scrub Master', icon:'<i class="ph-duotone ph-star" style="color:#F59E0B"></i>' }
  ],
  'Dress Yourself': [
    { count:10, name:'Cool Guy', icon:'<i class="ph-duotone ph-t-shirt" style="color:#22C55E"></i>' },
    { count:25, name:'Style Pro', icon:'<i class="ph-duotone ph-sunglasses" style="color:#0EA5E9"></i>' },
    { count:50, name:'Fashion God', icon:'<i class="ph-duotone ph-crown" style="color:#D97706"></i>' }
  ],
  'Hug Your Brother': [
    { count:10, name:'Bro-migo', icon:'<i class="ph-duotone ph-heart-straight" style="color:#F472B6"></i>' },
    { count:25, name:'Best Bro', icon:'<i class="ph-duotone ph-hand-heart" style="color:#EF4444"></i>' },
    { count:50, name:'Brother Hero', icon:'<i class="ph-duotone ph-users-three" style="color:#8B5CF6"></i>' }
  ],
  'Learn To Swim': [
    { count:10, name:'Getting Splashy', icon:'<i class="ph-duotone ph-waves" style="color:#0EA5E9"></i>' },
    { count:25, name:'Pool Pal', icon:'<i class="ph-duotone ph-lifebuoy" style="color:#F97316"></i>' },
    { count:50, name:'Swimmer Kitty', icon:'<i class="ph-duotone ph-fish" style="color:#14B8A6"></i>' }
  ],
  'Help With Laundry': [
    { count:10, name:'Sock Collector', icon:'<i class="ph-duotone ph-socks" style="color:#8B5CF6"></i>' },
    { count:25, name:'Hamper Stacker', icon:'<i class="ph-duotone ph-basket" style="color:#F59E0B"></i>' },
    { count:50, name:'Clothing King', icon:'<i class="ph-duotone ph-t-shirt" style="color:#22C55E"></i>' }
  ],
  'Clean Your Room': [
    { count:10, name:"Don't Trip!", icon:'<i class="ph-duotone ph-broom" style="color:#F59E0B"></i>' },
    { count:25, name:'Relax Mode', icon:'<i class="ph-duotone ph-bed" style="color:#6366F1"></i>' },
    { count:50, name:'Blanket Boy', icon:'<i class="ph-duotone ph-house-line" style="color:#22C55E"></i>' }
  ]
};

const BADGE_DEFS = [
  { id:'first_chore',  icon:'<i class="ph-duotone ph-check-circle" style="color:#16A34A"></i>',  name:'First Task',       desc:'Complete your very first task' },
  { id:'streak_3',     icon:'<i class="ph-duotone ph-fire" style="color:#F97316"></i>',           name:'On a Roll',         desc:'3-day streak' },
  { id:'streak_7',     icon:'<i class="ph-duotone ph-waves" style="color:#3B82F6"></i>',          name:'Week Warrior',      desc:'7-day streak' },
  { id:'streak_14',    icon:'<i class="ph-duotone ph-lightning" style="color:#F59E0B"></i>',      name:'Unstoppable',       desc:'14-day streak' },
  { id:'streak_30',    icon:'<i class="ph-duotone ph-medal" style="color:#D97706"></i>',          name:'Monthly Hero',      desc:'30-day streak' },
  { id:'dmds_50',      icon:'<i class="ph-duotone ph-diamond" style="color:#3B82F6"></i>',        name:'Gem Collector', desc:'Earn 50 gems total' },
  { id:'dmds_200',     icon:'<i class="ph-duotone ph-diamond" style="color:#7C3AED"></i>',  name:'Gem Hoarder',   desc:'Earn 200 gems total' },
  { id:'dmds_500',     icon:'<i class="ph-duotone ph-piggy-bank" style="color:#10B981"></i>',     name:'Gem Mogul',     desc:'Earn 500 gems total' },
  { id:'dmds_1000',    icon:'<i class="ph-duotone ph-crown" style="color:#D97706"></i>',          name:'Gem Club',      desc:'Earn 1000 gems total' },
  { id:'level_up',     icon:'<i class="ph-duotone ph-rocket-launch" style="color:#6C63FF"></i>',  name:'Level Up!',         desc:'Reach level 2 or higher' },
  { id:'level_master', icon:'<i class="ph-duotone ph-crown-simple" style="color:#D97706"></i>',   name:'Master Level',      desc:'Reach level 7 (Master)' },
];

function getLevels() {
  const custom = D?.settings?.customLevels;
  if (Array.isArray(custom) && custom.length >= 2) return custom;
  return DEFAULT_LEVELS;
}

function getMemberLevel(member) {
  const levels = getLevels();
  const xp = member.xp || member.totalEarned || 0;
  let current = levels[0];
  for (const lvl of levels) {
    if (xp >= lvl.minXp) current = lvl;
  }
  const nextIdx = levels.findIndex(l => l.level === current.level + 1);
  const next = nextIdx >= 0 ? levels[nextIdx] : null;
  const xpIntoLevel = next ? xp - current.minXp : 0;
  const xpNeeded    = next ? next.minXp - current.minXp : 1;
  const pct         = next ? Math.min(100, Math.round(xpIntoLevel / xpNeeded * 100)) : 100;
  return { current, next, xp, xpIntoLevel, xpNeeded, pct };
}

function getBaseBadgeDef(id) {
  const base = BADGE_DEFS.find(b => b.id === id);
  if (!base) return null;
  const custom = D?.settings?.customBadgeDefs?.[id] || {};
  return { ...base, ...custom };
}

function awardBadgeIfNew(member, badgeId) {
  if (D?.settings?.baseBadgesEnabled === false) return false;
  if (!Array.isArray(member.badges)) member.badges = [];
  if (member.badges.includes(badgeId)) return false;
  const def = getBaseBadgeDef(badgeId);
  if (!def) return false;
  member.badges.push(badgeId);
  addHistory('badge', member.id, def.name, 0, { badgeIcon: def.icon });
  return true;
}

function checkDiamondBadges(member) {
  const xp = member.xp || member.totalEarned || 0;
  if (xp >= 50)   awardBadgeIfNew(member, 'dmds_50');
  if (xp >= 200)  awardBadgeIfNew(member, 'dmds_200');
  if (xp >= 500)  awardBadgeIfNew(member, 'dmds_500');
  if (xp >= 1000) awardBadgeIfNew(member, 'dmds_1000');
}

function checkChoreBadges(chore, memberId) {
  if (!chore?.badges?.length) return;
  const member = getMember(memberId);
  if (!member) return;
  const allEntries = normalizeCompletionEntries(chore.completions?.[memberId]);
  const doneCount = allEntries.filter(e => e.status === 'done').length;
  if (!Array.isArray(member.badges)) member.badges = [];
  for (const badge of chore.badges) {
    if (!badge?.id || !badge?.count) continue;
    const key = `cb_${badge.id}`;
    if (doneCount >= badge.count && !member.badges.includes(key)) {
      member.badges.push(key);
      addHistory('badge', member.id, badge.name || 'Badge', 0, { badgeIcon: badge.icon || '<i class="ph-duotone ph-medal" style="color:#7C3AED"></i>', choreTitle: chore.title });
    }
  }
}

function checkLevelUp(member, prevLevel) {
  if (!D.settings.levelingEnabled) return;
  const { current } = getMemberLevel(member);
  if (current.level > prevLevel) {
    awardBadgeIfNew(member, 'level_up');
    const maxLevel = getLevels().at(-1)?.level;
    if (current.level === maxLevel) awardBadgeIfNew(member, 'level_master');
    addHistory('level', member.id, `Level Up - ${current.name}!`, 0);
    toast(`${current.icon} Level up! ${member.name} is now ${current.name}!`);
  }
}

function updateStreak(member) {
  if (!D.settings.streakEnabled) return 0;
  const t = today();
  const st = member.streak || { current:0, best:0, lastDate:null };
  let bonus = 0;
  if (st.lastDate === t) {
    // Already counted today
  } else if (st.lastDate && !streakHasGap(member, st.lastDate, t)) {
    st.current += 1;
    st.best = Math.max(st.best, st.current);
    bonus = getStreakBonus(st.current);
  } else {
    st.current = 1;
    st.best = Math.max(st.best, 1);
  }
  st.lastDate = t;
  member.streak = st;

  // Badge checks
  if (st.current >= 3)  awardBadgeIfNew(member, 'streak_3');
  if (st.current >= 7)  awardBadgeIfNew(member, 'streak_7');
  if (st.current >= 14) awardBadgeIfNew(member, 'streak_14');
  if (st.current >= 30) awardBadgeIfNew(member, 'streak_30');
  return bonus;
}

function dateDiffDays(dateStr1, dateStr2) {
  // Both "YYYY-MM-DD"
  const d1 = new Date(dateStr1 + 'T00:00:00');
  const d2 = new Date(dateStr2 + 'T00:00:00');
  return Math.round((d2 - d1) / 86400000);
}


function getMostRecentMonday() {
  const d = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return formatDateLocal(d);
}

// Returns true if member is expected to be at THIS household on the given date.
// Always returns true when split household is disabled.
function isMemberHereOnDate(member, dateStr) {
  const sh = member.splitHousehold;
  const overrides = sh?.overrides || {};
  if (dateStr in overrides) return overrides[dateStr];
  if (!sh || !sh.enabled) return true;
  const ref  = new Date((sh.referenceMonday || getMostRecentMonday()) + 'T00:00:00');
  const d    = new Date(dateStr + 'T00:00:00');
  const diff = Math.round((d - ref) / 86400000);
  const pos  = ((diff % 14) + 14) % 14;
  return sh.cycle?.[pos] !== false;
}

// Returns true if there is at least one "here" day between fromDate and toDate
function streakHasGap(member, fromDate, toDate) {
  const from = new Date(fromDate + 'T00:00:00');
  const to   = new Date(toDate   + 'T00:00:00');
  const diff = Math.round((to - from) / 86400000);
  if (diff <= 1) return false;
  for (let i = 1; i < diff; i++) {
    const d   = new Date(from.getTime() + i * 86400000);
    const ds  = formatDateLocal(d);
    if (isMemberHereOnDate(member, ds)) return true;
  }
  return false; // all intervening days were away days
}

// Schedules (or immediately runs) the 6 pm "are they actually here?" check.
function scheduleHereCheck() {
  const now   = new Date();
  const sixPm = new Date(now);
  sixPm.setHours(18, 0, 0, 0);
  const ms = sixPm - now;
  if (ms <= 0) {
    if (S.hereCheckDate !== today()) runHereCheck();
  } else {
    setTimeout(() => { if (S.hereCheckDate !== today()) runHereCheck(); }, ms);
  }
}

function runHereCheck() {
  if (S.currentUser?.role !== 'parent') return;
  if (D.settings?.hereCheckEnabled === false) return;
  S.hereCheckDate = today();
  const t = today();
  const missing = (D.family?.members || []).filter(m => {
    if (m.role !== 'kid') return false;
    if (!isMemberHereOnDate(m, t)) return false;
    // Has any chore completion today?
    return !D.chores.some(c =>
      c.completions?.[m.id]?.some(e => e.date === t && (e.status === 'done' || e.status === 'pending'))
    );
  });
  if (!missing.length) return;
  showHereCheckModal(missing);
  // Browser notification (works when PWA is open; on installed PWA may work in bg)
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    const names = missing.map(m => m.name).join(', ');
    new Notification('GemSprout', {
      body: `${names} hasn't done any tasks today - are they actually home?`,
    });
  }
}

const DAY_LABELS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

function showSplitHouseholdModal(memberId, triggerEl = null) {
  const member = getMember(memberId);
  if (!member) return;
  const rect = triggerEl?.getBoundingClientRect?.();
  if (rect) _modalLaunchOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  S.shMemberId = memberId;
  const sh = member.splitHousehold;
  const enabled = sh.enabled;
  const cycle = sh.cycle;
  const ref = sh.referenceMonday || getMostRecentMonday();

  const weekGrid = (weekIdx) => DAY_LABELS.map((lbl, i) => {
    const pos = weekIdx * 7 + i;
    const here = cycle[pos] !== false;
    return `<button class="sh-day-btn ${here ? 'here' : 'away'}" onclick="toggleShDay(${pos})" id="sh-day-${pos}">${lbl}</button>`;
  }).join('');

  showQuickActionModal(`
    <div class="modal-title"><i class="ph-duotone ph-house" style="color:#6C63FF;font-size:1.2rem;vertical-align:middle"></i> Split household schedule</div>

    <div class="form-group">
      <label class="form-label">Week 1 starts on <span class="form-label-hint">any Monday</span></label>
      <input type="date" id="sh-ref-monday" value="${ref}">
    </div>

    <div class="form-group" style="margin-bottom:4px">
      <label class="form-label">Schedule <span class="form-label-hint">tap a day to toggle home / away</span></label>
      <div class="sh-section">
        <div class="sh-week-block">
          <div class="sh-week-label">Week 1</div>
          <div class="sh-days-row">${weekGrid(0)}</div>
        </div>
        <div class="sh-week-block">
          <div class="sh-week-label">Week 2</div>
          <div class="sh-days-row">${weekGrid(1)}</div>
        </div>
      </div>
    </div>

    <div style="display:flex;gap:6px;font-size:0.78rem;color:var(--muted);margin-top:8px">
      <i class="ph-duotone ph-lightbulb" style="color:#F59E0B;flex-shrink:0;margin-top:2px"></i>
      <span>Completing a task on an away day automatically toggles the kid to home. Use the Home / Away toggles in Settings to make one-off changes.</span>
    </div>

    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveSplitHousehold()">Save</button>
    </div>`, 'quick-action-modal-wide');

  if (enabled && typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}


// Holds temporary cycle state while modal is open
function _getShCycle() {
  const btns = document.querySelectorAll('[id^="sh-day-"]');
  const cycle = Array(14).fill(true);
  btns.forEach(btn => {
    const pos = parseInt(btn.id.replace('sh-day-',''));
    cycle[pos] = btn.classList.contains('here');
  });
  return cycle;
}

function toggleShDay(pos) {
  const btn = document.getElementById(`sh-day-${pos}`);
  if (!btn) return;
  const nowHere = btn.classList.contains('here');
  btn.classList.toggle('here', !nowHere);
  btn.classList.toggle('away', nowHere);
}

function refreshShGrid() {
  // Re-render cycle preview based on current toggle states (no data change needed)
}

function addShOverride() {
  const date = document.getElementById('sh-ov-date')?.value;
  const type = document.getElementById('sh-ov-type')?.value === 'true';
  if (!date) return;
  const member = getMember(S.shMemberId);
  if (!member) return;
  member.splitHousehold.overrides[date] = type;
  // Refresh list
  const list = document.getElementById('sh-overrides-list');
  if (!list) return;
  list.innerHTML = Object.entries(member.splitHousehold.overrides)
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([d, isHere]) => `
      <div class="sh-override-row" id="sh-ov-${d}">
        <span class="sh-override-label">${d}</span>
        <span class="sh-badge ${isHere ? 'here' : 'away'}">${isHere ? 'Here' : 'Away'}</span>
        <button class="btn-icon-sm" onclick="removeShOverride('${d}')"><i class="ph-duotone ph-x" style="font-size:0.9rem"></i></button>
      </div>`).join('') || '<div style="color:var(--text-muted);font-size:0.82rem">No exceptions yet</div>';
}

function removeShOverride(date) {
  showQuickActionModal(`
    <div class="modal-title">Remove Exception?</div>
    <p style="margin:0 0 20px;color:var(--muted);font-size:0.95rem;line-height:1.5">The schedule exception for <strong>${date}</strong> will be removed.</p>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" onclick="closeModal();_doRemoveShOverride('${date}')">Remove</button>
    </div>`);
}

function _doRemoveShOverride(date) {
  const member = getMember(S.shMemberId);
  if (!member) return;
  delete member.splitHousehold.overrides[date];
  document.getElementById(`sh-ov-${date}`)?.remove();
  if (!Object.keys(member.splitHousehold.overrides).length) {
    const list = document.getElementById('sh-overrides-list');
    if (list) list.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem">No exceptions yet</div>';
  }
}

function saveSplitHousehold() {
  const source = getMember(S.shMemberId);
  if (!source) return;
  source.splitHousehold.referenceMonday = document.getElementById('sh-ref-monday')?.value || getMostRecentMonday();
  source.splitHousehold.cycle = _getShCycle();
  // Apply schedule to all kids equally (overrides stay per-kid)
  const { referenceMonday, cycle } = source.splitHousehold;
  D.family.members.filter(m => m.role === 'kid' && !m.deleted && m.id !== source.id).forEach(m => {
    normalizeMember(m);
    m.splitHousehold.referenceMonday = referenceMonday;
    m.splitHousehold.cycle = [...cycle];
  });
  saveData();
  closeModal();
  toast('Split household schedule saved');
  renderSettings();
}

function showHereCheckModal(members) {
  const rows = members.map(m => `
    <div class="here-check-member-row">
      <span style="font-size:1.8rem">${renderMemberAvatarHtml(m)}</span>
      <span style="font-weight:600;flex:1">${esc(m.name)}</span>
      <div class="here-check-btns">
        <button class="btn btn-sm" style="background:var(--green);color:#fff" onclick="markHereToday('${m.id}')">Here <i class="ph-duotone ph-check" style="font-size:0.9rem;vertical-align:middle"></i></button>
        <button class="btn btn-secondary btn-sm" onclick="markAwayToday('${m.id}')">Away</button>
      </div>
    </div>`).join('');

  showQuickActionModal(`
    <div class="modal-title"><i class="ph-duotone ph-house" style="color:#6C63FF;font-size:1.2rem;vertical-align:middle"></i> Are they home?</div>
    <p style="color:var(--text-muted);font-size:0.88rem;margin-bottom:12px">
      It's past 6 pm and these kids haven't done any tasks today. Are they actually at your house?
    </p>
    ${rows}
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Dismiss</button>
    </div>`, 'quick-action-modal-wide');
}

function markHereToday(memberId) {
  const member = getMember(memberId);
  if (member?.splitHousehold) member.splitHousehold.overrides[today()] = true;
  saveData();
  closeModal();
}

function markAwayToday(memberId) {
  const member = getMember(memberId);
  if (member?.splitHousehold) member.splitHousehold.overrides[today()] = false;
  saveData();
  closeModal();
}

function setTodayStatus(memberId, isHere) {
  const member = getMember(memberId);
  if (member?.splitHousehold) member.splitHousehold.overrides[today()] = isHere;
  saveData();
  renderSettings();
}

function toggleFamilySplitHousehold(enabled) {
  D.family.members.filter(m => m.role === 'kid' && !m.deleted).forEach(m => {
    normalizeMember(m);
    m.splitHousehold.enabled = enabled;
  });
  saveData();
  renderSettings();
}

function getStreakBonus(streakCount) {
  const s = D.settings;
  if (streakCount >= 30) return s.streakBonus30 || 10;
  if (streakCount >= 14) return s.streakBonus14 || 5;
  if (streakCount >= 7)  return s.streakBonus7  || 3;
  if (streakCount >= 3)  return s.streakBonus3  || 1;
  return 0;
}

function checkAfterDiamondsAwarded(member, dmds) {
  // Called after gems are added to member. Updates XP, level, streak, badges.
  if (!member) return;
  normalizeMember(member);
  const s = D.settings;
  const prevLevel = getMemberLevel(member).current.level;

  // Update XP
  if (s.levelingEnabled) {
    member.xp = (member.xp || 0) + dmds;
  }

  // Streak
  let streakBonus = 0;
  if (s.streakEnabled) {
    streakBonus = updateStreak(member);
    if (streakBonus > 0) {
      member.gems      = (member.gems      || 0) + streakBonus;
      member.totalEarned = (member.totalEarned || 0) + streakBonus;
      member.xp          = (member.xp          || 0) + streakBonus;
      addHistory('chore', member.id, `Streak bonus (${member.streak.current} days)`, streakBonus);
      toast(`<i class="ph-duotone ph-fire" style="color:#F97316;font-size:1rem;vertical-align:middle"></i> ${member.streak.current}-day streak! +${streakBonus} bonus gems`);
    }
  }

  // First chore badge
  awardBadgeIfNew(member, 'first_chore');
  checkDiamondBadges(member);
  if (s.levelingEnabled) checkLevelUp(member, prevLevel);
  // Check if daily combo is now complete
  checkComboBonus(member.id);
}

function _seededShuffle(arr, seed) {
  let s = seed >>> 0;
  const rand = () => {
    s += 0x6D2B79F5; let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Build all kids' combos in one pass so no chore appears in two kids' combos.
// Kids are processed in stable ID order; first kid gets first pick.
let _allCombosCache = { key: null, combos: {} };

function getAllDailyCombos() {
  const kids = D.family.members.filter(m => m.role === 'kid' && !m.deleted);
  const cacheKey = today() + '|' + kids.map(m => m.id).sort().join(',');
  if (_allCombosCache.key === cacheKey) return _allCombosCache.combos;

  const sortedKids = [...kids].sort((a, b) => a.id.localeCompare(b.id));
  const combos = {};
  const used   = new Set(); // chore IDs already claimed by an earlier kid

  for (const kid of sortedKids) {
    const eligible = D.chores.filter(c =>
      c.assignedTo?.includes(kid.id) &&
      c.schedule?.period !== 'once'  &&
      !used.has(c.id)
    );
    let ids;
    if (eligible.length <= 3) {
      ids = eligible.map(c => c.id);
    } else {
      let seed = 0;
      const str = today() + '|' + kid.id;
      for (let i = 0; i < str.length; i++) {
        seed = Math.imul(seed ^ str.charCodeAt(i), 0x9E3779B9);
      }
      ids = _seededShuffle(eligible, seed).slice(0, 3).map(c => c.id);
    }
    combos[kid.id] = ids;
    ids.forEach(id => used.add(id));
  }

  _allCombosCache = { key: cacheKey, combos };
  return combos;
}

function getDailyCombo(memberId) {
  const override = D.settings.comboOverrides?.[memberId];
  if (override && override.date === today()) return override.ids;
  return getAllDailyCombos()[memberId] || [];
}

function setComboOverride(memberId, slotIndex, choreId) {
  if (!D.settings.comboOverrides) D.settings.comboOverrides = {};
  const current = D.settings.comboOverrides[memberId];
  const existingIds = (current?.date === today()) ? [...current.ids] : getDailyCombo(memberId).slice(0, 3);
  existingIds[slotIndex] = choreId;
  D.settings.comboOverrides[memberId] = { date: today(), ids: existingIds };
  _allCombosCache = { key: null, combos: {} };
  saveData();
  renderParentLevels();
}

function clearComboOverride(memberId) {
  if (S.pendingComboOverrides) delete S.pendingComboOverrides[memberId];
  if (!D.settings.comboOverrides) { renderParentLevels(); return; }
  delete D.settings.comboOverrides[memberId];
  _allCombosCache = { key: null, combos: {} };
  saveData();
  renderParentLevels();
}

function stagePendingCombo(kidId, slotIndex, choreId) {
  if (!S.pendingComboOverrides) S.pendingComboOverrides = {};
  if (!S.pendingComboOverrides[kidId]) S.pendingComboOverrides[kidId] = {};
  S.pendingComboOverrides[kidId][slotIndex] = choreId;
  renderParentLevels();
}

function saveComboOverride(kidId) {
  if (!S.pendingComboOverrides) S.pendingComboOverrides = {};
  const pending = S.pendingComboOverrides[kidId] || {};
  const currentCombo = getDailyCombo(kidId);
  const finalIds = [0, 1, 2].map(i => pending[i] || currentCombo[i]).filter(Boolean);
  const member = getMember(kidId);
  if (!member) return;

  const alreadyAwarded = member.comboBonusDate === today();
  if (!alreadyAwarded && finalIds.length === 3) {
    const allDone = finalIds.every(id => {
      const chore = D.chores.find(c => c.id === id);
      return chore && getChoreProgress(chore, kidId).status === 'done';
    });
    if (allDone) {
      const baseSum = finalIds.reduce((sum, id) => {
        const chore = D.chores.find(c => c.id === id);
        return sum + (chore?.gems || 0);
      }, 0);
      const bonusPts = Math.max(1, (D.settings.comboMultiplier || 2) - 1) * baseSum;
      S._pendingComboSave = { kidId, finalIds };
      showQuickActionModal(`
        <div class="modal-title"><i class="ph-duotone ph-lightning" style="color:#F59E0B;vertical-align:middle"></i> Combo Will Complete!</div>
        <p style="font-size:0.9rem;color:var(--muted);margin:0 0 16px">
          Saving this rhythm for <b>${esc(member.name)}</b> will immediately award the Daily Combo bonus of <b>+${bonusPts} gems</b> since all 3 tasks are already complete.
        </p>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary" onclick="closeModal()" style="flex:1">Cancel</button>
          <button class="btn btn-primary" onclick="closeModal();_commitPendingComboSave()" style="flex:1">Save &amp; Award Gems</button>
        </div>`);
      return;
    }
  }
  _applyComboSave(kidId, finalIds);
}

function _commitPendingComboSave() {
  if (!S._pendingComboSave) return;
  const { kidId, finalIds } = S._pendingComboSave;
  S._pendingComboSave = null;
  _applyComboSave(kidId, finalIds);
}

function _applyComboSave(kidId, finalIds) {
  if (!S.pendingComboOverrides) S.pendingComboOverrides = {};
  delete S.pendingComboOverrides[kidId];
  if (!D.settings.comboOverrides) D.settings.comboOverrides = {};
  D.settings.comboOverrides[kidId] = { date: today(), ids: finalIds };
  _allCombosCache = { key: null, combos: {} };
  saveData();
  checkComboBonus(kidId);
  renderParentLevels();
}

function checkComboBonus(memberId) {
  if (D.settings.comboEnabled === false) return;
  const member = getMember(memberId);
  if (!member) return;
  const combo = getDailyCombo(memberId);
  if (combo.length < 3) return;
  if (member.comboBonusDate === today()) return; // already awarded today

  const allDone = combo.every(id => {
    const chore = D.chores.find(c => c.id === id);
    return chore && getChoreProgress(chore, memberId).status === 'done';
  });
  if (!allDone) return;

  member.comboBonusDate = today();
  const baseSum = combo.reduce((sum, id) => {
    const chore = D.chores.find(c => c.id === id);
    return sum + (chore?.gems || 0);
  }, 0);
  const bonusPts = Math.max(1, (D.settings.comboMultiplier || 2) - 1) * baseSum;
  member.gems      = (member.gems      || 0) + bonusPts;
  member.totalEarned = (member.totalEarned || 0) + bonusPts;
  if (D.settings.levelingEnabled !== false) member.xp = (member.xp || 0) + bonusPts;
  addHistory('bonus', memberId, 'Daily Combo Bonus!', bonusPts);
  markBonusesSeen(memberId); // prevent Firestore echo from re-triggering

  // Update combo streak
  normalizeMember(member);
  const cs = member.comboStreak;
  const yStr = addDaysToDate(today(), -1);
  if (cs.lastDate === yStr) {
    cs.current += 1;
  } else if (cs.lastDate !== today()) {
    cs.current = 1;
  }
  if (cs.current > (cs.best || 0)) cs.best = cs.current;
  cs.lastDate = today();
  saveData();

  setTimeout(() => {
    if (S.currentUser?.role === 'kid' && S.currentUser?.id === memberId) {
      launchMixedRain();
    }
    const streakMsg = cs.current > 1 ? ` <i class="ph-duotone ph-fire" style="color:#F97316;font-size:0.9rem;vertical-align:middle"></i> ${cs.current} day combo streak!` : '';
    toast(`<i class="ph-duotone ph-lightning" style="color:#F59E0B;font-size:1rem;vertical-align:middle"></i> COMBO COMPLETE! +${bonusPts} bonus gems!${streakMsg}`);
  }, 300);
}

function fmtNLTime(secs) {
  if (!secs || secs <= 0) return '0s';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

let _nlState = {
  isHolding: false, holdStart: null, accumulated: 0, diamondsLost: 0,
  selectedKids: [], rafId: null,
};

function showNotListening(preselectKidId = '') {
  const kids = D.family.members.filter(m => m.role === 'kid' && !m.deleted);
  _nlState = { isHolding: false, holdStart: null, accumulated: 0, diamondsLost: 0,
    selectedKids: preselectKidId ? [preselectKidId] : kids.length === 1 ? [kids[0].id] : [], rafId: null };
  showQuickActionModal('<div id="nl-modal-body" class="nl-modal-shell"></div>', 'quick-action-modal-wide');
  _renderNL();
}

function _renderNL() {
  const kids = D.family.members.filter(m => m.role === 'kid' && !m.deleted);
  const st = _nlState;
  const secsPerPt = D.settings.notListeningSecs || 60;
  const totalSecs = Math.floor(st.accumulated / 1000);
  const mins = String(Math.floor(totalSecs / 60)).padStart(2,'0');
  const secs = String(totalSecs % 60).padStart(2,'0');

  const target = document.getElementById('nl-modal-body') || document.getElementById('nl-root');
  if (!target) return;
  target.innerHTML = `

    <div class="nl-timer" id="nl-timer">${mins}:${secs}</div>
    <div class="nl-dmds-lost" id="nl-dmds">${st.diamondsLost > 0 ? `-${st.diamondsLost} gems so far` : 'Hold the button to deduct gems'}</div>
    <div class="nl-kids">
      ${kids.map(k => {
        const t = today();
        normalizeMember(k);
        const todaySecs = (k.nlDate === t ? k.nlTodaySecs || 0 : 0) + (st.selectedKids.includes(k.id) ? Math.floor(st.accumulated / 1000) : 0);
        const secsLabel = todaySecs > 0 ? ` ? ${Math.floor(todaySecs/60)}m${todaySecs%60}s today` : '';
        return `
        <div class="nl-kid-chip ${st.selectedKids.includes(k.id)?'selected':''}"
             onclick="_nlToggleKid('${k.id}')">
          ${k.avatar||'<i class="ph-duotone ph-smiley" style="color:#9CA3AF"></i>'} ${esc(k.name)}<br><span style="font-size:0.72rem;opacity:0.8">${secsLabel||'no time today'}</span>
        </div>`;
      }).join('')}
    </div>
    <button class="nl-hold-btn ${st.isHolding?'holding':''}" id="nl-btn"
      onmousedown="_nlHoldStart()" onmouseup="_nlHoldEnd()" onmouseleave="_nlHoldEnd()"
      ontouchstart="_nlHoldStart(event)" ontouchend="_nlHoldEnd(event)" ontouchcancel="_nlHoldEnd(event)">
      <span class="nl-hold-btn-text">${st.isHolding ? 'RUNNING' : 'HOLD'}</span>
      <span class="nl-hold-hint">${st.isHolding ? 'Release to pause' : 'Hold to penalize'}</span>
    </button>
    <div class="nl-actions">
      <button class="nl-btn-cancel" onclick="_nlCancel()">Cancel</button>
      <button class="nl-btn-done"   onclick="_nlDone()">Apply & Done</button>
    </div>`;
}

function _nlToggleKid(kidId) {
  const i = _nlState.selectedKids.indexOf(kidId);
  if (i >= 0) _nlState.selectedKids.splice(i, 1);
  else _nlState.selectedKids.push(kidId);
  _renderNL();
}

let _nlBonkTimer = null;

function _nlBonk() {
  try { new Audio('alarm.wav').play(); } catch(e) {}
}

function _nlAlarmStart() {
  const offset = _nlState.accumulated % 1000;
  const delay  = (offset === 0 ? 1000 : (1000 - offset)) + 25;
  _nlBonkTimer = setTimeout(() => {
    _nlBonk();
    _nlBonkTimer = setInterval(_nlBonk, 1000);
  }, delay);
}

function _nlAlarmStop() {
  if (_nlBonkTimer) { clearTimeout(_nlBonkTimer); clearInterval(_nlBonkTimer); _nlBonkTimer = null; }
}

function _nlHoldStart(evt) {
  if (evt) evt.preventDefault();
  if (_nlState.isHolding) return;
  _nlState.isHolding = true;
  _nlState.holdStart = Date.now();
  _nlAlarmStart();
  _renderNL();
  _nlTick();
}

function _nlHoldEnd(evt) {
  if (evt) evt.preventDefault();
  if (!_nlState.isHolding) return;
  _nlState.accumulated += Date.now() - _nlState.holdStart;
  _nlState.isHolding = false;
  _nlState.holdStart = null;
  _nlAlarmStop();
  if (_nlState.rafId) { cancelAnimationFrame(_nlState.rafId); _nlState.rafId = null; }
  _nlUpdateDisplay();
  _renderNL();
}

function _nlTick() {
  if (!_nlState.isHolding) return;
  _nlUpdateDisplay();
  _nlState.rafId = requestAnimationFrame(_nlTick);
}

function _nlUpdateDisplay() {
  const secsPerPt = D.settings.notListeningSecs || 60;
  const elapsed = _nlState.accumulated + (_nlState.isHolding ? Date.now() - _nlState.holdStart : 0);
  const totalSecs = Math.floor(elapsed / 1000);
  const mins = String(Math.floor(totalSecs / 60)).padStart(2,'0');
  const secs = String(totalSecs % 60).padStart(2,'0');
  _nlState.diamondsLost = Math.floor(elapsed / 1000 / secsPerPt);

  const timerEl = document.getElementById('nl-timer');
  const ptsEl   = document.getElementById('nl-dmds');
  if (timerEl) timerEl.textContent = `${mins}:${secs}`;
  if (ptsEl) ptsEl.textContent = _nlState.diamondsLost > 0
    ? `-${_nlState.diamondsLost} gems so far`
    : 'Hold the button to deduct gems';
}

function _nlCancel() {
  _nlAlarmStop();
  if (_nlState.rafId) cancelAnimationFrame(_nlState.rafId);
  _nlState = { isHolding:false, holdStart:null, accumulated:0, diamondsLost:0, selectedKids:[], rafId:null };
  const modalBody = document.getElementById('nl-modal-body');
  if (modalBody) closeModal();
  const nlRoot = document.getElementById('nl-root');
  if (nlRoot) {
    nlRoot.classList.remove('open');
    nlRoot.innerHTML = '';
  }
}

function _nlDone() {
  if (_nlState.isHolding) _nlHoldEnd();
  const sessionSecs = Math.floor(_nlState.accumulated / 1000);
  const secsPerPt = D.settings.notListeningSecs || 60;
  const t = today();
  let totalDeducted = 0;
  if (_nlState.selectedKids.length > 0) {
    _nlState.selectedKids.forEach(kidId => {
      const m = getMember(kidId);
      if (!m) return;
      normalizeMember(m);
      // Today's display counter (resets daily)
      if (m.nlDate !== t) { m.nlTodaySecs = 0; m.nlDate = t; }
      m.nlTodaySecs = (m.nlTodaySecs || 0) + sessionSecs;
      m.nlLifetimeSecs = (m.nlLifetimeSecs || 0) + sessionSecs;
      m.nlPendingSecs = (m.nlPendingSecs || 0) + sessionSecs;
      const dmds = Math.floor(m.nlPendingSecs / secsPerPt);
      m.nlPendingSecs = m.nlPendingSecs % secsPerPt;
      if (dmds > 0) {
        m.diamonds = Math.max(0, (m.diamonds || 0) - dmds);
        addHistory('penalty', kidId, `Not listening penalty`, -dmds);
        totalDeducted += dmds;
      }
    });
    saveData();
    if (totalDeducted > 0) {
      const names = _nlState.selectedKids.map(id => getMember(id)?.name).filter(Boolean).join(' & ');
      toast(`Deducted ${totalDeducted} gems from ${names}`);
    }
    renderParentHome();
    renderParentHeader();
    renderParentNav();
  }
  _nlCancel();
}

let ttsEnabled = true;

function getEnglishVoices() {
  return (window.speechSynthesis?.getVoices() || []).filter(v => v.lang.startsWith('en'));
}

function getBestVoice(name) {
  const voices = getEnglishVoices();
  if (!voices.length) return null;
  if (name) {
    const match = voices.find(v => v.name === name);
    if (match) return match;
  }
  return voices.find(v => v.name === 'Samantha') || voices[0];
}

function speak(text, voiceName) {
  if (!ttsEnabled || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utt  = new SpeechSynthesisUtterance(text);
  utt.rate   = 0.88;
  utt.pitch  = 1.15;
  utt.volume = 1;
  const voice = getBestVoice(voiceName || S.currentUser?.ttsVoice);
  if (voice) utt.voice = voice;
  window.speechSynthesis.speak(utt);
}

function setMemberVoice(i, voiceName) {
  if (!S.setupMembers[i]) return;
  S.setupMembers[i].ttsVoice = voiceName;
}

function previewMemberVoice(i) {
  const sel = document.getElementById(`voice-sel-${i}`);
  const voiceName = sel?.value || S.setupMembers[i]?.ttsVoice;
  if (!voiceName) return;
  speak(`Hi, I'm ${voiceName}!`, voiceName);
}

if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => {
    if (SETUP_STEPS[S.setupStep] === 'members') renderSetupStep({ preserveScroll: true });
  };
}

function fmtCurrencySpeech(amount, symbol) {
  if ((symbol || '$') !== '$') return `${amount.toFixed(2)} ${symbol}`;
  const dollars = Math.floor(amount);
  const cents   = Math.round((amount - dollars) * 100);
  if (dollars > 0 && cents > 0) return `${dollars} dollar${dollars !== 1 ? 's' : ''} and ${cents} cent${cents !== 1 ? 's' : ''}`;
  if (dollars > 0) return `${dollars} dollar${dollars !== 1 ? 's' : ''}`;
  return `${cents} cent${cents !== 1 ? 's' : ''}`;
}

function fmtCurrencyVisual(amount, symbol = '$') {
  const value = Number(amount || 0);
  if ((symbol || '$') !== '$') {
    return Number.isInteger(value) ? `${value} ${symbol}` : `${value.toFixed(2)} ${symbol}`;
  }
  return Number.isInteger(value) ? `${symbol}${value}` : `${symbol}${value.toFixed(2)}`;
}

function renderIcon(name, color, extraStyle='') {
  if (!name) return '';
  // Legacy emoji: any string with non-ASCII characters
  if ([...name].some(c => c.codePointAt(0) > 127)) return name;
  const col = color || '#6C63FF';
  return `<i class="ph-duotone ph-${name}" style="color:${col};${extraStyle}"></i>`;
}

function selChoreColor(el, color) {
  document.getElementById('cm-icon-color').value = color;
  el.closest('.icon-color-row').querySelectorAll('.icon-color-swatch').forEach(x => x.classList.remove('sel'));
  el.classList.add('sel');
  const grid = document.getElementById('icon-picker-grid');
  if (grid) grid.style.color = color;
}

function selPrizeColor(el, color) {
  document.getElementById('pm-icon-color').value = color;
  el.closest('.icon-color-row').querySelectorAll('.icon-color-swatch').forEach(x => x.classList.remove('sel'));
  el.classList.add('sel');
  const grid = document.getElementById('prize-icon-picker-grid');
  if (grid) grid.style.color = color;
}

function toast(msg, duration = 2900) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

function diamondsBurst(x, y, diamonds) {
  const el = document.createElement('div');
  el.className = 'dmds-burst';
  el.textContent = `+${diamonds} gems`;
  el.style.left = `${x}px`;
  el.style.top  = `${y}px`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1700);
}

function _startRain(pieces) {
  const wrap = document.getElementById('confetti-root');
  if (!wrap) return;
  const batchId = Date.now() + Math.random();
  pieces.forEach(el => { el.dataset.batch = batchId; wrap.appendChild(el); });
  setTimeout(() => {
    wrap.querySelectorAll(`[data-batch="${batchId}"]`).forEach(el => el.remove());
  }, 5000);
}

function launchRain(factory, count = 55, opts = {}) {
  const pieces = [];
  const minSize = opts.minSize ?? 28;
  const maxSize = opts.maxSize ?? 62;
  const minDuration = opts.minDuration ?? 1.8;
  const durationRange = opts.durationRange ?? 3.72;
  const maxDelay = opts.maxDelay ?? 1.4;
  const minOpacity = opts.minOpacity ?? 0.72;
  const opacityRange = opts.opacityRange ?? 0.28;
  const minDrift = opts.minDrift ?? -18;
  const driftRange = opts.driftRange ?? 36;
  const minRotateStart = opts.minRotateStart ?? -35;
  const rotateStartRange = opts.rotateStartRange ?? 70;
  const minRotateTravel = opts.minRotateTravel ?? 80;
  const rotateTravelRange = opts.rotateTravelRange ?? 180;
  for (let i = 0; i < count; i++) {
    const size = minSize + Math.random() * Math.max(0, maxSize - minSize);
    const drift = minDrift + Math.random() * driftRange;
    const rotateStart = minRotateStart + Math.random() * rotateStartRange;
    const rotateEnd = rotateStart + (Math.random() > 0.5 ? 1 : -1) * (minRotateTravel + Math.random() * rotateTravelRange);
    const el = factory({ index: i, size, drift, rotateStart, rotateEnd });
    if (!el) continue;
    el.classList.add('gem-rain-piece');
    el.style.cssText = `
      ${el.style.cssText || ''};
      left:${Math.random() * 110 - 5}%;
      animation-duration:${minDuration + Math.random() * durationRange}s;
      animation-delay:${Math.random() * maxDelay}s;
      opacity:${minOpacity + Math.random() * opacityRange};
      --rain-drift:${drift}px;
      --rain-rotate-start:${rotateStart}deg;
      --rain-rotate-end:${rotateEnd}deg;
    `;
    pieces.push(el);
  }
  _startRain(pieces);
}

function launchBadgeRain(iconHtml, count = 110) {
  const isHtml = iconHtml.includes('<');
  launchRain(({ size }) => {
    const el = document.createElement('div');
    if (isHtml) el.innerHTML = iconHtml;
    else el.textContent = iconHtml;
    el.style.cssText = `font-size:${Math.max(1, size / 20).toFixed(2)}rem;`;
    return el;
  }, count, { minSize: 20, maxSize: 48, minDuration: 1.5, durationRange: 2, maxDelay: 1.6 });
}

const _rapidTapState = {};

function _setRapidTapPulse(el, scale = 1, opacity = null) {
  if (!el) return;
  const isEggGem = el.id === 'egg-gem';
  el.style.transform = isEggGem
    ? `translate(-50%, -50%) scale(${scale})`
    : `scale(${scale})`;
  if (opacity != null) el.style.opacity = String(opacity);
}

function handleRapidTap(key, opts = {}) {
  const required = opts.required || 5;
  const windowMs = opts.windowMs || 2500;
  const pulseEl = opts.pulseEl || null;
  const idleOpacity = opts.idleOpacity ?? null;
  const state = _rapidTapState[key] || { taps: 0, timer: null };
  state.taps += 1;
  if (pulseEl) {
    _setRapidTapPulse(pulseEl, 1.4, idleOpacity != null ? Math.min(idleOpacity + state.taps * 0.15, 1) : null);
    setTimeout(() => _setRapidTapPulse(pulseEl, 1), 120);
  }
  clearTimeout(state.timer);
  if (state.taps >= required) {
    state.taps = 0;
    if (pulseEl && idleOpacity != null) pulseEl.style.opacity = '1';
    _rapidTapState[key] = state;
    opts.onTrigger?.();
    return;
  }
  state.timer = setTimeout(() => {
    state.taps = 0;
    if (pulseEl && idleOpacity != null) pulseEl.style.opacity = String(idleOpacity);
  }, windowMs);
  _rapidTapState[key] = state;
}

function launchAvatarRain(avatar, count = 80) {
  const isImage = !!avatar && /\.(png|jpe?g|gif|webp)$/i.test(avatar);
  launchRain(({ size }) => {
    const el = isImage ? document.createElement('img') : document.createElement('div');
    if (isImage) {
      el.src = avatar;
      el.alt = '';
      el.style.cssText = `width:${size}px;height:${size}px;`;
    } else {
      el.innerHTML = avatar || '<i class="ph-duotone ph-smiley" style="color:#9CA3AF"></i>';
      el.style.cssText = `font-size:${Math.max(1.2, size / 24).toFixed(2)}rem;`;
    }
    return el;
  }, count, { minSize: 28, maxSize: 70, minDuration: 2.2, durationRange: 2.8, maxDelay: 1.3 });
}

function easterEggTap() {
  handleRapidTap('egg-gem', {
    pulseEl: document.getElementById('egg-gem'),
    idleOpacity: 0.25,
    onTrigger: () => launchAvatarRain('gemsproutpadded.png', 80),
  });
}

function launchGemsproutRain(count = 80) {
  launchAvatarRain('gemsproutpadded.png', count);
}

function launchConfetti(count = 100, emoji = '*') {
  launchRain(({ size }) => {
    const el = document.createElement('div');
    el.textContent = emoji;
    el.style.cssText = `font-size:${Math.max(1, size / 18).toFixed(2)}rem;`;
    return el;
  }, count, { minSize: 18, maxSize: 52, minDuration: 1.4, durationRange: 2, maxDelay: 1.4 });
}

function launchMixedRain(count = 240) {
  launchRain(({ index, size }) => {
    const el = document.createElement('div');
    el.textContent = index % 3 === 0 ? '*' : '+';
    el.style.cssText = `font-size:${Math.max(1, size / 18).toFixed(2)}rem;`;
    return el;
  }, count, { minSize: 18, maxSize: 52, minDuration: 1.4, durationRange: 2, maxDelay: 1.4 });
}

function kidAvatarEasterEgg(ev) {
  ev?.preventDefault?.();
  ev?.stopPropagation?.();
  const m = S.currentUser;
  handleRapidTap('header-avatar', {
    pulseEl: document.querySelector('#kid-header .header-avatar'),
    onTrigger: () => launchAvatarRain(m?.avatar || '<i class="ph-duotone ph-smiley" style="color:#9CA3AF"></i>', 84),
  });
}

function parentAvatarEasterEgg(ev) {
  ev?.preventDefault?.();
  ev?.stopPropagation?.();
  const m = S.currentUser;
  handleRapidTap('header-avatar', {
    pulseEl: document.querySelector('#parent-header .header-avatar'),
    onTrigger: () => launchAvatarRain(m?.avatar || '<i class="ph-duotone ph-user-circle" style="color:#9CA3AF"></i>', 84),
  });
}

function launchDollarRain(count = 160) {
  const bills = ['$','$','$','$','$'];
  launchRain(({ index, size }) => {
    const el = document.createElement('div');
    el.textContent = bills[index % bills.length];
    el.style.cssText = `font-size:${Math.max(1, size / 18).toFixed(2)}rem;`;
    return el;
  }, count, { minSize: 18, maxSize: 52, minDuration: 1.4, durationRange: 2, maxDelay: 1.4 });
}

const _celebQueue = [];

function showCelebration(opts) {
  _celebQueue.push(opts);
  // Defer so all synchronous calls batch before any rendering,
  // ensuring the first modal knows the full queue size.
  if (_celebQueue.length === 1) setTimeout(_showNextCelebration, 0);
}

function _showNextCelebration() {
  const root = document.getElementById('celebration-root');
  if (root.innerHTML.trim() || _celebQueue.length === 0) return;
  _renderCelebration(_celebQueue.shift());
}

function _renderCelebration({ icon='<i class="ph-duotone ph-confetti" style="color:#F97316;font-size:3rem"></i>', title='Great job!', sub='', diamonds=null, dollars=null, cur='$', noAnimation=false, badgeIcon=null, btnLabel=null, tts=null, onClose=null }) {
  const root = document.getElementById('celebration-root');
  const ptsHtml = diamonds !== null
    ? `<div class="cel-gems">+${diamonds} gems</div>`
    : dollars !== null
      ? `<div class="cel-gems" style="color:#16A34A">+${cur}${dollars.toFixed(2)}</div>`
      : '';
  const remaining = _celebQueue.length;
  const moreHtml = remaining > 0
    ? `<div style="font-size:0.78rem;color:var(--muted);margin-top:8px">${remaining} more notification${remaining > 1 ? 's' : ''} waiting...</div>`
    : '';

  root.innerHTML = `
    <div class="celebration-overlay" id="cel-overlay">
      <div class="celebration-box">
        <div class="cel-icon">${icon}</div>
        <div class="cel-title">${title}</div>
        ${sub ? `<div class="cel-sub">${sub}</div>` : ''}
        ${ptsHtml}
        ${moreHtml}
        <button class="btn btn-primary btn-full" onclick="closeCelebration()">${btnLabel ?? 'Yay! <i class="ph-duotone ph-confetti" style="font-size:1rem;vertical-align:middle"></i>'}</button>
      </div>
    </div>`;

  if (!noAnimation) {
    if (badgeIcon !== null) launchBadgeRain(badgeIcon);
    else if (dollars !== null) launchDollarRain();
    else launchConfetti();
  }
  if (tts) speak(tts);
  window._celebOnClose = onClose;
}

function closeCelebration() {
  document.getElementById('celebration-root').innerHTML = '';
  if (typeof window._celebOnClose === 'function') {
    window._celebOnClose();
    window._celebOnClose = null;
  }
  if (_celebQueue.length > 0) setTimeout(_showNextCelebration, 300);
}

function testWhileAwayModal() {
  showCelebration({
    icon:     '<i class="ph-duotone ph-envelope" style="color:#7C3AED;font-size:3rem"></i>',
    title:    '<i class="ph-duotone ph-moon-stars" style="color:#7C3AED"></i> While you were away...',
    sub:      'Your parent approved "Brush Your Teeth" and you earned gems!',
    diamonds: 5,
    onClose:  () => {},
  });
}

function testQueuedCelebrations() {
  showCelebration({
    icon:     '<i class="ph-duotone ph-envelope" style="color:#7C3AED;font-size:3rem"></i>',
    title:    '<i class="ph-duotone ph-moon-stars" style="color:#7C3AED"></i> While you were away...',
    sub:      'Your parent approved "Brush Your Teeth" and you earned gems!',
    diamonds: 5,
    onClose:  () => {},
  });
  showCelebration({
    icon:     '<i class="ph-duotone ph-star" style="color:#F59E0B;font-size:3rem"></i>',
    title:    '<i class="ph-duotone ph-moon-stars" style="color:#7C3AED"></i> While you were away...',
    sub:      'Great job on your homework!',
    diamonds: 10,
    onClose:  () => {},
  });
  showCelebration({
    icon:     '<i class="ph-duotone ph-envelope" style="color:#7C3AED;font-size:3rem"></i>',
    title:    '<i class="ph-duotone ph-moon-stars" style="color:#7C3AED"></i> While you were away...',
    sub:      'Your parent approved "Clean Your Room" and you earned gems!',
    diamonds: 8,
    onClose:  () => {},
  });
}

function testSavingsDeposit() {
  const cur = D.settings.currency || '$';
  showCelebration({
    icon:    '<i class="ph-duotone ph-piggy-bank" style="color:#16A34A;font-size:3rem"></i>',
    title:   '<i class="ph-duotone ph-piggy-bank" style="color:#16A34A"></i> Savings Deposit!',
    sub:     'Birthday money from Grandma!',
    dollars: 20,
    cur,
    onClose: () => {},
  });
}

function testSpendApproved() {
  const cur = D.settings.currency || '$';
  showCelebration({
    icon:        '<i class="ph-duotone ph-shopping-bag" style="color:#16A34A;font-size:3rem"></i>',
    title:       '<i class="ph-duotone ph-check-circle" style="color:#16A34A"></i> Spend Approved!',
    sub:         '"Lego set" for $15.00 approved. Balance: $32.50',
    noAnimation: true,
    onClose:     () => {},
  });
}

function testSpendDenied() {
  showCelebration({
    icon:        '<i class="ph-duotone ph-smiley-sad" style="color:#9CA3AF;font-size:3rem"></i>',
    title:       '<i class="ph-duotone ph-x-circle" style="color:#9CA3AF"></i> Not This Time',
    sub:         'Your spend request for "Video game" for $60.00 wasn\'t approved.',
    noAnimation: true,
    btnLabel:    'Okay',
    onClose:     () => {},
  });
}

function emailDebugLogs() {
  const html = document.documentElement;
  const body = document.body;
  const logs = [
    `UA: ${navigator.userAgent}`,
    `window.inner: ${window.innerWidth}x${window.innerHeight}`,
    `screen: ${screen.width}x${screen.height}`,
    `devicePixelRatio: ${window.devicePixelRatio}`,
    `html scrollTop/Height: ${html.scrollTop} / ${html.scrollHeight}`,
    `html clientHeight: ${html.clientHeight}`,
    `body scrollTop/Height: ${body.scrollTop} / ${body.scrollHeight}`,
    `body clientHeight: ${body.clientHeight}`,
    `body offsetHeight: ${body.offsetHeight}`,
    `visualViewport: ${window.visualViewport?.width}x${window.visualViewport?.height} offset:${window.visualViewport?.offsetTop}`,
    `safeAreaTop: ${getComputedStyle(html).getPropertyValue('--sat') || 'check env()'}`,
    `screens visible: ${[...document.querySelectorAll('.screen')].filter(s => s.style.display !== 'none').map(s => s.id).join(', ')}`,
  ].join('\n');
  window.location.href = `mailto:beta@gemsprout.com?subject=GemSprout Debug Log&body=${encodeURIComponent(logs)}`;
}

async function devTestPushPermission() {
  if (!isNative()) { console.log('Push notifications only work on device.'); return; }
  try {
    const { FirebaseMessaging } = Capacitor.Plugins;
    if (!FirebaseMessaging) { console.warn('FirebaseMessaging plugin not found'); return; }
    const result = await FirebaseMessaging.requestPermissions();
    console.log('Permission status:', result.receive);
    toast(`<i class="ph-duotone ph-bell" style="font-size:1rem;vertical-align:middle"></i> Permission: ${result.receive}`);
  } catch(e) {
    console.error('devTestPushPermission error:', e);
  }
}

async function devShowPushToken() {
  if (!isNative()) { console.log('Push notifications only work on device.'); return; }
  try {
    const { FirebaseMessaging } = Capacitor.Plugins;
    if (!FirebaseMessaging) { console.warn('FirebaseMessaging plugin not found'); return; }
    const perm = await FirebaseMessaging.requestPermissions();
    if (perm.receive !== 'granted') { console.warn('Permission not granted:', perm.receive); toast(`Permission not granted: ${perm.receive}`); return; }
    const result = await FirebaseMessaging.getToken();
    const token = result?.token;
    if (!token) { console.warn('No token returned'); return; }
    const uid = getParentAuthUid();
    if (uid) {
      await db.doc(`users/${uid}`).set(
        { fcmTokens: firebase.firestore.FieldValue.arrayUnion(token) },
        { merge: true }
      );
    }
    const escapedToken = token.replace(/'/g, "\\'");
    showQuickActionModal(`
      <div style="padding:8px">
        <div style="font-weight:700;margin-bottom:10px"><i class="ph-duotone ph-bell" style="vertical-align:middle;margin-right:6px"></i>FCM Token</div>
        <div style="font-size:0.72rem;font-family:monospace;word-break:break-all;background:#F3F4F6;padding:10px;border-radius:8px;line-height:1.6">${token}</div>
        <div style="font-size:0.78rem;color:var(--muted);margin-top:8px">${uid ? 'Token saved to Firestore.' : 'Not signed in - token not saved.'}</div>
        <button class="btn btn-secondary btn-full" style="margin-top:12px" onclick="navigator.clipboard?.writeText('${escapedToken}').then(()=>toast('Copied!')).catch(()=>toast('Copy failed'))">Copy Token</button>
      </div>`);
  } catch(e) {
    console.error('devShowPushToken error:', e);
  }
}

async function devSendTestPushNotification() {
  try {
    const fn = firebase.functions().httpsCallable('sendApprovalNotification');
    const result = await fn({
      familyCode: getFamilyCode(),
      kidName:    'Test Kid',
      choreTitle: 'Clean Their Room',
    });
    console.log('Test push sent:', result.data);
    toast('<i class="ph-duotone ph-paper-plane-tilt" style="font-size:1rem;vertical-align:middle"></i> Test notification sent!');
  } catch(e) {
    console.error('devSendTestPushNotification error:', e);
    toast('Send failed - check console');
  }
}

function testCameraPermission() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'environment';
  input.onchange = () => toast('Camera permission granted!');
  input.click();
}

function showModal(html, opts = {}) {
  if (opts.lockScroll !== false) {
    // Lock body scroll so iOS keyboard opening doesn't shift background content
    const scrollY = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top      = `-${scrollY}px`;
    document.body.style.width    = '100%';
    document.body.dataset.scrollY = scrollY;
    const mc = document.querySelector('.main-content');
    if (mc) {
      if (mc.dataset.prevOverflow === undefined) mc.dataset.prevOverflow = mc.style.overflowY;
      mc.style.overflowY = 'hidden';
    }
  }

  const root = document.getElementById('modal-root');
  if (root) {
    root.style.display = 'block';
    root.style.pointerEvents = 'auto';
  }
  const overlayClasses = ['modal-overlay', opts.overlayClass, opts.useOrigin && _modalLaunchOrigin ? 'modal-overlay-origin' : ''].filter(Boolean).join(' ');
  const modalClasses = ['modal', opts.modalClass, opts.useOrigin && _modalLaunchOrigin ? 'modal-origin-sheet' : ''].filter(Boolean).join(' ');
  const originStyle = opts.useOrigin && _modalLaunchOrigin
    ? ` style="--modal-origin-x:${_modalLaunchOrigin.x}px;--modal-origin-y:${_modalLaunchOrigin.y}px"`
    : '';
  root.innerHTML = `
    <div class="${overlayClasses}" id="modal-overlay" onclick="closeModalIfBg(event)" data-disable-bg-close="${opts.disableBgClose ? '1' : '0'}"${originStyle}>
      <div class="${modalClasses}" id="modal-sheet"${originStyle}>
        <div class="modal-handle" id="modal-drag-handle"></div>
        ${html}
      </div>
    </div>`;
  _modalLaunchOrigin = null;
  _initModalSwipe();
}

let _weekReviewPress = null;

function handleWeekReviewCardPress(ev) {
  ev?.preventDefault?.();
  _weekReviewPress = {
    dir: 'hold',
    startedAt: Date.now(),
    suppressNav: true,
  };
  _weekReviewPause();
  return false;
}

function handleWeekReviewCardRelease() {
  if (_weekReviewPress?.dir === 'hold') _weekReviewPress = null;
  _weekReviewResume();
}

function handleWeekReviewPress(dir, ev) {
  ev?.preventDefault?.();
  _weekReviewPress = {
    dir,
    startedAt: Date.now(),
    suppressNav: false,
  };
  _weekReviewPause();
  return false;
}

function handleWeekReviewRelease(dir) {
  if (_weekReviewPress?.dir === dir) {
    _weekReviewPress.suppressNav = (Date.now() - _weekReviewPress.startedAt) > 180;
  }
  _weekReviewResume();
}

function handleWeekReviewTap(dir, ev) {
  ev?.preventDefault?.();
  const press = _weekReviewPress;
  _weekReviewPress = null;
  if (press?.dir === dir && press.suppressNav) return false;
  if (dir === 'prev') _weekReviewPrev();
  else _weekReviewNext();
  return false;
}

function _inferModalLaunchOrigin() {
  const el = document.activeElement;
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  if (!(el instanceof HTMLElement)) return null;
  const tag = (el.tagName || '').toLowerCase();
  const isInteractive = el.matches('button, a, [role="button"], input, .btn, .btn-sm, .btn-full, .hero-quick-action, .hero-quick-trigger');
  if (!isInteractive && !['button', 'a', 'input'].includes(tag)) return null;
  const rect = el.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) return null;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function showQuickActionModal(html, modalClass = '', opts = {}) {
  if (opts.useOrigin !== false && !_modalLaunchOrigin) {
    _modalLaunchOrigin = _inferModalLaunchOrigin();
  }
  const quickHtml = `
    ${opts.showClose === false ? '' : `<button class="modal-close-x" type="button" aria-label="Close" onclick="closeModal()">
      <span aria-hidden="true">&times;</span>
    </button>`}
    ${html}`;
  showModal(quickHtml, {
    overlayClass: 'quick-modal-overlay',
    modalClass: ['quick-action-modal', modalClass].filter(Boolean).join(' '),
    useOrigin: opts.useOrigin !== false,
    lockScroll: opts.lockScroll,
    disableBgClose: opts.disableBgClose
  });
}

function replaceQuickActionModal(html, modalClass = '') {
  const sheet = document.getElementById('modal-sheet');
  if (!sheet) {
    showQuickActionModal(html, modalClass, { useOrigin: false });
    return;
  }
  sheet.className = ['modal', 'quick-action-modal', modalClass].filter(Boolean).join(' ');
  sheet.style.transform = '';
  sheet.innerHTML = `
    <button class="modal-close-x" type="button" aria-label="Close" onclick="closeModal()">
      <span aria-hidden="true">&times;</span>
    </button>
    ${html}`;
}

function _initModalSwipe() {
  const sheet = document.getElementById('modal-sheet');
  if (!sheet) return;
  let startY = 0, currentY = 0, dragging = false;
  const onStart = (e) => {
    // Arm dismiss gesture if touch is in the top 56px of the sheet (generous handle zone)
    const sheetRect = sheet.getBoundingClientRect();
    const touchY = e.touches[0].clientY;
    if (touchY > sheetRect.top + 56) return;
    startY   = e.touches[0].clientY;
    currentY = startY;
    dragging = true;
    sheet.style.transition = 'none';
  };
  const onMove = (e) => {
    if (!dragging) return;
    e.preventDefault();
    currentY = e.touches[0].clientY;
    const dy = Math.max(0, currentY - startY);
    sheet.style.transform = `translateY(${dy}px)`;
  };
  const onEnd = () => {
    if (!dragging) return;
    dragging = false;
    const dy = Math.max(0, currentY - startY);
    if (dy > 100) {
      sheet.style.transition = 'transform 0.22s ease';
      sheet.style.transform  = 'translateY(110%)';
      setTimeout(closeModal, 220);
    } else {
      sheet.style.transition = 'transform 0.22s ease';
      sheet.style.transform  = '';
    }
  };
  sheet.addEventListener('touchstart', onStart, { passive: true });
  sheet.addEventListener('touchmove',  onMove,  { passive: false });
  sheet.addEventListener('touchend',   onEnd);
}

function _finishCloseModal() {
  _activeFamilySnapshot = null;
  const modalRoot = document.getElementById('modal-root');
  if (modalRoot) {
    modalRoot.innerHTML = '';
    modalRoot.style.display = 'block';
    modalRoot.style.pointerEvents = 'auto';
  }
  _snapshotTimePicker = null;
  _modalLaunchOrigin = null;
  // Restore body scroll position locked by showModal
  const savedY = parseInt(document.body.dataset.scrollY || '0', 10);
  document.body.style.position = '';
  document.body.style.top      = '';
  document.body.style.width    = '';
  delete document.body.dataset.scrollY;
  window.scrollTo(0, savedY);
  // Restore main-content scroller
  const mc = document.querySelector('.main-content');
  if (mc) {
    mc.style.overflowY = mc.dataset.prevOverflow || 'auto';
    delete mc.dataset.prevOverflow;
  }
}

function closeModal() {
  _finishCloseModal();
}

function closeFamilySnapshot() {
  const overlay = document.getElementById('modal-overlay');
  const sheet = document.getElementById('modal-sheet');
  if (!overlay || !sheet || !sheet.classList.contains('snapshot-panel')) {
    closeModal();
    return;
  }
  if (sheet.dataset.closing === '1') return;
  sheet.dataset.closing = '1';
  const exitClass = sheet.classList.contains('snapshot-panel-right') ? 'snapshot-panel-exit-right' : 'snapshot-panel-exit-left';
  sheet.classList.remove('snapshot-panel-left', 'snapshot-panel-right');
  sheet.classList.add('snapshot-panel-closing', exitClass);
  overlay.classList.add('snapshot-panel-overlay-closing');
  setTimeout(_finishCloseModal, 300);
}

function closeModalIfBg(e) {
  if (e.target.id !== 'modal-overlay') return;
  if (e.target.dataset.disableBgClose === '1') return;
  closeModal();
}

function openUserSettings() {
  if (S.currentUser?.role === 'parent') {
    S.settingsPage = 'main';
    const sr = document.getElementById('settings-root');
    _settingsPageEnterClass = 'settings-subpane-enter';
    sr.classList.add('open');
    renderSettings();
    _settingsPageEnterClass = '';
    sr.scrollTop = 0;
  } else {
    const name = S.currentUser?.name || 'User';
    showQuickActionModal(`
      <div class="modal-title"><i class="ph-duotone ph-gear-six" style="color:#6C63FF;font-size:1.2rem;vertical-align:middle"></i> Settings</div>
      <p style="color:var(--muted);font-size:0.95rem;margin-bottom:16px">Signed in as <strong>${esc(name)}</strong>.</p>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="closeModal()">Close</button>
        <button class="btn btn-primary" onclick="switchUserNow()">Switch User</button>
      </div>
      <div style="border-top:1px solid #F3F4F6;margin-top:12px;padding-top:12px">
        <button class="btn btn-secondary btn-sm" style="width:100%;color:#EF4444;border-color:#EF4444" onclick="closeModal();showLeaveDevicePin()">
          <i class="ph-duotone ph-sign-out" style="vertical-align:middle;margin-right:6px"></i> Leave this Device
        </button>
        <div style="font-size:0.78rem;color:var(--muted);margin-top:6px;text-align:center">Requires parent PIN. Removes this family from the device.</div>
      </div>`);
  }
}

let _settingsNavTimer = null;
let _settingsPageEnterClass = 'settings-subpane-enter';

function navigateSettingsPage(target) {
  clearTimeout(_settingsNavTimer);
  _settingsPageEnterClass = 'settings-subpane-enter';
  S.settingsPage = target;
  renderSettings();
  _settingsPageEnterClass = '';
}

function backSettingsPage(target = 'main') {
  const root = document.getElementById('settings-root');
  const panes = root ? Array.from(root.querySelectorAll('.settings-subpane')) : [];
  const pane = panes[panes.length - 1];
  clearTimeout(_settingsNavTimer);
  if (!pane) {
    _settingsPageEnterClass = '';
    S.settingsPage = target;
    renderSettings();
    _settingsPageEnterClass = 'settings-subpane-enter';
    return;
  }
  pane.classList.remove('settings-subpane-enter');
  pane.classList.add('settings-subpane-exit-right');
  _settingsNavTimer = setTimeout(() => {
    _settingsPageEnterClass = '';
    S.settingsPage = target;
    renderSettings();
  }, 230);
}

function showLeaveDevicePin() {
  if (!D.settings?.parentPin) {
    _doLeaveDevice();
    return;
  }
  const saved = S.currentUser;
  showScreen('screen-pin');
  S.pinBuffer = '';
  S.pinMode   = 'leaveDevice';
  S._leaveDeviceUser = saved;
  document.getElementById('pin-content').innerHTML = `
    <div class="pin-avatar"><i class="ph-duotone ph-sign-out" style="color:#6C63FF;font-size:2.5rem"></i></div>
    <div class="pin-title">Leave this Device</div>
    <div class="pin-sub">Enter the parent PIN to confirm</div>
    <div class="pin-dots" id="pin-dots">
      <div class="pin-dot" id="pd0"></div>
      <div class="pin-dot" id="pd1"></div>
      <div class="pin-dot" id="pd2"></div>
      <div class="pin-dot" id="pd3"></div>
    </div>
    <div class="pin-grid">
      ${[1,2,3,4,5,6,7,8,9,'',0,'Del'].map(k => `
        <button class="pin-key${k===''?' hidden':''}" onclick="pinKey('${k}')">${k}</button>
      `).join('')}
    </div>
    <div id="pin-error" class="pin-error hidden"></div>
    <button class="btn btn-secondary mt-16" style="width:min(360px,calc(100vw - 48px))" onclick="S.currentUser=S._leaveDeviceUser;routeToView(S._leaveDeviceUser)">Cancel</button>`;
}

function _doLeaveDevice() {
  if (firestoreUnsub) { firestoreUnsub(); firestoreUnsub = null; }
  localStorage.removeItem(LS_KEY);
  localStorage.removeItem(FAMILY_CODE_KEY);
  setCurrentUserId('');
  setParentAuthUid(null);
  try { localStorage.removeItem(PARENT_AUTH_PROVIDER_KEY); } catch {}
  D = defaultData();
  S.currentUser = null;
  showScreen('screen-setup');
  renderSetupGate();
}

function closeSettings() {
  const root = document.getElementById('settings-root');
  const panes = root ? Array.from(root.querySelectorAll('.settings-subpane')) : [];
  const pane = panes[panes.length - 1];
  clearTimeout(_settingsNavTimer);
  if (!root) return;
  if (!pane) {
    root.classList.remove('open');
    return;
  }
  pane.classList.remove('settings-subpane-enter');
  pane.classList.add('settings-subpane-exit-right');
  _settingsNavTimer = setTimeout(() => {
    root.classList.remove('open');
    root.innerHTML = '';
    S.settingsPage = 'main';
    _settingsPageEnterClass = 'settings-subpane-enter';
  }, 230);
}

function openFullHistory(memberId = null) {
  renderFullHistory(memberId);
  const sr = document.getElementById('settings-root');
  sr.classList.add('open');
  sr.scrollTop = 0;
}

function renderFullHistory(memberId = null) {
  const history = memberId
    ? (D.history || []).filter(h => h.memberId === memberId)
    : (D.history || []);
  const rows = history.map(renderActivityRow).join('');
  const member = memberId ? getMember(memberId) : null;
  const title = member ? `${member.name}'s Activity` : 'Full Activity History';

  document.getElementById('settings-root').innerHTML = `
    <div class="settings-subpane${_settingsPageEnterClass ? ` ${_settingsPageEnterClass}` : ''}">
    <div class="settings-header">
      <button class="btn-back" onclick="closeSettings()">&larr;</button>
      <span class="settings-header-title"><i class="ph-duotone ph-clipboard-text" style="color:#9CA3AF;font-size:1.1rem;vertical-align:middle"></i> ${esc(title)}</span>
    </div>
    <div class="settings-body">
      <div class="card activity-card">
        ${rows || '<div class="empty-state"><div class="empty-text">No activity yet</div></div>'}
      </div>
    </div>`;
}

// Swipe from left edge to close settings (iOS-style back gesture)
(function() {
  let startX = 0, startY = 0, tracking = false;
  document.addEventListener('touchstart', e => {
    if (e.touches[0].clientX < 24) { startX = e.touches[0].clientX; startY = e.touches[0].clientY; tracking = true; }
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (!tracking) return;
    const dx = e.touches[0].clientX - startX;
    const dy = Math.abs(e.touches[0].clientY - startY);
    if (dx > 60 && dy < 40) {
      tracking = false;
      const sr = document.getElementById('settings-root');
      if (sr?.classList.contains('open')) closeSettings();
    }
  }, { passive: true });
  document.addEventListener('touchend', () => { tracking = false; }, { passive: true });
})();

function switchUserNow() {
  closeModal();
  goHome();
}

const _expandedSettingsMembers = new Set();
function toggleSettingsMember(id) {
  if (_expandedSettingsMembers.has(id)) _expandedSettingsMembers.delete(id);
  else _expandedSettingsMembers.add(id);
  renderSettings();
}

function showResetPinFlow() {
  if (!D.settings.parentPin) {
    showNewPinModal();
    return;
  }
  // Close settings and use the real PIN/Face ID screen for verification
  closeSettings();
  showScreen('screen-pin');
  S.pinBuffer = '';
  S.pinMode   = 'pinReset';
  document.getElementById('pin-content').innerHTML = `
    <div class="pin-avatar"><i class="ph-duotone ph-lock-key" style="color:#6C63FF;font-size:2.5rem"></i></div>
    <div class="pin-title">Verify Identity</div>
    <div class="pin-sub">Enter your current PIN to reset it</div>
    <div class="pin-dots" id="pin-dots">
      <div class="pin-dot" id="pd0"></div>
      <div class="pin-dot" id="pd1"></div>
      <div class="pin-dot" id="pd2"></div>
      <div class="pin-dot" id="pd3"></div>
    </div>
    <div class="pin-grid">
      ${[1,2,3,4,5,6,7,8,9,'',0,'Del'].map(k => `
        <button class="pin-key${k===''?' hidden':''}" onclick="pinKey('${k}')">${k}</button>
      `).join('')}
    </div>
    <div id="pin-error" class="pin-error hidden"></div>
    ${getBiometricCredentialId() ? `<button class="btn btn-secondary mt-16" style="width:min(360px,calc(100vw - 48px))" onclick="tryBiometricUnlock()"><i class="ph-duotone ph-fingerprint" style="font-size:1rem;vertical-align:middle"></i> Use ${getBiometricLabel()}</button>` : ''}
    <button class="btn btn-secondary mt-16" style="width:min(360px,calc(100vw - 48px))" onclick="openUserSettings()">Cancel</button>`;
  clearTimeout(S._biometricTimer);
  if (getBiometricCredentialId()) {
    S._biometricTimer = setTimeout(() => tryBiometricUnlock(), 400);
  }
}

function afterPinResetVerified() {
  renderSettings();
  document.getElementById('settings-root').classList.add('open');
  showNewPinModal();
}

function showNewPinModal() {
  showQuickActionModal(`
    <div class="modal-title">Set New PIN</div>
    <div class="form-group">
      <label class="form-label">New PIN <span class="form-label-hint">4 digits</span></label>
      <input type="password" id="rp-new" maxlength="4" placeholder="4 digits" inputmode="numeric" pattern="[0-9]*" oninput="this.value=this.value.replace(/\D/g,'').slice(0,4)">
      <div id="rp-new-error" style="display:none;color:var(--pink);font-size:0.8rem;margin-top:4px"></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="applyNewPin()">Save</button>
    </div>`, 'quick-action-modal-wide');
}

function applyNewPin() {
  const val = document.getElementById('rp-new')?.value.trim();
  if (!/^\d{4}$/.test(val || '')) {
    const err = document.getElementById('rp-new-error');
    if (err) { err.textContent = 'Please enter a 4-digit PIN.'; err.style.display = 'block'; }
    return;
  }
  D.settings.parentPin = val;
  saveData();
  closeModal();
  if (isBiometricSupported() && !getBiometricCredentialId()) {
    offerBiometricSetup(() => { toast('PIN updated'); renderSettings(); });
  } else {
    toast('PIN updated');
    renderSettings();
  }
}

function renderSettings() {
  const root = document.getElementById('settings-root');
  if (!root) return;
  const showSubpane = S.settingsPage === 'account' || S.settingsPage === 'notifications';
  let html = _renderSettingsMain(showSubpane ? '' : _settingsPageEnterClass, true);
  if (S.settingsPage === 'account') html += _renderSettingsAccount(_settingsPageEnterClass, true);
  if (S.settingsPage === 'notifications') html += _renderSettingsNotifications(_settingsPageEnterClass, true);
  root.innerHTML = html;
}

function _settingsAuthProviders() {
  let _authProviders = S.currentUser?.authProviders || [];
  if (!_authProviders.length && auth.currentUser && !auth.currentUser.isAnonymous) {
    _authProviders = auth.currentUser.providerData.map(p => ({
      providerId: p.providerId, uid: auth.currentUser.uid,
      email: p.email || auth.currentUser.email || ''
    }));
  }
  return _authProviders;
}

const _GOOGLE_ICON = `<img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" style="width:22px;height:22px;flex-shrink:0">`;
const _APPLE_ICON  = `<svg width="22" height="22" viewBox="0 0 24 24" fill="#000" style="flex-shrink:0" xmlns="http://www.w3.org/2000/svg"><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701z"/></svg>`;

function _renderSettingsMain(paneClass = _settingsPageEnterClass, returnHtml = false) {
  const s = D.settings;
  const members = D.family.members.filter(m => m.role !== 'parent' && !m.deleted);

  const shEnabled = members.some(k => k.splitHousehold?.enabled);
  const firstKid = members[0];

  const familyHtml = members.map(k => {
    const isHere = isMemberHereOnDate(k, today());
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #F3F4F6">
        <span style="font-size:1.6rem">${k.avatar||'<i class="ph-duotone ph-smiley" style="color:#9CA3AF"></i>'}</span>
        <div style="flex:1">
          <div style="font-weight:700">${esc(k.name)}</div>
          <div style="font-size:0.78rem;color:var(--muted)">${k.gems||0} gems${s.savingsEnabled!==false?` &middot; ${s.currency||'$'}${(k.savings||0).toFixed(2)} <i class="ph-duotone ph-piggy-bank" style="color:#16A34A;font-size:0.85rem;vertical-align:middle"></i>`:''}</div>
        </div>
        <div style="display:flex;gap:5px">
          <button class="btn btn-sm" style="background:${isHere?'var(--green)':'#F3F4F6'};color:${isHere?'#fff':'var(--text)'}" onclick="setTodayStatus('${k.id}',true)">Home</button>
          <button class="btn btn-sm" style="background:${!isHere?'#EF4444':'#F3F4F6'};color:${!isHere?'#fff':'var(--text)'}" onclick="setTodayStatus('${k.id}',false)">Away</button>
        </div>
      </div>`;
  }).join('');

  const html = `
    <div class="settings-subpane${paneClass ? ` ${paneClass}` : ''}">
    <div class="settings-header">
      <button class="btn-back settings-back-btn" onclick="closeSettings()">&larr;</button>
      <span class="settings-header-title"><i class="ph-duotone ph-gear-six" style="color:#426e58;font-size:1.1rem;vertical-align:middle"></i> Settings</span>
      <div class="settings-header-actions">
        <button class="btn btn-secondary btn-sm settings-header-btn" onclick="showFamilyCodeModal(this)">Add user</button>
        <button class="btn btn-secondary btn-sm settings-header-btn" onclick="closeSettings();goHome()">Switch user</button>
      </div>
    </div>
    <div class="settings-body">

      <div class="section-row"><span class="section-title"><i class="ph-duotone ph-sliders" style="color:#6C63FF;font-size:1rem;vertical-align:middle"></i> General</span></div>
      <div class="card">
        <div class="toggle-row">
          <div><div class="toggle-label">Auto-approve tasks</div>
            <div class="toggle-sub">Kids earn gems instantly without a final review - pre-approval photos (if set) still require manual approval</div></div>
          <label class="toggle"><input type="checkbox" ${s.autoApprove?'checked':''} onchange="saveSetting('autoApprove',this.checked);renderParentHome()"><span class="toggle-track"></span></label>
        </div>
        <div class="toggle-row">
          <div><div class="toggle-label">Hide unavailable tasks</div>
            <div class="toggle-sub">Tasks outside their allowed time window won't show on kids' screens</div></div>
          <label class="toggle"><input type="checkbox" ${s.hideUnavailable?'checked':''} onchange="saveSetting('hideUnavailable',this.checked)"><span class="toggle-track"></span></label>
        </div>
        <div class="toggle-row">
          <div><div class="toggle-label">Show swipe hints</div>
            <div class="toggle-sub">Auto-bounce hint cards the first time they appear</div></div>
          <label class="toggle"><input type="checkbox" ${s.tooltipBounceEnabled!==false?'checked':''} onchange="saveSetting('tooltipBounceEnabled',this.checked)"><span class="toggle-track"></span></label>
        </div>
        <div class="form-group mb-0">
          <label class="form-label">Family timezone</label>
          <select onchange="saveSetting('familyTimezone',this.value)" style="width:100%">
            ${(Intl.supportedValuesOf?.('timeZone') ?? [s.familyTimezone]).map(tz =>
              `<option value="${tz}" ${tz === (s.familyTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone) ? 'selected' : ''}>${tz.replace(/_/g,' ')}</option>`
            ).join('')}
          </select>
          <div style="font-size:0.78rem;color:var(--muted);margin-top:4px">Used to determine "today" for all tasks and streaks - keeps devices in sync across time zones</div>
        </div>
        <button class="settings-link-row" onclick="navigateSettingsPage('notifications')">
          <div>
            <div class="settings-link-title"><i class="ph-duotone ph-bell" style="color:#6C63FF;font-size:0.9rem;vertical-align:middle"></i> Notifications</div>
            <div class="settings-link-sub">Approval alerts, interest day reminder</div>
          </div>
          <i class="ph-duotone ph-caret-right" style="color:var(--muted);font-size:1.1rem;flex-shrink:0"></i>
        </button>
        <button class="settings-link-row" onclick="navigateSettingsPage('account')">
          <div>
            <div class="settings-link-title"><i class="ph-duotone ph-shield-check" style="color:#6C63FF;font-size:0.9rem;vertical-align:middle"></i> Account &amp; Security</div>
            <div class="settings-link-sub">Sign-in, PIN, biometrics</div>
          </div>
          <i class="ph-duotone ph-caret-right" style="color:var(--muted);font-size:1.1rem;flex-shrink:0"></i>
        </button>
      </div>

      <div style="height:14px"></div>
      <div class="section-row">
        <span class="section-title"><i class="ph-duotone ph-piggy-bank" style="color:#16A34A;font-size:1rem;vertical-align:middle"></i> Savings Banking</span>
        <label class="toggle"><input type="checkbox" ${s.savingsEnabled!==false?'checked':''} onchange="saveSetting('savingsEnabled',this.checked);renderSettings()"><span class="toggle-track"></span></label>
      </div>
      <div class="card">
        <p style="font-size:0.85rem;color:var(--muted);margin-bottom:${s.savingsEnabled!==false?'14':'0'}px">Kids can convert gems into real savings</p>
        ${s.savingsEnabled !== false ? `
        <div class="form-group">
          <label class="form-label">Gems per dollar <span class="form-label-hint">conversion rate</span></label>
          <input type="number" value="${s.diamondsPerDollar||10}" min="1" onchange="saveSetting('diamondsPerDollar',parseInt(this.value)||10)">
        </div>
        <div class="toggle-row">
          <div><div class="toggle-label">Savings matching</div>
            <div class="toggle-sub">Parents match a percentage of what kids save</div></div>
          <label class="toggle"><input type="checkbox" ${s.savingsMatchingEnabled?'checked':''} onchange="saveSetting('savingsMatchingEnabled',this.checked);renderSettings()"><span class="toggle-track"></span></label>
        </div>
        ${s.savingsMatchingEnabled ? `
        <div class="form-group mt-8">
          <label class="form-label">Match percentage <span class="form-label-hint">% of amount saved</span></label>
          <input type="number" value="${s.savingsMatchPercent||50}" min="1" max="200" onchange="saveSetting('savingsMatchPercent',parseInt(this.value)||50)">
        </div>` : ''}
        <div class="toggle-row" style="margin-top:${s.savingsMatchingEnabled?'4':'8'}px">
          <div><div class="toggle-label">Add interest</div>
            <div class="toggle-sub">Kids claim their interest as a reward on interest day</div></div>
          <label class="toggle"><input type="checkbox" ${s.savingsInterestEnabled?'checked':''} onchange="saveSetting('savingsInterestEnabled',this.checked);if(this.checked)_offerInterestDayReminder();renderSettings()"><span class="toggle-track"></span></label>
        </div>
        ${s.savingsInterestEnabled ? (() => {
          const ip = s.savingsInterestPeriod || 'monthly';
          const iDay = s.savingsInterestDay ?? 1;
          const iDom = s.savingsInterestDayOfMonth || 1;
          const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
          const domSuffix = iDom === 1 ? 'st' : iDom === 2 ? 'nd' : iDom === 3 ? 'rd' : 'th';
          return `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
            <div class="form-group mb-0">
              <label class="form-label">Interest rate %</label>
              <input type="number" value="${s.savingsInterestRate||5}" min="0.1" max="100" step="0.1" onchange="saveSetting('savingsInterestRate',parseFloat(this.value)||5)">
            </div>
            <div class="form-group mb-0">
              <label class="form-label">Period</label>
              <select onchange="saveSetting('savingsInterestPeriod',this.value);renderSettings()">
                <option value="weekly"  ${ip==='weekly' ?'selected':''}>Weekly</option>
                <option value="monthly" ${ip==='monthly'?'selected':''}>Monthly</option>
              </select>
            </div>
            ${ip === 'weekly' ? `
            <div class="form-group mb-0" style="grid-column:1/-1">
              <label class="form-label">Available on</label>
              <select onchange="saveSetting('savingsInterestDay',parseInt(this.value));renderSettings()">
                ${dayNames.map((d,i) => `<option value="${i}" ${iDay===i?'selected':''}>${d}</option>`).join('')}
              </select>
            </div>` : `
            <div class="form-group mb-0" style="grid-column:1/-1">
              <label class="form-label">Available on day of month <span class="form-label-hint">1-28</span></label>
              <input type="number" value="${iDom}" min="1" max="28" onchange="saveSetting('savingsInterestDayOfMonth',Math.min(28,Math.max(1,parseInt(this.value)||1)));renderSettings()">
            </div>`}
          </div>
          <div style="font-size:0.8rem;color:#6B7280;margin-top:6px;padding:6px 10px;background:#F9FAFB;border-radius:8px">
            <i class="ph-duotone ph-calendar-blank" style="vertical-align:middle;margin-right:4px;flex-shrink:0"></i>${ip === 'weekly'
              ? `Interest is available to claim every <strong>${dayNames[iDay]}</strong>.`
              : `Interest is available to claim on the <strong>${iDom}${domSuffix} of each month</strong>.`}
            <div style="margin-left:20px">Unclaimed interest expires at midnight.</div>
          </div>`;
        })() : ''}
        ` : ''}
      </div>

      <div style="height:14px"></div>
      <div class="section-row"><span class="section-title"><i class="ph-duotone ph-users-three" style="color:#6C63FF;font-size:1rem;vertical-align:middle"></i> Family</span></div>
      <div class="card">
        ${familyHtml || '<div class="empty-state"><div class="empty-text">No kids yet</div></div>'}
        <button class="btn btn-secondary btn-sm btn-full" style="margin-top:12px" onclick="closeSettings();goSetup()">Edit Family Setup</button>
        <div class="toggle-row" style="margin-top:14px">
          <div>
            <div class="toggle-label">Split household</div>
            <div class="toggle-sub">Streaks skip days kids are at the other household</div>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            ${shEnabled && firstKid ? `<button class="btn btn-secondary btn-sm" onclick="showSplitHouseholdModal('${firstKid.id}', this)">Configure</button>` : ''}
            <label class="toggle"><input type="checkbox" ${shEnabled?'checked':''} onchange="toggleFamilySplitHousehold(this.checked)"><span class="toggle-track"></span></label>
          </div>
        </div>
      </div>

      <div style="height:14px"></div>
      <div class="section-row">
        <span class="section-title"><i class="ph-duotone ph-speaker-slash" style="color:#EF4444;font-size:1rem;vertical-align:middle"></i> You're Not Listening</span>
        <label class="toggle"><input type="checkbox" ${s.notListeningEnabled!==false?'checked':''} onchange="saveSetting('notListeningEnabled',this.checked);renderSettings();renderParentHome()"><span class="toggle-track"></span></label>
      </div>
      <div class="card">
        <p style="font-size:0.85rem;color:var(--muted);margin-bottom:${s.notListeningEnabled!==false?'14px':'0'}">
          Adds a hold-to-track button on the dashboard that deducts gems for not listening - seconds accumulate indefinitely, leftovers carry over until a full interval is reached
        </p>
        ${s.notListeningEnabled!==false ? `
        <div class="form-group mb-0">
          <label class="form-label">Seconds per gem lost</label>
          <input type="number" value="${s.notListeningSecs||60}" min="1" onchange="saveSetting('notListeningSecs',parseInt(this.value)||60)">
          <div style="font-size:0.78rem;color:var(--muted);margin-top:4px">Hold the button to track time, then release to apply it. One gem is lost per interval, and leftover seconds carry forward indefinitely.</div>
        </div>` : ''}
      </div>

      ${RC.betaMode ? `<div style="height:14px"></div>
      <div class="section-row"><span class="section-title" style="color:var(--muted)"><i class="ph-duotone ph-terminal" style="color:var(--muted);font-size:1rem;vertical-align:middle"></i> Dev Settings</span></div>
      <div class="card" style="border:2px solid #E5E7EB;background:#F9FAFB">
        <div style="background:#FEF9C3;border:1.5px solid #F59E0B;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:0.82rem;color:#78350F;line-height:1.5">
          <strong>For testers only.</strong> These settings exist to help us find and fix bugs before launch. They will not be present in the final App Store release.
        </div>
        <div class="card" style="background:#F0FDF4;border:1.5px solid var(--green);margin-bottom:10px">
          <div class="card-title" style="font-size:0.9rem"><i class="ph-duotone ph-cloud" style="color:#10B981;font-size:1rem;vertical-align:middle"></i> Cloud Sync</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <span style="font-size:0.85rem;color:var(--green);font-weight:600"><i class="ph-duotone ph-check-circle" style="color:var(--green);vertical-align:middle"></i> Automatic</span>
            <button class="btn btn-secondary btn-sm" onclick="location.reload(true)"><i class="ph-duotone ph-arrow-clockwise" style="font-size:1rem;vertical-align:middle"></i> Reload App</button>
          </div>
          ${s.lastSync?`<div style="font-size:0.78rem;color:var(--muted);margin-top:8px">Last synced: ${new Date(s.lastSync).toLocaleString()}</div>`:''}
        </div>
        <button class="btn btn-secondary btn-full" style="margin-bottom:8px" onclick="launchConfetti(60)"><i class="ph-duotone ph-diamond" style="font-size:1rem;vertical-align:middle"></i> Test Gem Rain</button>
        <button class="btn btn-secondary btn-full" style="margin-bottom:8px" onclick="launchMixedRain()"><i class="ph-duotone ph-lightning" style="font-size:1rem;vertical-align:middle"></i> Test Combo Rain</button>
        <button class="btn btn-secondary btn-full" style="margin-bottom:8px" onclick="testWhileAwayModal()"><i class="ph-duotone ph-envelope" style="font-size:1rem;vertical-align:middle"></i> Test While You Were Away</button>
        <button class="btn btn-secondary btn-full" style="margin-bottom:8px" onclick="testQueuedCelebrations()"><i class="ph-duotone ph-bell" style="font-size:1rem;vertical-align:middle"></i> Test Queued Notifications (3)</button>
        <button class="btn btn-secondary btn-full" style="margin-bottom:8px" onclick="testSavingsDeposit()"><i class="ph-duotone ph-piggy-bank" style="font-size:1rem;vertical-align:middle"></i> Test Savings Deposit</button>
        <button class="btn btn-secondary btn-full" style="margin-bottom:8px" onclick="testSpendApproved()"><i class="ph-duotone ph-check-circle" style="font-size:1rem;vertical-align:middle"></i> Test Spend Approved</button>
        <button class="btn btn-secondary btn-full" style="margin-bottom:10px" onclick="testSpendDenied()"><i class="ph-duotone ph-x-circle" style="font-size:1rem;vertical-align:middle"></i> Test Spend Denied</button>
        <div style="height:10px"></div>
        <div style="font-size:0.82rem;font-weight:700;color:var(--muted);margin-bottom:8px"><i class="ph-duotone ph-bell" style="vertical-align:middle;margin-right:4px"></i> Push Notifications</div>
        <button class="btn btn-secondary btn-full" style="margin-bottom:6px" onclick="devTestPushPermission()"><i class="ph-duotone ph-lock-open" style="font-size:0.9rem;vertical-align:middle"></i> Request Permission</button>
        <button class="btn btn-secondary btn-full" style="margin-bottom:6px" onclick="devShowPushToken()"><i class="ph-duotone ph-identification-card" style="font-size:0.9rem;vertical-align:middle"></i> Register &amp; Show FCM Token</button>
        <button class="btn btn-secondary btn-full" style="margin-bottom:8px" onclick="devSendTestPushNotification()"><i class="ph-duotone ph-paper-plane-tilt" style="font-size:0.9rem;vertical-align:middle"></i> Send Test Approval Notification</button>
        <button class="btn btn-secondary btn-full" style="margin-bottom:8px" onclick="testCameraPermission()"><i class="ph-duotone ph-camera" style="font-size:1rem;vertical-align:middle"></i> Test Camera Permission</button>
        <button class="btn btn-secondary btn-full" style="margin-bottom:8px" onclick="emailDebugLogs()"><i class="ph-duotone ph-envelope" style="font-size:1rem;vertical-align:middle"></i> Email Debug Logs</button>
        <button class="btn btn-secondary btn-full" style="margin-bottom:8px" onclick="S.isPro=false;closeSettings();showPaywall()"><i class="ph-duotone ph-crown-simple" style="font-size:1rem;vertical-align:middle"></i> Test Paywall</button>
        <button class="btn btn-secondary btn-full" style="margin-bottom:8px" onclick="startTestOnboarding()"><i class="ph-duotone ph-rocket-launch" style="font-size:1rem;vertical-align:middle"></i> Test Onboarding</button>
        <button class="btn btn-secondary btn-full" style="margin-bottom:8px" onclick="closeSettings();showWeekReview()"><i class="ph-duotone ph-calendar-star" style="font-size:1rem;vertical-align:middle"></i> Test Week in Review</button>
        <button class="btn btn-secondary btn-full" style="margin-bottom:8px" onclick="try{localStorage.removeItem(CHANGELOG_SEEN_KEY)}catch(_){};showChangelog()"><i class="ph-duotone ph-newspaper" style="font-size:1rem;vertical-align:middle"></i> Test What's New</button>
        <div style="height:10px"></div>
        <div style="font-size:0.82rem;font-weight:700;color:var(--muted);margin-bottom:8px"><i class="ph-duotone ph-user-plus" style="vertical-align:middle;margin-right:4px"></i> Invite Tester</div>
        <button class="btn btn-secondary btn-full" style="margin-bottom:6px" onclick="_devShowInviteTest()"><i class="ph-duotone ph-flask" style="font-size:0.9rem;vertical-align:middle"></i> Test Invite System</button>
        <button class="btn btn-secondary btn-full" onclick="_devResetInviteTest()"><i class="ph-duotone ph-arrow-counter-clockwise" style="font-size:0.9rem;vertical-align:middle"></i> Reset Invite Test</button>
        <div style="font-size:0.75rem;color:var(--muted);margin-top:6px">Reset clears all invites for this family and the last test user doc automatically.</div>
        <div style="height:10px"></div>
        <button class="btn btn-sm btn-full" style="background:#1f2937;color:#fff" onclick="showAdvancedEditor()"><i class="ph-duotone ph-wrench" style="font-size:1rem;vertical-align:middle"></i> Advanced Data Editor</button>
      </div>` : ''}

      <div style="height:20px"></div>
      <div class="settings-footer-stack">
        <button class="btn btn-secondary btn-full" onclick="showWeekReview()"><i class="ph-duotone ph-calendar-star" style="font-size:1rem;vertical-align:middle;margin-right:6px"></i> Week in Review</button>
        <button class="btn btn-secondary btn-full" onclick="showChangelog()"><i class="ph-duotone ph-newspaper" style="font-size:1rem;vertical-align:middle;margin-right:6px"></i> What's New</button>
      </div>
      <div style="text-align:center;color:var(--muted);font-size:0.78rem;padding:16px 0 8px">GemSprout v${APP_VERSION}</div>

    </div>
    </div>`;
  if (returnHtml) return html;
  document.getElementById('settings-root').innerHTML = html;
}

function _renderSettingsAccount(paneClass = _settingsPageEnterClass, returnHtml = false) {
  const s = D.settings;
  const _authProviders = _settingsAuthProviders();
  const _googleProv = _authProviders.find(p => p.providerId === 'google.com');
  const _appleProv  = _authProviders.find(p => p.providerId === 'apple.com');
  const _anyLinked  = !!(_googleProv || _appleProv);
  const pinLabel = s.parentPin ? 'Reset PIN' : 'Set PIN';
  const bioBtn = isBiometricSupported() ? (getBiometricCredentialId()
    ? `<button class="btn btn-secondary btn-sm" onclick="removeBiometric();renderSettings()"><i class="ph-duotone ph-fingerprint" style="font-size:1rem;vertical-align:middle"></i> Remove ${getBiometricLabel()}</button>`
    : `<button class="btn btn-secondary btn-sm" onclick="registerBiometric()"><i class="ph-duotone ph-fingerprint" style="font-size:1rem;vertical-align:middle"></i> Set Up ${getBiometricLabel()}</button>`) : '';

  const html = `
    <div class="settings-subpane${paneClass ? ` ${paneClass}` : ''}">
    <div class="settings-header">
      <button class="btn-back settings-back-btn" onclick="backSettingsPage('main')">&larr;</button>
      <span class="settings-header-title"><i class="ph-duotone ph-shield-check" style="color:#6C63FF;font-size:1.1rem;vertical-align:middle"></i> Account &amp; Security</span>
      <div class="settings-header-spacer"></div>
    </div>
    <div class="settings-body">

      <div class="section-row"><span class="section-title"><i class="ph-duotone ph-user-circle" style="color:#6C63FF;font-size:1rem;vertical-align:middle"></i> Sign-In</span></div>
      <div class="card">
        <div class="settings-provider-row">
          <div class="settings-provider-main">
            ${_GOOGLE_ICON}
            <div>
              ${_googleProv
                ? `<div class="settings-provider-title">Google</div><div class="settings-provider-sub">${esc(_googleProv.email||'Linked')}</div>`
                : `<div class="settings-provider-title" style="color:var(--muted)">Google</div>`}
            </div>
          </div>
          ${_googleProv
            ? `<button class="btn btn-secondary btn-sm" style="color:#EF4444;border-color:#EF4444" onclick="unlinkProvider('google.com')">Sign Out</button>`
            : `<button class="btn btn-secondary btn-sm" onclick="linkAdditionalProvider('google.com')">Sign In</button>`}
        </div>
        <div class="settings-provider-row">
          <div class="settings-provider-main">
            ${_APPLE_ICON}
            <div>
              ${_appleProv
                ? `<div class="settings-provider-title">Apple</div><div class="settings-provider-sub">${esc(_appleProv.email||'Linked')}</div>`
                : `<div class="settings-provider-title" style="color:var(--muted)">Apple</div>`}
            </div>
          </div>
          ${_appleProv
            ? `<button class="btn btn-secondary btn-sm" style="color:#EF4444;border-color:#EF4444" onclick="unlinkProvider('apple.com')">Sign Out</button>`
            : `<button class="btn btn-secondary btn-sm" onclick="linkAdditionalProvider('apple.com')">Sign In</button>`}
        </div>
        ${!_anyLinked ? `<div style="font-size:0.82rem;color:var(--muted);margin-top:4px">Sign in with Google or Apple to enable push notifications and secure your profile</div>` : ''}
      </div>

      <div style="height:14px"></div>
      <div class="section-row"><span class="section-title"><i class="ph-duotone ph-lock-key" style="color:#6C63FF;font-size:1rem;vertical-align:middle"></i> PIN &amp; Biometric</span></div>
      <div class="card">
        <div class="form-group">
          <label class="form-label">Parent PIN &amp; ${getBiometricLabel()}</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-secondary btn-sm" onclick="showResetPinFlow()">${pinLabel}</button>
            ${bioBtn}
          </div>
        </div>
        ${(s.parentPin || getBiometricCredentialId()) ? `
        <div class="toggle-row" style="margin-top:4px">
          <div><div class="toggle-label">Lock when leaving app</div>
            <div class="toggle-sub">Require PIN or ${getBiometricLabel()} each time the app is opened or returns from the background</div></div>
          <label class="toggle"><input type="checkbox" ${s.lockOnBackground?'checked':''} onchange="saveSetting('lockOnBackground',this.checked)"><span class="toggle-track"></span></label>
        </div>` : ''}
      </div>

      <div style="height:14px"></div>
      <div class="section-row"><span class="section-title"><i class="ph-duotone ph-crown-simple" style="color:#6C63FF;font-size:1rem;vertical-align:middle"></i> Subscription</span></div>
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <div>
            <div class="settings-provider-title">GemSprout Pro</div>
            <div class="settings-provider-sub">${S.isPro ? 'Active' : 'No active subscription'}</div>
          </div>
          ${S.isPro ? `<span class="settings-status-pill active">Active</span>` : `<span class="settings-status-pill inactive">Inactive</span>`}
        </div>
        ${S.isPro
          ? `<button class="btn btn-secondary btn-sm btn-full" onclick="window.open('https://apps.apple.com/account/subscriptions','_system')">Manage Subscription</button>`
          : `<button class="btn btn-primary btn-sm btn-full" onclick="closeSettings();showPaywall()">Subscribe</button>`}
        <button class="btn btn-secondary btn-sm btn-full" style="margin-top:8px" onclick="rcRestorePurchases()">Restore Purchases</button>
      </div>

      <div style="height:14px"></div>
      <div class="section-row"><span class="section-title" style="color:#EF4444"><i class="ph-duotone ph-warning" style="color:#EF4444;font-size:1rem;vertical-align:middle"></i> Danger Zone</span></div>
      <div class="card settings-danger-card">
        <button class="btn btn-danger btn-sm" onclick="switchFamily()" style="width:100%;margin-bottom:8px">
          <i class="ph-duotone ph-link-break" style="vertical-align:middle;margin-right:6px"></i> Join Different Family
        </button>
        <div style="font-size:0.78rem;color:var(--muted);margin-bottom:12px">Clears all local data on this device and connects you to a different family. Your family's cloud data is not affected.</div>
        <button class="btn btn-danger btn-sm" onclick="resetAllData()" style="width:100%">Reset All Data</button>
        <div style="font-size:0.78rem;color:var(--muted);margin-top:8px">Permanently deletes all family data including tasks, prizes, history, and member profiles. This cannot be undone.</div>
      </div>

    </div>
    </div>`;
  if (returnHtml) return html;
  document.getElementById('settings-root').innerHTML = html;
}

function _renderSettingsNotifications(paneClass = _settingsPageEnterClass, returnHtml = false) {
  const s = D.settings;
  const interestOn = s.savingsEnabled !== false && s.savingsInterestEnabled;

  const html = `
    <div class="settings-subpane${paneClass ? ` ${paneClass}` : ''}">
    <div class="settings-header">
      <button class="btn-back settings-back-btn" onclick="backSettingsPage('main')">&larr;</button>
      <span class="settings-header-title"><i class="ph-duotone ph-bell" style="color:#6C63FF;font-size:1.1rem;vertical-align:middle"></i> Notifications</span>
      <div class="settings-header-spacer"></div>
    </div>
    <div class="settings-body">

      <div class="section-row"><span class="section-title"><i class="ph-duotone ph-device-mobile" style="color:#6C63FF;font-size:1rem;vertical-align:middle"></i> Push Notifications</span></div>
      <div class="card">
        <div class="toggle-row">
          <div>
            <div class="toggle-label">Task approval requests</div>
            <div class="toggle-sub">Sends a notification when a kid marks a task complete and it's waiting for your review</div>
          </div>
          <label class="toggle"><input type="checkbox" ${s.notifyChoreApproval!==false?'checked':''} onchange="saveSetting('notifyChoreApproval',this.checked);if(this.checked)initPushNotifications(firebase.auth().currentUser)"><span class="toggle-track"></span></label>
        </div>
        <div class="toggle-row" style="${s.savingsEnabled===false?'opacity:0.4;pointer-events:none':''}">
          <div>
            <div class="toggle-label">Savings spend requests</div>
            <div class="toggle-sub">${s.savingsEnabled===false?'Enable Savings Banking to use this':'Sends a notification when a kid requests to spend from their savings'}</div>
          </div>
          <label class="toggle"><input type="checkbox" ${s.notifySavingsSpend!==false?'checked':''} ${s.savingsEnabled===false?'disabled':''} onchange="saveSetting('notifySavingsSpend',this.checked);if(this.checked)initPushNotifications(firebase.auth().currentUser)"><span class="toggle-track"></span></label>
        </div>
      </div>

      <div style="height:14px"></div>
      <div class="section-row"><span class="section-title"><i class="ph-duotone ph-clock" style="color:#6C63FF;font-size:1rem;vertical-align:middle"></i> Scheduled Reminders</span></div>
      <div class="card">
        <div class="toggle-row" style="${!interestOn ? 'opacity:0.4;pointer-events:none' : ''}">
          <div>
            <div class="toggle-label">Interest day reminder</div>
            <div class="toggle-sub">${interestOn ? 'Reminds you on interest day to have kids open the app and claim their interest' : 'Enable Savings Interest to use this'}</div>
          </div>
          <label class="toggle"><input type="checkbox" ${s.interestDayNotify!==false?'checked':''} ${!interestOn?'disabled':''} onchange="saveSetting('interestDayNotify',this.checked);scheduleInterestDayNotification()"><span class="toggle-track"></span></label>
        </div>
      </div>

    </div>
    </div>`;
  if (returnHtml) return html;
  document.getElementById('settings-root').innerHTML = html;
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => { s.classList.remove('active'); s.removeAttribute('style'); s.classList.remove('loading'); });
  const el = document.getElementById(id);
  el.classList.add('active');
  const content = el.querySelector('.main-content');
  if (content) content.scrollTop = 0;
}


function renderCurrentView() {
  if (!S.currentUser) {
    const home = document.getElementById('screen-home');
    if (home?.classList.contains('active')) renderHome();
    return;
  }
  const freshCurrentUser = getMember(S.currentUser.id);
  if (freshCurrentUser) S.currentUser = freshCurrentUser;
  if (S.currentUser.role === 'parent') {
    renderParentHeader();
    renderParentNav();
    renderParentTab();
  } else {
    renderKidView();
  }
}

(function setupPullToRefresh() {
  return;
  const indicator = document.getElementById('ptr-indicator');
  let startY = 0, pulling = false, triggered = false, activeScroller = null;
  let lastScrollTime = 0;
  const THRESHOLD = 72; // px to pull before release triggers refresh
  const SCROLL_COOLDOWN = 350; // ms to wait after any scroll before arming PTR

  const markScroll = () => { lastScrollTime = Date.now(); };
  document.addEventListener('scroll', markScroll, { passive: true, capture: true });
  window.addEventListener('scroll', markScroll, { passive: true });

  // Returns true if the page is definitely NOT at the very top
  function pageIsScrolled() {
    if (window.scrollY > 2) return true;
    if (document.documentElement.scrollTop > 2) return true;
    if (activeScroller && activeScroller.scrollTop > 2) return true;
    return false;
  }

  function setIndicator(pullPx) {
    if (pullPx <= 0) {
      indicator.style.height = '0';
      indicator.innerHTML = '';
      return;
    }
    const pct  = Math.min(pullPx / THRESHOLD, 1);
    const h    = Math.round(pct * 52);
    indicator.style.height = h + 'px';
    indicator.style.transition = 'none';
    indicator.innerHTML = pullPx >= THRESHOLD
      ? '<span>Release to refresh</span>'
      : '<span>Pull to refresh</span>';
  }

  function doRefresh() {
    indicator.style.transition = 'height 0.15s ease';
    indicator.style.height = '52px';
    indicator.innerHTML = '<div class="ptr-spinner"></div><span>Refreshing...</span>';
    // Force a fresh Firestore fetch, fall back to local re-render
    const done = () => {
      indicator.style.height = '0';
      setTimeout(() => { indicator.innerHTML = ''; }, 160);
    };
    try {
      db.doc(getFamilyDoc()).get({ source: 'server' }).then(snap => {
        if (snap.exists) {
          D = normalizeData(snap.data());
          try { localStorage.setItem(LS_KEY, JSON.stringify(D)); } catch(e) {}
        }
        renderCurrentView();
        done();
      }).catch(() => { renderCurrentView(); done(); });
    } catch(e) { renderCurrentView(); done(); }
  }

  document.addEventListener('touchstart', e => {
    const scroller = e.target.closest('.main-content');
    if (!scroller) return;
    activeScroller = scroller;
    if (pageIsScrolled()) return;
    if (Date.now() - lastScrollTime < SCROLL_COOLDOWN) return;
    startY    = e.touches[0].clientY;
    pulling   = true;
    triggered = false;
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!pulling) return;
    // Abort if the page has scrolled since touchstart
    if (pageIsScrolled()) { pulling = false; setIndicator(0); return; }
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0) { pulling = false; setIndicator(0); return; }
    setIndicator(dy);
    if (dy >= THRESHOLD) triggered = true;
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if (!pulling) return;
    pulling = false;
    activeScroller = null;
    if (triggered) {
      doRefresh();
    } else {
      indicator.style.transition = 'height 0.2s ease';
      indicator.style.height = '0';
      setTimeout(() => { indicator.innerHTML = ''; }, 200);
    }
    triggered = false;
  }, { passive: true });
})();

function renderHome() {
  showScreen('screen-home');
  const members = D.family.members.filter(m => !m.deleted);
  const rawFamilyName = (D.family?.name || '').trim() || 'Our Family';
  const familyStem = rawFamilyName
    .replace(/^\s*the\s+/i, '')
    .replace(/\s+family\s*$/i, '')
    .trim() || rawFamilyName;
  const kids = members.filter(m => m.role !== 'parent');
  const parents = members.filter(m => m.role === 'parent');
  const cur = D.settings.currency || '$';
  const totalDiamonds = kids.reduce((sum, kid) => sum + (kid.gems || 0), 0);
  const totalSavings = kids.reduce((sum, kid) => sum + (kid.savings || 0), 0);
  const pendingCount = familyInboxCount();
  const cards = members.map(m => {
    const bday = isBirthday(m);
    const ptsLabel = m.role === 'parent'
      ? '<i class="ph-duotone ph-gear-six" style="font-size:0.9rem;vertical-align:middle"></i> Parent tools'
      : `<i class="ph-duotone ph-diamond" style="font-size:0.9rem;vertical-align:middle"></i> ${m.gems || 0} gems`;
    return `
      <button class="profile-card${bday ? ' bday-card' : ''}" style="--member-color:${m.color || '#6C63FF'};position:relative"
              onclick="selectProfile('${m.id}')">
        ${bday ? `<span class="bday-badge"><i class="ph-duotone ph-cake" style="font-size:0.9rem"></i></span>` : ''}
        <span class="profile-avatar">${renderMemberAvatarHtml(m)}</span>
        <span class="profile-name">${esc(m.name)}</span>
        <span class="profile-diamonds">${ptsLabel}</span>
      </button>`;
  }).join('');
  const anyBday = members.some(m => m.role !== 'parent' && isBirthday(m));
  const bdayBanner = anyBday
    ? `<div class="bday-banner"><i class="ph-duotone ph-cake" style="font-size:1rem;vertical-align:middle"></i> It's a birthday today! <i class="ph-duotone ph-confetti" style="font-size:1rem;vertical-align:middle"></i></div>` : '';

  const root = document.getElementById('screen-home');
  root.innerHTML = `
    ${bdayBanner}
    <div class="home-shell">
      <div class="home-hero">
        <div class="home-hero-copy">
          <div class="home-kicker"><i class="ph-duotone ph-leaf" style="font-size:1rem"></i> Family Space</div>
          <div class="home-family-stack">
            <div class="home-family-line home-family-line-top">The</div>
            <div class="home-family-line home-family-line-name">${esc(familyStem)}</div>
            <div class="home-family-line home-family-line-bottom">Family</div>
          </div>
        </div>
        <img class="home-logo" src="gemsproutpadded.png" alt="GemSprout">
        <div class="home-hero-meta">
          <div class="home-subtitle">A quick look at how the family is doing right now.</div>
          <div class="home-pill-row">
            <div class="home-pill"><i class="ph-duotone ph-diamond" style="font-size:1rem"></i> ${totalDiamonds} gems</div>
            <div class="home-pill"><i class="ph-duotone ph-piggy-bank" style="font-size:1rem"></i> ${cur}${totalSavings.toFixed(2)} saved</div>
            <div class="home-pill"><i class="ph-duotone ph-clock-countdown" style="font-size:1rem"></i> ${pendingCount} pending</div>
          </div>
        </div>
      </div>
      <div class="home-lower">
        <div class="home-section-head">
          <div class="home-section-title">Choose your place in the family</div>
        </div>
        <div class="profile-grid" style="max-width:980px;width:100%;padding:0">${cards}</div>
        <button class="home-setup-btn" onclick="goSetup()"><i class="ph-duotone ph-gear-six" style="color:#1D6B57;font-size:1.1rem;vertical-align:middle"></i> Edit family setup</button>
      </div>
    </div>`;
  if (WEEK_REVIEW_PREVIEW_MODE && !_weekReviewPreviewShown) {
    _weekReviewPreviewShown = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => showWeekReview());
    });
  }
}
function selectProfile(id) {
  const member = getMember(id);
  if (!member) return;
  setCurrentUserId(member.id);

  // Parents require Google/Apple auth
  if (member.role === 'parent' && !isParentSignedIn()) {
    showParentSignIn(id, (authedMember) => {
      if (isBirthday(authedMember)) {
        S.currentUser = authedMember;
        launchConfetti(80);
        showCelebration({
          icon: '<i class="ph-duotone ph-cake" style="color:#F97316;font-size:3rem"></i>', title: `Happy Birthday, ${authedMember.name}!`,
          sub: '<i class="ph-duotone ph-confetti" style="color:#F97316"></i> Have an amazing day! <i class="ph-duotone ph-confetti" style="color:#F97316"></i>',
          tts: null, onClose: () => routeToView(authedMember),
        });
      } else {
        routeToView(authedMember);
      }
    });
    return;
  }

  if (isBirthday(member)) {
    S.currentUser = member;
    launchConfetti(80);
    showCelebration({
      icon:  '<i class="ph-duotone ph-cake" style="color:#F97316;font-size:3rem"></i>',
      title: `Happy Birthday, ${member.name}!`,
      sub:   '<i class="ph-duotone ph-confetti" style="color:#F97316"></i> Have an amazing day! <i class="ph-duotone ph-confetti" style="color:#F97316"></i>',
      tts:   isTiny(member) ? `Happy Birthday ${member.name}! Wishing you the most wonderful day!` : null,
      onClose: () => routeToView(member),
    });
    return;
  }

  S.currentUser = member;
  routeToView(member);
}

function routeToView(member) {
  const switchingUsers = !!S._activeViewUserId && S._activeViewUserId !== member.id;
  const switchingRoles = !!S._activeViewRole && S._activeViewRole !== member.role;
  if (switchingUsers || switchingRoles) {
    clearScrollMemory();
    resetPrimaryTabs();
  }
  S._activeViewUserId = member.id;
  S._activeViewRole = member.role;
  if (member.role === 'parent') {
    if (!ensureParentAuth(member, (authedMember) => routeToView(authedMember))) return;
    if (!S.isPro && !RC.betaMode) { showPaywall(); return; }
    renderParentView();
  } else {
    renderKidView(); // handles both 'tiny' and 'regular'
  }
}

function renderPin() {
  showScreen('screen-pin');
  S.pinBuffer = '';
  const m = S.currentUser;
  const _pinAvEl = m.avatar && /\.(png|jpe?g)$/i.test(m.avatar)
    ? `<img class="pin-avatar" src="${m.avatar}">`
    : `<div class="pin-avatar">${renderMemberAvatarHtml(m, '<i class="ph-duotone ph-user" style="color:#6C63FF;font-size:2.5rem"></i>')}</div>`;
  document.getElementById('pin-content').innerHTML = `
    ${_pinAvEl}
    <div class="pin-title">Welcome back, ${esc(m.name)}!</div>
    <div class="pin-sub">Enter your PIN</div>
    <div class="pin-dots" id="pin-dots">
      <div class="pin-dot" id="pd0"></div>
      <div class="pin-dot" id="pd1"></div>
      <div class="pin-dot" id="pd2"></div>
      <div class="pin-dot" id="pd3"></div>
    </div>
    <div class="pin-grid">
      ${[1,2,3,4,5,6,7,8,9,'',0,'Del'].map(k => `
        <button class="pin-key${k===''?' hidden':''}" onclick="pinKey('${k}')">${k}</button>
      `).join('')}
    </div>
    <div id="pin-error" class="pin-error hidden"></div>
    <button class="btn btn-secondary mt-16" onclick="showAppPin()">&larr; Back</button>`;
}

function pinKey(k) {
  if (k === 'Del') {
    S.pinBuffer = S.pinBuffer.slice(0,-1);
  } else if (S.pinBuffer.length < 4) {
    S.pinBuffer += k;
  }
  // Update dots
  for (let i=0;i<4;i++) {
    const dot = document.getElementById('pd'+i);
    if (dot) dot.classList.toggle('filled', i < S.pinBuffer.length);
  }
  if (S.pinBuffer.length === 4) {
    setTimeout(() => {
      if (S.pinBuffer === D.settings.parentPin) {
        S.pinBuffer = '';
        if (S.pinMode === 'pinReset') { afterPinResetVerified(); return; }
        if (S.pinMode === 'leaveDevice') { _doLeaveDevice(); return; }
        if (S.pinMode === 'app') {
          setAppUnlocked(true);
          const rememberedUser = getMember(getCurrentUserId());
          if (rememberedUser) {
            S.currentUser = rememberedUser;
            if (S._afterPinNav === 'overview') { S._afterPinNav = null; S.parentTab = 'home'; }
            routeToView(rememberedUser);
          } else {
            renderHome();
          }
          return;
        }
        renderParentView();
      } else {
        const err = document.getElementById('pin-error');
        if (err) { err.textContent='Incorrect PIN, try again'; err.classList.remove('hidden'); }
        setTimeout(() => {
          S.pinBuffer = '';
          for (let i=0;i<4;i++) { const d=document.getElementById('pd'+i); if(d) d.classList.remove('filled'); }
        }, 500);
      }
    }, 200);
  }
}

const BIOMETRIC_KEY = 'gemsprout_biometric_id';

function isNative() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

let _biometricAvailable = null;
let _biometricType = null; // 1 = Touch ID, 2 = Face ID

async function checkBiometricAvailability() {
  if (isNative()) {
    try {
      const { NativeBiometric } = Capacitor.Plugins;
      const result = await NativeBiometric.isAvailable();
      _biometricAvailable = result.isAvailable;
      _biometricType = result.biometryType || null;
    } catch { _biometricAvailable = false; }
  } else {
    _biometricAvailable = !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
  }
}

function isBiometricSupported() {
  if (_biometricAvailable !== null) return _biometricAvailable;
  // fallback before cache is populated (PWA only)
  return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
}

function getBiometricLabel() {
  if (_biometricType === 1) return 'Touch ID';
  if (_biometricType === 2) return 'Face ID';
  return 'Face ID'; // default for PWA / unknown
}

function getBiometricCredentialId() {
  return localStorage.getItem(BIOMETRIC_KEY);
}

let _biometricOfferCallback = null;

function offerBiometricSetup(onComplete) {
  _biometricOfferCallback = onComplete || null;
  const label = getBiometricLabel();
  showQuickActionModal(`
    <div style="text-align:center;padding:8px 0 4px">
      <i class="ph-duotone ph-fingerprint" style="font-size:3rem;color:#6C63FF"></i>
      <div class="modal-title" style="margin-top:8px">Use ${label}?</div>
      <p style="font-size:0.88rem;color:var(--muted);margin:10px 0 0;line-height:1.5">Skip typing your PIN - unlock GemSprout instantly with ${label}.</p>
    </div>
    <div class="modal-actions" style="margin-top:20px">
      <button class="btn btn-secondary" onclick="declineBiometricOffer()">Not Now</button>
      <button class="btn btn-primary" onclick="acceptBiometricOffer()">Set Up ${label}</button>
    </div>`, 'quick-action-modal-wide', {
    disableBgClose: !!S._setupBiometricDecisionRequired,
    showClose: !S._setupBiometricDecisionRequired
  });
}

function acceptBiometricOffer() {
  const cb = _biometricOfferCallback;
  _biometricOfferCallback = null;
  closeModal();
  if (S._testOnboarding?.active) {
    toast('Biometric setup previewed');
    if (cb) cb();
    return;
  }
  registerBiometricWithCallback(cb);
}

function declineBiometricOffer() {
  const cb = _biometricOfferCallback;
  _biometricOfferCallback = null;
  closeModal();
  if (cb) cb();
}

async function registerBiometricWithCallback(onComplete) {
  if (!isBiometricSupported()) { if (onComplete) onComplete(); return; }
  const label = getBiometricLabel();
  try {
    if (isNative()) {
      const { NativeBiometric } = Capacitor.Plugins;
      await NativeBiometric.verifyIdentity({ reason: `Set up ${label} for GemSprout`, title: `Set Up ${label}` });
      localStorage.setItem(BIOMETRIC_KEY, 'native');
    } else {
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const cred = await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: { name: 'GemSprout' },
          user: { id: new Uint8Array(16), name: 'parent', displayName: 'Parent' },
          pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
          authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
          timeout: 60000,
        }
      });
      const id = btoa(String.fromCharCode(...new Uint8Array(cred.rawId)));
      localStorage.setItem(BIOMETRIC_KEY, id);
    }
    toast(`${label} set up!`);
  } catch(e) {
    if (e.name !== 'NotAllowedError' && e.message !== 'Authentication cancelled.') {
      alert(`Could not set up ${label}: ` + e.message);
    }
  } finally {
    if (onComplete) onComplete();
  }
}

function registerBiometric() {
  registerBiometricWithCallback(() => renderSettings());
}

let _biometricInProgress = false;

async function authenticateBiometric(onSuccess) {
  if (_biometricInProgress) return false;
  const storedId = getBiometricCredentialId();
  if (!storedId || !isBiometricSupported()) return false;
  _biometricInProgress = true;
  try {
    if (isNative()) {
      const { NativeBiometric } = Capacitor.Plugins;
      await NativeBiometric.verifyIdentity({ reason: 'Unlock GemSprout', title: 'GemSprout' });
    } else {
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const rawId = Uint8Array.from(atob(storedId), c => c.charCodeAt(0));
      await navigator.credentials.get({
        publicKey: {
          challenge,
          allowCredentials: [{ id: rawId, type: 'public-key' }],
          userVerification: 'required',
          timeout: 60000,
        }
      });
    }
    onSuccess();
    return true;
  } catch(e) {
    if (e.name !== 'NotAllowedError' && e.message !== 'Authentication cancelled.') {
      console.warn('Biometric auth failed:', e.message);
    }
    return false;
  } finally {
    _biometricInProgress = false;
  }
}

function removeBiometric() {
  localStorage.removeItem(BIOMETRIC_KEY);
  toast(`${getBiometricLabel()} removed`);
}

function tryBiometricUnlock() {
  authenticateBiometric(() => {
    S.pinBuffer = '';
    if (S.pinMode === 'pinReset') { afterPinResetVerified(); return; }
    if (S.pinMode === 'app') {
      setAppUnlocked(true);
      const rememberedUser = getMember(getCurrentUserId());
      if (rememberedUser) {
        S.currentUser = rememberedUser;
        if (S._afterPinNav === 'overview') { S._afterPinNav = null; S.parentTab = 'home'; }
        routeToView(rememberedUser);
      } else {
        renderHome();
      }
    } else {
      renderParentView();
    }
  });
}

const SETUP_STEPS_NEW  = ['welcome','parents','members','chores','prizes','appSettings','done'];
const SETUP_STEPS_EDIT = ['welcome','parents','members'];
let SETUP_STEPS = SETUP_STEPS_NEW;

function renderSetupGate() {
  const gate = document.getElementById('setup-gate');
  const content = document.getElementById('setup-content');
  gate.style.display = 'flex';
  content.style.display = 'none';
  gate.innerHTML = `
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 28px;gap:24px;background:linear-gradient(145deg,#667eea,#764ba2)">
      <img src="gemsproutpadded.png" style="width:120px;height:120px">
      <div style="color:#fff;font-size:2rem;font-weight:800;text-align:center;text-shadow:0 2px 12px rgba(0,0,0,0.2)">Welcome to GemSprout</div>
      <div style="color:rgba(255,255,255,0.8);font-size:1rem;text-align:center;max-width:280px">Rhythms, rewards, and goals for the whole family.</div>
      <div style="display:flex;flex-direction:column;gap:12px;width:100%;max-width:320px;margin-top:8px">
        <button class="btn btn-primary" style="font-size:1.05rem;padding:16px;background:#fff;color:#6C63FF;border:none" onclick="startNewFamily()">
          <i class="ph-duotone ph-sparkle" style="vertical-align:middle;margin-right:6px"></i> Get Started
        </button>
        <button class="btn btn-secondary" style="font-size:1rem;padding:14px;background:rgba(255,255,255,0.15);color:#fff;border:1.5px solid rgba(255,255,255,0.4)" onclick="showSignInFlow()">
          <i class="ph-duotone ph-sign-in" style="vertical-align:middle;margin-right:6px"></i> Sign In
        </button>
        <button class="btn btn-secondary" style="font-size:1rem;padding:14px;background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.85);border:1.5px solid rgba(255,255,255,0.25)" onclick="showKidEntry()">
          <i class="ph-duotone ph-smiley" style="vertical-align:middle;margin-right:6px"></i> I'm a Kid
        </button>
      </div>
    </div>`;
}

function startNewFamily() {
  const gate = document.getElementById('setup-gate');
  gate.innerHTML = `
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 28px;gap:20px;background:linear-gradient(145deg,#667eea,#764ba2)">
      <img src="gemsproutpadded.png" style="width:90px;height:90px">
      <div style="color:#fff;font-weight:800;font-size:1.5rem;text-align:center">Create Your Family</div>
      <div style="color:rgba(255,255,255,0.8);font-size:0.95rem;text-align:center;max-width:280px">Sign in to secure your account and sync your family across devices.</div>
      <div style="display:flex;flex-direction:column;gap:12px;width:100%;max-width:320px;margin-top:8px">
        <button class="btn" style="background:#fff;color:#333;font-size:1rem;padding:14px 20px;border-radius:12px;display:flex;align-items:center;gap:12px;justify-content:center;font-weight:600;border:none" onclick="_newFamilyAuth('google')">
          <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" style="width:20px;height:20px">
          Continue with Google
        </button>
        <button class="btn" style="background:#000;color:#fff;font-size:1rem;padding:14px 20px;border-radius:12px;display:flex;align-items:center;gap:12px;justify-content:center;font-weight:600;border:none" onclick="_newFamilyAuth('apple')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff" xmlns="http://www.w3.org/2000/svg"><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701z"/></svg>
          Continue with Apple&nbsp;
        </button>
      </div>
      <button style="background:none;border:none;color:rgba(255,255,255,0.6);font-size:0.9rem;cursor:pointer;margin-top:8px" onclick="renderSetupGate()"><i class="ph-duotone ph-arrow-left" style="font-size:0.95rem;vertical-align:middle"></i> Back</button>
      ${RC.betaMode ? `
      <div style="margin-top:28px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.15);width:100%;max-width:320px">
        <div style="color:rgba(255,255,255,0.4);font-size:0.72rem;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px;text-align:center">Dev Only - skip real auth</div>
        <div style="display:flex;gap:8px">
          <input id="dev-getstarted-email" type="email" placeholder="test@email.com" autocomplete="off"
            style="flex:1;padding:10px 12px;border:none;border-radius:10px;font-size:0.9rem;background:rgba(255,255,255,0.15);color:#fff;outline:none">
          <button onclick="_devTestGetStarted()" style="padding:10px 14px;border-radius:10px;background:rgba(255,255,255,0.2);color:#fff;border:none;font-size:0.85rem;font-weight:600;cursor:pointer;white-space:nowrap">Test Sign In</button>
        </div>
      </div>` : ''}
    </div>`;
}

async function _newFamilyAuth(provider) {
  const btns = document.querySelectorAll('#setup-gate .btn');
  btns.forEach(b => { b.disabled = true; b.style.opacity = '0.6'; });
  const user = provider === 'google' ? await signInWithGoogle() : await signInWithApple();
  if (!user) {
    btns.forEach(b => { b.disabled = false; b.style.opacity = '1'; });
    return;
  }
  await _processNewFamilyUser(user);
}

async function _devTestGetStarted() {
  const email = (document.getElementById('dev-getstarted-email')?.value || '').trim().toLowerCase();
  if (!email || !email.includes('@')) { toast('Enter a test email first'); return; }
  await _processNewFamilyUser({ uid: `dev-${email.replace(/[^a-z0-9]/g, '-')}`, email, displayName: '' });
}

async function _processNewFamilyUser(user) {
  S._pendingNewFamilyUser = user;
  const email = (user.email || '').toLowerCase();
  if (email) {
    try {
      const inviteSnap = await db.collection('invites').where('email', '==', email).limit(1).get();
      const invite = inviteSnap.docs[0];
      if (invite && !invite.data().used) {
        showQuickActionModal(`
          <div style="text-align:center;padding:4px 0 8px">
            <i class="ph-duotone ph-question" style="font-size:2.5rem;color:#6C63FF"></i>
            <div class="modal-title" style="margin-top:8px">Joining a family?</div>
          </div>
          <p style="font-size:0.88rem;color:var(--muted);margin:0 0 16px;line-height:1.5">This email has a pending invite to an existing GemSprout family. Did you mean to join that family, or create a brand new one?</p>
          <div style="display:flex;flex-direction:column;gap:8px">
            <button class="btn btn-primary" onclick="closeModal();_acceptInviteFromGetStarted()">Join existing family</button>
            <button class="btn btn-secondary" onclick="closeModal();_continueNewFamily()">Create a new family</button>
          </div>`, 'quick-action-modal-wide');
        return;
      }
    } catch(e) {  }
  }
  _continueNewFamily();
}

async function _continueNewFamily() {
  const user = S._pendingNewFamilyUser;
  S._pendingNewFamilyUser = null;
  if (!user) return;
  S._newFamilyFirebaseUser = user; // kept so finishSetup() can link auth without re-prompting
  S.newFamilyDisplayName = user.displayName || '';
  setFamilyCode(await genUniqueFamilyCode());
  document.getElementById('setup-gate').style.display = 'none';
  document.getElementById('setup-content').style.display = '';
  goSetup();
}

async function _acceptInviteFromGetStarted() {
  const user = S._pendingNewFamilyUser;
  S._pendingNewFamilyUser = null;
  if (!user) return;
  await _resolveSignInUser(user);
}

function showKidEntry() {
  const gate = document.getElementById('setup-gate');
  gate.innerHTML = `
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 28px;gap:20px">
      <div style="font-size:3.5rem"><i class="ph-duotone ph-smiley" style="color:#6C63FF"></i></div>
      <div style="font-weight:800;font-size:1.4rem">I'm a Kid!</div>
      <div style="color:#6B7280;text-align:center;max-width:280px">Enter the family code from your parent's Settings screen, or scan the QR code they show you.</div>
      <input id="join-code-input" type="text" maxlength="6" placeholder="XXXXXX" autocapitalize="characters" autocomplete="off"
        style="font-size:2rem;font-weight:800;letter-spacing:0.2em;text-align:center;text-transform:uppercase;width:100%;max-width:280px;padding:16px;border:2px solid var(--border);border-radius:12px;background:#fff;outline:none"
        oninput="this.value=this.value.toUpperCase().replace(/[^A-Z0-9]/g,'')" />
      <button class="btn btn-primary" style="width:100%;max-width:280px;padding:14px" onclick="joinFamily()">
        <i class="ph-duotone ph-sign-in" style="vertical-align:middle;margin-right:6px"></i> Join Family
      </button>
      ${isNative() ? `
      <button class="btn btn-secondary" style="width:100%;max-width:280px;padding:12px" onclick="startQRScan()">
        <i class="ph-duotone ph-qr-code" style="vertical-align:middle;margin-right:6px"></i> Scan QR Code
      </button>` : ''}
      <button class="btn-back" style="background:none;border:none;color:var(--muted);font-size:0.95rem;cursor:pointer" onclick="renderSetupGate()"><i class="ph-duotone ph-arrow-left" style="font-size:0.95rem;vertical-align:middle"></i> Back</button>
    </div>`;
}

async function joinFamily() {
  const input = document.getElementById('join-code-input');
  const code = input?.value.trim().toUpperCase() || '';
  if (code.length !== 6) { toast('Please enter the full 6-character code'); return; }

  const btn = document.querySelector('#screen-setup .btn-primary');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ph-duotone ph-hourglass" style="vertical-align:middle"></i> Joining...'; }

  try {
    const snap = await db.doc(`families/${code}`).get();
    if (!snap.exists) {
      toast('Family code not found - double-check and try again');
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ph-duotone ph-sign-in" style="vertical-align:middle;margin-right:6px"></i> Join Family'; }
      return;
    }
    D = normalizeData(snap.data());
    setFamilyCode(code);
    setCurrentUserId('');   // don't inherit a remembered profile from a previous session
    setParentAuthUid(null); // don't inherit parent auth trust from a previous session
    try { localStorage.setItem(LS_KEY, JSON.stringify(D)); } catch(e) {}
    ensureFirestoreAuth()
      .then(() => {
        if (auth.currentUser && !getParentAuthUid()) {
          db.doc(`users/${auth.currentUser.uid}`).set({ familyCode: code, role: 'kid' }, { merge: true }).catch(() => {});
        }
        subscribeToFirestore();
      })
      .catch(() => {});
    routeAfterLoad();
  } catch(e) {
    toast('Connection error - please try again');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ph-duotone ph-sign-in" style="vertical-align:middle;margin-right:6px"></i> Join Family'; }
  }
}

function showSignInFlow() {
  const gate = document.getElementById('setup-gate');
  gate.innerHTML = `
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 28px;gap:0;background:linear-gradient(145deg,#667eea,#764ba2)">
      <img src="gemsproutpadded.png" style="width:90px;height:90px;margin-bottom:16px">
      <div style="color:#fff;font-size:1.6rem;font-weight:800;margin-bottom:6px">Welcome back!</div>
      <div style="color:rgba(255,255,255,0.8);font-size:0.95rem;margin-bottom:32px;text-align:center">Sign in to access your family on this device</div>
      <div style="display:flex;flex-direction:column;gap:12px;width:100%;max-width:320px">
        <button id="signin-google-btn" class="btn" style="background:#fff;color:#3c4043;font-size:1rem;padding:14px 20px;border-radius:12px;display:flex;align-items:center;gap:12px;justify-content:center;font-weight:600;border:none" onclick="_handleSignIn('google')">
          <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" style="width:20px;height:20px">
          Continue with Google
        </button>
        <button id="signin-apple-btn" class="btn" style="background:#000;color:#fff;font-size:1rem;padding:14px 20px;border-radius:12px;display:flex;align-items:center;gap:12px;justify-content:center;font-weight:600;border:none" onclick="_handleSignIn('apple')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff" xmlns="http://www.w3.org/2000/svg"><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701z"/></svg>
          Continue with Apple&nbsp;
        </button>
      </div>
      <button style="margin-top:24px;background:none;border:none;color:rgba(255,255,255,0.5);font-size:0.85rem;cursor:pointer" onclick="renderSetupGate()"><i class="ph-duotone ph-arrow-left" style="font-size:0.95rem;vertical-align:middle"></i> Back</button>
      ${RC.betaMode ? `
      <div style="margin-top:28px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.15);width:100%;max-width:320px">
        <div style="color:rgba(255,255,255,0.4);font-size:0.72rem;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px;text-align:center">Dev Only - skip real auth</div>
        <div style="display:flex;gap:8px">
          <input id="dev-signin-email" type="email" placeholder="invited@email.com" autocomplete="off"
            style="flex:1;padding:10px 12px;border:none;border-radius:10px;font-size:0.9rem;background:rgba(255,255,255,0.15);color:#fff;outline:none">
          <button onclick="_devTestSignIn()" style="padding:10px 14px;border-radius:10px;background:rgba(255,255,255,0.2);color:#fff;border:none;font-size:0.85rem;font-weight:600;cursor:pointer;white-space:nowrap">Test Sign In</button>
        </div>
      </div>` : ''}
    </div>`;
}

async function _handleSignIn(provider) {
  const btns = document.querySelectorAll('#signin-google-btn,#signin-apple-btn');
  btns.forEach(b => { b.disabled = true; b.style.opacity = '0.6'; });
  const user = provider === 'google' ? await signInWithGoogle() : await signInWithApple();
  if (!user) {
    btns.forEach(b => { b.disabled = false; b.style.opacity = '1'; });
    return;
  }
  await _resolveSignInUser(user);
}

async function _resolveSignInUser(firebaseUser) {
  showLoading();
  try {
    // 1. Check if this UID is already linked to a family (returning parent, any device)
    const userDoc = await db.doc(`users/${firebaseUser.uid}`).get();
    if (userDoc.exists && userDoc.data().familyCode) {
      setFamilyCode(userDoc.data().familyCode);
      setParentAuthUid(firebaseUser.uid);
      await ensureFirestoreAuth();
      subscribeToFirestore(routeAfterLoad);
      return;
    }
    // 2. Check if their email has a pending invite (Parent B joining for the first time)
    const email = (firebaseUser.email || '').toLowerCase();
    if (email) {
      const inviteSnap = await db.collection('invites').where('email', '==', email).limit(1).get();
      const invite = inviteSnap.docs[0];
      if (invite && !invite.data().used) {
        const familyCode = invite.data().familyCode;
        await invite.ref.update({ used: true, usedAt: Date.now(), usedByUid: firebaseUser.uid });
        setFamilyCode(familyCode);
        db.doc(`users/${firebaseUser.uid}`).set({ familyCode, uid: firebaseUser.uid, email }, { merge: true }).catch(() => {});
        await ensureFirestoreAuth();
        subscribeToFirestore(() => showParentBSetup(firebaseUser));
        return;
      }
      const emailSnap = await db.collection('users').where('email', '==', email).limit(1).get();
      if (!emailSnap.empty) {
        const data = emailSnap.docs[0].data();
        if (data.familyCode) {
          // Register this new UID so future lookups hit step 1 instead
          db.doc(`users/${firebaseUser.uid}`).set({ familyCode: data.familyCode, uid: firebaseUser.uid, email }, { merge: true }).catch(() => {});
          setFamilyCode(data.familyCode);
          await ensureFirestoreAuth();
          subscribeToFirestore(routeAfterLoad);
          return;
        }
      }
    }
    _showSignInNotFound();
  } catch(e) {
    console.warn('Sign in lookup failed:', e);
    _showSignInNotFound();
  }
}

function _showSignInNotFound() {
  const gate = document.getElementById('setup-gate');
  if (!gate) return;
  showScreen('screen-setup');
  gate.style.display = 'flex';
  document.getElementById('setup-content').style.display = 'none';
  gate.innerHTML = `
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 28px;gap:16px;background:linear-gradient(145deg,#667eea,#764ba2)">
      <i class="ph-duotone ph-magnifying-glass" style="font-size:3rem;color:rgba(255,255,255,0.7)"></i>
      <div style="color:#fff;font-size:1.4rem;font-weight:800;text-align:center">No family found</div>
      <div style="color:rgba(255,255,255,0.8);font-size:0.95rem;text-align:center;max-width:300px;line-height:1.5">This account isn't linked to a GemSprout family yet. Go back and tap <strong>Get Started</strong> to create one, or make sure you're signing in with the same account your family invite was sent to.</div>
      <button class="btn" style="background:#fff;color:#6C63FF;font-weight:700;padding:14px 28px;border:none;border-radius:12px;margin-top:8px" onclick="renderSetupGate()"><i class="ph-duotone ph-arrow-left" style="font-size:0.95rem;vertical-align:middle"></i> Back</button>
    </div>`;
}

function showParentBSetup(firebaseUser) {
  const defaultName = firebaseUser?.displayName || '';
  const col = COLORS[Math.floor(Math.random() * COLORS.length)] || '#6C63FF';
  S._parentBMember = { id: genId(), name: defaultName, avatar: '<i class="ph-duotone ph-user-circle" style="color:#6C63FF"></i>', color: col, role: 'parent', gems: 0, savings: 0, totalEarned: 0, birthday: '' };
  S._parentBFirebaseUser = firebaseUser;

  showScreen('screen-setup');
  document.getElementById('setup-gate').style.display = 'none';
  const content = document.getElementById('setup-content');
  content.style.display = '';

  const avatarOpts = [
    `<div class="avatar-opt${'<i class="ph-duotone ph-leaf" style="color:#16A34A"></i>'===S._parentBMember.avatar?' sel':''}" onclick="S._parentBMember.avatar='<i class=&quot;ph-duotone ph-leaf&quot; style=&quot;color:#16A34A&quot;></i>';document.querySelectorAll('#parentb-avatars .avatar-opt').forEach(el=>el.classList.remove('sel'));this.classList.add('sel')"><i class="ph-duotone ph-leaf" style="color:#16A34A"></i></div>`,
    ...AVATARS.slice(0, 23).map(a => {
      const encoded = encodeURIComponent(a);
      return `<div class="avatar-opt${a === S._parentBMember.avatar ? ' sel' : ''}" onclick="S._parentBMember.avatar=decodeURIComponent('${encoded}');document.querySelectorAll('#parentb-avatars .avatar-opt').forEach(el=>el.classList.remove('sel'));this.classList.add('sel')">${a}</div>`;
    })
  ].join('');
  const colorSwatches = COLORS.map(c =>
    `<div class="color-swatch${c === col ? ' sel' : ''}" style="background:${c}" onclick="S._parentBMember.color='${c}';document.querySelectorAll('#parentb-colors .color-swatch').forEach(el=>el.classList.remove('sel'));this.classList.add('sel')"></div>`
  ).join('');

  content.innerHTML = `
    <div class="setup-step active">
      <div class="setup-top" style="padding-top:20px">
        <div class="setup-emoji"><i class="ph-duotone ph-hand-waving" style="color:#6C63FF;font-size:3rem"></i></div>
        <div class="setup-title">Welcome to ${esc(D.family.name || 'GemSprout')}!</div>
        <div class="setup-sub">Set up your parent profile and you're in.</div>
      </div>
      <div class="form-group">
        <label class="form-label">Your name</label>
        <input type="text" id="parentb-name" placeholder="Your name" value="${esc(defaultName)}" oninput="S._parentBMember.name=this.value">
      </div>
      <div class="form-group">
        <label class="form-label">Avatar</label>
        <div class="avatar-grid" id="parentb-avatars">${avatarOpts}</div>
      </div>
      <div class="form-group">
        <label class="form-label">Color</label>
        <div class="color-row" id="parentb-colors">${colorSwatches}</div>
      </div>
      <button class="btn btn-primary btn-full mt-8" onclick="finishParentBSetup()">
        Get Started <i class="ph-duotone ph-arrow-right" style="vertical-align:middle;margin-left:4px"></i>
      </button>
    </div>`;
}

async function finishParentBSetup() {
  const member = S._parentBMember;
  const firebaseUser = S._parentBFirebaseUser;
  const name = (document.getElementById('parentb-name')?.value || '').trim();
  if (!name) { toast('Enter your name to continue'); return; }
  member.name = name;
  const firstParentIdx = D.family.members.findIndex(m => m.role === 'parent');
  D.family.members.splice(firstParentIdx >= 0 ? firstParentIdx + 1 : 0, 0, member);
  S.currentUser = member;
  setCurrentUserId(member.id);
  setAppUnlocked(true);
  saveData();
  await linkParentAuth(firebaseUser, member.id);
  S._parentBMember = null;
  S._parentBFirebaseUser = null;
  routeToView(member);
}

const DEV_TEST_UID_KEY = 'gemsprout.devTestUid';

function _devShowInviteTest() {
  showInviteParent(true);
}

async function _devTestSignIn() {
  const email = (document.getElementById('dev-signin-email')?.value || '').trim().toLowerCase();
  if (!email || !email.includes('@')) { toast('Enter a test email first'); return; }
  const fakeUid = `dev-${email.replace(/[^a-z0-9]/g, '-')}`;
  try { localStorage.setItem(DEV_TEST_UID_KEY, fakeUid); } catch {}
  await _resolveSignInUser({ uid: fakeUid, email });
}

async function _devResetInviteTest() {
  try {
    const deletes = [];
    const snaps = await db.collection('invites').where('familyCode', '==', getFamilyCode()).get();
    snaps.docs.forEach(d => deletes.push(d.ref.delete()));
    const storedUid = localStorage.getItem(DEV_TEST_UID_KEY);
    if (storedUid) {
      deletes.push(db.doc(`users/${storedUid}`).delete());
      localStorage.removeItem(DEV_TEST_UID_KEY);
    }
    await Promise.all(deletes);
    toast(`Reset complete - ${snaps.docs.length} invite(s) cleared`);
  } catch(e) {
    toast('Reset failed: ' + e.message);
  }
}

let _qrStream = null, _qrAnimFrame = null;

async function startQRScan() {
  if (!isNative()) return;
  if (typeof jsQR === 'undefined') { toast('QR scanner not available - enter the code manually'); return; }

  // Build fullscreen overlay
  const overlay = document.createElement('div');
  overlay.id = 'qr-scan-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:#000;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center';
  overlay.innerHTML = `
    <video id="qr-video" playsinline muted autoplay
      style="width:100%;height:100%;object-fit:cover;position:absolute;inset:0"></video>
    <div style="position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;gap:20px;pointer-events:none">
      <div style="width:220px;height:220px;border:3px solid rgba(255,255,255,0.8);border-radius:16px;box-shadow:0 0 0 9999px rgba(0,0,0,0.45)"></div>
      <div style="color:#fff;font-size:0.95rem;font-weight:600;text-shadow:0 1px 4px rgba(0,0,0,0.6)">Point at the QR code</div>
    </div>
    <button onclick="stopQRScan()" style="position:absolute;bottom:56px;background:rgba(255,255,255,0.15);border:1.5px solid rgba(255,255,255,0.4);color:#fff;font-size:1rem;font-weight:600;padding:14px 36px;border-radius:50px;cursor:pointer">Cancel</button>`;
  document.body.appendChild(overlay);

  try {
    _qrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const video = document.getElementById('qr-video');
    video.srcObject = _qrStream;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    const scan = () => {
      if (!document.getElementById('qr-scan-overlay')) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const result = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
        if (result?.data) {
          stopQRScan();
          const code = result.data.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
          const input = document.getElementById('join-code-input');
          if (input) { input.value = code; joinFamily(); }
          return;
        }
      }
      _qrAnimFrame = requestAnimationFrame(scan);
    };
    _qrAnimFrame = requestAnimationFrame(scan);

  } catch(e) {
    stopQRScan();
    const msg = (e?.message || '').toLowerCase();
    if (msg.includes('permission') || msg.includes('denied')) {
      toast('Camera permission denied - enter the code manually');
    } else if (!msg.includes('abort')) {
      toast('Camera unavailable - enter the code manually');
    }
  }
}

function stopQRScan() {
  if (_qrAnimFrame) { cancelAnimationFrame(_qrAnimFrame); _qrAnimFrame = null; }
  if (_qrStream) { _qrStream.getTracks().forEach(t => t.stop()); _qrStream = null; }
  const overlay = document.getElementById('qr-scan-overlay');
  if (overlay) overlay.remove();
}


function showFamilyCodeModal(triggerEl = null, opts = {}) {
  const code = getFamilyCode();
  const escapedCode = code.replace(/'/g, "\\'");
  const rect = triggerEl?.getBoundingClientRect?.();
  if (!opts.replace && rect) _modalLaunchOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  const modalHtml = `
    <div style="text-align:center;padding:4px 0 8px">
      <i class="ph-duotone ph-users" style="font-size:2.5rem;color:#6C63FF"></i>
      <div class="modal-title" style="margin-top:8px">Add user</div>
    </div>
    <div style="display:flex;align-items:center;justify-content:center;gap:10px;margin:8px 0 6px">
      <div style="font-size:2rem;font-weight:800;letter-spacing:0.18em;color:#6C63FF;font-family:monospace">${code}</div>
      <button onclick="navigator.clipboard.writeText('${escapedCode}').then(()=>toast('Code copied!'))" style="background:none;border:none;cursor:pointer;padding:4px;line-height:1">
        <i class="ph-duotone ph-copy" style="font-size:1.5rem;color:#6C63FF;vertical-align:middle"></i>
      </button>
    </div>
    <div style="font-size:0.8rem;color:var(--muted);text-align:center;margin-bottom:18px">Use this code to add a kid's device to your family, or use the QR code below</div>
    <div style="display:flex;justify-content:center;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      <button class="btn btn-secondary btn-sm" onclick="showKidDeviceQR(null, { replace: true })">
        <i class="ph-duotone ph-qr-code" style="font-size:0.9rem;vertical-align:middle"></i> Add with QR code
      </button>
      <button class="btn btn-secondary btn-sm" onclick="showInviteParent(false, null, { replace: true })">
        <i class="ph-duotone ph-user-plus" style="font-size:0.9rem;vertical-align:middle"></i> Invite a parent
      </button>
    </div>
    ${RC.betaMode ? `<div style="padding:10px 12px;background:#F5F3FF;border-radius:10px;font-size:0.82rem">
      <span style="color:var(--muted)">Install on other devices: </span>
      <a href="${RC.appDownloadUrl}" target="_blank" style="font-weight:700;color:#6C63FF;text-decoration:none">${RC.appDownloadUrl}</a>
    </div>` : ''}
    <div class="modal-actions" style="margin-top:12px">
      <button class="btn btn-secondary" onclick="closeModal()">Done</button>
    </div>`;
  if (opts.replace) replaceQuickActionModal(modalHtml, 'quick-action-modal-wide');
  else showQuickActionModal(modalHtml, 'quick-action-modal-wide');
}

function showKidDeviceQR(triggerEl = null, opts = {}) {
  const code = getFamilyCode();
  const rect = triggerEl?.getBoundingClientRect?.();
  if (!opts.replace && rect) _modalLaunchOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  const modalHtml = `
    <div style="text-align:center;padding:4px 0 8px">
      <i class="ph-duotone ph-device-mobile" style="font-size:2.5rem;color:#6C63FF"></i>
      <div class="modal-title" style="margin-top:8px">Add a kid device</div>
      <p style="font-size:0.88rem;color:var(--muted);margin:8px 0 16px;line-height:1.5">On the kid's device, open GemSprout, tap <strong>I'm a Kid</strong>, then scan this QR code or type the code below.</p>
    </div>
    <div style="display:flex;justify-content:center;margin-bottom:14px">
      <div id="qr-code-container" style="width:200px;height:200px;display:flex;align-items:center;justify-content:center;background:#fff;border:1px solid rgba(76,29,149,0.08);border-radius:18px;box-shadow:inset 0 1px 0 rgba(255,255,255,0.8)"></div>
    </div>
    <div style="text-align:center;font-size:1.8rem;font-weight:900;letter-spacing:0.2em;color:#4C1D95;font-family:monospace;margin-bottom:16px">${code}</div>
    <button class="btn btn-secondary" style="width:100%" onclick="showFamilyCodeModal(null, { replace: true })">Done</button>`;
  if (opts.replace) replaceQuickActionModal(modalHtml, 'quick-action-modal-wide');
  else showQuickActionModal(modalHtml, 'quick-action-modal-wide');
  setTimeout(() => {
    const el = document.getElementById('qr-code-container');
    if (!el) return;
    if (typeof QRCode !== 'undefined') {
      new QRCode(el, { text: code, width: 200, height: 200, colorDark: '#4C1D95', colorLight: '#FFFFFF', correctLevel: QRCode.CorrectLevel.H });
    } else {
      el.innerHTML = `<div style="font-size:0.82rem;color:var(--muted)">QR unavailable - use the code above</div>`;
    }
  }, 50);
}

function showInviteParent(testMode = false, triggerEl = null, opts = {}) {
  const rect = triggerEl?.getBoundingClientRect?.();
  if (!opts.replace && rect) _modalLaunchOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  const cancelAction = opts.replace
    ? `showFamilyCodeModal(null, { replace: true })`
    : `closeModal()`;
  const modalHtml = `
    <div style="text-align:center;padding:4px 0 8px">
      <i class="ph-duotone ph-user-plus" style="font-size:2.5rem;color:#6C63FF"></i>
      <div class="modal-title" style="margin-top:8px">${testMode ? 'Test: Invite a Parent' : 'Add a parent'}</div>
      <p style="font-size:0.88rem;color:var(--muted);margin:8px 0 16px;line-height:1.5">${testMode
        ? 'Enter any fake email. After submitting you\'ll get a button to go to the welcome screen and test the sign-in.'
        : 'Enter the email they\'ll use to sign in with Google or Apple. No email will be sent; just have them open GemSprout and sign in with this account.'}</p>
    </div>
    <div id="invite-modal-body" style="min-height:210px;display:flex;flex-direction:column">
      <input id="invite-email-input" type="email" placeholder="${testMode ? 'faketest@email.com' : 'partner@email.com'}" autocomplete="${testMode ? 'off' : 'email'}"
        style="width:100%;box-sizing:border-box;padding:12px 14px;border:1.5px solid #E5E7EB;border-radius:10px;font-size:1rem;margin-bottom:16px;outline:none">
      <div style="margin-top:auto">
        <button class="btn btn-primary" style="width:100%" onclick="_submitParentInvite(${testMode})">
          <i class="ph-duotone ph-user-plus" style="vertical-align:middle;margin-right:6px"></i> ${testMode ? 'Save Test Invite' : 'Add parent'}
        </button>
        <button class="btn btn-secondary" style="width:100%;margin-top:8px" onclick="${cancelAction}">Cancel</button>
      </div>
    </div>`;
  if (opts.replace) replaceQuickActionModal(modalHtml, 'quick-action-modal-wide');
  else showQuickActionModal(modalHtml, 'quick-action-modal-wide');
  setTimeout(() => document.getElementById('invite-email-input')?.focus(), 100);
}

async function _submitParentInvite(testMode = false) {
  if (S._testOnboarding?.active) {
    toast('Parent invites are disabled during onboarding preview');
    return;
  }
  const email = (document.getElementById('invite-email-input')?.value || '').trim().toLowerCase();
  if (!email || !email.includes('@')) { toast('Enter a valid email address'); return; }
  const btn = document.querySelector('#invite-modal-body .btn-primary');
  if (btn) { btn.disabled = true; btn.innerHTML = 'Saving...'; }
  try {
    await db.collection('invites').add({
      email,
      familyCode: getFamilyCode(),
      createdAt: Date.now(),
      createdByMemberId: S.currentUser?.id || '',
      used: false
    });
    const body = document.getElementById('invite-modal-body');
    if (!body) return;
    if (testMode) {
      body.innerHTML = `
        <div style="text-align:center;padding:8px 0">
          <i class="ph-duotone ph-check-circle" style="font-size:2rem;color:var(--green)"></i>
          <div style="font-weight:700;margin:8px 0 4px">Invite saved for <span style="color:#6C63FF">${esc(email)}</span></div>
          <div style="font-size:0.85rem;color:var(--muted);margin-bottom:16px">Now tap below to go to the welcome screen, hit Sign In, and type this email in the Dev box.</div>
          <button class="btn btn-primary" style="width:100%" onclick="closeModal();closeSettings();showScreen('screen-setup');renderSetupGate()">
            Go to Welcome Screen
          </button>
        </div>`;
    } else {
      body.innerHTML = `
        <div style="text-align:center;padding:8px 0">
          <i class="ph-duotone ph-check-circle" style="font-size:2rem;color:var(--green)"></i>
          <div style="font-weight:700;margin:8px 0 4px">All set!</div>
          <div style="font-size:0.85rem;color:var(--muted);margin-bottom:16px"><strong>${esc(email)}</strong> is ready. Have them open GemSprout and sign in with this account to join your family automatically.</div>
          <button class="btn btn-secondary" style="width:100%" onclick="closeModal()">Done</button>
        </div>`;
    }
  } catch(e) {
    toast('Something went wrong - please try again');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ph-duotone ph-user-plus" style="vertical-align:middle;margin-right:6px"></i> ' + (testMode ? 'Save Test Invite' : 'Add parent'); }
  }
}

function cancelSetup() {
  S._setupBiometricDecisionRequired = false;
  S._setupBiometricOfferAnswered = false;
  if (_exitTestOnboarding('Onboarding preview closed - nothing was saved.')) return;
  const user = S.currentUser;
  if (user) routeToView(user);
  else renderHome();
}

function _cloneOnboardingTestState(value) {
  try { return JSON.parse(JSON.stringify(value)); }
  catch { return null; }
}

function startTestOnboarding() {
  if (S._testOnboarding?.active) return;
  S._testOnboarding = {
    active: true,
    snapshotD: _cloneOnboardingTestState(D),
    snapshotCurrentUserId: getCurrentUserId(),
    snapshotKidTab: S.kidTab,
    snapshotParentTab: S.parentTab,
  };
  closeSettings();
  showScreen('screen-setup');
  renderSetupGate();
}

function _exitTestOnboarding(message = '') {
  const test = S._testOnboarding;
  if (!test?.active) return false;
  S._testOnboarding = null;
  D = normalizeData(test.snapshotD || defaultData());
  S.setupStep = 0;
  S.setupMembers = [];
  S.setupParents = [];
  S.kidTab = test.snapshotKidTab || 'chores';
  S.parentTab = test.snapshotParentTab || 'home';
  const userId = test.snapshotCurrentUserId || '';
  setCurrentUserId(userId);
  S.currentUser = userId ? getMember(userId) : null;
  if (S.currentUser) routeToView(S.currentUser);
  else renderHome();
  if (message) toast(message);
  return true;
}

function goSetup(opts = {}) {
  S._setupBiometricDecisionRequired = false;
  S._setupBiometricOfferAnswered = false;
  const testMode = !!opts.testMode;
  if (!testMode && S._testOnboarding?.active) S._testOnboarding = null;
  if (testMode) {
    D = normalizeData(defaultData());
    D.family.name = '';
  } else {
    loadData();
  }
  SETUP_STEPS    = (!testMode && D.setup) ? SETUP_STEPS_EDIT : SETUP_STEPS_NEW;
  S.setupStep    = 0;
  S.setupParents = D.family.members
    .filter(m => m.role === 'parent')
    .map(m => ({...m}));
  if (S.setupParents.length === 0) {
    S.setupParents = [{ id:genId(), name: S.newFamilyDisplayName || '', avatar:'<i class="ph-duotone ph-user-circle" style="color:#6C63FF"></i>', color:'#6C63FF', role:'parent', gems:0, savings:0, totalEarned:0, birthday:'' }];
  }
  // All non-parent members in one unified list
  S.setupMembers = D.family.members
    .filter(m => m.role !== 'parent' && !m.deleted)
    .map(m => ({...m}));
  // New setup: pre-populate one blank kid so the form is ready immediately
  if (!D.setup && S.setupMembers.length === 0) {
    S.setupMembers.push({ id:genId(), name:'', age:null, avatar:'<i class="ph-duotone ph-smiley" style="color:#F59E0B"></i>', color:COLORS[0], displayMode:'regular', role:'kid', gems:0, savings:0, totalEarned:0, birthday:'' });
  }
  showScreen('screen-setup');
  renderSetupStep();
}

function renderSetupStep(opts = {}) {
  const preserveScroll = !!opts.preserveScroll;
  const existingScreen = document.getElementById('screen-setup');
  const existingContent = document.getElementById('setup-content');
  const savedScreenScroll = preserveScroll ? (existingScreen?.scrollTop || 0) : 0;
  const savedContentScroll = preserveScroll ? (existingContent?.scrollTop || 0) : 0;
  const step  = S.setupStep;
  const total = SETUP_STEPS.length;
  const dots  = SETUP_STEPS.map((_,i) =>
    `<div class="step-dot ${i===step?'active':i<step?'done':''}"></div>`
  ).join('');

  let content = '';
  switch(SETUP_STEPS[step]) {

    case 'welcome': content = `
      <div class="setup-top">
        <div class="setup-emoji"><i class="ph-duotone ph-house" style="color:#6C63FF;font-size:3rem"></i></div>
        <div class="setup-title">${S._testOnboarding?.active ? 'Test Onboarding' : D.setup ? 'Edit Family' : 'Welcome to GemSprout'}</div>
        <div class="setup-sub">${S._testOnboarding?.active ? 'Preview the full onboarding flow. Nothing you do here will be saved.' : D.setup ? 'Update your family profiles.' : "Let's build your family growth space in just a few steps."}</div>
      </div>
      <div class="form-group">
        <label class="form-label">Family name</label>
        <input type="text" id="setup-family-name" placeholder="The Smiths" value="${esc(D.family.name||'')}">
      </div>
      ${D.setup || S._testOnboarding?.active ? `
      <div class="flex gap-10 mt-8">
        <button class="btn btn-secondary" style="flex:0 0 80px" onclick="cancelSetup()">Cancel</button>
        <button class="btn btn-primary" style="flex:1" onclick="setupNext()">Let's go</button>
      </div>` : `
      <div class="flex gap-10 mt-8">
        <button class="btn btn-secondary" style="flex:0 0 80px" onclick="renderSetupGate()"><i class="ph-duotone ph-arrow-left" style="font-size:0.95rem;vertical-align:middle"></i> Back</button>
        <button class="btn btn-primary" style="flex:1" onclick="setupNext()">Let's go</button>
      </div>`}`;
      break;

    case 'parents': content = `
      <div class="setup-top" style="padding-top:20px">
        <div class="setup-emoji"><i class="ph-duotone ph-shield-star" style="color:#6C63FF;font-size:3rem"></i></div>
        <div class="setup-title">Your Profile</div>
        <div class="setup-sub">Setup your parent profile, and invite a second parent if you'd like. A second parent can always be added later in Settings.</div>
      </div>
      <div id="parents-list">${S.setupParents.map((p,i)=>parentSetupCard(p,i)).join('')}</div>
      <button class="btn btn-secondary btn-full mt-8" onclick="showInviteParent(false, this)" style="margin-bottom:14px">
        <i class="ph-duotone ph-user-plus" style="vertical-align:middle;margin-right:6px"></i> Invite a Parent
      </button>
      <div class="flex gap-10 mt-8">
        <button class="btn btn-secondary" style="flex:0 0 80px" onclick="setupBack()"><i class="ph-duotone ph-arrow-left" style="font-size:0.95rem;vertical-align:middle"></i> Back</button>
        <button class="btn btn-primary" style="flex:1" onclick="setupNext()">Next</button>
      </div>`;
      break;

    case 'members': content = `
      <div class="setup-top" style="padding-top:20px">
        <div class="setup-emoji"><i class="ph-duotone ph-users-three" style="color:#6C63FF;font-size:3rem"></i></div>
        <div class="setup-title">Kids</div>
        <div class="setup-sub">Add the kids who will be using GemSprout.</div>
      </div>
      <div id="members-list">${S.setupMembers.map((m,i)=>memberSetupCard(m,i)).join('')}</div>
      <button class="btn btn-secondary btn-full mt-8" onclick="addMemberCard()" style="margin-bottom:14px">+ Add a kid</button>
      <div class="flex gap-10 mt-8">
        <button class="btn btn-secondary" style="flex:0 0 80px" onclick="setupBack()"><i class="ph-duotone ph-arrow-left" style="font-size:0.95rem;vertical-align:middle"></i> Back</button>
        <button class="btn btn-primary" style="flex:1" onclick="setupNext()">${SETUP_STEPS === SETUP_STEPS_EDIT ? 'Finish!' : 'Next'}</button>
      </div>`;
      break;

    case 'chores': content = `
      <div class="setup-top" style="padding-top:20px">
        <div class="setup-emoji"><i class="ph-duotone ph-clipboard-text" style="color:#6C63FF;font-size:3rem"></i></div>
        <div class="setup-title">Starter Tasks</div>
        <div class="setup-sub">Get started with a few ready-made tasks. Everything can be customized later from your parent dashboard.</div>
      </div>
      <div id="chore-checks">
        ${DEFAULT_CHORES.slice().sort((a,b)=>((a.gems ?? a.diamonds ?? 0) - (b.gems ?? b.diamonds ?? 0)) || (a.title || '').localeCompare(b.title || '')).map((c,i) => `
          <label class="chore-checkbox-row">
            <input type="checkbox" id="sc${i}" ${D.setup&&D.chores.find(x=>x.title===c.title)?'checked':!D.setup?'checked':''}>
            <span class="chore-checkbox-icon">${renderIcon(c.icon, c.iconColor, 'font-size:1.4rem')}</span>
            <span class="chore-checkbox-label">${c.title}</span>
            <span class="chore-checkbox-dmds">${fmtDmds(c.gems ?? c.diamonds)} / ${c.frequency}</span>
          </label>`).join('')}
      </div>
      <div class="flex gap-10 mt-8">
        <button class="btn btn-secondary" style="flex:0 0 80px" onclick="setupBack()"><i class="ph-duotone ph-arrow-left" style="font-size:0.95rem;vertical-align:middle"></i> Back</button>
        <button class="btn btn-primary" style="flex:1" onclick="setupNext()">${SETUP_STEPS === SETUP_STEPS_EDIT ? 'Finish!' : 'Next'}</button>
      </div>`;
      break;

    case 'prizes': content = `
      <div class="setup-top" style="padding-top:20px">
        <div class="setup-emoji"><i class="ph-duotone ph-gift" style="color:#FF6584;font-size:3rem"></i></div>
        <div class="setup-title">Rewards & Motivation</div>
        <div class="setup-sub">Choose a few starter rewards. These can be customized later as well.</div>
      </div>
      <div id="prize-checks">
        ${DEFAULT_PRIZES.slice().sort((a,b)=>(a.cost || 0) - (b.cost || 0) || (a.title || '').localeCompare(b.title || '')).map((p,i) => `
          <label class="chore-checkbox-row">
            <input type="checkbox" id="sp${i}" ${D.setup&&D.prizes.find(x=>x.title===p.title)?'checked':!D.setup?'checked':''}>
            <span class="chore-checkbox-icon">${renderIcon(p.icon,p.iconColor)}</span>
            <span class="chore-checkbox-label">${p.title}</span>
            <span class="chore-checkbox-dmds">${p.cost} gems &middot; ${p.type}</span>
          </label>`).join('')}
      </div>
      <div class="flex gap-10 mt-8">
        <button class="btn btn-secondary" style="flex:0 0 80px" onclick="setupBack()"><i class="ph-duotone ph-arrow-left" style="font-size:0.95rem;vertical-align:middle"></i> Back</button>
        <button class="btn btn-primary" style="flex:1" onclick="setupNext()">Next</button>
      </div>`;
      break;

    case 'appSettings': {
      content = `
      <div class="setup-top" style="padding-top:20px">
        <div class="setup-emoji"><i class="ph-duotone ph-gear-six" style="color:#6C63FF;font-size:3rem"></i></div>
        <div class="setup-title">Family Settings</div>
        <div class="setup-sub">Tune approvals, notifications, and protections for your household. You can change these any time.</div>
      </div>
      <div class="form-group" id="setup-pin-group" style="margin-bottom:0">
        <label class="form-label">Parent PIN <span class="form-label-hint">(required)</span></label>
        <div style="font-size:0.78rem;color:var(--muted);margin-bottom:6px">Protects the parent dashboard and family account settings.</div>
        <input type="password" id="setup-pin" maxlength="4" placeholder="4 digits" inputmode="numeric" pattern="[0-9]*" oninput="handleSetupPinInput(this)" value="${esc(D.settings.parentPin||'')}">
        <div id="setup-pin-error" style="display:block;min-height:20px;color:var(--pink);font-size:0.8rem;line-height:1.2;margin-top:5px;visibility:hidden"></div>
      </div>
      <div class="section-row" style="margin-top:0"><span class="section-title"><i class="ph-duotone ph-sliders" style="color:#6C63FF;font-size:1rem;vertical-align:middle"></i> General</span></div>
      <div class="card">
        <div class="toggle-row">
          <div><div class="toggle-label">Auto-approve tasks</div>
            <div class="toggle-sub">Kids earn gems instantly without parent approval</div></div>
          <label class="toggle"><input type="checkbox" id="setup-auto-approve" ${D.settings.autoApprove?'checked':''}><span class="toggle-track"></span></label>
        </div>
        <div class="toggle-row">
          <div><div class="toggle-label">Hide unavailable tasks</div>
            <div class="toggle-sub">Tasks outside their time window won't show on kids' screens</div></div>
          <label class="toggle"><input type="checkbox" id="setup-hide-unavailable" ${D.settings.hideUnavailable?'checked':''}><span class="toggle-track"></span></label>
        </div>
        <div class="form-group mb-0">
          <label class="form-label">Family timezone</label>
          <select id="setup-timezone" style="width:100%">
            ${(Intl.supportedValuesOf?.('timeZone') ?? [D.settings.familyTimezone]).map(tz =>
              `<option value="${tz}" ${tz === (D.settings.familyTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone) ? 'selected' : ''}>${tz.replace(/_/g,' ')}</option>`
            ).join('')}
          </select>
          <div style="font-size:0.78rem;color:var(--muted);margin-top:4px">This will be used to determine "today" for tasks and streaks when family members are in different time zones</div>
        </div>
      </div>
      <div class="section-row" style="margin-top:14px"><span class="section-title"><i class="ph-duotone ph-device-mobile" style="color:#6C63FF;font-size:1rem;vertical-align:middle"></i> Push Notifications</span></div>
      <div class="card">
        <div class="toggle-row">
          <div><div class="toggle-label">Task approval requests</div>
            <div class="toggle-sub">Get notified when a kid marks a task complete and it needs your review</div></div>
          <label class="toggle"><input type="checkbox" id="setup-notify-chore" ${D.settings.notifyChoreApproval!==false?'checked':''}><span class="toggle-track"></span></label>
        </div>
        <div class="toggle-row" style="${D.settings.savingsEnabled===false?'opacity:0.4;pointer-events:none':''}">
          <div><div class="toggle-label">Savings spend requests</div>
            <div class="toggle-sub">${D.settings.savingsEnabled===false?'Enable Savings Banking to use this':'Get notified when a kid requests to spend from their savings'}</div></div>
          <label class="toggle"><input type="checkbox" id="setup-notify-spend" ${D.settings.notifySavingsSpend!==false?'checked':''} ${D.settings.savingsEnabled===false?'disabled':''}><span class="toggle-track"></span></label>
        </div>
      </div>
      <div class="flex gap-10" style="margin-top:16px">
        <button class="btn btn-secondary" style="flex:0 0 80px" onclick="setupBack()"><i class="ph-duotone ph-arrow-left" style="font-size:0.95rem;vertical-align:middle"></i> Back</button>
        <button class="btn btn-primary" style="flex:1" onclick="setupNext()">Finish! <i class="ph-duotone ph-confetti" style="font-size:0.95rem;vertical-align:middle"></i></button>
      </div>`;
      break;
    }

    case 'done': {
      const _fc = getFamilyCode();
      content = `
      <div style="text-align:center;padding:24px 20px 12px">
        <div style="font-size:4rem"><i class="ph-duotone ph-confetti" style="color:#F97316"></i></div>
        <div class="setup-title mt-8">You're all set!</div>
        <div class="setup-sub mt-4">Your family growth space is ready.</div>
      </div>

      <div class="card" style="margin-bottom:12px">
        <div style="font-size:0.82rem;font-weight:700;color:#6C63FF;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.05em"><i class="ph-duotone ph-smiley" style="vertical-align:middle;margin-right:4px"></i> Adding your kids</div>
        <p style="font-size:0.83rem;color:var(--muted);line-height:1.5;margin-bottom:10px">On each kid's device, open GemSprout and tap <strong>I'm a Kid</strong>. Next, enter your Family Code found below or scan the QR code found in <strong>Settings &middot; Add user</strong>.</p>
        <div style="display:flex;align-items:center;gap:12px">
          <div style="font-size:1.8rem;font-weight:900;letter-spacing:0.18em;color:#4C1D95;font-family:monospace;flex:1">${_fc}</div>
          <button class="btn btn-secondary btn-sm" onclick="navigator.clipboard.writeText('${_fc}').then(()=>toast('Code copied!'))">
            <i class="ph-duotone ph-copy" style="font-size:0.9rem;vertical-align:middle"></i> Copy
          </button>
        </div>
      </div>

      <div class="card" style="margin-bottom:12px">
        <div style="font-size:0.82rem;font-weight:700;color:#6C63FF;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em"><i class="ph-duotone ph-user-plus" style="vertical-align:middle;margin-right:4px"></i> Adding your partner</div>
        <p style="font-size:0.83rem;color:var(--muted);line-height:1.5">Have them install GemSprout and sign in with the same account that you invited during setup. If you still need to invite them, go to <strong>Settings &middot; Add user &middot; Invite a parent</strong>.</p>
      </div>

      ${RC.betaMode ? `<div class="card" style="margin-bottom:20px">
        <div style="font-size:0.82rem;font-weight:700;color:#6C63FF;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em"><i class="ph-duotone ph-device-mobile" style="vertical-align:middle;margin-right:4px"></i> Get the app</div>
        <p style="font-size:0.83rem;color:var(--muted);line-height:1.5;margin-bottom:8px">Install GemSprout on each family member's device to get everyone connected.</p>
        <a href="${RC.appDownloadUrl}" target="_blank" style="font-size:0.84rem;font-weight:700;color:#6C63FF;text-decoration:none;word-break:break-all">${RC.appDownloadUrl}</a>
      </div>` : ''}

      <button class="btn btn-primary btn-full" onclick="finishSetup()">${S._testOnboarding?.active ? 'Exit Preview' : "Let's go!"}</button>`;
      break;
    }
  }

  document.getElementById('setup-content').innerHTML = `
    <div class="step-indicator" style="padding-top:16px">${dots}</div>
    <div class="setup-step active">${content}</div>`;
  const nextScreen = document.getElementById('screen-setup');
  const nextContent = document.getElementById('setup-content');
  const restore = () => {
    if (preserveScroll) {
      if (nextScreen) nextScreen.scrollTop = savedScreenScroll;
      if (nextContent) nextContent.scrollTop = savedContentScroll;
      return;
    }
    if (nextScreen) nextScreen.scrollTop = 0;
    if (nextContent) nextContent.scrollTop = 0;
    window.scrollTo(0, 0);
  };
  restore();
  if (preserveScroll) requestAnimationFrame(restore);
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function _setupCardDisplayName(kind, i, name) {
  const trimmed = String(name || '').trim();
  if (trimmed) return esc(trimmed);
  return kind === 'parent' ? 'Parent' : 'Kid';
}

function updateSetupCardPreview(kind, i, rawName) {
  const name = String(rawName || '');
  if (kind === 'parent' && S.setupParents[i]) S.setupParents[i].name = name;
  if (kind === 'member' && S.setupMembers[i]) S.setupMembers[i].name = name;
  const label = document.getElementById(`${kind}-card-label-${i}`);
  if (label) label.innerHTML = _setupCardDisplayName(kind, i, name);
}

function memberSetupCard(mem, i) {
  const avatarOpts = [
    `<div class="avatar-opt${'<i class="ph-duotone ph-leaf" style="color:#16A34A"></i>'===mem.avatar?' sel':''}" onclick="setMemberField(${i},'avatar','<i class=&quot;ph-duotone ph-leaf&quot; style=&quot;color:#16A34A&quot;></i>',true)"><i class="ph-duotone ph-leaf" style="color:#16A34A"></i></div>`,
    ...AVATARS.slice(0,23).map(a => {
      const encoded = encodeURIComponent(a);
      return `<div class="avatar-opt${a===mem.avatar?' sel':''}" onclick="setMemberField(${i},'avatar',decodeURIComponent('${encoded}'),true)">${a}</div>`;
    })
  ].join('');
  const profileColorSwatches = COLORS.map(c =>
    `<div class="color-swatch${c===mem.color?' sel':''}" style="background:${c}" onclick="setMemberField(${i},'color','${c}',true)"></div>`
  ).join('');
  const avatarColorSwatches = COLORS.map(c =>
    `<div class="color-swatch${c===(mem.avatarColor || mem.color)?' sel':''}" style="background:${c}" onclick="setMemberField(${i},'avatarColor','${c}',true)"></div>`
  ).join('');

  const dm = mem.displayMode || 'regular';
  const modes = [
    { id:'regular', icon:'<i class="ph-duotone ph-user" style="color:#6C63FF;font-size:1.1rem"></i>', label:'Big Kid',     sub:'Standard view' },
    { id:'tiny',    icon:'<i class="ph-duotone ph-star" style="color:#F97316;font-size:1.1rem"></i>', label:'Little Kid',  sub:'Larger icons & text-to-speech & no not-listening meter' },
  ];
  const modeOpts = modes.map(m =>
    `<div class="mode-opt${dm===m.id?' sel':''}" onclick="setMemberField(${i},'displayMode','${m.id}',true)">
      <span class="mode-opt-icon">${m.icon}</span>
      <span class="mode-opt-title">${m.label}</span>
      <span class="mode-opt-sub">${m.sub}</span>
    </div>`
  ).join('');

  // Birthday dropdowns
  const [bdMm, bdDd] = (mem.birthday||'').split('-');
  const monthSel = `<select id="bday-m-${i}" onchange="setMemberBday(${i})">
    <option value="">Month</option>
    ${MONTHS.map((mn,idx)=>`<option value="${String(idx+1).padStart(2,'0')}" ${bdMm===String(idx+1).padStart(2,'0')?'selected':''}>${mn}</option>`).join('')}
  </select>`;
  const daySel = `<select id="bday-d-${i}" onchange="setMemberBday(${i})">
    <option value="">Day</option>
    ${Array.from({length:31},(_,n)=>n+1).map(d=>`<option value="${String(d).padStart(2,'0')}" ${bdDd===String(d).padStart(2,'0')?'selected':''}>${d}</option>`).join('')}
  </select>`;

  return `
    <div class="kid-setup-card" id="member-card-${i}" style="--setup-accent:${mem.color || COLORS[0]}">
      <div class="kid-setup-card-header">
        <span class="setup-card-header-label" style="font-size:1.5rem;font-weight:700">
          <span class="setup-card-header-avatar">${renderAvatarHtml(mem.avatar,'<i class="ph-duotone ph-smiley" style="color:#9CA3AF"></i>', mem.avatarColor || mem.color)}</span>
          <span id="member-card-label-${i}">${_setupCardDisplayName('member', i, mem.name)}</span>
        </span>
        <button class="btn-icon-sm btn-icon-delete" onclick="removeMemberCard(${i})"><i class="ph-duotone ph-x" style="font-size:0.9rem"></i></button>
      </div>
      <div class="form-group mb-0">
        <label class="form-label">Name</label>
        <input type="text" id="mname-${i}" placeholder="Name" value="${esc(mem.name||'')}" oninput="updateSetupCardPreview('member',${i},this.value)">
      </div>
      <div class="form-group mt-8">
        <label class="form-label"><i class="ph-duotone ph-cake" style="color:#F97316;font-size:1rem;vertical-align:middle"></i> Birthday <span class="form-label-hint">for surprise animations!</span></label>
        <div class="input-row">${monthSel}${daySel}</div>
      </div>
      <div class="form-group" style="position:relative">
        <label class="form-label">Display Mode</label>
        <div class="display-mode-row">${modeOpts}</div>
      </div>
      ${dm === 'tiny' ? (() => {
        const voices = getEnglishVoices();
        if (!voices.length) return `
      <div class="form-group">
        <label class="form-label"><i class="ph-duotone ph-speaker-high" style="color:#6C63FF;font-size:1rem;vertical-align:middle"></i> Voice</label>
        <button class="btn btn-secondary btn-sm" onclick="window.speechSynthesis?.getVoices();renderSetupStep({ preserveScroll: true })">Load voice options</button>
      </div>`;
        const current = mem.ttsVoice || voices.find(v=>v.name==='Samantha')?.name || voices[0]?.name;
        const opts = voices.map(v => `<option value="${esc(v.name)}"${v.name===current?' selected':''}>${esc(v.name)}</option>`).join('');
        return `
      <div class="form-group">
        <label class="form-label"><i class="ph-duotone ph-speaker-high" style="color:#6C63FF;font-size:1rem;vertical-align:middle"></i> Voice</label>
        <div style="display:flex;gap:8px;align-items:center">
          <select id="voice-sel-${i}" style="flex:1" onchange="setMemberVoice(${i},this.value)">${opts}</select>
          <button class="btn btn-secondary btn-sm" style="flex-shrink:0" onclick="previewMemberVoice(${i})"><i class="ph-duotone ph-play" style="font-size:0.9rem;vertical-align:middle"></i> Preview</button>
        </div>
      </div>`;
      })() : ''}
      <div class="form-group mt-8">
        <label class="form-label">Avatar</label>
        <div class="avatar-grid">${avatarOpts}</div>
      </div>
      <div class="form-group" style="position:relative;padding-bottom:18px">
        <label class="form-label">Avatar Color</label>
        <div class="color-row">${avatarColorSwatches}</div>
      </div>
      <div class="form-group" style="position:relative;padding-bottom:18px">
        <label class="form-label">Profile Color</label>
        <div class="color-row">${profileColorSwatches}</div>
      </div>
    </div>`;
}

function parentSetupCard(p, i) {
  const avatarOpts = [
    `<div class="avatar-opt${'<i class="ph-duotone ph-leaf" style="color:#16A34A"></i>'===p.avatar?' sel':''}" onclick="setParentField(${i},'avatar','<i class=&quot;ph-duotone ph-leaf&quot; style=&quot;color:#16A34A&quot;></i>',true)"><i class="ph-duotone ph-leaf" style="color:#16A34A"></i></div>`,
    ...AVATARS.slice(0,23).map(a => {
      const encoded = encodeURIComponent(a);
      return `<div class="avatar-opt${a===p.avatar?' sel':''}" onclick="setParentField(${i},'avatar',decodeURIComponent('${encoded}'),true)">${a}</div>`;
    })
  ].join('');
  const profileColorSwatches = COLORS.map(c =>
    `<div class="color-swatch${c===p.color?' sel':''}" style="background:${c}" onclick="setParentField(${i},'color','${c}',true)"></div>`
  ).join('');
  const avatarColorSwatches = COLORS.map(c =>
    `<div class="color-swatch${c===(p.avatarColor || p.color)?' sel':''}" style="background:${c}" onclick="setParentField(${i},'avatarColor','${c}',true)"></div>`
  ).join('');
  const [bdMm, bdDd] = (p.birthday||'').split('-');
  const monthSel = `<select id="pbday-m-${i}" onchange="setParentBday(${i})">
    <option value="">Month</option>
    ${MONTHS.map((mn,idx)=>`<option value="${String(idx+1).padStart(2,'0')}" ${bdMm===String(idx+1).padStart(2,'0')?'selected':''}>${mn}</option>`).join('')}
  </select>`;
  const daySel = `<select id="pbday-d-${i}" onchange="setParentBday(${i})">
    <option value="">Day</option>
    ${Array.from({length:31},(_,n)=>n+1).map(d=>`<option value="${String(d).padStart(2,'0')}" ${bdDd===String(d).padStart(2,'0')?'selected':''}>${d}</option>`).join('')}
  </select>`;
  return `
    <div class="kid-setup-card" id="parent-card-${i}" style="--setup-accent:${p.color || COLORS[0]}">
      <div class="kid-setup-card-header">
        <span class="setup-card-header-label" style="font-size:1.5rem;font-weight:700">
          <span class="setup-card-header-avatar">${renderAvatarHtml(p.avatar,'<i class="ph-duotone ph-user-circle" style="color:#9CA3AF"></i>', p.avatarColor || p.color)}</span>
          <span id="parent-card-label-${i}">${_setupCardDisplayName('parent', i, p.name)}</span>
        </span>
        ${S.setupParents.length > 1 ? `<button class="btn-icon-sm btn-icon-delete" onclick="removeParentCard(${i})"><i class="ph-duotone ph-x" style="font-size:0.9rem"></i></button>` : ''}
      </div>
      <div class="form-group">
        <label class="form-label">Name</label>
        <input type="text" id="pname-${i}" placeholder="Name" value="${esc(p.name||'')}" oninput="updateSetupCardPreview('parent',${i},this.value)">
      </div>
      <div class="form-group">
        <label class="form-label"><i class="ph-duotone ph-cake" style="color:#F97316;font-size:1rem;vertical-align:middle"></i> Birthday <span class="form-label-hint">for surprise animations!</span></label>
        <div class="input-row">${monthSel}${daySel}</div>
      </div>
      <div class="form-group mt-8">
        <label class="form-label">Avatar</label>
        <div class="avatar-grid">${avatarOpts}</div>
      </div>
      <div class="form-group">
        <label class="form-label">Avatar Color</label>
        <div class="color-row">${avatarColorSwatches}</div>
      </div>
      <div class="form-group">
        <label class="form-label">Profile Color</label>
        <div class="color-row">${profileColorSwatches}</div>
      </div>
    </div>`;
}

// Unified member card helpers
function addMemberCard() {
  const defaults = AVATARS.slice(0, 6);
  const i = S.setupMembers.length;
  S.setupMembers.push({
    id: genId(), name:'', age:null,
    avatar: defaults[i % defaults.length],
    color:  COLORS[i % COLORS.length],
    avatarColor: COLORS[i % COLORS.length],
    displayMode: 'regular', role:'kid',
    gems:0, savings:0, totalEarned:0, birthday:'',
  });
  renderSetupStep({ preserveScroll: true });
}

function removeMemberCard(i) {
  showQuickActionModal(`
    <div class="modal-title">Remove Member?</div>
    <p style="margin:0 0 20px;color:var(--muted);font-size:0.95rem;line-height:1.5">This family member will be removed from setup.</p>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" onclick="closeModal();S.setupMembers.splice(${i},1);renderSetupStep({ preserveScroll: true })">Remove</button>
    </div>`, 'quick-action-modal-wide');
}

function setMemberField(i, field, value, rerender=false) {
  if (S.setupMembers[i]) {
    if (field === 'color' && !S.setupMembers[i].avatarColor) {
      S.setupMembers[i].avatarColor = S.setupMembers[i].color || COLORS[0];
    }
    S.setupMembers[i][field] = value;
  }
  if (rerender) {
    S.setupMembers.forEach((_, j) => {
      const ni = document.getElementById(`mname-${j}`);
      if (ni) S.setupMembers[j].name = ni.value;
    });
    renderSetupStep({ preserveScroll: true });
  }
}

function setMemberBday(i) {
  const mm = document.getElementById(`bday-m-${i}`)?.value;
  const dd = document.getElementById(`bday-d-${i}`)?.value;
  if (S.setupMembers[i]) S.setupMembers[i].birthday = (mm && dd) ? `${mm}-${dd}` : '';
}

function addParentCard() {
  const i = S.setupParents.length;
  const parentColors = ['#6C63FF','#FF6584','#43D9AD','#FF9A3C'];
  const parentAvatars = [
    '<i class="ph-duotone ph-user-circle" style="color:#6C63FF"></i>',
    '<i class="ph-duotone ph-user-circle" style="color:#FF6584"></i>',
    '<i class="ph-duotone ph-user-circle" style="color:#43D9AD"></i>',
    '<i class="ph-duotone ph-user-circle" style="color:#FF9A3C"></i>'
  ];
  S.setupParents.push({ id:genId(), name:'', avatar:parentAvatars[i % parentAvatars.length], color:parentColors[i % parentColors.length], avatarColor: parentColors[i % parentColors.length], role:'parent', gems:0, savings:0, totalEarned:0, birthday:'' });
  renderSetupStep({ preserveScroll: true });
}

function removeParentCard(i) {
  showQuickActionModal(`
    <div class="modal-title">Remove Parent?</div>
    <p style="margin:0 0 20px;color:var(--muted);font-size:0.95rem;line-height:1.5">This parent will be removed from setup.</p>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" onclick="closeModal();S.setupParents.splice(${i},1);renderSetupStep({ preserveScroll: true })">Remove</button>
    </div>`);
}

function setParentField(i, field, value, rerender=false) {
  if (S.setupParents[i]) {
    if (field === 'color' && !S.setupParents[i].avatarColor) {
      S.setupParents[i].avatarColor = S.setupParents[i].color || COLORS[0];
    }
    S.setupParents[i][field] = value;
  }
  if (rerender) {
    S.setupParents.forEach((_, j) => {
      const ni = document.getElementById(`pname-${j}`);
      if (ni) S.setupParents[j].name = ni.value;
    });
    renderSetupStep({ preserveScroll: true });
  }
}

function setParentBday(i) {
  const mm = document.getElementById(`pbday-m-${i}`)?.value;
  const dd = document.getElementById(`pbday-d-${i}`)?.value;
  if (S.setupParents[i]) S.setupParents[i].birthday = (mm && dd) ? `${mm}-${dd}` : '';
}

function setupNext() {
  const stepName = SETUP_STEPS[S.setupStep];

  if (stepName === 'welcome') {
    const name = document.getElementById('setup-family-name')?.value.trim();
    if (!name) { toast('Please enter a family name'); return; }
    D.family.name = name;
  }

  if (stepName === 'parents') {
    S.setupParents.forEach((p,i) => {
      const ni = document.getElementById(`pname-${i}`);
      if (ni) p.name = ni.value.trim();
      setParentBday(i);
    });
    if (S.setupParents.some(p=>!p.name)) { toast('Please give yourself a name'); return; }
  }

  if (stepName === 'members') {
    // Flush any still-pending form values before validating
    S.setupMembers.forEach((m,i) => {
      const ni = document.getElementById(`mname-${i}`);
      if (ni) m.name = ni.value.trim();
      setMemberBday(i); // flush birthday selects
    });
    if (S.setupMembers.length === 0) { toast('Add at least one family member'); return; }
    if (S.setupMembers.some(m=>!m.name)) { toast('Each family member needs a name'); return; }
  }

  if (stepName === 'chores') {
    const kidMembers = S.setupMembers;
    DEFAULT_CHORES.forEach((c,i) => {
      const cb = document.getElementById('sc'+i);
      if (cb && cb.checked && !D.chores.find(x=>x.title===c.title)) {
        const chore = normalizeChore({
          title: c.title,
          icon: c.icon,
          iconColor: c.iconColor,
          gems: c.gems,
          frequency: c.frequency,
          assignedTo: kidMembers.map(k=>k.id),
          completions: {},
          description: '',
        });
        chore.id = genId();
        D.chores.push(chore);
      }
    });
  }

  if (stepName === 'prizes') {
    DEFAULT_PRIZES.forEach((p,i) => {
      const cb = document.getElementById('sp'+i);
      if (cb && cb.checked && !D.prizes.find(x=>x.title===p.title)) {
        D.prizes.push({ id:genId(), title:p.title, icon:p.icon, cost:p.cost, type:p.type, redemptions:[] });
      }
    });
  }

  if (stepName === 'appSettings') {
    const pinEl = document.getElementById('setup-pin');
    const pin   = pinEl?.value.trim() || '';
    if (!/^\d{4}$/.test(pin)) {
      const err = document.getElementById('setup-pin-error');
      if (err) {
        err.textContent = 'Please enter a 4-digit pin. It must be all numbers.';
        err.style.visibility = 'visible';
      }
      pinEl?.focus();
      return;
    }
    const err = document.getElementById('setup-pin-error');
    if (err) {
      err.textContent = '';
      err.style.visibility = 'hidden';
    }
    D.settings.parentPin = pin;
    const autoEl = document.getElementById('setup-auto-approve');
    if (autoEl) D.settings.autoApprove = autoEl.checked;
    const hideEl = document.getElementById('setup-hide-unavailable');
    if (hideEl) D.settings.hideUnavailable = hideEl.checked;
    const tzEl = document.getElementById('setup-timezone');
    if (tzEl) D.settings.familyTimezone = tzEl.value;
    const notifyChoreEl = document.getElementById('setup-notify-chore');
    if (notifyChoreEl) D.settings.notifyChoreApproval = notifyChoreEl.checked;
    const notifySpendEl = document.getElementById('setup-notify-spend');
    if (notifySpendEl) D.settings.notifySavingsSpend = notifySpendEl.checked;
    // Request iOS notification permission if any push toggle is on
    if (isNative() && (D.settings.notifyChoreApproval !== false || D.settings.notifySavingsSpend !== false)) {
      try {
        const { FirebaseMessaging } = Capacitor.Plugins;
        if (FirebaseMessaging) FirebaseMessaging.requestPermissions().catch(() => {});
      } catch(e) {}
    }
    S.setupStep++;
    if (S.setupStep >= SETUP_STEPS.length) { finishSetup(); return; }
    renderSetupStep();
    return;
  }

  S.setupStep++;
  if (S.setupStep >= SETUP_STEPS.length) { finishSetup(); return; }
  renderSetupStep();
}

function setupBack() {
  if (S.setupStep > 0) { S.setupStep--; renderSetupStep(); }
}

function handleSetupPinInput(el) {
  if (!el) return;
  el.value = String(el.value || '').replace(/\D/g, '').slice(0, 4);
  const err = document.getElementById('setup-pin-error');
  if (err) {
    err.textContent = '';
    err.style.visibility = 'hidden';
  }
}

function finishSetup() {
  if (SETUP_STEPS !== SETUP_STEPS_EDIT && !S._setupBiometricOfferAnswered && isBiometricSupported() && (S._testOnboarding?.active || !getBiometricCredentialId())) {
    S._setupBiometricDecisionRequired = true;
    offerBiometricSetup(() => {
      S._setupBiometricDecisionRequired = false;
      S._setupBiometricOfferAnswered = true;
      finishSetup();
    });
    return;
  }
  S._setupBiometricDecisionRequired = false;
  S._setupBiometricOfferAnswered = false;
  if (_exitTestOnboarding('Onboarding preview finished - nothing was saved.')) return;
  const wasSetup = !!D.setup;
  const mergedParents = S.setupParents.map(p => {
    const existing = D.family.members.find(x=>x.id===p.id) || {};
    return { ...existing, ...p, role:'parent' };
  });

  // Derive role from displayMode, preserve existing gems/savings
  const mergedMembers = S.setupMembers.map(m => {
    const existing = D.family.members.find(x=>x.id===m.id) || {};
    const role = 'kid';
    return { ...existing, ...m, role };
  });

  const keptIds = new Set(S.setupMembers.map(m => m.id));
  const softDeleted = D.family.members
    .filter(m => m.role === 'kid' && !m.deleted && !keptIds.has(m.id))
    .map(m => ({ ...m, deleted: true }));
  D.family.members = [...mergedParents, ...mergedMembers, ...softDeleted];

  // Assign orphaned chores to all kid members
  const kidIds = mergedMembers.map(m=>m.id);
  D.chores.forEach(c => {
    if (!c.assignedTo || c.assignedTo.length === 0) c.assignedTo = kidIds;
  });

  if (!D.settings.familyTimezone) {
    D.settings.familyTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  }
  D.setup = true;
  if (S._newFamilyFirebaseUser && mergedParents[0]) {
    const setupUser = S._newFamilyFirebaseUser;
    linkParentAuth(setupUser, mergedParents[0].id);
    S._recentParentAuth = { uid: setupUser.uid, email: (setupUser.email || '').toLowerCase(), at: Date.now() };
    S._newFamilyFirebaseUser = null;
  }
  saveData();
  ensureFirestoreAuth().then(() => subscribeToFirestore());
  clearScrollMemory();
  resetPrimaryTabs();
  S._activeViewUserId = '';
  S._activeViewRole = '';
  S.currentUser = null;
  setCurrentUserId('');
  if (wasSetup) toast('Family updated');
  renderHome();
}

function esc(str) {
  return String(str||'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function renderKidView() {
  const m = S.currentUser;
  if (!m) return;
  const tiny = isTiny(m);
  const headerEl = document.getElementById('kid-header');
  const navEl = document.getElementById('kid-nav');

  showScreen('screen-kid');
  if (tiny) {
    document.getElementById('kid-content').className = 'main-content tiny-mode';
    ttsEnabled = true; // always on for tiny kids
  } else {
    document.getElementById('kid-content').className = 'main-content';
  }
  headerEl?.classList.toggle('tiny-kid-header', tiny);
  navEl?.classList.toggle('tiny-kid-nav', tiny);

  renderKidHeader();
  renderKidNav();
  renderKidTab();
  restoreCurrentScrollPosition(0);

  // Show interest claim modal once per session per kid
  if (!S._interestShown) S._interestShown = new Set();
  if (isInterestDay() && (m.savings || 0) > 0 && m.savingsInterestLastDate !== today() && !S._interestShown.has(m.id)) {
    S._interestShown.add(m.id);
    const s = D.settings;
    const rate = parseFloat(s.savingsInterestRate) || 5;
    const cur  = s.currency || '$';
    const interest = parseFloat((m.savings * rate / 100).toFixed(2));
    setTimeout(() => showCelebration({
      icon:     '<i class="ph-duotone ph-trend-up" style="color:#16A34A;font-size:3rem"></i>',
      title:    "It's Interest Day!",
      sub:      `Your savings grew ${rate}% - you earned <strong>${cur}${interest.toFixed(2)}</strong>!`,
      dollars:  interest,
      cur,
      btnLabel: 'Claim Interest',
      onClose:  () => { claimInterest(m.id); renderKidView(); },
    }), 600);
  }
}

function renderKidHeader() {
  const m = S.currentUser;
  if (!m) return;
  const tiny = isTiny(m);
  const dmds = m.gems || 0;
  normalizeMember(m);
  const myChores = D.chores.filter(c => c.assignedTo?.includes(m.id)).sort((a,b) => (a.diamonds||0)-(b.diamonds||0) || (a.title||'').localeCompare(b.title||''));
  const progressMap = new Map(myChores.map(chore => [chore.id, getChoreProgress(chore, m.id)]));
  const totalUnits = myChores.reduce((sum, chore) => sum + (progressMap.get(chore.id)?.targetCount || 0), 0);
  const doneUnits = myChores.reduce((sum, chore) => sum + (progressMap.get(chore.id)?.doneCount || 0), 0);
  const routineLabel = totalUnits > 0
    ? `${doneUnits} / ${totalUnits} tasks in today's rhythm`
    : 'No tasks in today\'s rhythm';
  const headerTts = totalUnits > 0
    ? `Hi ${m.name}. You have ${dmds} gems, and ${doneUnits} out of ${totalUnits} tasks complete today.`
    : `Hi ${m.name}. You have ${dmds} gems and no tasks in today's rhythm yet.`;
  document.getElementById('kid-header').innerHTML = `
    <div class="header-left"${tiny ? ` onclick="speak('${headerTts.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}')"` : ''}>
      <span class="header-avatar" onclick="kidAvatarEasterEgg(event)" style="cursor:pointer">${renderMemberAvatarHtml(m)}</span>
      <div>
        <div class="header-name">Hi, ${esc(m.name)}!</div>
        <div class="header-sub"><i class="ph-duotone ph-check-square-offset" style="color:#1D6B57;font-size:0.85rem;vertical-align:middle"></i> ${routineLabel}</div>
      </div>
    </div>
    <div class="header-actions">
      <div class="header-badge"${tiny ? ` onclick="speak('You have ${dmds} gems.')"` : ''}><i class="ph-duotone ph-diamond" style="color:#7C3AED;font-size:0.95rem;vertical-align:middle"></i> ${dmds}</div>
      <button class="btn-icon-sm" style="background:#F3F4F6" onclick="${tiny ? `speak('Settings');` : ''}openUserSettings()" title="Settings"><i class="ph-duotone ph-gear-six" style="color:#6C63FF;font-size:1.15rem"></i></button>
    </div>`;
}

function renderKidNav() {
  const tabs = [
    ['chores',  ICONS.chores,  'Rhythm'],
    ['diamonds', ICONS.diamond, 'Gems'],
    ['shop',    ICONS.shop,    'Shop'],
    ['team',    ICONS.team,    'Team'],
    ['stats',   ICONS.stats,   'Stats'],
  ];
  document.getElementById('kid-nav').innerHTML = tabs.map(([id,icon,label]) => `
    <button class="nav-item${S.kidTab===id?' active':''}" onclick="switchKidTab('${id}')">
      <span class="nav-icon">${icon}</span>${label}
    </button>`).join('');
}

function switchKidTab(tab) {
  rememberCurrentScrollPosition();
  const prevTab = S.kidTab;
  S.kidTab = tab;
  if (tab !== 'chores' || prevTab !== 'chores') {
    S._kidRoutineHintBounceShown = false;
  }
  renderKidNav();
  renderKidTab();
  restoreCurrentScrollPosition(0);
  const m = S.currentUser;
  if (!m || !isTiny(m)) return;
  const dmds = m.gems || 0;
  if (tab === 'chores') {
    const myChores = D.chores.filter(c => c.assignedTo?.includes(m.id)).sort((a,b) => (a.gems||0)-(b.gems||0) || (a.title||'').localeCompare(b.title||''));
    const progressMap = new Map(myChores.map(c => [c.id, getChoreProgress(c, m.id)]));
    const totalUnits = myChores.reduce((sum, c) => sum + (progressMap.get(c.id)?.targetCount || 0), 0);
    const doneUnits  = myChores.reduce((sum, c) => sum + (progressMap.get(c.id)?.doneCount  || 0), 0);
    const total = totalUnits || myChores.length;
    speak(`Let's look at your rhythm. Today you have completed ${doneUnits} out of ${total} tasks.`);
  } else if (tab === 'diamonds') {
    const { current: lvl } = getMemberLevel(m);
    const streak = m.streak?.current || 0;
    speak(`You currently have ${dmds} gems, you are level ${lvl.level}, and have a ${streak} day streak.`);
  } else if (tab === 'shop') {
    const affordable = D.prizes.filter(p => p.type === 'individual' && (p.cost || 0) <= dmds).length;
    speak(`You have ${dmds} gems to spend and can afford ${affordable} prize${affordable === 1 ? '' : 's'}.`);
  } else if (tab === 'team') {
    speak('Spend your gems towards team prizes.');
  } else if (tab === 'stats') {
    speak('Good job! Here\'s everything you\'ve accomplished.');
  }
}


function renderKidTab() {
  try {
  document.getElementById('kid-content')?.classList.remove('stats-page-content');
  switch(S.kidTab) {
    case 'chores': renderKidChores(); break;
    case 'diamonds': renderKidDiamonds(); break;
    case 'shop':   renderKidShop();   break;
    case 'team':   renderKidTeam();   break;
    case 'stats':  renderStatsPage(document.getElementById('kid-content')); break;
  }
  } catch(e) {
    console.error('renderKidTab error:', e);
    const el = document.getElementById('kid-content');
    if (el) el.innerHTML = `<div class="card" style="border:2px solid #EF4444;color:#EF4444;padding:1rem">Something went wrong. Please try again or ask a parent.</div>`;
  }
}

function renderKidChores() {
  const m = S.currentUser;
  const myChores = D.chores.filter(c => c.assignedTo?.includes(m.id)).sort((a,b) => (a.diamonds||0)-(b.diamonds||0) || (a.title||'').localeCompare(b.title||''));

  if (myChores.length === 0) {
    document.getElementById('kid-content').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon"><i class="ph-duotone ph-confetti" style="color:#F97316;font-size:3rem"></i></div>
        <div class="empty-text">No rhythms assigned yet. Ask a parent to add some.</div>
      </div>`;
    return;
  }

  const progressMap = new Map(myChores.map(chore => [chore.id, getChoreProgress(chore, m.id)]));
  const done        = myChores.filter(c => progressMap.get(c.id)?.status === 'done');
  const awaiting    = myChores.filter(c => progressMap.get(c.id)?.status === 'pending');
  const partial     = myChores.filter(c => progressMap.get(c.id)?.status === 'partial');
  const todo        = myChores.filter(c => progressMap.get(c.id)?.status === 'none');
  const unavailable = myChores.filter(c => progressMap.get(c.id)?.status === 'unavailable');

  const totalUnits  = myChores.reduce((sum, chore) => sum + (progressMap.get(chore.id)?.targetCount || 0), 0);
  const doneUnits   = myChores.reduce((sum, chore) => sum + (progressMap.get(chore.id)?.doneCount || 0), 0);
  const totalPts    = myChores.reduce((sum, chore) => sum + ((progressMap.get(chore.id)?.targetCount || 0) * chore.diamonds), 0);
  const earnedPts   = myChores.reduce((sum, chore) => sum + ((progressMap.get(chore.id)?.doneCount || 0) * chore.diamonds), 0);
  const pct = totalPts > 0 ? Math.round(earnedPts / totalPts * 100) : 0;

  const comboIds  = D.settings.comboEnabled !== false ? new Set(getDailyCombo(m.id)) : new Set();
  const comboChores = [...comboIds].map(id => D.chores.find(c => c.id === id)).filter(Boolean);
  const comboCompleted = comboChores.filter(c => progressMap.get(c.id)?.status === 'done').length;
  const comboBonusAlreadyAwarded = m.comboBonusDate === today();

  const tiny = isTiny(m);
  const pickerChore = _snapshotTimePicker?.memberId === m.id ? myChores.find(c => c.id === _snapshotTimePicker.choreId) : null;
  const pickerHtml = pickerChore ? renderSnapshotTimePicker(pickerChore, m) : '';
  const todoVisible = D.settings.hideUnavailable
    ? todo.filter(c => progressMap.get(c.id)?.availableNow !== false)
    : todo;

  const _progressTts = `Today you've done ${doneUnits} out of ${totalUnits || myChores.length} tasks in your rhythm.`;
  const completedLabel = `${doneUnits} / ${totalUnits || myChores.length}`;
  const progressHeading = pct === 100
    ? 'Everything for today is wrapped up.'
    : todoVisible.length > 0
      ? `${todoVisible.length} task${todoVisible.length === 1 ? '' : 's'} ready right now.`
      : awaiting.length > 0
        ? 'You are waiting on a parent check-in.'
        : 'Your day is in motion.';
  const progressSupport = pct === 100
    ? 'Take a breath, check your gems, and enjoy the momentum.'
    : awaiting.length > 0
      ? `${awaiting.length} item${awaiting.length === 1 ? '' : 's'} already sent for review.`
      : 'Keep going. Every task you finish adds more gems.';
  let html = `
    <section class="kid-chores-hero${pct === 100 ? ' is-complete' : ''}"${tiny ? ` onclick="speak('${_progressTts.replace(/'/g,"\\'")}')"` : ''}>
      <div class="kid-chores-hero-copy">
        <div class="kid-chores-head">
          <div>
            <div class="kid-chores-eyebrow">Today</div>
            <div class="kid-chores-title-row">
              <h2 class="kid-chores-title">Your rhythm</h2>
            </div>
          </div>
          <div class="kid-chores-title-utility">
            <div class="kid-chores-avatar">${pct===100?'<i class="ph-duotone ph-seal-check" style="color:#e8c76a"></i>':renderMemberAvatarHtml(m, '<i class="ph-duotone ph-leaf" style="color:#e8c76a"></i>')}</div>
          </div>
        </div>
        <div class="kid-chores-progress-line">
          <span class="kid-chores-progress-value">${completedLabel}</span>
          <span class="kid-chores-progress-label">tasks complete</span>
        </div>
        <p class="kid-chores-lead">${progressHeading}</p>
        <p class="kid-chores-support">${progressSupport}</p>
        <div class="kid-chores-progress-shell" aria-label="${pct}% complete">
          <div class="kid-chores-progress-fill" style="width:${pct}%"></div>
        </div>
      </div>
      <div class="kid-chores-summary-grid">
        <div class="kid-chores-summary-card"${tiny ? ` onclick="event.stopPropagation();speak('${todoVisible.length} ready')"` : ''}>
          <span class="kid-chores-summary-label">Ready</span>
          <strong class="kid-chores-summary-value">${todoVisible.length}</strong>
        </div>
        <div class="kid-chores-summary-card"${tiny ? ` onclick="event.stopPropagation();speak('${awaiting.length} waiting')"` : ''}>
          <span class="kid-chores-summary-label">Waiting</span>
          <strong class="kid-chores-summary-value">${awaiting.length}</strong>
        </div>
        <div class="kid-chores-summary-card"${tiny ? ` onclick="event.stopPropagation();speak('${done.length} complete')"` : ''}>
          <span class="kid-chores-summary-label">Complete</span>
          <strong class="kid-chores-summary-value">${done.length}</strong>
        </div>
        <div class="kid-chores-summary-card"${tiny ? ` onclick="event.stopPropagation();speak('${earnedPts} gems')"` : ''}>
          <span class="kid-chores-summary-label">Gems</span>
          <strong class="kid-chores-summary-value">${earnedPts}</strong>
        </div>
      </div>
    </section>`;

  if (D.settings.comboEnabled !== false && comboChores.length >= 3) {
    const bonusPts = comboChores.reduce((s, c) => s + c.diamonds, 0);
    const _comboNames = comboChores.map(c => c.title);
    const _comboNameStr = _comboNames.slice(0,-1).join(', ') + ', and ' + _comboNames[_comboNames.length-1];
    const _comboTts = comboBonusAlreadyAwarded
      ? `Amazing! You completed the daily routine and earned bonus gems!`
      : `If you can finish ${_comboNameStr} today, you will earn double gems for all three tasks!`;
    html += `
      <div class="combo-banner"${tiny ? ` onclick="speak('${_comboTts.replace(/'/g,"\\'")}')"` : ''}>
        <div class="combo-banner-header">
          <div>
            <div class="combo-banner-title"><i class="ph-duotone ph-lightning" style="color:#F59E0B;font-size:1rem;vertical-align:middle"></i> Daily Combo ${comboBonusAlreadyAwarded ? 'Complete! <i class="ph-duotone ph-confetti" style="font-size:0.95rem;vertical-align:middle"></i>' : ''}</div>
            <div class="combo-banner-sub">${comboBonusAlreadyAwarded
              ? `You earned ${bonusPts} bonus gems today!`
              : `Complete all 3 for ${bonusPts} bonus gems`}</div>
          </div>
          <div class="combo-progress-badge ${comboCompleted >= 3 ? 'complete' : ''}" style="--combo-progress:${Math.min(100, Math.round((comboCompleted / 3) * 100))}%">
            <div class="combo-progress-badge-center">
              <strong>${comboCompleted}</strong>
              <span>/3</span>
            </div>
          </div>
        </div>
        <div class="combo-chore-list">
          ${comboChores.map(c => {
            const isDone = progressMap.get(c.id)?.status === 'done';
            return `<div class="combo-chore-item ${isDone ? 'done' : ''}">
              <span class="combo-chore-item-check">${isDone ? '<i class="ph-duotone ph-check-circle" style="color:#16A34A;font-size:1.1rem"></i>' : '<i class="ph-duotone ph-circle" style="color:#D1D5DB;font-size:1.1rem"></i>'}</span>
              <span>${renderIcon(c.icon, c.iconColor, 'font-size:1rem;vertical-align:middle')} <span class="combo-item-title">${esc(c.title)}</span></span>
              ${isDone
                ? `<span class="combo-task-reward combo-task-reward-done">${c.diamonds}</span>`
                : `<span class="combo-task-reward">${c.diamonds}</span>`}
            </div>`;
          }).join('')}
        </div>
      </div>`;
  }

  const renderStage = (title, icon, color, count, items, id, { emphasis = 'default', sub = '', bare = false } = {}) => {
    if (!items.length) return '';
    const countLabel = `${count} Task${count === 1 ? '' : 's'}`;
    return `<section class="routine-stage routine-stage-${emphasis}${bare ? ' routine-stage-bare' : ''}">
      <div class="routine-stage-head">
        <div>
          <div class="routine-stage-title"><i class="ph-duotone ${icon}" style="color:${color};font-size:1rem"></i> ${title}</div>
          ${sub ? `<div class="routine-stage-sub">${sub}</div>` : ''}
        </div>
        <div class="routine-stage-count">${countLabel}</div>
      </div>
      <div id="${id}" class="chore-stack">${items.map(c => normalChoreCard(c, m, progressMap.get(c.id), comboIds)).join('')}</div>
    </section>`;
  };

  html += renderStage('Open Now', 'ph-sun-horizon', '#1D6B57', todoVisible.length, todoVisible, 'sort-todo', {
    emphasis: 'primary',
    sub: todoVisible.length ? 'Start here first.' : '',
    bare: true
  });

  if (partial.length > 0) {
    html += renderStage('In Motion', 'ph-path', '#c96f3b', partial.length, partial, 'sort-partial', {
      emphasis: 'progress',
      sub: 'Already started, not finished yet.',
      bare: true
    });
  }

  html += renderStage('Waiting on Parent', 'ph-hourglass', '#6f8f99', awaiting.length, awaiting, 'sort-pending', {
    sub: 'Sent in and ready for a check.',
    bare: true
  });
  html += renderStage('Complete', 'ph-check-circle', '#5f8f63', done.length, done, 'sort-done', {
    sub: 'Done for today.',
    bare: true
  });

  if (!D.settings.hideUnavailable) {
    html += renderStage('Later Windows', 'ph-moon-stars', '#6b6d63', unavailable.length, unavailable, 'sort-unavail', {
      sub: 'These unlock later in the day.'
    });
  }

  document.getElementById('kid-content').innerHTML = `${html}${pickerHtml}<div class="tab-end-cap" aria-hidden="true"></div>`;
  if (!tiny && D.settings.tooltipBounceEnabled !== false && !S._kidRoutineHintBounceShown) {
    S._kidRoutineHintBounceShown = true;
    setTimeout(() => {
      const first = document.querySelector('.kid-routine-shell');
      if (!first) return;
      first.classList.remove('hint-bounce');
      first.classList.add('hint-bounce');
      setTimeout(() => first.classList.remove('hint-bounce'), 2200);
    }, 180);
  }

}

function kidRoutineRevealStatus(label, icon, extraClass = '') {
  return `<div class="snapshot-reveal-btn snapshot-reveal-btn-secondary kid-routine-reveal-status${extraClass ? ` ${extraClass}` : ''}"><i class="ph-duotone ${icon}"></i><span>${label}</span></div>`;
}

function kidRoutineTinyOrb(icon, tone = 'secondary', attrs = '', disabled = false) {
  if (disabled) {
    return `<span class="kid-routine-action-orb kid-routine-action-orb-${tone} is-static"${attrs}><i class="ph-duotone ${icon}"></i></span>`;
  }
  return `<button class="kid-routine-action-orb kid-routine-action-orb-${tone}" type="button"${attrs}><i class="ph-duotone ${icon}"></i></button>`;
}

function renderKidRoutineCardFrame(chore, member, statusClass, comboClass, bodyHtml, actionHtml, ttsAttr = '', revealToneClass = 'secondary') {
  const gemValue = chore.gems ?? chore.diamonds ?? 0;
  const tiny = isTiny(member);
  if (!tiny) {
    const swipeKey = `kid_routine_${member?.id || 'kid'}_${chore.id}`;
    return `
      <div class="snapshot-routine-shell kid-routine-shell" data-swipe-id="${swipeKey}">
        <div class="snapshot-routine-reveal snapshot-routine-reveal-${revealToneClass} kid-routine-reveal">${actionHtml}</div>
        <div class="snapshot-routine-card kid-routine-card ${statusClass}${comboClass}"${ttsAttr} onpointerdown="startSnapshotSwipe(event,'${swipeKey}')" onpointermove="moveSnapshotSwipe(event)" onpointerup="endSnapshotSwipe(event)" onpointercancel="cancelSnapshotSwipe()" onclick="return handleSnapshotCardTap(event,'${swipeKey}')">
          ${comboClass ? '<div class="snapshot-routine-combo-label">Combo</div>' : ''}
          <div class="snapshot-routine-top">
            <div class="snapshot-routine-main">
              <div class="snapshot-routine-title-row">
                <div class="kid-routine-copy">
                  <div class="snapshot-routine-title">${esc(chore.title)}</div>
                  <div class="kid-routine-body">
                    ${bodyHtml}
                  </div>
                </div>
                <div class="snapshot-routine-diamond-badge"><span class="snapshot-routine-glyph-main">${renderIcon(chore.icon, chore.iconColor)}</span><span class="snapshot-routine-glyph-badge">${gemValue}</span></div>
                <div class="snapshot-routine-utility">
                  <button class="snapshot-routine-swipe-hint" type="button" aria-label="Reveal action" onclick="event.stopPropagation();toggleSnapshotSwipe('${swipeKey}')">
                    <i class="ph-duotone ph-caret-double-left"></i>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }
  return `
    <div class="snapshot-routine-card kid-routine-card ${statusClass}${comboClass}"${ttsAttr}>
      ${comboClass ? '<div class="snapshot-routine-combo-label">Combo</div>' : ''}
      <div class="snapshot-routine-top">
        <div class="snapshot-routine-main">
          <div class="snapshot-routine-title-row">
            <div class="snapshot-routine-diamond-badge"><span class="snapshot-routine-glyph-main">${renderIcon(chore.icon, chore.iconColor)}</span><span class="snapshot-routine-glyph-badge">${gemValue}</span></div>
            <div class="kid-routine-copy">
              <div class="snapshot-routine-title">${esc(chore.title)}</div>
              <div class="kid-routine-body">
                ${bodyHtml}
              </div>
            </div>
            <div class="snapshot-routine-utility">${actionHtml || '<span class="kid-routine-action-orb-placeholder" aria-hidden="true"></span>'}</div>
          </div>
        </div>
      </div>
    </div>`;
}

function kidRoutineMetaRows(chore) {
  return parentChoreMetaSummary(chore)
    .split('\n')
    .filter(Boolean)
    .map(line => `<div class="chore-meta">${esc(line)}</div>`)
    .join('');
}

function normalChoreCard(chore, member, progress, comboIds = null) {
  const isCombo = comboIds?.has(chore.id) || false;
  const choreStatus = progress?.status || 'none';
  const comboClass = isCombo && choreStatus !== 'done' ? ' combo-chore' : '';
  const tiny = isTiny(member);
  const ttsText = `${chore.title}. Worth ${chore.diamonds} gems!`;
  const ttsAttr = tiny ? ` onclick="speak('${ttsText.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}');"` : '';

  // Slot mode: show per-slot rows inside the card
  if (progress?.isSlotMode) {
    const slotStatuses = progress.slotStatuses || [];

    // Single-slot: render exactly like a simple count card (no slot table)
    if (slotStatuses.length === 1) {
      const { slot, status: ss } = slotStatuses[0];
      let btnHtml = '';
      if (tiny) {
        if (ss === 'available') {
          btnHtml = kidRoutineTinyOrb(
            chore.requiresPhoto ? 'ph-camera' : 'ph-check-circle',
            'approve',
            ` onclick="event.stopPropagation();kidCompleteChore('${chore.id}',event,'${slot.id}')"`
          );
        } else if (ss === 'pending') {
          btnHtml = kidRoutineTinyOrb('ph-hourglass', 'secondary', '', true);
        } else if (ss !== 'done') {
          btnHtml = kidRoutineTinyOrb('ph-clock', 'secondary', '', true);
        } else {
          btnHtml = kidRoutineTinyOrb('ph-check-circle', 'done', '', true);
        }
      } else {
        const slotPickerOpen = _snapshotTimePicker?.memberId === member?.id && _snapshotTimePicker?.choreId === chore.id;
        btnHtml = `<button class="snapshot-reveal-btn snapshot-reveal-btn-secondary" type="button" title="View times" onpointerdown="return handleSnapshotTimesTrigger(event,'${chore.id}','${member.id}', this)" onclick="return false;"><i class="ph-duotone ph-clock"></i><span>${slotPickerOpen ? 'Close' : 'Times'}</span></button>`;
      }
      const cardStatus = ss === 'done' ? 'done' : ss === 'pending' ? 'pending' : ss === 'available' ? 'none' : 'unavailable';
      const bodyHtml = kidRoutineMetaRows(chore);
      return renderKidRoutineCardFrame(chore, member, cardStatus, comboClass, bodyHtml, btnHtml, ttsAttr, tiny && ss === 'available' ? 'approve' : 'secondary');
    }

    const slotsHtml = slotStatuses.map(({slot, status: ss}) => {
      const label = formatSlotLabel(slot);
      let slotBtn;
      if (ss === 'done')    slotBtn = `<span class="slot-status slot-done"><i class="ph-duotone ph-check-circle" style="color:#16A34A;font-size:1rem"></i></span>`;
      else if (ss === 'pending') slotBtn = `<span class="slot-status slot-pending"><i class="ph-duotone ph-hourglass" style="color:#3B82F6;font-size:1rem"></i></span>`;
      else if (ss === 'available') {
        const btnLabel = chore.requiresPhoto
          ? (tiny ? '<i class="ph-duotone ph-camera" style="font-size:1.5rem;vertical-align:middle"></i>' : '<i class="ph-duotone ph-camera" style="font-size:0.9rem;vertical-align:middle"></i> Photo')
          : (tiny ? '<i class="ph-duotone ph-check-circle" style="font-size:1.5rem;vertical-align:middle"></i>'  : '<i class="ph-duotone ph-check-circle" style="font-size:0.9rem;vertical-align:middle"></i> Done');
        slotBtn = `<button class="chore-btn chore-btn-do" onclick="kidCompleteChore('${chore.id}',event,'${slot.id}')">${btnLabel}</button>`;
      } else {
        const timeHint = slot.start ? formatTimeWindow({start:slot.start, end:slot.end}) : '';
        slotBtn = `<span class="slot-status slot-waiting" title="${timeHint}"><i class="ph-duotone ph-clock" style="color:#9CA3AF;font-size:1rem"></i></span>`;
      }
      return `<div class="chore-slot-row"><span class="chore-slot-label">${esc(label)}</span>${slotBtn}</div>`;
    }).join('');
    const slotPickerOpen = _snapshotTimePicker?.memberId === member?.id && _snapshotTimePicker?.choreId === chore.id;
    const bodyHtml = `
      ${kidRoutineMetaRows(chore)}
      ${tiny ? '' : ''}`;
    const revealHtml = tiny
      ? kidRoutineTinyOrb('ph-clock', 'secondary', ` onclick="event.stopPropagation();openSnapshotTimes('${chore.id}','${member.id}', this)"`)
      : `<button class="snapshot-reveal-btn snapshot-reveal-btn-secondary" type="button" title="View times" onpointerdown="return handleSnapshotTimesTrigger(event,'${chore.id}','${member.id}', this)" onclick="return false;"><i class="ph-duotone ph-clock"></i><span>${slotPickerOpen ? 'Close' : 'Times'}</span></button>`;
    return renderKidRoutineCardFrame(chore, member, progress.status, comboClass, bodyHtml, revealHtml, ttsAttr, 'secondary');
  }

  const photoPhase = getChorePhotoPhase(chore, member?.id);
  if (photoPhase) {
    return normalChoreCardPhoto(chore, member, progress, photoPhase, comboIds);
  }

  const status = choreStatus;
  const submitted = progress?.completedCount || 0;
  let btnHtml = '';
  if (progress?.canSubmit) {
    btnHtml = tiny
      ? kidRoutineTinyOrb('ph-check-circle', 'approve', ` onclick="event.stopPropagation();kidCompleteChore('${chore.id}',event)"`)
      : `<button class="snapshot-reveal-btn snapshot-reveal-btn-approve" type="button" title="Mark task done" onpointerdown="event.preventDefault();event.stopPropagation();kidCompleteChore('${chore.id}',event);return false;" onclick="return false;"><i class="ph-duotone ph-check-circle"></i><span>${submitted > 0 ? 'One more' : 'Done'}</span></button>`;
  } else if (status==='pending' || status==='partial') {
    btnHtml = tiny ? kidRoutineTinyOrb('ph-hourglass', 'secondary', '', true) : kidRoutineRevealStatus('Pending', 'ph-hourglass');
  } else if (status==='unavailable') {
    btnHtml = tiny ? kidRoutineTinyOrb('ph-clock', 'secondary', '', true) : kidRoutineRevealStatus('Later', 'ph-clock');
  } else {
    btnHtml = tiny ? kidRoutineTinyOrb('ph-check-circle', 'done', '', true) : kidRoutineRevealStatus('Done', 'ph-check-circle', 'is-done');
  }
  const bodyHtml = kidRoutineMetaRows(chore);
  return renderKidRoutineCardFrame(chore, member, status, comboClass, bodyHtml, btnHtml, ttsAttr, progress?.canSubmit ? 'approve' : 'secondary');
}

function normalChoreCardPhoto(chore, member, progress, photoPhase, comboIds = null) {
  const isCombo = comboIds?.has(chore.id) || false;
  const tiny = isTiny(member);
  const { phase } = photoPhase;
  let statusClass = 'none';
  let hintHtml = '';
  let btnHtml  = '';

  if (phase === 'needs_before') {
    statusClass = 'none';
    hintHtml = '';
    btnHtml  = tiny
      ? kidRoutineTinyOrb('ph-camera', 'approve', ` onclick="event.stopPropagation();speak('Let\\'s take a picture first! Tap on the camera.');kidCompleteChore('${chore.id}',event,null,'before')"`)
      : `<button class="snapshot-reveal-btn snapshot-reveal-btn-approve" type="button" title="Request with photo" onpointerdown="event.preventDefault();event.stopPropagation();kidCompleteChore('${chore.id}',event,null,'before');return false;" onclick="return false;"><i class="ph-duotone ph-camera"></i><span>Request</span></button>`;
  } else if (phase === 'before_pending') {
    statusClass = 'pending';
    hintHtml = `<div class="chore-meta" style="color:var(--yellow)"><i class="ph-duotone ph-hourglass" style="font-size:0.9rem;vertical-align:middle"></i> Waiting for parent to approve the start</div>`;
    btnHtml  = tiny ? kidRoutineTinyOrb('ph-hourglass', 'secondary', '', true) : kidRoutineRevealStatus('Awaiting OK', 'ph-hourglass');
  } else if (phase === 'needs_after') {
    statusClass = 'partial';
    hintHtml = '';
    btnHtml  = tiny
      ? kidRoutineTinyOrb('ph-camera', 'approve', ` onclick="event.stopPropagation();kidCompleteChore('${chore.id}',event,null,'after')"`)
      : `<button class="snapshot-reveal-btn snapshot-reveal-btn-approve" type="button" title="Submit done photo" onpointerdown="event.preventDefault();event.stopPropagation();kidCompleteChore('${chore.id}',event,null,'after');return false;" onclick="return false;"><i class="ph-duotone ph-camera"></i><span>Done</span></button>`;
  } else if (phase === 'after_pending') {
    statusClass = 'pending';
    hintHtml = `<div class="chore-meta" style="color:var(--yellow)"><i class="ph-duotone ph-hourglass" style="font-size:0.9rem;vertical-align:middle"></i> Waiting for parent to approve completion</div>`;
    btnHtml  = tiny ? kidRoutineTinyOrb('ph-hourglass', 'secondary', '', true) : kidRoutineRevealStatus('Pending', 'ph-hourglass');
  } else {
    statusClass = 'done';
    btnHtml = tiny ? kidRoutineTinyOrb('ph-check-circle', 'done', '', true) : kidRoutineRevealStatus('Done', 'ph-check-circle', 'is-done');
  }

  const comboClass = isCombo && statusClass !== 'done' ? ' combo-chore' : '';
  let ttsText;
  if (phase === 'needs_before') {
    ttsText = `${chore.title}. Take a before photo to start this chore!`;
  } else if (phase === 'before_pending') {
    ttsText = `${chore.title}. Waiting for your grown-up to say yes!`;
  } else if (phase === 'needs_after') {
    ttsText = `${chore.title}. You were approved! Do the chore, then take a done photo.`;
  } else if (phase === 'after_pending') {
    ttsText = `${chore.title}. Waiting for your grown-up to check your done photo.`;
  } else {
    ttsText = `${chore.title}. Done! You earned ${chore.gems} gems!`;
  }
  const ttsAttr = tiny ? ` onclick="speak('${ttsText.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}');"` : '';

  const bodyHtml = `
    ${kidRoutineMetaRows(chore)}
    ${hintHtml}`;
  return renderKidRoutineCardFrame(chore, member, statusClass, comboClass, bodyHtml, btnHtml, ttsAttr, (phase === 'needs_before' || phase === 'needs_after') ? 'approve' : 'secondary');
}

function tinyChoreCard(chore, member, progress) {
  return normalChoreCard(chore, member, progress);
}

// entryTypeOverride: 'before' | 'after' | null
// slotId: slot id for slot-mode chores
function kidCompleteChore(choreId, evt, slotId = null, entryTypeOverride = null) {
  evt && evt.stopPropagation();
  const m = S.currentUser;
  if (!m) return;
  const chore = D.chores.find(c=>c.id===choreId);
  if (!chore) return;

  // If photo mode is set (after or before_after), always go through photo capture
  if (chore.photoMode && chore.photoMode !== 'none') {
    const entryType = entryTypeOverride || (chore.photoMode === 'after' ? 'after' : 'before');
    showPhotoCapture(choreId, slotId, entryType);
    return;
  }

  const result = doCompleteChore(choreId, m.id, slotId);
  if (!result) return;
  if (result.error) {
    toast(result.error);
    if (isTiny(m)) speak(result.error);
    return;
  }
  choreCompleteReact(chore, m, result, evt);
}

function choreCompleteReact(chore, m, result, evt) {
  const tiny = isTiny(m);
  if (!result.approved) {
    showCelebration({
      icon:       renderIcon(chore?.icon, chore?.iconColor, 'font-size:3rem') || '<i class="ph-duotone ph-hourglass" style="color:#6C63FF;font-size:3rem"></i>',
      title:      'Nice work!',
      sub:        `"${esc(chore?.title||'Chore')}" is waiting for parent approval`,
      noAnimation: true,
      btnLabel:   'Got it!',
      tts:        tiny ? 'All done! Waiting for your grown-up to check!' : null,
      onClose:    () => { renderKidChores(); renderKidHeader(); renderKidNav(); },
    });
  } else {
    showCelebration({
      icon:     renderIcon(chore?.icon, chore?.iconColor, 'font-size:3rem') || '<i class="ph-duotone ph-confetti" style="color:#F97316;font-size:3rem"></i>',
      title:    'Amazing job! <i class="ph-duotone ph-confetti" style="color:#F97316"></i>',
      sub:      esc(chore?.title||'Chore'),
      diamonds: chore?.diamonds||0,
      tts:      tiny ? `Wow! You finished ${chore?.title}! You earned ${chore?.diamonds} gems! You are amazing!` : null,
      onClose:  () => { renderKidChores(); renderKidHeader(); renderKidNav(); },
    });
  }
}

function showPhotoCapture(choreId, slotId, entryType) {
  const chore = D.chores.find(c => c.id === choreId);
  const isBefore = entryType === 'before';
  const titleText  = isBefore ? '<i class="ph-duotone ph-camera" style="color:#6C63FF;font-size:1.1rem;vertical-align:middle"></i> Take a "Before" Photo' : '<i class="ph-duotone ph-camera" style="color:#6C63FF;font-size:1.1rem;vertical-align:middle"></i> Take a "Done" Photo';
  const hintText   = isBefore
    ? `Show the current state of "${esc(chore?.title||'')}" - e.g. the messy room, the full trash can. Parent will approve before you start.`
    : `Show that you've completed "${esc(chore?.title||'')}"`;
  const submitText = isBefore ? 'Submit' : 'Submit Completion';
  const root = document.getElementById('modal-root');
  if (!root) return;
  logPhotoCaptureDebug('open:start', { choreId, slotId, entryType });
  root.style.display = 'block';
  root.style.pointerEvents = 'auto';
  root.innerHTML = `
    <div class="photo-capture-overlay" id="photo-capture-overlay" onclick="closePhotoCaptureIfBg(event)">
      <div class="photo-capture-sheet" role="dialog" aria-modal="true" aria-label="Photo capture">
        <button class="modal-close-x" type="button" aria-label="Close" onclick="closePhotoCaptureModal()">
          <span aria-hidden="true">&times;</span>
        </button>
        <div class="modal-title">${titleText}</div>
        <p style="color:var(--muted);font-size:0.88rem;margin-bottom:14px">${hintText}</p>
        <div class="photo-preview-wrap" id="photo-drop-zone" onclick="document.getElementById('photo-file-input').click()">
          <img id="photo-preview-img" src="" alt="" style="display:none">
          <div id="photo-drop-hint" style="color:var(--muted);font-size:2rem;padding:20px 0">
            <i class="ph-duotone ph-camera" style="color:#9CA3AF;font-size:2.5rem"></i><br><span style="font-size:0.95rem">Tap to take photo or choose image</span>
          </div>
        </div>
        <input type="file" id="photo-file-input" accept="image/*" capture="environment" style="display:none" onchange="previewChorePhoto(event)">
        <div class="modal-actions">
          <button class="btn btn-primary" id="photo-submit-btn" style="opacity:0.4;pointer-events:none" onclick="submitChorePhoto('${choreId}','${slotId||''}','${entryType||''}')">${submitText}</button>
          <button class="btn btn-secondary" onclick="closePhotoCaptureModal()">Cancel</button>
        </div>
      </div>
    </div>`;
  logPhotoCaptureDebug('open:rendered', { choreId, slotId, entryType });
}

function closePhotoCaptureModal() {
  logPhotoCaptureDebug('close:start');
  const root = document.getElementById('modal-root');
  if (document.activeElement?.blur) document.activeElement.blur();
  _snapshotSwipeSession = null;
  closeAllSnapshotSwipes();
  _snapshotTimePicker = null;
  if (root) {
    root.innerHTML = '';
    root.style.pointerEvents = 'none';
    root.style.display = 'none';
  }
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.width = '';
  delete document.body.dataset.scrollY;
  const mc = document.querySelector('.main-content');
  if (mc) {
    mc.style.overflowY = 'auto';
    delete mc.dataset.prevOverflow;
  }
  logPhotoCaptureDebug('close:after-cleanup');
  setTimeout(() => logPhotoCaptureDebug('close:+100ms'), 100);
  setTimeout(() => logPhotoCaptureDebug('close:+500ms'), 500);
}

function closePhotoCaptureIfBg(e) {
  logPhotoCaptureDebug('close:bg-click', { targetId: e?.target?.id || '' });
  if (e.target?.id === 'photo-capture-overlay') closePhotoCaptureModal();
}

function logPhotoCaptureDebug(label, extra = {}) {
  try {
    const root = document.getElementById('modal-root');
    const overlay = document.getElementById('photo-capture-overlay');
    const activeScreen = document.querySelector('.screen.active')?.id || '';
    const main = document.querySelector('.main-content');
    console.log('[PhotoCaptureDebug]', label, {
      ...extra,
      rootChildren: root?.childElementCount ?? null,
      rootHtmlLength: root?.innerHTML?.length ?? null,
      rootDisplay: root?.style?.display || '',
      rootPointerEvents: root?.style?.pointerEvents || '',
      overlayPresent: !!overlay,
      bodyPosition: document.body.style.position || '',
      bodyTop: document.body.style.top || '',
      bodyWidth: document.body.style.width || '',
      bodyScrollY: document.body.dataset.scrollY || '',
      mainOverflowY: main?.style?.overflowY || '',
      activeElement: document.activeElement?.id || document.activeElement?.tagName || '',
      activeScreen
    });
  } catch (err) {
    console.warn('[PhotoCaptureDebug] log failed', err);
  }
}

function previewChorePhoto(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const img  = document.getElementById('photo-preview-img');
    const hint = document.getElementById('photo-drop-hint');
    const btn  = document.getElementById('photo-submit-btn');
    img.src = e.target.result;
    img.style.display = 'block';
    if (hint) hint.style.display = 'none';
    if (btn)  { btn.style.opacity = '1'; btn.style.pointerEvents = 'auto'; }
  };
  reader.readAsDataURL(file);
}

async function submitChorePhoto(choreId, slotId, entryType) {
  const input = document.getElementById('photo-file-input');
  const file  = input?.files[0];
  if (!file) { toast('Please take a photo first'); return; }
  const btn = document.getElementById('photo-submit-btn');
  if (btn) { btn.style.opacity = '0.5'; btn.style.pointerEvents = 'none'; btn.textContent = 'Submitting...'; }
  try {
    const photoUrl = await uploadChorePhoto(file);
    closePhotoCaptureModal();
    const m = S.currentUser;
    const resolvedEntryType = entryType || null;
    const result = doCompleteChore(choreId, m.id, slotId || null, photoUrl, resolvedEntryType);
    if (!result) return;
    if (result.error) { toast(result.error); return; }
    if (result.isBefore) {
      toast('<i class="ph-duotone ph-camera" style="font-size:1rem;vertical-align:middle"></i> Before photo sent! Waiting for parent to approve the start <i class="ph-duotone ph-hourglass" style="font-size:1rem;vertical-align:middle"></i>');
      if (isTiny(m)) speak('Photo sent! Waiting for your grown-up to say yes!');
      renderKidChores(); renderKidHeader(); renderKidNav();
      return;
    }
    const chore = D.chores.find(c => c.id === choreId);
    choreCompleteReact(chore, m, result, null);
  } catch(e) {
    console.warn('Photo upload failed:', e);
    toast('Upload failed - check your connection and try again.');
    if (btn) {
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
      btn.textContent = entryType === 'before' ? 'Submit' : 'Submit Completion';
    }
  }
}

async function uploadChorePhoto(file) {
  const compressed = await compressImage(file, 400, 0.5);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(compressed);
  });
}

function compressImage(file, maxPx, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > maxPx || h > maxPx) {
        if (w > h) { h = Math.round(h * maxPx / w); w = maxPx; }
        else       { w = Math.round(w * maxPx / h); h = maxPx; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Canvas toBlob failed')), 'image/jpeg', quality);
    };
    img.onerror = reject;
    img.src = url;
  });
}

function viewPhoto(url) {
  showQuickActionModal(`
    <div class="modal-title"><i class="ph-duotone ph-camera" style="color:#6C63FF;font-size:1.1rem;vertical-align:middle"></i> Chore Photo</div>
    <img src="${url}" alt="Chore photo" style="width:100%;border-radius:12px;margin-bottom:16px;display:block">
    <div class="modal-actions">
      <button class="btn btn-primary" onclick="closeModal()">Close</button>
    </div>`);
}

function renderKidDiamonds() {
  const m   = S.currentUser;
  const dmds = m.diamonds || 0;
  const sav = m.savings || 0;
  normalizeMember(m);
  const tiny = isTiny(m);
  const _savSpeech = fmtCurrencySpeech(sav, D.settings.currency || '$');

  const kidHistory = D.history.filter(h=>h.memberId===m.id);
  const myHistory = kidHistory.slice(0,5);

  const _savOn = D.settings.savingsEnabled !== false;
  const savingsDisplay = Number.isInteger(sav)
    ? `${D.settings.currency||'$'}${sav}`
    : `${D.settings.currency||'$'}${sav.toFixed(2)}`;
  let html = `
    <div class="stats-grid kid-gems-top-stats kid-gems-top-stats-${_savOn ? 2 : 1}">
      <div class="stat-card kid-gems-top-card"${tiny ? ` onclick="speak('You have ${dmds} gems.')"` : ''}><div class="stat-val">${dmds}</div><div class="stat-label"><i class="ph-duotone ph-diamond" style="color:#7C3AED;font-size:0.95rem;vertical-align:middle"></i> Gems</div></div>
      ${_savOn ? `<div class="stat-card kid-gems-top-card"${tiny ? ` onclick="speak('You have ${_savSpeech} in savings.')"` : ''}><div class="stat-val">${savingsDisplay}</div><div class="stat-label"><i class="ph-duotone ph-piggy-bank" style="color:#16A34A;font-size:0.95rem;vertical-align:middle"></i> Savings</div></div>` : ''}
    </div>`;

  const summaryCards = [];

  // Level progress banner
  if (D.settings.levelingEnabled !== false) {
    const { current: lvl, next, xpIntoLevel, xpNeeded, pct } = getMemberLevel(m);
    const _lvlTts = next
      ? `You are currently level ${lvl.level}, and need ${xpNeeded - xpIntoLevel} more X P to level up.`
      : `You are at the max level! Amazing!`;
    summaryCards.push(`
      <div class="card kid-gems-summary-card kid-gems-level-card"${tiny ? ` onclick="speak('${_lvlTts}')"` : ''}>
        <div class="kid-gems-summary-label">Level ${lvl.level}</div>
        <div class="kid-gems-summary-well kid-gems-level-well">
          <div class="kid-gems-summary-well-value kid-gems-level-icon">${lvl.icon}</div>
          <div class="kid-gems-summary-well-label">${esc(lvl.name)}</div>
        </div>
        ${next
          ? `<div class="level-xp-bar kid-gems-level-bar"><div class="level-xp-fill" style="width:${pct}%"></div></div>
             <div class="kid-gems-summary-sub">${xpIntoLevel}/${xpNeeded} XP</div>`
          : `<div class="level-xp-bar kid-gems-level-bar"><div class="level-xp-fill" style="width:100%"></div></div>
             <div class="kid-gems-summary-sub">Max level reached</div>`}
      </div>`, 'quick-action-modal-wide');
  }

  // Streak row
  if (D.settings.streakEnabled !== false) {
    const streak = m.streak?.current || 0;
    const best   = m.streak?.best    || 0;
    const _streakTts = streak > 0 && streak >= best
      ? `You currently have a ${streak} day streak, and this is your best streak so far!`
      : `You currently have a ${streak} day streak, and your best streak is ${best} days.`;
    summaryCards.push(`
      <div class="card kid-gems-summary-card kid-gems-streak-card"${tiny ? ` onclick="speak('${_streakTts}')"` : ''}>
        <div class="kid-gems-summary-label">Current Streak</div>
        <div class="kid-gems-summary-well kid-gems-streak-well">
          <div class="kid-gems-summary-well-value kid-gems-streak-value"><i class="ph-duotone ph-fire" style="color:#F97316"></i></div>
          <div class="kid-gems-summary-well-label">${streak} day${streak === 1 ? '' : 's'}</div>
        </div>
        <div class="kid-gems-summary-sub">Best ${best} day${best === 1 ? '' : 's'}</div>
      </div>`);
  }

  // Not Listening meter (non-tiny only)
  if (!tiny && D.settings.notListeningEnabled !== false) {
    normalizeMember(m);
    const _nlSecsPerDmd = D.settings.notListeningSecs || 60;
    const _nlPending = m.nlPendingSecs || 0;
    const _nlPct = Math.min(100, Math.round(_nlPending / _nlSecsPerDmd * 100));
    const _nlToday = (m.nlDate === today() ? m.nlTodaySecs || 0 : 0);
    const _wholeMinutes = Math.floor(_nlToday / 60);
    summaryCards.push(`
      <div class="card kid-gems-summary-card kid-gems-nl-card">
        <div class="kid-gems-summary-label kid-gems-nl-label"><i class="ph-duotone ph-speaker-slash" style="color:#D95B4B;font-size:0.9rem;vertical-align:middle"></i> Not Listening</div>
        <div class="nl-ring-wrap">
          <div class="nl-ring" style="--nl-progress:${_nlPct}%">
            <div class="nl-ring-center">
              <strong>${_wholeMinutes}</strong>
              <span>${_wholeMinutes === 1 ? 'minute' : 'minutes'}</span>
            </div>
          </div>
        </div>
        <div class="kid-gems-summary-sub kid-gems-nl-sub">${_nlToday > 0 ? `${fmtNLTime(_nlToday)} today` : 'None today'}</div>
      </div>`);
  }

  if (summaryCards.length) {
    html += `<div class="kid-gems-summary-grid kid-gems-summary-grid-${summaryCards.length}">${summaryCards.join('')}</div>`;
  }

  // Badge grid
  if (D.settings.levelingEnabled !== false) {
    const earned = Array.isArray(m.badges) ? m.badges : [];
    const baseBadgeChips = D?.settings?.baseBadgesEnabled === false ? '' : BADGE_DEFS.map(b => {
      const def = getBaseBadgeDef(b.id);
      const have = earned.includes(b.id);
      const badgeTts = tiny ? ` onclick="speak('${def.name.replace(/'/g,"\\'")}')"` : '';
      return `<div class="badge-chip ${have?'earned':'badge-chip-locked'}"${badgeTts}>
        <span class="badge-chip-icon">${def.icon}</span>${esc(def.name)}
      </div>`;
    }).join('');
    // Chore badges: earned always shown, non-secret unearned shown locked, secret unearned hidden
    const choreBadgeChips = (D.chores || []).flatMap(chore =>
      (chore.badges || []).map(b => {
        const key = `cb_${b.id}`;
        const have = earned.includes(key);
        if (!have && b.secret) return '';
        const badgeTts = tiny ? ` onclick="speak('${(b.name||'').replace(/'/g,"\\'")}')"` : '';
        return `<div class="badge-chip ${have?'earned':'badge-chip-locked'}"${badgeTts}>
          <span class="badge-chip-icon">${b.icon||'<i class="ph-duotone ph-medal" style="color:#F59E0B"></i>'}</span>${esc(b.name||'')}
        </div>`;
      })
    ).join('');
    html += `
      <div class="section-row kid-gems-section-row">
        <div class="section-title"${tiny ? ` onclick="speak('Badges. Tap a badge to hear its name.')"` : ''}><i class="ph-duotone ph-medal" style="color:#7C3AED;font-size:1rem;vertical-align:middle"></i> Badges</div>
      </div>
      <div class="card kid-gems-section-card">
        <div class="badge-grid">${baseBadgeChips}${choreBadgeChips}</div>
      </div>`;
  }

  // Savings tracker
  if (_savOn) {
    const cur          = D.settings.currency || '$';
    const matchOn      = D.settings.savingsMatchingEnabled;
    const interestOn   = D.settings.savingsInterestEnabled;
    const gifted       = m.savingsGifted || 0;
    const matched      = m.savingsMatched || 0;
    const interest     = m.savingsInterest || 0;
    const selfSaved    = Math.max(0, sav - gifted - matched - interest);
    const matchPct     = D.settings.savingsMatchPercent || 50;
    const interestRate   = D.settings.savingsInterestRate || 5;
    const interestPeriod = D.settings.savingsInterestPeriod || 'monthly';
    const _iDay = D.settings.savingsInterestDay ?? 1;
    const _iDom = D.settings.savingsInterestDayOfMonth || 1;
    const _iDomSfx = _iDom === 1 ? 'st' : _iDom === 2 ? 'nd' : _iDom === 3 ? 'rd' : 'th';
    const interestTip = interestPeriod === 'weekly'
      ? `claimable every ${'Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday'.split(',')[_iDay]}`
      : `claimable on the ${_iDom}${_iDomSfx} of each month`;
    const selfSavedDisplay = Number.isInteger(selfSaved) ? `${cur}${selfSaved}` : `${cur}${selfSaved.toFixed(2)}`;
    const giftedDisplay = Number.isInteger(gifted) ? `${cur}${gifted}` : `${cur}${gifted.toFixed(2)}`;
    const matchedDisplay = Number.isInteger(matched) ? `${cur}${matched}` : `${cur}${matched.toFixed(2)}`;
    const interestDisplay = Number.isInteger(interest) ? `${cur}${interest}` : `${cur}${interest.toFixed(2)}`;
    const savingsBreakdownCards = [
      ...(selfSaved > 0 ? [`<div class="snapshot-stat-card"><strong>${selfSavedDisplay}</strong><small>Yours</small></div>`] : []),
      ...(gifted > 0 ? [`<div class="snapshot-stat-card"><strong>${giftedDisplay}</strong><small>Gifted</small></div>`] : []),
      ...(matched > 0 ? [`<div class="snapshot-stat-card"><strong>${matchedDisplay}</strong><small>Matched</small></div>`] : []),
      ...(interest > 0 ? [`<div class="snapshot-stat-card"><strong>${interestDisplay}</strong><small>Interest</small></div>`] : [])
    ];
    const statCards = savingsBreakdownCards.length >= 2 ? savingsBreakdownCards.join('') : '';
    const _savTts = tiny ? ` onclick="speak('You have ${_savSpeech} in savings.${matchOn && matched > 0 ? ` Your grown-up matched ${cur}${matched.toFixed(2)}.` : ''}${interestOn && interest > 0 ? ` You have earned ${cur}${interest.toFixed(2)} in interest.` : ''}')"` : '';
    html += `
      <div class="section-row kid-gems-section-row">
        <div class="section-title"><i class="ph-duotone ph-piggy-bank" style="color:#16A34A;font-size:1rem;vertical-align:middle"></i> My Savings Jar</div>
      </div>
      <div class="card savings-card kid-gems-section-card"${_savTts}>
        <div class="savings-card-top">
          <div>
            <div class="savings-card-eyebrow">Saved So Far</div>
            <div class="savings-amount">${savingsDisplay}</div>
            <div class="savings-label">Great work!</div>
          </div>
          <div class="savings-card-hero"><i class="ph-duotone ph-piggy-bank"></i></div>
        </div>
        ${statCards ? `<div class="snapshot-stats-grid savings-stats-grid savings-stats-grid-${savingsBreakdownCards.length}">${statCards}</div>` : ''}
        ${(matchOn || interestOn)
          ? `<div class="savings-card-notes">
               ${matchOn ? `<div class="savings-card-note"><i class="ph-duotone ph-hand-heart"></i> ${matchPct}% parent match active</div>` : ''}
               ${interestOn ? `<div class="savings-card-note"><i class="ph-duotone ph-trend-up"></i> ${interestRate}% interest ${interestTip}</div>` : ''}
             </div>`
          : ''}
        <div class="savings-card-actions">
          <button class="btn btn-sm savings-card-btn savings-card-btn-primary" onclick="${tiny ? `speak('Add savings');` : ''}showSavingsModal('${m.id}', this);event.stopPropagation()"><i class="ph-duotone ph-plus-circle" style="font-size:0.95rem;vertical-align:middle"></i> Add Savings</button>
          <button class="btn btn-sm savings-card-btn savings-card-btn-neutral" onclick="${tiny ? `speak('Savings history');` : ''}showSavingsHistory('${m.id}', this);event.stopPropagation()"><i class="ph-duotone ph-clock-clockwise" style="font-size:0.9rem;vertical-align:middle"></i> History</button>
          ${(function(){
            const hasPending = (D.savingsRequests||[]).some(r=>r.memberId===m.id&&r.status==='pending');
            if (hasPending) return `<button class="btn btn-sm savings-card-btn savings-card-btn-pending" style="pointer-events:none" onclick="event.stopPropagation()"><i class="ph-duotone ph-hourglass" style="font-size:0.9rem;vertical-align:middle"></i> Pending</button>`;
            if (sav > 0) return `<button class="btn btn-sm savings-card-btn savings-card-btn-accent" onclick="${tiny ? `speak('Spend savings');` : ''}showSpendRequestModal('${m.id}', this);event.stopPropagation()"><i class="ph-duotone ph-shopping-cart" style="font-size:0.9rem;vertical-align:middle"></i> Spend</button>`;
            return '';
          })()}
        </div>
      </div>`;
  }

  // History
  if (myHistory.length > 0) {
    const actRows = myHistory.map(renderActivityRow).join('');
    html += `
      <div class="section-row kid-gems-section-row">
        <span class="section-title"${tiny ? ` onclick="speak('Here\\'s what you\\'ve been up to recently.')"` : ''}><i class="ph-duotone ph-clipboard-text" style="color:#9CA3AF;font-size:1rem;vertical-align:middle"></i> Recent Activity</span>
      </div>
      <div class="card activity-card kid-gems-section-card">${actRows}
        ${kidHistory.length > 5 ? `<div style="margin-top:10px;padding-top:10px;border-top:1px solid #f3f4f6"><button class="btn btn-secondary btn-sm btn-full" onclick="${tiny ? `speak('All your activity');` : ''}openFullHistory('${m.id}')">View All Activity</button></div>` : ''}
      </div>`;
  } else {
    html += `<div class="empty-state"><div class="empty-icon"><i class="ph-duotone ph-scroll" style="color:#9CA3AF;font-size:3rem"></i></div><div class="empty-text">Complete tasks to earn gems!</div></div>`;
  }

  document.getElementById('kid-content').innerHTML = `${html}<div class="tab-end-cap" aria-hidden="true"></div>`;
}

function showSpendRequestModal(memberId, triggerEl = null) {
  const m = getMember(memberId);
  if (!m) return;
  const cur = D.settings.currency || '$';
  const sav = m.savings || 0;
  const hasPending = (D.savingsRequests || []).some(r => r.memberId === memberId && r.status === 'pending');
  if (hasPending) { toast('You already have a request waiting for approval.'); return; }
  if (sav <= 0) { toast('No savings to spend.'); return; }
  const rect = triggerEl?.getBoundingClientRect?.();
  if (rect) _modalLaunchOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  showQuickActionModal(`
    <div class="modal-title kid-savings-modal-title"><i class="ph-duotone ph-shopping-cart" style="color:#6C63FF;font-size:1.2rem;vertical-align:middle"></i> Spend Savings</div>
    <p class="kid-savings-modal-copy">Balance: <strong>${cur}${sav.toFixed(2)}</strong> and your parent will approve this.</p>
    <div class="form-group">
      <label class="form-label">Amount (${cur})</label>
      <input type="number" id="spend-amt" min="0.01" max="${sav.toFixed(2)}" step="0.01" placeholder="e.g. 10.00">
    </div>
    <div class="form-group">
      <label class="form-label">What for? <span class="form-label-hint">optional</span></label>
      <input type="text" id="spend-reason" placeholder="Lego set, book, game...">
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitSpendRequest('${memberId}')">Send Request</button>
    </div>`, 'quick-action-modal-wide kid-savings-modal kid-savings-spend-modal');
}

function submitSpendRequest(memberId) {
  const m      = getMember(memberId);
  const amt    = parseFloat(document.getElementById('spend-amt')?.value) || 0;
  const reason = document.getElementById('spend-reason')?.value.trim() || '';
  const cur    = D.settings.currency || '$';
  if (!m || amt <= 0) { toast('Enter an amount'); return; }
  if (amt > (m.savings || 0)) { toast(`You only have ${cur}${(m.savings||0).toFixed(2)} saved.`); return; }
  if ((D.savingsRequests || []).some(r => r.memberId === memberId && r.status === 'pending')) {
    toast('Request already pending.'); return;
  }
  D.savingsRequests = D.savingsRequests || [];
  D.savingsRequests.push({ id: genId(), memberId, amount: amt, reason, status: 'pending', date: today(), createdAt: Date.now() });
  saveData();
  closeModal();
  toast('<i class="ph-duotone ph-hourglass" style="font-size:1rem;vertical-align:middle"></i> Request sent! Waiting for parent approval');
  if (D.settings.notifySavingsSpend !== false) {
    try {
      firebase.functions().httpsCallable('sendSpendNotification')({
        familyCode: getFamilyCode(),
        kidName:    m.name || 'A kid',
        amount:     amt,
        reason:     reason || '',
        pendingCount: pendingApprovals().length + pendingSpendRequests().length,
      }).catch(() => {});
    } catch(e) {}
  }
  if (isTiny(m)) speak('You asked to spend some money! Waiting for your grown-up to say yes!');
  renderKidDiamonds();
}

function approveSavingsRequest(requestId, btn) {
  const req = (D.savingsRequests || []).find(r => r.id === requestId);
  if (!req) return;
  const m   = getMember(req.memberId);
  const cur = D.settings.currency || '$';
  if (!m) return;
  _fadeOutAdminCard(btn, () => {
    const actual = Math.min(req.amount, m.savings || 0);
    reduceSavingsBuckets(m, actual);
    m.savings = parseFloat(Math.max(0, (m.savings || 0) - actual).toFixed(2));
    req.status = 'approved';
    const label = req.reason ? `Spent: ${req.reason}` : 'Savings withdrawal approved';
    addHistory('savings_withdraw', req.memberId, label, 0, { dollars: actual });
    saveData();
    toast(`Approved ${cur}${actual.toFixed(2)} spend for ${m.name}`);
    renderParentHome(); renderParentHeader(); renderParentNav();
    syncAppBadge();
  });
}

function denySavingsRequest(requestId, btn) {
  const req = (D.savingsRequests || []).find(r => r.id === requestId);
  if (!req) return;
  const m = getMember(req.memberId);
  _fadeOutAdminCard(btn, () => {
    req.status = 'denied';
    saveData();
    toast(`Spend request denied for ${m?.name || 'kid'}`);
    renderParentHome(); renderParentHeader(); renderParentNav();
    syncAppBadge();
  });
}

function showSavingsHistory(memberId, triggerEl = null) {
  const m = getMember(memberId);
  if (!m) return;
  const cur = D.settings.currency || '$';
  const savTypes = new Set(['savings', 'savings_deposit', 'savings_withdraw']);
  const entries = (D.history || []).filter(h => h.memberId === memberId && savTypes.has(h.type));

  const savingsIcon = (h) => {
    if (h.type === 'savings_deposit')  return '<i class="ph-duotone ph-arrow-circle-down" style="color:#2563EB"></i>';
    if (h.type === 'savings_withdraw') return '<i class="ph-duotone ph-shopping-bag" style="color:#6C63FF"></i>';
    const t = (h.title || '').toLowerCase();
    if (t.includes('interest'))   return '<i class="ph-duotone ph-trend-up" style="color:#16A34A"></i>';
    if (t.includes('match'))      return '<i class="ph-duotone ph-handshake" style="color:#0E7490"></i>';
    if (t.includes('converted'))  return '<i class="ph-duotone ph-arrows-left-right" style="color:#7C3AED"></i>';
    return '<i class="ph-duotone ph-piggy-bank" style="color:#16A34A"></i>';
  };

  const rows = entries.length === 0
    ? '<div class="empty-state" style="padding:10px 0 4px"><div class="empty-text">No savings activity yet</div></div>'
    : entries.map(h => {
        const isDeposit  = h.type === 'savings_deposit';
        const isWithdraw = h.type === 'savings_withdraw';
        const hasDollars = (h.dollars || 0) > 0;
        const delta = hasDollars
          ? `${isWithdraw ? '-' : '+'}${cur}${h.dollars.toFixed(2)}`
          : h.diamonds !== 0
            ? `${h.diamonds > 0 ? '+' : ''}${h.diamonds}`
            : '';
        const deltaUnit = hasDollars ? '' : (h.diamonds !== 0 ? 'gems' : '');
        const deltaClass = hasDollars ? (isWithdraw ? 'negative' : 'positive') : (h.diamonds > 0 ? 'positive' : h.diamonds < 0 ? 'negative' : 'neutral');
        return `<div class="activity-row">
          <span class="activity-badge" style="background:${isWithdraw ? '#ede9fe' : '#e8f5ee'};color:${isWithdraw ? '#6C63FF' : '#1f7a55'}">${savingsIcon(h)}</span>
          <div class="activity-body">
            <div class="activity-title">${esc(h.title||'')}</div>
            <div class="activity-meta">${fmtDate(h.date)}</div>
          </div>
          ${delta ? `<div class="activity-delta ${deltaClass}">
            <span class="activity-delta-value">${delta}</span>
            ${deltaUnit ? `<span class="activity-delta-unit">${deltaUnit}</span>` : ''}
          </div>` : ''}
        </div>`;
      }).join('');

  const rect = triggerEl?.getBoundingClientRect?.();
  if (rect) _modalLaunchOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  showQuickActionModal(`
    <div class="modal-title kid-savings-modal-title"><i class="ph-duotone ph-piggy-bank" style="color:#16A34A;font-size:1.2rem;vertical-align:middle"></i> Savings History</div>
    <p class="kid-savings-modal-copy">A quick look at ${esc(m.name)}'s savings activity.</p>
    <div class="kid-savings-history-list">${rows}</div>
    <div class="modal-actions">
      <button class="btn btn-secondary btn-full" onclick="closeModal()">Close</button>
    </div>`, 'quick-action-modal-wide kid-savings-modal kid-savings-history-modal');
}

function showSavingsModal(memberId, triggerEl = null) {
  const m = getMember(memberId);
  if (!m) return;
  const rate     = D.settings.diamondsPerDollar || 10;
  const cur      = D.settings.currency || '$';
  const matchOn  = D.settings.savingsMatchingEnabled && D.settings.savingsEnabled !== false;
  const matchPct = D.settings.savingsMatchPercent || 50;
  const interestOn  = D.settings.savingsInterestEnabled && D.settings.savingsEnabled !== false;
  const interestRate = D.settings.savingsInterestRate || 5;
  const interestPeriod = D.settings.savingsInterestPeriod || 'monthly';
  const matchNote = matchOn
    ? `<div class="kid-savings-modal-note kid-savings-modal-note-green">
        <strong>Parent match is on!</strong> For every ${cur}1.00 you save, your parents add ${cur}${(matchPct/100).toFixed(2)} extra (${matchPct}% match).
       </div>`
    : '';
  const _siDay = D.settings.savingsInterestDay ?? 1;
  const _siDom = D.settings.savingsInterestDayOfMonth || 1;
  const _siDomSfx = _siDom === 1 ? 'st' : _siDom === 2 ? 'nd' : _siDom === 3 ? 'rd' : 'th';
  const _siWhen = interestPeriod === 'weekly'
    ? `every ${'Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday'.split(',')[_siDay]}`
    : `on the ${_siDom}${_siDomSfx} of each month`;
  const interestNote = interestOn
    ? `<div class="kid-savings-modal-note kid-savings-modal-note-blue">
        <strong>Interest is on!</strong> Your savings grow by ${interestRate}% - claimable ${_siWhen}.
       </div>`
    : '';
  const rect = triggerEl?.getBoundingClientRect?.();
  if (rect) _modalLaunchOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  showQuickActionModal(`
    <div class="modal-title kid-savings-modal-title"><i class="ph-duotone ph-piggy-bank" style="color:#16A34A;font-size:1.2rem;vertical-align:middle"></i> Savings Jar</div>
    <p class="kid-savings-modal-copy" style="margin-bottom:${(matchOn||interestOn)?'10':'16'}px">
      Convert gems to savings (${rate} gems = ${cur}1.00).
    </p>
    ${matchNote}${interestNote}
    <div class="form-group">
      <label class="form-label">Gems to convert <span class="form-label-hint">(you have ${m.diamonds||0})</span></label>
      <input type="number" id="save-dmds" min="0" max="${m.diamonds||0}" step="1" placeholder="1"
             oninput="updateSavingsPreview('${memberId}',this.value)">
    </div>
    <div id="savings-preview" class="kid-savings-preview"></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-teal" onclick="doSaveDiamonds('${memberId}')">Convert</button>
    </div>`, 'quick-action-modal-wide kid-savings-modal kid-savings-convert-modal');
}

function updateSavingsPreview(memberId, rawVal) {
  const el = document.getElementById('savings-preview');
  if (!el) return;
  const rate     = D.settings.diamondsPerDollar || 10;
  const cur      = D.settings.currency || '$';
  const matchOn  = D.settings.savingsMatchingEnabled && D.settings.savingsEnabled !== false;
  const matchPct = D.settings.savingsMatchPercent || 50;
  const dmds     = parseInt(rawVal) || 0;
  if (dmds <= 0) { el.textContent = ''; return; }
  const dollars      = parseFloat((dmds / rate).toFixed(2));
  const matchDollars = matchOn ? parseFloat((dollars * matchPct / 100).toFixed(2)) : 0;
  const total        = dollars + matchDollars;
  el.innerHTML = matchOn && matchDollars > 0
    ? `${cur}${dollars.toFixed(2)} yours + ${cur}${matchDollars.toFixed(2)} parent match = <strong>${cur}${total.toFixed(2)} total</strong>`
    : `You'll save ${cur}${dollars.toFixed(2)}`;
}

function doSaveDiamonds(memberId) {
  const m    = getMember(memberId);
  const dmds = parseInt(document.getElementById('save-dmds')?.value) || 0;
  const rate = D.settings.diamondsPerDollar || 10;
  const cur  = D.settings.currency || '$';
  if (!m || dmds <= 0 || dmds > (m.diamonds||0)) {
    toast(`Enter a valid gem amount`); return;
  }
  const dollars = parseFloat((dmds / rate).toFixed(2));
  m.diamonds -= dmds;
  m.savings   = parseFloat(((m.savings||0) + dollars).toFixed(2));
  addHistory('savings', memberId, `Converted ${dmds} gems to savings`, -dmds);

  const matchOn  = D.settings.savingsMatchingEnabled && D.settings.savingsEnabled !== false;
  let toastMsg   = `+${cur}${dollars.toFixed(2)} saved!`;
  if (matchOn) {
    const matchPct    = D.settings.savingsMatchPercent || 50;
    const matchDollars = parseFloat((dollars * matchPct / 100).toFixed(2));
    if (matchDollars > 0) {
      m.savings        = parseFloat(((m.savings||0) + matchDollars).toFixed(2));
      m.savingsMatched = parseFloat(((m.savingsMatched||0) + matchDollars).toFixed(2));
      addHistory('savings', memberId, `Parent match (${matchPct}%) +${cur}${matchDollars.toFixed(2)}`, 0);
      toastMsg = `+${cur}${dollars.toFixed(2)} saved + ${cur}${matchDollars.toFixed(2)} parent match!`;
    }
  }

  saveData();
  closeModal();
  toast(toastMsg);
  renderKidDiamonds();
  renderKidHeader();
}

function isInterestDay() {
  const s = D.settings;
  if (!s.savingsEnabled || !s.savingsInterestEnabled) return false;
  const d = parseDateLocal(today());
  const period = s.savingsInterestPeriod || 'monthly';
  return period === 'weekly'
    ? d.getDay() === (s.savingsInterestDay ?? 1)
    : d.getDate() === (s.savingsInterestDayOfMonth || 1);
}

function claimInterest(memberId) {
  const s = D.settings;
  if (!isInterestDay()) return;
  const m = getMember(memberId);
  if (!m || (m.savings || 0) <= 0 || m.savingsInterestLastDate === today()) return;
  const rate   = parseFloat(s.savingsInterestRate) || 5;
  const period = s.savingsInterestPeriod || 'monthly';
  const cur    = s.currency || '$';
  const interest = parseFloat((m.savings * rate / 100).toFixed(2));
  if (interest <= 0) return;
  m.savings                 = (m.savings || 0) + interest;
  m.savingsInterest         = (m.savingsInterest || 0) + interest;
  m.savingsInterestLastDate = today();
  addHistory('savings', m.id, `Interest (${rate}% ${period}) +${cur}${interest.toFixed(2)}`, 0);
  saveData();
}

// Kept for any legacy calls; now a no-op since kids claim interactively
function applyInterestForAllKids() {}

function renderKidShop() {
  const m    = S.currentUser;
  const tiny = isTiny(m);
  const dmds  = m.gems || 0;
  const indiv = D.prizes.filter(p => p.type === 'individual').slice().sort((a,b) => (a.cost||0)-(b.cost||0) || (a.title||'').localeCompare(b.title||''));

  if (indiv.length === 0) {
    document.getElementById('kid-content').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon"><i class="ph-duotone ph-gift" style="color:#FF6584;font-size:3rem"></i></div>
        <div class="empty-text">No prizes yet! Ask a parent to add some.</div>
      </div>`;
    return;
  }

  const renderPrizeCard = (p) => {
    const canAfford = dmds >= p.cost;
    const cls = canAfford ? 'can-afford' : '';
    const tts  = `${p.title}. Costs ${p.cost} gems.${canAfford?' You can get this!':` You need ${p.cost-dmds} more gems.`}`;
    return `
      <div class="prize-card kid-shop-prize-card ${cls}" onclick="kidRedeemPrize('${p.id}',event)${tiny?`;speak('${tts.replace(/'/g,"\\'")}')`:''}"
           ${tiny?`title="${esc(tts)}"`:''}>
        <div class="kid-shop-prize-top">
          <span class="prize-icon kid-shop-prize-icon">${renderIcon(p.icon,p.iconColor)}</span>
          <span class="kid-shop-prize-cost">
            <i class="ph-duotone ph-diamond" style="font-size:0.95rem;vertical-align:middle"></i>
            ${p.cost}
          </span>
        </div>
        <div class="prize-name kid-shop-prize-name">${esc(p.title)}</div>
        <div class="kid-shop-prize-note">
          ${canAfford
            ? `Ready!`
            : `${p.cost-dmds} more gems needed`}
        </div>
      </div>`;
  };

  let html = `
    <div class="section-row"><span class="section-title"${tiny ? ` onclick="speak('My prizes. Tap a prize to hear what it costs.')"` : ''}><i class="ph-duotone ph-gift" style="color:#FF6584;font-size:1rem;vertical-align:middle"></i> My Prizes</span></div>
    <div class="prize-grid kid-shop-prize-grid">${indiv.map(p=>renderPrizeCard(p)).join('')}</div>`;

  document.getElementById('kid-content').innerHTML = html;
}

function kidRedeemPrize(prizeId, evt) {
  evt && evt.stopPropagation();
  const m     = S.currentUser;
  const prize = D.prizes.find(p=>p.id===prizeId);
  if (!m || !prize) return;

  const dmds = m.gems||0;
  if (dmds < prize.cost) {
    const need = prize.cost - dmds;
    if (isTiny(m)) speak(`You need ${need} more gems for this prize!`);
    else toast(`Need ${need} more gems for "${prize.title}"`);
    return;
  }

  showQuickActionModal(`
    <div class="modal-title">${renderIcon(prize.icon,prize.iconColor,'font-size:1.2rem;vertical-align:middle')} Redeem Prize?</div>
    <p style="margin-bottom:20px;line-height:1.6">Redeem <strong>${esc(prize.title)}</strong> for ${prize.cost} of your ${dmds} gems?</p>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Not yet</button>
      <button class="btn btn-primary" onclick="confirmRedeem('${prizeId}')">Yes, redeem! <i class="ph-duotone ph-confetti" style="font-size:1rem;vertical-align:middle"></i></button>
    </div>`);
}

function confirmRedeem(prizeId) {
  const m     = S.currentUser;
  const prize = D.prizes.find(p=>p.id===prizeId);
  closeModal();
  if (!prize) { toast('Prize no longer available'); return; }
  const ok = doRedeemPrize(prizeId, m?.id);
  if (!ok) { toast('Could not redeem - not enough gems'); return; }

  showCelebration({
    icon:   renderIcon(prize.icon, prize.iconColor, 'font-size:3.5rem'),
    title:  'Prize Unlocked!',
    sub:    prize.title,
    tts:    isTiny(m) ? `You got it! ${prize.title}! Go show your grown-up!` : null,
    onClose: () => { renderKidShop(); renderKidHeader(); }
  });
}

function renderKidTeam() {
  const m    = S.currentUser;
  const tiny = isTiny(m);
  const dmds  = m.gems || 0;
  const goals = (D.teamGoals || []).slice().sort((a,b) => (a.targetPoints||0)-(b.targetPoints||0) || (a.title||'').localeCompare(b.title||''));
  const kids  = D.family.members.filter(k=>k.role==='kid'&&!k.deleted);

  if (goals.length === 0) {
    document.getElementById('kid-content').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon"><i class="ph-duotone ph-trophy" style="color:#D97706;font-size:3rem"></i></div>
        <div class="empty-text">No team prizes yet! Ask a parent to add some.</div>
      </div>`;
    return;
  }

  const goalCards = goals.map(g => {
    const total  = goalTotal(g);
    const target = g.targetPoints || 1;
    const pct    = Math.min(100, Math.round(total/target*100));
    const reached = pct >= 100;
    const myContrib = (g.contributions||{})[m.id] || 0;
    const contribs = kids.map(k => {
      const c = (g.contributions||{})[k.id]||0;
      const pctBar = total>0 ? Math.round(c/total*100) : 0;
      return `
        <div class="contrib-row kid-team-contrib-row">
          <span class="contrib-avatar kid-team-contrib-avatar">${k.avatar||'<i class="ph-duotone ph-smiley" style="color:#9CA3AF"></i>'}</span>
          <span class="contrib-name kid-team-contrib-name">${esc(k.name)}</span>
          <div class="contrib-bar-bg"><div class="contrib-fill" style="width:${pctBar}%"></div></div>
          <span class="contrib-val kid-team-contrib-val">${c}</span>
        </div>`;
    }).join('');
    const _needed = target - total;
    const _goalTts = reached
      ? `${g.title}. Amazing! The team reached this goal!`
      : total > 0
        ? `${g.title}. The team needs ${_needed} more gems.`
        : `${g.title}. The team needs ${target} gems to reach this goal.`;
    return `
      <div class="goal-card kid-team-goal-card"${tiny ? ` onclick="speak('${_goalTts.replace(/'/g,"\\'")}')"` : ''}>
        <div class="kid-team-goal-top">
          <div class="kid-team-goal-copy">
            <div class="goal-title kid-team-goal-title">${esc(g.title)}</div>
            <div class="goal-sub kid-team-goal-sub">${reached ? 'Team prize reached' : `${total} / ${target} gems gathered`}</div>
          </div>
          <div class="kid-team-goal-badge">
            <span class="kid-team-goal-glyph">${renderIcon(g.icon, g.iconColor, 'font-size:2rem')}</span>
            <span class="kid-team-goal-target">${target}</span>
          </div>
        </div>
        <div class="goal-bar-bg kid-team-goal-bar-bg"><div class="goal-bar-fill kid-team-goal-bar-fill" style="width:${pct}%"></div></div>
        <div class="goal-dmds kid-team-goal-status">${pct}% there${reached ? ' • Goal reached!' : ''}</div>
        ${kids.length>1?`<div class="kid-team-contrib-list">${contribs}</div>`:''}
        ${!reached?`
          <div class="kid-team-goal-action">
            ${dmds > 0
              ? `<button class="btn btn-primary btn-full kid-team-goal-btn" onclick="showContributeModal('${m.id}','${g.id}', this)">
                   Add Gems!
                 </button>`
              : `<div class="kid-team-goal-empty">Complete tasks to earn gems first!</div>`}
          </div>`
        : `<div class="kid-team-goal-complete">Tell a parent to collect the reward! <i class="ph-duotone ph-confetti" style="font-size:1rem;vertical-align:middle"></i></div>`}
      </div>`;
  }).join('');

  document.getElementById('kid-content').innerHTML = `
    <div class="section-row"><span class="section-title"${tiny ? ` onclick="speak('Team prizes. Tap a card to hear how close your team is.')"` : ''}><i class="ph-duotone ph-trophy" style="color:#D97706;font-size:1rem;vertical-align:middle"></i> Team Prizes</span></div>
    ${goalCards}`;
}

function showContributeModal(memberId, goalId, triggerEl = null) {
  const m    = getMember(memberId);
  const goal = D.teamGoals?.find(g => g.id === goalId);
  if (!m || !goal) return;
  const rect = triggerEl?.getBoundingClientRect?.();
  if (rect) _modalLaunchOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  const total = Object.values(goal.contributions || {}).reduce((a, b) => a + b, 0);
  const remaining = Math.max(0, (goal.targetPoints || 0) - total);
  const maxAllowed = Math.max(0, Math.min(m.gems || 0, remaining));
  showQuickActionModal(`
    <div class="modal-title"><i class="ph-duotone ph-trophy" style="color:#D97706;font-size:1.2rem;vertical-align:middle"></i> ${esc(goal.title)}</div>
    <p style="color:var(--muted);font-size:0.9rem;margin-bottom:16px">
      You have <strong>${m.gems||0} gems</strong>. How many do you want to contribute?
    </p>
    <div class="form-group">
      <label class="form-label">Gems to contribute</label>
      <div style="display:flex;gap:10px;align-items:center">
        <input type="number" id="contrib-dmds" min="1" placeholder="e.g. 50" style="flex:1 1 auto">
        <button class="btn btn-secondary btn-sm" type="button" onclick="setGoalContribMax('${memberId}','${goalId}')">Max</button>
      </div>
      <div style="margin-top:8px;font-size:0.8rem;color:var(--muted)">Up to ${maxAllowed} gems will go toward this prize right now.</div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="doContrib('${memberId}','${goalId}')">Add Gems!</button>
    </div>`, 'quick-action-modal-wide');
}

function setGoalContribMax(memberId, goalId) {
  const m = getMember(memberId);
  const goal = D.teamGoals?.find(g => g.id === goalId);
  const input = document.getElementById('contrib-dmds');
  if (!m || !goal || !input) return;
  const total = Object.values(goal.contributions || {}).reduce((a, b) => a + b, 0);
  const remaining = Math.max(0, (goal.targetPoints || 0) - total);
  input.value = Math.max(0, Math.min(m.gems || 0, remaining));
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function showContribAdjustmentModal(memberId, goalId, details) {
  const m = getMember(memberId);
  const goal = D.teamGoals?.find(g => g.id === goalId);
  if (!m || !goal || !details?.refund) return;
  const reasonText = details.reason === 'goal_cap'
    ? `This prize only needed ${details.remaining} more gems, so you're getting ${details.refund} gems back!`
    : `You only had ${details.owned} gems ready to add, so you're getting ${details.refund} gems back!`;
  showQuickActionModal(`
    <div class="modal-title"><i class="ph-duotone ph-arrow-u-down-left" style="color:#0F766E;font-size:1.2rem;vertical-align:middle"></i> Just Right</div>
    <p class="kid-savings-modal-copy" style="margin-bottom:16px">${reasonText}</p>
    <div class="modal-actions">
      <button class="btn btn-primary btn-full" onclick="closeModal()">Okay</button>
    </div>`, 'quick-action-modal-wide kid-savings-modal');
  if (isTiny(m)) speak(reasonText);
}

function doContrib(memberId, goalId) {
  const dmds  = parseInt(document.getElementById('contrib-dmds')?.value)||0;
  const goal = D.teamGoals?.find(g => g.id === goalId);
  if (dmds <= 0) { toast('Enter gems to contribute'); return; }
  const result = doContributeToGoal(memberId, goalId, dmds);
  closeModal();
  if (!result?.ok) {
    if (result?.reason === 'complete') toast('This prize is already fully funded!');
    else if (result?.reason === 'insufficient') toast('No gems available to add right now.');
    else toast('Enter gems to contribute');
    return;
  }
  toast(`+${result.applied} gems contributed to "${goal?.title}"! <i class="ph-duotone ph-trophy" style="color:#D97706;font-size:0.9rem;vertical-align:middle"></i>`);
  const m = getMember(memberId);
  if (isTiny(m)) speak(`You gave ${result.applied} gems to the team! Amazing!`);
  if (result.refund > 0) showContribAdjustmentModal(memberId, goalId, result);
  renderKidTeam();
  renderKidHeader();
}

function renderParentView() {
  const member = S.currentUser;
  if (member?.role === 'parent' && !ensureParentAuth(member, () => renderParentView())) return;
  showScreen('screen-parent');
  renderParentHeader();
  renderParentNav();
  renderParentTab();
  restoreCurrentScrollPosition(0);
}


function confirmSignOut() {
        showQuickActionModal(`
    <div class="modal-title">Sign Out?</div>
    <p style="font-size:0.9rem;color:var(--muted);margin-bottom:16px">You'll need to sign in again to access the parent dashboard on this device.</p>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="closeModal();closeSettings();signOutAndGoHome()">Sign Out</button>
          </div>`, 'quick-action-modal-wide');
}

async function linkAdditionalProvider(providerId) {
  let user;
  if (providerId === 'google.com')      user = await signInWithGoogle();
  else if (providerId === 'apple.com')  user = await signInWithApple();
  if (!user || !S.currentUser) return;
  await linkParentAuth(user, S.currentUser.id, providerId);
  renderSettings();
}

function _removeLastProviderAndSignOut() {
  const member = S.currentUser;
  if (member) {
    member.authProviders = [];
    member.authUids = [];
    saveData();
  }
  closeSettings();
  signOutAndGoHome();
}

function unlinkProvider(providerId) {
  const member = S.currentUser;
  if (!member?.authProviders?.length) return;
  const remaining = member.authProviders.filter(p => p.providerId !== providerId);
  if (remaining.length === 0) {
    showQuickActionModal(`
      <div class="modal-title">Remove Account?</div>
      <p style="font-size:0.9rem;color:var(--muted);margin-bottom:16px">This is your only linked account. Removing it will sign you out.</p>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" style="background:#EF4444;border-color:#EF4444" onclick="closeModal();_removeLastProviderAndSignOut()">Remove &amp; Sign Out</button>
      </div>`);
    return;
  }
  member.authProviders = remaining;
  member.authUids = remaining.map(p => p.uid);
  const next = remaining[0];
  setParentAuthUid(next.uid);
  try { localStorage.setItem(PARENT_AUTH_PROVIDER_KEY, next.providerId); } catch {}
  saveData();
  renderSettings();
}

function renderParentHeader() {
  const m = S.currentUser;
  document.getElementById('parent-header').innerHTML = `
    <div class="header-left">
      <span class="header-avatar" onclick="parentAvatarEasterEgg(event)" style="cursor:pointer">${renderMemberAvatarHtml(m)}</span>
      <div>
        <div class="header-name">Hi, ${esc(m.name)}!</div>
        <div class="header-sub">${esc(D.family.name)}</div>
      </div>
    </div>
    <div class="header-actions">
      ${S.parentTab === 'stats' ? `<button class="btn btn-secondary btn-sm" onclick="showWeekReview()">Week in Review</button>` : ''}
      <button class="btn-icon-sm" style="background:#F3F4F6" onclick="openUserSettings()" title="Settings"><i class="ph-duotone ph-gear-six" style="color:#6C63FF;font-size:1.15rem"></i></button>
    </div>`;
}

function renderParentNav() {
  const pending   = familyInboxCount();
  const homeCount = pending;
  const tabs = [
    ['home',    ICONS.home,     'Overview'],
    ['chores',  ICONS.chores,   'Rhythm'],
    ['prizes',  ICONS.prizes,   'Prizes'],
    ['levels',  ICONS.levels,   'Levels'],
    ['stats',   ICONS.stats,    'Stats'],
  ];
  document.getElementById('parent-nav').innerHTML = tabs.map(([id,icon,label]) => `
    <button class="nav-item${S.parentTab===id?' active':''}" onclick="switchParentTab('${id}')">
      <span class="nav-icon">${icon}</span>${label}
      ${id==='home'&&homeCount>0?`<span class="nav-badge">${homeCount}</span>`:''}
    </button>`).join('');
}

function switchParentTab(tab) {
  rememberCurrentScrollPosition();
  S.parentTab = tab;
  renderParentHeader();
  renderParentNav();
  renderParentTab();
  restoreCurrentScrollPosition(0);
}

function renderParentTab() {
  try {
  document.getElementById('parent-content')?.classList.remove('stats-page-content');
  switch(S.parentTab) {
    case 'home':     renderParentHome();     break;
    case 'chores':   renderParentChores();   break;
    case 'prizes':   renderParentPrizes();   break;
    case 'levels':   renderParentLevels();   break;
    case 'stats':    renderStatsPage(document.getElementById('parent-content')); break;
  }
  } catch(e) {
    console.error('renderParentTab error:', e);
    const el = document.getElementById('parent-content');
    if (el) el.innerHTML = `<div class="card" style="border:2px solid #EF4444;color:#EF4444;padding:1rem">Something went wrong rendering this tab. Check the browser console for details.</div>`;
  }
}

function buildMemberStats(member, histIdx) {
  const hist = histIdx ? (histIdx.get(member.id) || []) : (D.history || []).filter(h => h.memberId === member.id);
  normalizeMember(member);

  // Chore history breakdown
  const choreHist    = hist.filter(h => h.type === 'chore');
  const prizeHist    = hist.filter(h => h.type === 'prize');
  const penaltyHist  = hist.filter(h => h.type === 'penalty');
  const bonusHist    = hist.filter(h => h.type === 'bonus');
  const levelHist    = hist.filter(h => h.type === 'level');
  const savDepHist   = hist.filter(h => h.type === 'savings_deposit');
  const savWithHist  = hist.filter(h => h.type === 'savings_withdraw');

  const choreCount = {};
  choreHist.filter(h => !(h.title||'').startsWith('Streak bonus (')).forEach(h => { choreCount[h.title] = (choreCount[h.title] || 0) + 1; });
  const choreBreakdown = Object.entries(choreCount).sort((a,b) => b[1]-a[1]);

  // Per-prize counts (from prize.redemptions)
  const prizeCount = {};
  (D.prizes || []).forEach(p => {
    const count = (p.redemptions || []).filter(r => r.memberId === member.id).length;
    if (count > 0) prizeCount[p.title] = { count, icon: p.icon || 'gift', cost: p.cost };
  });
  const prizeBreakdown = Object.entries(prizeCount).sort((a,b) => b[1].count - a[1].count);

  // Active days (days with any history)
  const activeDates = new Set(hist.map(h => h.date));
  const daysActive = activeDates.size;

  // Most productive date
  const ptsByDate = {};
  choreHist.forEach(h => { ptsByDate[h.date] = (ptsByDate[h.date]||0) + (h.gems||0); });
  const bestDate = Object.entries(ptsByDate).sort((a,b)=>b[1]-a[1])[0];

  // Favorite chore
  const favChore = choreBreakdown[0] || null;

  // NL time
  const nlSecs = member.nlLifetimeSecs || 0;
  const nlFmt = nlSecs === 0 ? '0s' : `${Math.floor(nlSecs/60)}m ${nlSecs%60}s`;

  // Level info
  const lvlInfo = getMemberLevel(member);

  return {
    choreDone:        choreHist.length,
    diamondsEarned:      [...choreHist, ...bonusHist].reduce((s,h) => s + (h.gems||0), 0),
    rewardCount:      prizeHist.length,
    diamondsSpent:      prizeHist.reduce((s,h) => s + Math.abs(h.gems||0), 0),
    penaltyCount:     penaltyHist.length,
    penaltyAmount:    penaltyHist.reduce((s,h) => s + Math.abs(h.gems||0), 0),
    nlLifetimeSecs:   nlSecs,
    nlFmt,
    totalXP:          member.xp || member.totalEarned || 0,
    badgeCount:       (member.badges || []).length,  // includes standard + chore badges
    bestStreak:       member.streak?.best || 0,
    currentStreak:    member.streak?.current || 0,
    bestComboStreak:  member.comboStreak?.best || 0,
    currentComboStreak: member.comboStreak?.current || 0,
    savings:          member.savings || 0,
    totalDeposited:   savDepHist.reduce((s, h) => s + (h.dollars || 0), 0),
    totalWithdrawn:   savWithHist.reduce((s, h) => s + (h.dollars || 0), 0),
    declineCount:     hist.filter(h => h.type === 'decline').length,
    comboCount:       bonusHist.length,
    comboDiamonds:       bonusHist.reduce((s,h) => s + Math.abs(h.gems||0), 0),
    levelUps:         Math.max(levelHist.length, lvlInfo.current.level - 1),
    currentLevel:     lvlInfo.current,
    daysActive,
    bestDate:         bestDate ? { date: bestDate[0], dmds: bestDate[1] } : null,
    favChore,
    avgChoresPerDay:  daysActive > 0 ? (choreHist.length / daysActive).toFixed(1) : '0',
    choreBreakdown,
    prizeBreakdown,
    totalPoints:      member.gems || 0,
    totalEarned:      member.totalEarned || 0,
  };
}

function _statTile(icon, label, value, color, sub, ttsText) {
  const _ttsAttr = ttsText ? ` onclick="speak('${ttsText.replace(/'/g,"\\'")}')"` : '';
  return `
    <div class="stats-panel-tile"${_ttsAttr}>
      <div class="stats-panel-tile-icon">${icon}</div>
      <div class="stats-panel-tile-value" style="color:${color||'#1f2937'}">${value}</div>
      <div class="stats-panel-tile-label">${label}</div>
      ${sub ? `<div class="stats-panel-tile-sub">${sub}</div>` : ''}
    </div>`;
}

function _statSection(title, tilesHtml) {
  return `
    <div class="stats-panel-section">
      <div class="stats-panel-section-title">${title}</div>
      <div class="stats-panel-grid">${tilesHtml}</div>
    </div>`;
}

function _statBreakdownTable(rows, col1, col2) {
  if (!rows.length) return `<div class="stats-panel-empty">None yet</div>`;
  return `<table class="stats-panel-table">
    ${rows.map(([name,val],i) => `
      <tr>
        <td class="${i===0?'top-row':''}">${esc(name)}</td>
        <td>${val} ${col2}</td>
      </tr>`).join('')}
  </table>`;
}

function renderFamilyStatsCard(kids, histIdx, expandedOverride = null) {
  const kidIds = new Set(kids.map(k => k.id));
  const allHist = histIdx
    ? kids.flatMap(k => histIdx.get(k.id) || [])
    : (D.history || []).filter(h => kidIds.has(h.memberId));
  const choreHist   = allHist.filter(h => h.type === 'chore');
  const declineHist = allHist.filter(h => h.type === 'decline');

  // Overview totals
  const totalChores  = choreHist.length;
  const totalDiamonds = kids.reduce((s, k) => s + (k.totalEarned || 0), 0);
  const totalPrizes  = D.prizes.reduce((s, p) => s + (p.redemptions || []).length, 0);

  // Streaks
  const kidsOnStreak = kids.filter(k => (k.streak?.current || 0) > 0).length;

  // Most popular chore
  const choreCounts = {};
  choreHist.forEach(h => { choreCounts[h.title] = (choreCounts[h.title] || 0) + 1; });
  const topChore = Object.entries(choreCounts).sort((a, b) => b[1] - a[1])[0];

  // Best single day (most gems earned across any kid)
  const dmByDate = {};
  choreHist.forEach(h => { dmByDate[h.date] = (dmByDate[h.date] || 0) + (h.gems || 0); });
  const bestDay = Object.entries(dmByDate).sort((a, b) => b[1] - a[1])[0];

  // Favorite prize
  const prizeCounts = {};
  D.prizes.forEach(p => {
    const n = (p.redemptions || []).length;
    if (n > 0) prizeCounts[p.title] = { n, icon: p.icon || 'gift' };
  });
  const topPrize = Object.entries(prizeCounts).sort((a, b) => b[1].n - a[1].n)[0];

  // Total NL time
  const totalNlSecs = kids.reduce((s, k) => s + (k.nlLifetimeSecs || 0), 0);
  const nlFmt = totalNlSecs === 0 ? 'None'
    : totalNlSecs < 60 ? `${totalNlSecs}s`
    : `${Math.floor(totalNlSecs / 60)}m ${totalNlSecs % 60}s`;

  const cur = D.settings.currency || '$';
  const savOn = D.settings.savingsEnabled !== false;
  const familyBalance   = kids.reduce((s, k) => s + (k.savings || 0), 0);
  const familyDeposited = (D.history || []).filter(h => kids.some(k=>k.id===h.memberId) && h.type==='savings_deposit').reduce((s,h)=>s+(h.dollars||0),0);
  const familyWithdrawn = (D.history || []).filter(h => kids.some(k=>k.id===h.memberId) && h.type==='savings_withdraw').reduce((s,h)=>s+(h.dollars||0),0);

  const overviewSection = _statSection('Family Overview',
    _statTile('<i class="ph-duotone ph-check-circle" style="color:#16A34A"></i>', 'Tasks Done', totalChores, '#166534', 'all time, all kids') +
    _statTile('<i class="ph-duotone ph-diamond" style="color:#D97706"></i>', 'Gems Earned', totalDiamonds, '#92400e', 'all time, all kids') +
    _statTile('<i class="ph-duotone ph-gift" style="color:#1D4ED8"></i>', 'Prizes Redeemed', totalPrizes, '#1e40af', 'all time, all kids')
  );

  const savingsOverview = savOn ? _statSection('Family Savings',
    _statTile('<i class="ph-duotone ph-piggy-bank" style="color:#16A34A"></i>', 'Total Balance', `${cur}${familyBalance.toFixed(2)}`, '#166534', 'across all kids') +
    _statTile('<i class="ph-duotone ph-arrow-circle-down" style="color:#2563EB"></i>', 'Total Deposited', `${cur}${familyDeposited.toFixed(2)}`, '#1e40af', 'all time') +
    _statTile('<i class="ph-duotone ph-shopping-bag" style="color:#6C63FF"></i>', 'Total Spent', `${cur}${familyWithdrawn.toFixed(2)}`, '#4c1d95', 'from savings')
  ) : '';

  const funTiles =
    (D.settings.streakEnabled !== false
      ? _statTile('<i class="ph-duotone ph-fire" style="color:#F97316"></i>', 'Active Streaks', kidsOnStreak, '#b45309', `kid${kidsOnStreak !== 1 ? 's' : ''} on a streak now`)
      : '') +
    (topChore
      ? _statTile('<i class="ph-duotone ph-star" style="color:#7C3AED"></i>', 'Most Popular Chore', topChore[0].split(' ')[0], '#4c1d95', `${topChore[0]} - ${topChore[1]}x`)
      : '') +
    (topPrize
      ? _statTile(renderIcon(topPrize[1].icon, '#1e40af', 'font-size:1.6rem'), 'Fav Prize', topPrize[1].n + 'x', '#1e40af', topPrize[0])
      : '') +
    (bestDay
      ? _statTile('<i class="ph-duotone ph-calendar-star" style="color:#D97706"></i>', 'Best Family Day', `${bestDay[1]} gems`, '#d97706', fmtDate(bestDay[0]))
      : '') +
    _statTile('<i class="ph-duotone ph-arrow-u-down-left" style="color:#6B7280"></i>', 'Tasks Declined', declineHist.length, '#374151', 'by parents, all time') +
    (D.settings.notListeningEnabled !== false
      ? _statTile('<i class="ph-duotone ph-speaker-slash" style="color:#991B1B"></i>', 'Not-Listening Time', nlFmt, '#991b1b', 'total across all kids')
      : '');

  const funSection = funTiles.trim() ? _statSection('Fun Facts', funTiles) : '';

  const isExpanded = expandedOverride ?? _familyStatsExpanded;
  const caret = expandedOverride === null ? `<i class="ph-duotone ph-caret-${isExpanded?'up':'down'}" style="color:var(--muted);font-size:1.1rem;flex-shrink:0;margin-left:auto"></i>` : '';
  const headerAttrs = expandedOverride === null
    ? `onclick="toggleFamilyStats()" style="cursor:pointer;display:flex;align-items:center;gap:12px;margin-bottom:${isExpanded?'18':'0'}px"`
    : `style="display:flex;align-items:center;gap:12px;margin-bottom:18px"`;

  return `
    <div class="stats-panel-card stats-panel-family-card">
      <div ${headerAttrs}>
        <img src="gemsproutpadded.png" style="width:2.75rem;height:2.75rem;border-radius:14px;flex-shrink:0">
        <div>
          <div class="stats-panel-header-title">${esc(D.family.name || 'The Family')}</div>
          <div class="stats-panel-header-sub">${kids.length} kid${kids.length !== 1 ? 's' : ''} &middot; all-time combined stats</div>
        </div>
        ${caret}
      </div>
      ${isExpanded ? `${overviewSection}${savingsOverview}${funSection}` : ''}
    </div>`;
}

function renderMemberStatsCard(member, collapse, histIdx) {
  // collapse = { isExpanded: bool, toggleFn: string } | null (null = always expanded, no toggle)
  const s = buildMemberStats(member, histIdx);
  const color = member.color || '#6C63FF';
  const tts = (isTiny(member) && S.currentUser?.id === member.id) ? (t) => t : () => '';

  const choresSection = _statSection('Routine & Gems',
    _statTile('<i class="ph-duotone ph-check-circle" style="color:#16A34A"></i>','Tasks Done', s.choreDone, '#166534', '', tts(`${s.choreDone} tasks done.`)) +
    _statTile('<i class="ph-duotone ph-diamond" style="color:#D97706"></i>','Gems Earned', s.diamondsEarned, '#92400e', '', tts(`You have earned ${s.diamondsEarned} gems.`)) +
    _statTile('<i class="ph-duotone ph-sparkle" style="color:#7C3AED"></i>','Total XP', s.totalXP, '#4c1d95', '', tts(`You have ${s.totalXP} total X P.`))
  );

  const _levelTiles = (D.settings.levelingEnabled !== false ? _statTile('<i class="ph-duotone ph-trophy" style="color:#D97706"></i>','Level', `${s.currentLevel.icon} ${s.currentLevel.level}`, color, s.currentLevel.name, tts(`You are level ${s.currentLevel.level}, ${s.currentLevel.name}.`)) : '') +
    (D.settings.streakEnabled !== false ? _statTile('<i class="ph-duotone ph-fire" style="color:#F97316"></i>','Best Streak', `${s.bestStreak}d`, '#b45309', s.currentStreak > 0 ? `${s.currentStreak}d now` : '', tts(`Your best streak is ${s.bestStreak} days.${s.currentStreak > 0 ? ` You are on a ${s.currentStreak} day streak right now!` : ''}`)) : '') +
    (D.settings.streakEnabled !== false ? _statTile('<i class="ph-duotone ph-lightning" style="color:#F59E0B"></i>','Best Combo Streak', `${s.bestComboStreak}d`, '#92400E', s.currentComboStreak > 0 ? `${s.currentComboStreak}d now` : '', tts(`Your best combo streak is ${s.bestComboStreak} days.`)) : '') +
    _statTile('<i class="ph-duotone ph-calendar-check" style="color:#0E7490"></i>','Days Active', s.daysActive, '#0e7490', '', tts(`You have been active for ${s.daysActive} days.`));
  const levelSection = _levelTiles.trim() ? _statSection('Level & Streaks', _levelTiles) : '';

  const rewardSection = _statSection('Rewards & Combos',
    _statTile('<i class="ph-duotone ph-gift" style="color:#1D4ED8"></i>','Prizes Won', s.rewardCount, '#1e40af', '', tts(`You have won ${s.rewardCount} prize${s.rewardCount !== 1 ? 's' : ''}.`)) +
    _statTile('<i class="ph-duotone ph-lightning" style="color:#F59E0B"></i>','Combos Hit', s.comboCount, '#b45309', `+${s.comboDiamonds} bonus gems`, tts(`You have hit ${s.comboCount} combo${s.comboCount !== 1 ? 's' : ''}.`)) +
    _statTile('<i class="ph-duotone ph-shopping-cart" style="color:#374151"></i>','Gems Spent', s.diamondsSpent, '#374151', 'on prizes', tts(`You have spent ${s.diamondsSpent} gems on prizes.`))
  );

  const cur = D.settings.currency || '$';
  const savingsSection = D.settings.savingsEnabled !== false ? _statSection('Savings Jar',
    _statTile('<i class="ph-duotone ph-piggy-bank" style="color:#16A34A"></i>', 'Balance', `${cur}${(s.savings||0).toFixed(2)}`, '#166534', 'current', tts(`You have ${cur}${(s.savings||0).toFixed(2)} in savings.`)) +
    _statTile('<i class="ph-duotone ph-arrow-circle-down" style="color:#2563EB"></i>', 'Total Deposited', `${cur}${(s.totalDeposited||0).toFixed(2)}`, '#1e40af', 'all time') +
    _statTile('<i class="ph-duotone ph-shopping-bag" style="color:#6C63FF"></i>', 'Total Spent', `${cur}${(s.totalWithdrawn||0).toFixed(2)}`, '#4c1d95', 'from savings')
  ) : '';

  const earnedBadgeSet = new Set((member.badges||[]).filter(b => b.startsWith('cb_')));
  const choreBadgeItems = [];
  for (const chore of D.chores) {
    for (const b of (chore.badges||[])) {
      const key = `cb_${b.id}`;
      const have = earnedBadgeSet.has(key);
      if (!have && b.secret) continue;
      choreBadgeItems.push({ b, chore, have });
    }
  }
  const choreBadgeGrid = choreBadgeItems.length === 0 ? '' : `
    <div style="margin-bottom:18px">
      <div style="font-size:0.78rem;font-weight:800;text-transform:uppercase;letter-spacing:0.06em;color:#9ca3af;margin-bottom:8px"><i class="ph-duotone ph-medal" style="color:#7C3AED;vertical-align:middle"></i> Task Badges</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        ${choreBadgeItems.map(({b, chore, have}) =>
          `<div class="badge-chip ${have?'earned':'badge-chip-locked'}" title="${esc(chore.title)} - ${b.count}">
            <span class="badge-chip-icon">${b.icon||'<i class="ph-duotone ph-medal" style="color:#F59E0B"></i>'}</span>${esc(b.name||'')}</div>`
        ).join('')}
      </div>
    </div>`;

  const badgeSection = D.settings.levelingEnabled !== false ? _statSection('Achievements',
    _statTile('<i class="ph-duotone ph-medal" style="color:#7C3AED"></i>','Badges', s.badgeCount, '#7c3aed', '', tts(`You have ${s.badgeCount} badge${s.badgeCount !== 1 ? 's' : ''}.`)) +
    _statTile('<i class="ph-duotone ph-trend-up" style="color:#0F766E"></i>','Level-Ups', s.levelUps, '#0f766e', '', tts(`You have leveled up ${s.levelUps} time${s.levelUps !== 1 ? 's' : ''}.`)) +
    _statTile('<i class="ph-duotone ph-chart-bar" style="color:#374151"></i>','Avg/Day', s.avgChoresPerDay, '#374151', 'tasks per active day', tts(`You average ${s.avgChoresPerDay} tasks per day.`))
  ) : '';

  const penaltySection = _statSection('Penalties',
    _statTile('<i class="ph-duotone ph-speaker-slash" style="color:#991B1B"></i>','Penalties', s.penaltyCount, '#991b1b', '', tts(`You have had ${s.penaltyCount} penalty${s.penaltyCount !== 1 ? 's' : ''}.`)) +
    _statTile('<i class="ph-duotone ph-diamond" style="color:#EF4444"></i>','Gems Deducted', s.penaltyAmount, '#991b1b', '', tts(`You have had ${s.penaltyAmount} gems deducted.`)) +
    _statTile('<i class="ph-duotone ph-timer" style="color:#B45309"></i>','NL Time', s.nlFmt, '#b45309', 'lifetime', tts((() => {
      const ns = s.nlLifetimeSecs || 0;
      if (ns === 0) return 'No not-listening time. Great job!';
      const hrs = Math.floor(ns / 3600), mins = Math.floor((ns % 3600) / 60), secs = ns % 60;
      if (hrs > 0) return `${hrs} hour${hrs!==1?'s':''} and ${mins} minute${mins!==1?'s':''} of not-listening time.`;
      if (mins > 0 && secs > 0) return `${mins} minute${mins!==1?'s':''} and ${secs} second${secs!==1?'s':''} of not-listening time.`;
      if (mins > 0) return `${mins} minute${mins!==1?'s':''} of not-listening time.`;
      return `${secs} second${secs!==1?'s':''} of not-listening time.`;
    })()))
  );

  const bestDaySub = s.bestDate ? `${fmtDate(s.bestDate.date)} &middot; ${s.bestDate.dmds} gems` : 'No data yet';
  const favChoreSub = s.favChore ? `${s.favChore[1]}x completed` : 'No tasks yet';
  const extraSection = _statSection('Fun Facts',
    _statTile('<i class="ph-duotone ph-calendar-star" style="color:#D97706"></i>','Best Day', s.bestDate ? `${s.bestDate.dmds} gems` : 'None', '#d97706', bestDaySub, tts(s.bestDate ? `Your best day was ${s.bestDate.dmds} gems.` : `No best day yet.`)) +
    _statTile('<i class="ph-duotone ph-heart" style="color:#DB2777"></i>','Fav Chore', s.favChore ? `${s.favChore[0].split(' ')[0]}` : 'None', '#db2777', favChoreSub, tts(s.favChore ? `Your favorite chore is ${s.favChore[0]}.` : `No favorite chore yet.`)) +
    _statTile('<i class="ph-duotone ph-arrow-u-down-left" style="color:#6B7280"></i>','Declined', s.declineCount, '#374151', 'tasks declined', '')
  );

  // Chore breakdown table
  const choreTableRows = s.choreBreakdown.map(([name,count]) => [name, count]);
  const choreTable = `
    <div class="stats-panel-section">
      <div class="stats-panel-section-title"><i class="ph-duotone ph-clipboard-text" style="color:#9CA3AF;vertical-align:middle"></i> Chore Breakdown</div>
      ${_statBreakdownTable(choreTableRows.slice(0,10), 'Chore', 'times')}
    </div>`;

  // Prize breakdown table
  const prizeTable = `
    <div class="stats-panel-section">
      <div class="stats-panel-section-title"><i class="ph-duotone ph-gift" style="color:#FF6584;vertical-align:middle"></i> Prize Breakdown</div>
      ${s.prizeBreakdown.length
        ? `<table class="stats-panel-table">
            ${s.prizeBreakdown.slice(0,10).map(([name,info],i) => `
              <tr>
                <td class="${i===0?'top-row':''}">${renderIcon(info.icon)} ${esc(name)}</td>
                <td style="padding:5px 4px;text-align:right;font-weight:700;color:#6C63FF">${info.count}x</td>
              </tr>`).join('')}
          </table>`
        : '<div class="stats-panel-empty">No prizes redeemed yet</div>'
      }
    </div>`;

  const caret = collapse ? `<i class="ph-duotone ph-caret-${collapse.isExpanded?'up':'down'}" style="color:var(--muted);font-size:1.1rem;flex-shrink:0;margin-left:auto"></i>` : '';
  const headerClick = collapse ? `onclick="${collapse.toggleFn}" style="cursor:pointer;display:flex;align-items:center;gap:12px;margin-bottom:${collapse.isExpanded?'18':'0'}px"` : `style="display:flex;align-items:center;gap:12px;margin-bottom:18px"`;

  return `
    <div class="stats-panel-card" style="--stats-accent:${color}">
      <div ${headerClick}>
        <span style="font-size:2.5rem;width:2.5rem;text-align:center;flex-shrink:0">${renderMemberAvatarHtml(member)}</span>
        <div>
          <div class="stats-panel-header-title">${esc(member.name)}</div>
          <div class="stats-panel-header-sub">${D.settings.levelingEnabled !== false ? `${s.currentLevel.icon} ${s.currentLevel.name} &middot; ` : ''}${s.totalEarned} total gems earned</div>
        </div>
        ${caret}
      </div>
      ${collapse && !collapse.isExpanded ? '' : `
      ${choresSection}
      ${levelSection}
      ${rewardSection}
      ${savingsSection}
      ${badgeSection}
      ${choreBadgeGrid}
      ${penaltySection}
      ${extraSection}
      ${choreTable}
      ${prizeTable}
      `}
    </div>`;
}

function buildHistoryIndex() {
  const idx = new Map();
  for (const h of (D.history || [])) {
    if (!idx.has(h.memberId)) idx.set(h.memberId, []);
    idx.get(h.memberId).push(h);
  }
  return idx;
}

function renderStatsPage(container) {
  if (!container) return;
  container.classList.add('stats-page-content');
  const viewer = S.currentUser;
  const isKid  = viewer?.role === 'kid';
  const tinyKid = isKid && isTiny(viewer);
  const kids   = D.family.members.filter(m => m.role === 'kid' && !m.deleted);
  const histIdx = buildHistoryIndex();

  let html = `<div><div class="section-row"><span class="section-title"${tinyKid ? ` onclick="speak('Lifetime stats. Tap any card to hear more.')"` : ''}><i class="ph-duotone ph-chart-bar" style="color:#6C63FF;font-size:1rem;vertical-align:middle"></i> Lifetime Stats</span></div>`;

  if (isKid) {
    html += renderMemberStatsCard(viewer, null, histIdx);
  } else {
    if (kids.length === 0) {
      html += `<div class="empty-state"><div class="empty-icon"><i class="ph-duotone ph-smiley" style="color:#9CA3AF;font-size:3rem"></i></div><div class="empty-text">No kids added yet</div></div>`;
    } else {
      html += `<div class="stats-launch-grid">`;
      html += renderFamilyStatsLaunchCard(kids, histIdx);
      kids.forEach((kid, index) => {
        html += renderMemberStatsLaunchCard(kid, histIdx, index % 2 === 1 ? 'right' : 'left');
      });
      html += `</div>`;
    }
  }

  html += `
    <div class="tab-end-cap tab-end-cap-gem" aria-hidden="true">
      <img src="gemsproutpadded.png" id="egg-gem" onclick="easterEggTap()" style="width:36px;height:36px;opacity:0.25;cursor:pointer;transition:transform 0.1s,opacity 0.2s">
    </div>
  </div>`;
  container.innerHTML = html;
  setTimeout(() => {
    try {
      const gem = document.getElementById('egg-gem');
      const cap = gem?.closest?.('.tab-end-cap-gem');
      const nav = document.querySelector('.nav-bar');
      const content = container;
      if (!gem || !cap || !nav || !content) return;
      const contentStyles = getComputedStyle(content);
      const contentPaddingBottom = parseFloat(contentStyles.paddingBottom) || 0;
      const navHeight = nav.offsetHeight || 0;
      const capHeight = cap.offsetHeight || 0;
      const visibleGap = Math.max(0, capHeight + contentPaddingBottom - navHeight);
      cap.style.setProperty('--stats-visible-gap', `${visibleGap}px`);
    } catch {}
  }, 0);
}

function renderFamilyStatsLaunchCard(kids, histIdx) {
  const kidIds = new Set(kids.map(k => k.id));
  const allHist = histIdx
    ? kids.flatMap(k => histIdx.get(k.id) || [])
    : (D.history || []).filter(h => kidIds.has(h.memberId));
  const choreHist = allHist.filter(h => h.type === 'chore');
  const totalDiamonds = kids.reduce((s, k) => s + (k.totalEarned || 0), 0);
  const totalPrizes = D.prizes.reduce((s, p) => s + (p.redemptions || []).length, 0);
  const totalSavings = kids.reduce((s, k) => s + (k.savings || 0), 0);
  const cur = D.settings.currency || '$';
  return `
    <button class="snapshot-summary-card stats-launch-card stats-launch-card-family" type="button" onclick="openStatsDetailPanel('family')" style="--stats-accent:#365e4f">
      <div class="stats-launch-head">
        <div class="stats-launch-avatar stats-launch-avatar-family"><img src="gemsproutpadded.png" alt="" style="width:100%;height:100%;border-radius:18px"></div>
        <div class="stats-launch-hero">
          <div class="stats-launch-name">${esc(D.family.name || 'The Family')}</div>
          <div class="stats-launch-sub">Family snapshot</div>
        </div>
      </div>
      <div class="stats-launch-spotlight-grid">
        <div class="stats-launch-spotlight">
          <div class="stats-launch-spotlight-value">${totalDiamonds}</div>
          <div class="stats-launch-spotlight-label">Gems earned across the family</div>
        </div>
        <div class="stats-launch-spotlight">
          <div class="stats-launch-spotlight-value">${cur}${totalSavings.toFixed(2)}</div>
          <div class="stats-launch-spotlight-label">Current family savings</div>
        </div>
      </div>
      <div class="stats-launch-gridline">
        <span class="stats-launch-chip"><strong>${choreHist.length}</strong><small>Tasks</small></span>
        <span class="stats-launch-chip"><strong>${totalPrizes}</strong><small>Prizes</small></span>
        <span class="stats-launch-chip"><strong>${kids.length}</strong><small>Kids</small></span>
      </div>
    </button>`;
}

function renderMemberStatsLaunchCard(member, histIdx, side = 'left') {
  const s = buildMemberStats(member, histIdx);
  const streakValue = D.settings.streakEnabled !== false ? (member.streak?.current || 0) : 0;
  const cur = D.settings.currency || '$';
  return `
    <button class="snapshot-summary-card stats-launch-card" type="button" onclick="openStatsDetailPanel('kid','${member.id}','${side}')" style="--stats-accent:${member.color || '#6C63FF'}">
      <div class="stats-launch-head">
        <div class="stats-launch-avatar">${renderMemberAvatarHtml(member)}</div>
        <div class="stats-launch-hero">
          <div class="stats-launch-name">${esc(member.name)}</div>
          <div class="stats-launch-sub">
            ${D.settings.levelingEnabled !== false ? `${s.currentLevel.icon}<span>${s.currentLevel.name}</span>` : `${s.choreDone} tasks completed`}
          </div>
        </div>
      </div>
      <div class="stats-launch-spotlight">
        <div class="stats-launch-spotlight-value">${s.diamondsEarned}</div>
        <div class="stats-launch-spotlight-label">Lifetime gems earned</div>
      </div>
      <div class="stats-launch-spotlight">
        <div class="stats-launch-spotlight-value">${cur}${(s.savings || 0).toFixed(2)}</div>
        <div class="stats-launch-spotlight-label">Current savings</div>
      </div>
      <div class="stats-launch-gridline stats-launch-gridline-2x2">
        <span class="stats-launch-chip"><strong>${s.choreDone}</strong><small>Tasks</small></span>
        <span class="stats-launch-chip"><strong>${streakValue}</strong><small>Streak</small></span>
        <span class="stats-launch-chip"><strong>${s.rewardCount}</strong><small>Prizes</small></span>
        <span class="stats-launch-chip"><strong>${s.totalXP}</strong><small>Total XP</small></span>
      </div>
    </button>`;
}

function renderStatsDetailPanel(kind, memberId = '') {
  const histIdx = buildHistoryIndex();
  if (kind === 'family') {
    const kids = D.family.members.filter(m => m.role === 'kid' && !m.deleted);
    return `
      <div class="snapshot-panel-head stats-panel-head" style="--snapshot-accent:#6C63FF">
        <button class="snapshot-panel-close" onclick="closeFamilySnapshot()"><i class="ph-duotone ph-arrow-left"></i></button>
        <div class="snapshot-panel-person">
          <div class="snapshot-panel-avatar"><img src="gemsproutpadded.png" alt="" style="width:100%;height:100%;border-radius:20px"></div>
          <div>
            <div class="snapshot-panel-name">${esc(D.family.name || 'The Family')}</div>
            <div class="snapshot-panel-sub">Combined lifetime stats</div>
          </div>
        </div>
      </div>
      <div class="snapshot-panel-body stats-panel-body">${renderFamilyStatsCard(kids, histIdx, true)}</div>`;
  }
  const member = getMember(memberId);
  if (!member) return '';
  return `
    <div class="snapshot-panel-head stats-panel-head" style="--snapshot-accent:${member.color || '#6C63FF'}">
      <button class="snapshot-panel-close" onclick="closeFamilySnapshot()"><i class="ph-duotone ph-arrow-left"></i></button>
      <div class="snapshot-panel-person">
        <div class="snapshot-panel-avatar">${renderMemberAvatarHtml(member)}</div>
        <div>
          <div class="snapshot-panel-name">${esc(member.name)}</div>
          <div class="snapshot-panel-sub">Lifetime stats</div>
        </div>
      </div>
    </div>
    <div class="snapshot-panel-body stats-panel-body">${renderMemberStatsCard(member, null, histIdx)}</div>`;
}

function openStatsDetailPanel(kind, memberId = '', side = 'left') {
  showModal(renderStatsDetailPanel(kind, memberId), {
    overlayClass: 'snapshot-panel-overlay',
    modalClass: `snapshot-panel snapshot-panel-${side} stats-detail-panel`
  });
}

// -- PARENT HOME (OVERVIEW) -------------------------------------
const _expandedSlots     = new Set();
const _expandedKids      = new Set();
const _expandedStatsKids = new Set();
let _familyStatsExpanded = false;
const _expandedChores    = new Set();
let _snapshotSwipeSuppressTapUntil = 0;
let _parentQuickHoldTimer = null;
let _parentQuickFanOpen = false;
let _parentQuickHover = null;
let _parentQuickSuppressClick = false;
let _parentQuickCloseTimer = null;
let _modalLaunchOrigin = null;
let _activeFamilySnapshot = null;
let _snapshotTimePicker = null;
let _snapshotTimePickerCloseTimer = null;
let _snapshotTimePickerSuppressCloseUntil = 0;
let _tinySnapshotSlotConfirm = null;
let _snapshotSwipeDismissHandlersBound = false;
let _snapshotSummaryReveal = new Set();
let _snapshotSummarySwipeSession = null;
let _snapshotSummaryDismissHandlersBound = false;
let _snapshotSummarySuppressHintBounceOnce = false;

function toggleSlotExpand(key) {
  if (_expandedSlots.has(key)) _expandedSlots.delete(key);
  else _expandedSlots.add(key);
  renderParentHome();
}
function toggleChoreExpand(id) {
  if (_expandedChores.has(id)) _expandedChores.delete(id);
  else _expandedChores.add(id);
  renderParentChores();
}
function toggleKidSection(kidId) {
  if (_expandedKids.has(kidId)) _expandedKids.delete(kidId);
  else _expandedKids.add(kidId);
  renderParentHome();
}
function openFamilySnapshot(kidId, side = 'left') {
  const kid = getMember(kidId);
  if (!kid) return;
  _activeFamilySnapshot = { kidId, side };
  _snapshotTimePicker = null;
  showModal(renderFamilySnapshotPanel(kidId), {
    overlayClass: 'snapshot-panel-overlay',
    modalClass: `snapshot-panel snapshot-panel-${side}`
  });
  if (D.settings.tooltipBounceEnabled !== false) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const first = document.querySelector('#modal-sheet .snapshot-chore-stack .snapshot-routine-shell');
      if (!first) return;
      first.classList.remove('hint-bounce');
      void first.offsetWidth;
      first.classList.add('hint-bounce');
      setTimeout(() => first.classList.remove('hint-bounce'), 2200);
    }));
  }
}
function renderFamilySnapshotPanel(kidId) {
  const kid = getMember(kidId);
  if (!kid) return '';
  const myChores = D.chores.filter(c => c.assignedTo?.includes(kid.id)).sort((a,b)=>(a.gems||0)-(b.gems||0)||(a.title||'').localeCompare(b.title||''));
  const doneCount = myChores.filter(c=>choreStatus(c,kid.id)==='done').length;
  const pendCount = myChores.filter(c=>choreStatus(c,kid.id)==='pending').length;
  const pct = myChores.length>0 ? Math.round(doneCount/myChores.length*100) : 0;
  const kidCombo = D.settings.comboEnabled !== false ? new Set(getDailyCombo(kid.id)) : new Set();
  const cur = D.settings.currency || '$';
  const pickerChore = _snapshotTimePicker?.memberId === kid.id ? myChores.find(c => c.id === _snapshotTimePicker.choreId) : null;
  const pickerHtml = pickerChore ? renderSnapshotTimePicker(pickerChore, kid) : '';
  const choreRows = myChores.length === 0
    ? `<div class="empty-state" style="padding:22px 8px"><div class="empty-text">No rhythms assigned</div></div>`
    : `<div class="kid-overview-list snapshot-chore-stack">${myChores.map(chore => {
        const progress = getChoreProgress(chore, kid.id);
        const status = progress.status;
        const isDone = status === 'done';
        const isCombo = kidCombo.has(chore.id);
        const swipeKey = `snapshot_${kid.id}_${chore.id}`;
        const slotPickerOpen = _snapshotTimePicker?.memberId === kid.id && _snapshotTimePicker?.choreId === chore.id;
        let actionBtn, revealToneClass = 'approve';
        if (progress.isSlotMode) {
          revealToneClass = 'secondary';
          actionBtn = `<button class="snapshot-reveal-btn snapshot-reveal-btn-secondary" type="button" title="View times" onpointerdown="return handleSnapshotTimesTrigger(event,'${chore.id}','${kid.id}', this)" onclick="return false;"><i class="ph-duotone ph-clock"></i><span>${slotPickerOpen ? 'Close' : 'Times'}</span></button>`;
        } else {
          revealToneClass = isDone ? 'danger' : 'approve';
          actionBtn = isDone
            ? `<button class="snapshot-reveal-btn snapshot-reveal-btn-danger" type="button" title="Remove completion" onclick="event.stopPropagation();parentUnmarkChoreDone('${chore.id}','${kid.id}')"><i class="ph-duotone ph-arrow-counter-clockwise"></i><span>Undo</span></button>`
            : `<button class="snapshot-reveal-btn snapshot-reveal-btn-approve" type="button" title="Mark done (award gems)" onclick="event.stopPropagation();parentMarkChoreDone('${chore.id}','${kid.id}')"><i class="ph-duotone ph-check-circle"></i><span>Done</span></button>`;
        }
        return `
          <div class="snapshot-routine-shell" data-swipe-id="${swipeKey}">
            <div class="snapshot-routine-reveal snapshot-routine-reveal-${revealToneClass}">${actionBtn}</div>
            <div class="snapshot-routine-card ${isDone ? 'done' : status === 'partial' ? 'pending' : status === 'pending' ? 'pending' : status === 'unavailable' ? 'unavailable' : ''}${isCombo ? ' combo-chore' : ''}" onpointerdown="startSnapshotSwipe(event,'${swipeKey}')" onpointermove="moveSnapshotSwipe(event)" onpointerup="endSnapshotSwipe(event)" onpointercancel="cancelSnapshotSwipe()" onclick="return handleSnapshotCardTap(event,'${swipeKey}')">
              ${isCombo ? '<div class="snapshot-routine-combo-label">Combo</div>' : ''}
              <div class="snapshot-routine-top">
                <div class="snapshot-routine-main">
                  <div class="snapshot-routine-title-row">
                    <div class="snapshot-routine-title">${esc(chore.title)}</div>
                    <div class="snapshot-routine-diamond-badge"><span class="snapshot-routine-glyph-main">${renderIcon(chore.icon,chore.iconColor)}</span><span class="snapshot-routine-glyph-badge">${chore.diamonds || 0}</span></div>
                    <div class="snapshot-routine-utility">
                      <button class="snapshot-routine-swipe-hint" type="button" aria-label="Reveal action" onclick="event.stopPropagation();toggleSnapshotSwipe('${swipeKey}')">
                        <i class="ph-duotone ph-caret-double-left"></i>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>`;
      }).join('')}</div>`;
  return `
    <div class="snapshot-panel-head" style="--snapshot-accent:${kid.color||'#6C63FF'}">
      <button class="snapshot-panel-close" onclick="closeFamilySnapshot()"><i class="ph-duotone ph-arrow-left"></i></button>
      <div>
        <div class="snapshot-panel-person">
          <div class="snapshot-panel-avatar">${renderMemberAvatarHtml(kid, '??')}</div>
          <div>
            <div class="snapshot-panel-name">${esc(kid.name)}</div>
            <div class="snapshot-panel-sub">${doneCount}/${myChores.length} tasks wrapped up${pendCount>0?` ? ${pendCount} waiting`:''}</div>
          </div>
        </div>
        <div class="snapshot-panel-stats">
          <span class="snapshot-panel-stat"><strong>${kid.diamonds||0}</strong><small>Gems</small></span>
          ${D.settings.savingsEnabled!==false?`<span class="snapshot-panel-stat"><strong>${cur}${(kid.savings||0).toFixed(2)}</strong><small>Savings</small></span>`:''}
          <span class="snapshot-panel-stat"><strong>${pct}%</strong><small>On track</small></span>
        </div>
      </div>
    </div>
    <div class="snapshot-panel-body">
      ${choreRows}
      ${pickerHtml}
    </div>`;
}
function openSnapshotTimes(choreId, memberId, triggerEl) {
  clearTimeout(_snapshotTimePickerCloseTimer);
  const triggerRect = triggerEl?.getBoundingClientRect?.();
  if (_snapshotTimePicker?.choreId === choreId && _snapshotTimePicker?.memberId === memberId && _snapshotTimePicker?.phase === 'open') {
    closeSnapshotTimes();
    return;
  }
  _snapshotTimePickerSuppressCloseUntil = Date.now() + 240;
  _snapshotTimePicker = {
    choreId,
    memberId,
    phase: 'opening',
    originX: triggerRect ? Math.round(triggerRect.left + triggerRect.width / 2) : Math.round(window.innerWidth / 2),
    originY: triggerRect ? Math.round(triggerRect.top + triggerRect.height / 2) : Math.round(window.innerHeight / 2),
    anchorTop: triggerRect ? Math.max(20, Math.round(triggerRect.top - 24)) : Math.round(window.innerHeight * 0.35)
  };
  closeAllSnapshotSwipes();
  refreshSnapshotTimeHost({ memberId });
  requestAnimationFrame(() => {
    if (!_snapshotTimePicker || _snapshotTimePicker.choreId !== choreId || _snapshotTimePicker.memberId !== memberId) return;
    _snapshotTimePicker.phase = 'open';
    document.querySelector('.snapshot-time-picker-shell')?.classList.add('open');
  });
}
function handleSnapshotTimesTrigger(ev, choreId, memberId, triggerEl) {
  ev?.preventDefault?.();
  ev?.stopPropagation?.();
  openSnapshotTimes(choreId, memberId, triggerEl);
  return false;
}
function closeSnapshotTimes(force = false) {
  if (!force && Date.now() < _snapshotTimePickerSuppressCloseUntil) return;
  const memberId = _snapshotTimePicker?.memberId || _activeFamilySnapshot?.kidId;
  const shell = document.querySelector('.snapshot-time-picker-shell');
  if (!_snapshotTimePicker || !memberId) return;
  _tinySnapshotSlotConfirm = null;
  clearTimeout(_snapshotTimePickerCloseTimer);
  if (shell) {
    shell.classList.remove('open');
    shell.classList.add('closing');
    _snapshotTimePicker.phase = 'closing';
    _snapshotTimePickerCloseTimer = setTimeout(() => {
      _snapshotTimePicker = null;
      refreshSnapshotTimeHost({ memberId });
    }, 220);
    return;
  }
  _snapshotTimePicker = null;
  _tinySnapshotSlotConfirm = null;
  refreshSnapshotTimeHost({ memberId });
}
function handleTinySnapshotTimeConfirm(choreId, memberId, slotId, slotLabel) {
  const currentKid = S.currentUser;
  if (!(currentKid?.role === 'kid' && currentKid.id === memberId && isTiny(currentKid))) {
    return handleSnapshotTimeAction('done', choreId, memberId, slotId);
  }
  const now = Date.now();
  const matchesCurrent = _tinySnapshotSlotConfirm
    && _tinySnapshotSlotConfirm.choreId === choreId
    && _tinySnapshotSlotConfirm.memberId === memberId
    && _tinySnapshotSlotConfirm.slotId === slotId
    && _tinySnapshotSlotConfirm.expiresAt > now;
  if (matchesCurrent) {
    _tinySnapshotSlotConfirm = null;
    return handleSnapshotTimeAction('done', choreId, memberId, slotId);
  }
  _tinySnapshotSlotConfirm = {
    choreId,
    memberId,
    slotId,
    expiresAt: now + 6000
  };
  speak(`${slotLabel}. Tap again to mark it done.`);
  return false;
}
function handleSnapshotTimeAction(mode, choreId, memberId, slotId) {
  const shell = document.querySelector('.snapshot-time-picker-shell');
  const currentKid = S.currentUser;
  const isKidSelf = currentKid?.role === 'kid' && currentKid.id === memberId;
  const run = () => {
    if (isKidSelf) {
      if (mode === 'done') kidCompleteChore(choreId, null, slotId);
      else refreshSnapshotTimeHost({ memberId });
      return;
    }
    if (mode === 'undo') parentUnmarkSlotDone(choreId, memberId, slotId);
    else parentMarkSlotDone(choreId, memberId, slotId);
  };
  if (!shell) {
    _snapshotTimePicker = null;
    run();
    return false;
  }
  clearTimeout(_snapshotTimePickerCloseTimer);
  shell.classList.remove('open');
  shell.classList.add('closing');
  if (_snapshotTimePicker) _snapshotTimePicker.phase = 'closing';
  _snapshotTimePickerCloseTimer = setTimeout(() => {
    _snapshotTimePicker = null;
    if (isKidSelf) {
      refreshSnapshotTimeHost({ memberId });
      requestAnimationFrame(() => run());
      return;
    }
    run();
  }, 220);
  return false;
}
function renderSnapshotTimePicker(chore, kid) {
  const progress = getChoreProgress(chore, kid.id);
  const currentKid = S.currentUser;
  const isKidSelf = currentKid?.role === 'kid' && currentKid.id === kid.id;
  const isTinyKidSelf = isKidSelf && isTiny(currentKid);
  const slotStatuses = progress.slotStatuses || [];
  const orbLayoutClass = slotStatuses.length <= 3 ? 'wide' : 'compact';
  const buttons = slotStatuses.map(({ slot, status }, idx) => {
    const slotLabel = formatSlotLabel(slot) || 'Time';
    const stateClass = status === 'done' ? 'done' : status === 'pending' ? 'pending' : status === 'waiting' ? 'later' : 'todo';
    const iconClass = status === 'done'
      ? (isKidSelf ? 'ph-check-circle' : 'ph-arrow-counter-clockwise')
      : status === 'waiting'
        ? 'ph-clock'
        : 'ph-check-circle';
    const disabled = status === 'pending' || status === 'done' || status === 'waiting'
      ? (isTinyKidSelf ? '' : 'disabled')
      : '';
    const action = status === 'done'
      ? (isTinyKidSelf
          ? `speak('${esc(slotLabel).replace(/'/g,"\\'")}. Already done.'); return false;`
          : isKidSelf
            ? ''
            : `return handleSnapshotTimeAction('undo','${chore.id}','${kid.id}','${slot.id}')`)
      : status === 'pending'
        ? (isTinyKidSelf ? `speak('${esc(slotLabel).replace(/'/g,"\\'")}. Waiting for your grown-up.'); return false;` : '')
        : status === 'waiting'
          ? (isTinyKidSelf ? `speak('${esc(slotLabel).replace(/'/g,"\\'")}. Not available right now.'); return false;` : '')
        : (isTinyKidSelf
            ? `return handleTinySnapshotTimeConfirm('${chore.id}','${kid.id}','${slot.id}','${esc(slotLabel).replace(/'/g,"\\'")}')`
            : `return handleSnapshotTimeAction('done','${chore.id}','${kid.id}','${slot.id}')`);
    const clickAttr = action ? `onclick="${action}"` : '';
    return `<button class="snapshot-time-orb ${stateClass}" style="--slot-index:${idx}" type="button" ${clickAttr} ${disabled}><i class="ph-duotone ${iconClass}" aria-hidden="true"></i><span class="snapshot-time-orb-label">${esc(slotLabel)}</span></button>`;
  }).join('');
  const originX = _snapshotTimePicker?.originX ?? Math.round(window.innerWidth / 2);
  const originY = _snapshotTimePicker?.originY ?? Math.round(window.innerHeight / 2);
  const anchorTop = _snapshotTimePicker?.anchorTop ?? Math.round(window.innerHeight * 0.35);
  const phaseClass = _snapshotTimePicker?.phase === 'closing' ? 'closing' : _snapshotTimePicker?.phase === 'open' ? 'open' : '';
  return `<div class="snapshot-time-picker-shell ${phaseClass}" style="--picker-origin-x:${originX}px;--picker-origin-y:${originY}px;--picker-anchor-top:${anchorTop}px" onclick="closeSnapshotTimes()"><div class="snapshot-time-orb-grid snapshot-time-orb-grid-${orbLayoutClass}" onclick="event.stopPropagation()">${buttons || '<div class="empty-text">No times configured</div>'}</div></div>`;
}
function refreshOpenFamilySnapshot(opts = {}) {
  const active = _activeFamilySnapshot;
  const sheet = document.getElementById('modal-sheet');
  if (!active || !sheet || !sheet.classList.contains('snapshot-panel')) return;
  if (opts.memberId && active.kidId !== opts.memberId) return;

  const rerender = () => {
    const body = sheet.querySelector('.snapshot-panel-body');
    const scrollTop = body ? body.scrollTop : 0;
    sheet.innerHTML = `<div class="modal-handle" id="modal-drag-handle"></div>${renderFamilySnapshotPanel(active.kidId)}`;
    const nextBody = sheet.querySelector('.snapshot-panel-body');
    if (nextBody) nextBody.scrollTop = scrollTop;
  };

  const swipeId = opts.choreId ? `snapshot_${opts.memberId}_${opts.choreId}` : null;
  const shell = swipeId ? document.querySelector(`.snapshot-routine-shell[data-swipe-id="${swipeId}"]`) : null;
  const card = shell ? shell.querySelector('.snapshot-routine-card') : null;

  if (opts.mode === 'mark-done' && shell && card) {
    shell.classList.remove('revealed');
    card.classList.add('done', 'snapshot-routine-committing');
    setTimeout(rerender, 240);
    return;
  }

  if (shell) shell.classList.remove('revealed');
  rerender();
}
function refreshSnapshotTimeHost(opts = {}) {
  const active = _activeFamilySnapshot;
  const sheet = document.getElementById('modal-sheet');
  if (active && sheet && sheet.classList.contains('snapshot-panel')) {
    refreshOpenFamilySnapshot(opts);
    return;
  }
  const currentKid = S.currentUser;
  if (currentKid?.role === 'kid' && opts.memberId && currentKid.id === opts.memberId) {
    renderKidChores();
  }
}
function closeAllSnapshotSwipes(exceptId = null) {
  document.querySelectorAll('.snapshot-routine-shell.revealed').forEach(node => {
    if (exceptId && node.dataset.swipeId === exceptId) return;
    node.classList.remove('revealed');
  });
}
function _bindSnapshotSwipeAutoDismiss() {
  if (_snapshotSwipeDismissHandlersBound) return;
  const dismissIfNeeded = () => {
    if (!document.querySelector('.snapshot-routine-shell.revealed')) return;
    closeAllSnapshotSwipes();
  };
  document.addEventListener('pointerdown', ev => {
    if (!document.querySelector('.snapshot-routine-shell.revealed')) return;
    if (ev.target?.closest?.('.snapshot-routine-shell')) return;
    dismissIfNeeded();
  }, true);
  document.addEventListener('scroll', () => dismissIfNeeded(), true);
  document.addEventListener('wheel', () => dismissIfNeeded(), { passive: true });
  document.addEventListener('touchmove', () => dismissIfNeeded(), { passive: true });
  _snapshotSwipeDismissHandlersBound = true;
}
function toggleSnapshotSwipe(id) {
  _bindSnapshotSwipeAutoDismiss();
  const shell = document.querySelector(`.snapshot-routine-shell[data-swipe-id="${id}"]`);
  if (!shell) return;
  const willReveal = !shell.classList.contains('revealed');
  closeAllSnapshotSwipes(willReveal ? id : null);
  shell.classList.toggle('revealed', willReveal);
}
function handleSnapshotCardTap(ev, id) {
  if (Date.now() < _snapshotSwipeSuppressTapUntil) return false;
  if (ev.target?.closest?.('.snapshot-routine-reveal')) return false;
  toggleSnapshotSwipe(id);
  return false;
}
function startSnapshotSwipe(ev, id) {
  const shell = ev.currentTarget?.closest?.('.snapshot-routine-shell');
  if (!shell) return;
  ev.currentTarget?.setPointerCapture?.(ev.pointerId);
  const card = shell.querySelector('.snapshot-routine-card');
  closeAllSnapshotSwipes(shell.dataset.swipeId);
  _snapshotSwipeSession = {
    id,
    shell,
    card,
    startX: ev.clientX,
    startY: ev.clientY,
    lastX: ev.clientX,
    lastT: Date.now(),
    velocityX: 0,
    revealedAtStart: shell.classList.contains('revealed'),
    dragging: false,
    dx: 0
  };
}
function moveSnapshotSwipe(ev) {
  if (!_snapshotSwipeSession) return;
  const dx = ev.clientX - _snapshotSwipeSession.startX;
  const dy = ev.clientY - _snapshotSwipeSession.startY;
  const now = Date.now();
  const dt = Math.max(1, now - (_snapshotSwipeSession.lastT || now));
  const stepDx = ev.clientX - (_snapshotSwipeSession.lastX ?? ev.clientX);
  _snapshotSwipeSession.velocityX = stepDx / dt;
  _snapshotSwipeSession.lastX = ev.clientX;
  _snapshotSwipeSession.lastT = now;
  if (!_snapshotSwipeSession.dragging) {
    if (Math.abs(dx) < 1 || Math.abs(dx) < Math.abs(dy) * 0.18) return;
    _snapshotSwipeSession.dragging = true;
  }
  const shell = _snapshotSwipeSession.shell;
  const card = _snapshotSwipeSession.card;
  const shift = parseFloat(getComputedStyle(shell).getPropertyValue('--snapshot-reveal-shift')) || 100;
  const base = _snapshotSwipeSession.revealedAtStart ? -shift : 0;
  const clampedDx = _snapshotSwipeSession.revealedAtStart
    ? Math.max(shift * -0.2, Math.min(dx, shift))
    : Math.max(-shift, Math.min(dx, shift * 0.24));
  _snapshotSwipeSession.dx = clampedDx;
  if (card) {
    card.style.transition = 'none';
    card.style.transform = `translateX(${base + clampedDx}px)`;
  }
  ev.preventDefault?.();
}
function endSnapshotSwipe(ev) {
  if (!_snapshotSwipeSession) return;
  const dx = _snapshotSwipeSession.dragging
    ? _snapshotSwipeSession.dx
    : ev.clientX - _snapshotSwipeSession.startX;
  const shell = _snapshotSwipeSession.shell;
  const card = _snapshotSwipeSession.card;
  const resetCard = () => {
    if (!card) return;
    card.style.removeProperty('transition');
    card.style.removeProperty('transform');
  };
  if (_snapshotSwipeSession.dragging) {
    _snapshotSwipeSuppressTapUntil = Date.now() + 320;
    if (dx < 0) {
      closeAllSnapshotSwipes(shell.dataset.swipeId);
      shell.classList.add('revealed');
    } else if (dx > 0) {
      shell.classList.remove('revealed');
    } else {
      shell.classList.toggle('revealed', _snapshotSwipeSession.revealedAtStart);
    }
  }
  requestAnimationFrame(resetCard);
  _snapshotSwipeSession = null;
}
function cancelSnapshotSwipe() {
  const card = _snapshotSwipeSession?.card;
  if (card) {
    card.style.removeProperty('transition');
    card.style.removeProperty('transform');
  }
  _snapshotSwipeSession = null;
}
function closeAllSnapshotSummaryReveals(exceptId = null) {
  document.querySelectorAll('.snapshot-summary-shell.revealed').forEach(node => {
    if (exceptId && node.dataset.summaryId === exceptId) return;
    node.classList.remove('revealed');
    _snapshotSummaryReveal.delete(node.dataset.summaryId);
  });
}
function _bindSnapshotSummaryAutoDismiss() {
  if (_snapshotSummaryDismissHandlersBound) return;
  const dismissIfNeeded = () => {
    if (!_snapshotSummaryReveal.size) return;
    closeAllSnapshotSummaryReveals();
  };
  document.addEventListener('pointerdown', ev => {
    if (!_snapshotSummaryReveal.size) return;
    if (ev.target?.closest?.('.snapshot-summary-shell')) return;
    dismissIfNeeded();
  }, true);
  document.addEventListener('scroll', () => dismissIfNeeded(), true);
  document.addEventListener('wheel', () => dismissIfNeeded(), { passive: true });
  document.addEventListener('touchmove', () => dismissIfNeeded(), { passive: true });
  _snapshotSummaryDismissHandlersBound = true;
}
function handleSnapshotSummaryOpen(kidId, side) {
  closeAllSnapshotSummaryReveals();
  openFamilySnapshot(kidId, side);
}
function startSnapshotSummarySwipe(ev, id) {
  const shell = ev.currentTarget?.closest?.('.snapshot-summary-shell');
  if (!shell) return;
  ev.currentTarget?.setPointerCapture?.(ev.pointerId);
  const card = shell.querySelector('.snapshot-summary-card');
  closeAllSnapshotSummaryReveals(shell.dataset.summaryId);
  _snapshotSummarySwipeSession = {
    id,
    shell,
    card,
    startX: ev.clientX,
    startY: ev.clientY,
    revealedAtStart: shell.classList.contains('revealed'),
    dragging: false,
    dy: 0
  };
}
function moveSnapshotSummarySwipe(ev) {
  if (!_snapshotSummarySwipeSession) return;
  const dx = ev.clientX - _snapshotSummarySwipeSession.startX;
  const dy = ev.clientY - _snapshotSummarySwipeSession.startY;
  if (!_snapshotSummarySwipeSession.dragging) {
    if (dy < 8 || dy < Math.abs(dx)) return;
    _snapshotSummarySwipeSession.dragging = true;
  }
  const card = _snapshotSummarySwipeSession.card;
  const shift = 85;
  const base = _snapshotSummarySwipeSession.revealedAtStart ? shift : 0;
  const clampedDy = _snapshotSummarySwipeSession.revealedAtStart
    ? Math.max(-shift, Math.min(dy, 0))
    : Math.max(0, Math.min(dy, shift));
  _snapshotSummarySwipeSession.dy = clampedDy;
  if (card) {
    card.style.transition = 'none';
    card.style.transform = `translateY(${base + clampedDy}px)`;
  }
  ev.preventDefault?.();
}
function endSnapshotSummarySwipe(ev) {
  if (!_snapshotSummarySwipeSession) return;
  const dy = _snapshotSummarySwipeSession.dragging
    ? _snapshotSummarySwipeSession.dy
    : ev.clientY - _snapshotSummarySwipeSession.startY;
  const shell = _snapshotSummarySwipeSession.shell;
  const card = _snapshotSummarySwipeSession.card;
  const resetCard = () => {
    if (!card) return;
    card.style.removeProperty('transition');
    card.style.removeProperty('transform');
  };
  if (_snapshotSummarySwipeSession.dragging) {
    if (dy > 24) {
      closeAllSnapshotSummaryReveals(shell.dataset.summaryId);
      shell.classList.add('revealed');
      _snapshotSummaryReveal.add(shell.dataset.summaryId);
    } else if (dy < -18) {
      shell.classList.remove('revealed');
      _snapshotSummaryReveal.delete(shell.dataset.summaryId);
    } else {
      shell.classList.toggle('revealed', _snapshotSummarySwipeSession.revealedAtStart);
    }
  }
  requestAnimationFrame(resetCard);
  _snapshotSummarySwipeSession = null;
}
function cancelSnapshotSummarySwipe() {
  const card = _snapshotSummarySwipeSession?.card;
  if (card) {
    card.style.removeProperty('transition');
    card.style.removeProperty('transform');
  }
  _snapshotSummarySwipeSession = null;
}
function setOverviewTodayStatus(memberId, isHere) {
  const member = getMember(memberId);
  if (member?.splitHousehold) member.splitHousehold.overrides[today()] = isHere;
  saveData();
  closeAllSnapshotSummaryReveals();
  _snapshotSummarySuppressHintBounceOnce = true;
  renderParentHome();
}
function handleOverviewTodayStatusAction(ev, memberId, isHere) {
  ev?.preventDefault?.();
  ev?.stopPropagation?.();
  const shell = ev?.currentTarget?.closest?.('.snapshot-summary-shell');
  const apply = () => setOverviewTodayStatus(memberId, isHere);
  if (!shell) {
    apply();
    return false;
  }
  const reveal = shell.querySelector('.snapshot-summary-reveal');
  if (reveal) {
    reveal.classList.toggle('here', !!isHere);
    reveal.classList.toggle('away', !isHere);
  }
  const homeBtn = shell.querySelector('.snapshot-summary-toggle-btn.home');
  const awayBtn = shell.querySelector('.snapshot-summary-toggle-btn.away');
  if (homeBtn) homeBtn.classList.toggle('active', !!isHere);
  if (awayBtn) awayBtn.classList.toggle('active', !isHere);
  shell.classList.remove('revealed');
  _snapshotSummaryReveal.delete(shell.dataset.summaryId);
  setTimeout(apply, 220);
  return false;
}
function _parentQuickActions() {
  return [
    { id: 'listening', label: 'Not Listening', icon: 'ph-speaker-slash', tint: '#f6b4a8', enabled: D.settings.notListeningEnabled !== false, run: showNotListening },
    { id: 'savings', label: 'Savings', icon: 'ph-piggy-bank', tint: '#a8e6c0', enabled: D.settings.savingsEnabled !== false, run: showAdjustSavingsQuick },
    { id: 'diamonds', label: 'Gems', icon: 'ph-diamond', tint: '#f4d58d', enabled: true, run: showAdjustDiamondsQuick }
  ].filter(action => action.enabled);
}
function _clearParentQuickHold() {
  if (_parentQuickHoldTimer) {
    clearTimeout(_parentQuickHoldTimer);
    _parentQuickHoldTimer = null;
  }
}
function _setParentQuickHoverFromPoint(clientX, clientY) {
  if (!_parentQuickFanOpen) return;
  const el = document.elementFromPoint(clientX, clientY);
  const actionEl = el?.closest?.('.hero-quick-action');
  const nextHover = actionEl?.dataset?.action || null;
  if (nextHover !== _parentQuickHover) {
    _parentQuickHover = nextHover;
    document.querySelectorAll('.hero-quick-action').forEach(node => {
      node.classList.toggle('active', node.dataset.action === _parentQuickHover);
    });
  }
}
function _openParentQuickFan() {
  _clearParentQuickHold();
  const host = document.getElementById('parent-quick-launch');
  if (!host) return;
  clearTimeout(_parentQuickCloseTimer);
  host.classList.remove('closing');
  _parentQuickFanOpen = true;
  host.classList.add('open');
  host.setAttribute('aria-expanded', 'true');
  _layoutParentQuickFan();
}
function _closeParentQuickFan() {
  _clearParentQuickHold();
  const host = document.getElementById('parent-quick-launch');
  if (host) {
    host.classList.remove('open');
    host.classList.add('closing');
    host.setAttribute('aria-expanded', 'false');
    clearTimeout(_parentQuickCloseTimer);
    _parentQuickCloseTimer = setTimeout(() => host.classList.remove('closing'), 180);
  }
  _parentQuickFanOpen = false;
  _parentQuickHover = null;
  document.querySelectorAll('.hero-quick-action.active').forEach(node => node.classList.remove('active'));
}
function beginParentQuickLaunch(ev) {
  ev?.preventDefault?.();
  if (!_parentQuickActions().length) return;
  _clearParentQuickHold();
  _parentQuickHoldTimer = setTimeout(() => {
    _openParentQuickFan();
    if (typeof ev?.clientX === 'number' && typeof ev?.clientY === 'number') {
      _setParentQuickHoverFromPoint(ev.clientX, ev.clientY);
    }
  }, 220);
}
function moveParentQuickLaunch(ev) {
  if (!_parentQuickFanOpen || typeof ev?.clientX !== 'number' || typeof ev?.clientY !== 'number') return;
  _setParentQuickHoverFromPoint(ev.clientX, ev.clientY);
}
function endParentQuickLaunch(ev) {
  if (typeof ev?.clientX === 'number' && typeof ev?.clientY === 'number') {
    _setParentQuickHoverFromPoint(ev.clientX, ev.clientY);
  }
  const didOpen = _parentQuickFanOpen;
  const selectedId = didOpen ? _parentQuickHover : null;
  if (selectedId) {
    const selectedEl = document.querySelector(`.hero-quick-action[data-action="${selectedId}"]`);
    const rect = selectedEl?.getBoundingClientRect?.();
    if (rect) _modalLaunchOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }
  _parentQuickSuppressClick = didOpen;
  _closeParentQuickFan();
  if (!selectedId) return;
  const action = _parentQuickActions().find(item => item.id === selectedId);
  action?.run?.();
}
function cancelParentQuickLaunch() {
  _closeParentQuickFan();
}
function toggleParentQuickLaunch() {
  if (_parentQuickSuppressClick) {
    _parentQuickSuppressClick = false;
    return;
  }
  if (!_parentQuickActions().length) return;
  if (_parentQuickFanOpen) _closeParentQuickFan();
  else _openParentQuickFan();
}
function runParentQuickAction(actionId, el) {
  const action = _parentQuickActions().find(item => item.id === actionId);
  if (!action) return;
  const rect = el?.getBoundingClientRect?.();
  if (rect) _modalLaunchOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  _closeParentQuickFan();
  action.run?.();
}
function closeParentQuickFanIfBackdrop(ev) {
  if (ev?.target?.classList?.contains('hero-quick-fan')) _closeParentQuickFan();
}
function _layoutParentQuickFan() {
  const host = document.getElementById('parent-quick-launch');
  const trigger = host?.querySelector?.('.hero-quick-trigger');
  if (!host || !trigger) return;
  const rect = trigger.getBoundingClientRect();
  const positions = [
    { dx: -6, dy: 106 },
    { dx: -103, dy: 84 },
    { dx: -174, dy: 26 }
  ];
  host.querySelectorAll('.hero-quick-action').forEach((node, idx) => {
    const pos = positions[idx] || positions[positions.length - 1];
    const width = node.offsetWidth || 104;
    const maxLeft = Math.max(12, window.innerWidth - width - 12);
    const left = Math.min(maxLeft, Math.max(12, rect.right - width + pos.dx));
    const top = Math.min(window.innerHeight - 60, Math.max(12, rect.top + pos.dy));
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  });
}
function toggleStatsKid(kidId) {
  if (_expandedStatsKids.has(kidId)) _expandedStatsKids.delete(kidId);
  else _expandedStatsKids.add(kidId);
  renderStatsPage(document.getElementById('parent-content'));
}
function toggleFamilyStats() {
  _familyStatsExpanded = !_familyStatsExpanded;
  renderStatsPage(document.getElementById('parent-content'));
}

const BETA_WELCOME_KEY = 'gemsprout.betaWelcomeSeen';
function showBetaWelcomeIfNeeded() {
  if (!RC.betaMode) return;
  try { if (localStorage.getItem(BETA_WELCOME_KEY)) return; } catch(_) { return; }
  try { localStorage.setItem(BETA_WELCOME_KEY, '1'); } catch(_) {}
  showQuickActionModal(`
    <div style="text-align:center;margin-bottom:16px">
      <img src="gemsproutpadded.png" style="width:72px;height:72px;margin-bottom:8px">
      <div class="modal-title" style="margin-bottom:6px">Welcome to the GemSprout Beta!</div>
      <p style="color:var(--muted);font-size:0.88rem;line-height:1.5;margin-bottom:14px">
        Thank you so much for helping us shape GemSprout. Your feedback during this beta means everything.
      </p>
    </div>
    <div style="background:#F5F3FF;border-radius:12px;padding:14px;margin-bottom:10px">
      <div style="font-weight:700;font-size:0.9rem;margin-bottom:6px"><i class="ph-duotone ph-devices" style="color:#6C63FF;font-size:1rem;vertical-align:middle"></i> Installing on other devices</div>
      <p style="font-size:0.83rem;color:var(--muted);line-height:1.5;margin-bottom:8px">
        Open the link below on each device, install TestFlight if prompted, then install GemSprout. Your family code is shown in Settings.
      </p>
      <a href="${RC.appDownloadUrl}" target="_blank" style="font-size:0.82rem;font-weight:700;color:#6C63FF;word-break:break-all;text-decoration:none">${RC.appDownloadUrl}</a>
    </div>
    <div style="background:#F0FDF4;border-radius:12px;padding:14px;margin-bottom:14px">
      <div style="font-weight:700;font-size:0.9rem;margin-bottom:6px"><i class="ph-duotone ph-chat-text" style="color:#16A34A;font-size:1rem;vertical-align:middle"></i> Send us feedback</div>
      <p style="font-size:0.83rem;color:var(--muted);line-height:1.5;margin-bottom:8px">
        Found a bug or have a suggestion? We'd love to hear it.
      </p>
      <a href="mailto:beta@gemsprout.com" style="font-size:0.82rem;font-weight:700;color:#16A34A;text-decoration:none">beta@gemsprout.com</a>
    </div>
    <div class="modal-actions">
      <button class="btn btn-primary" style="width:100%" onclick="closeModal()">Got it - let's go!</button>
    </div>`);
}

function renderParentHome() {
  const kids        = D.family.members.filter(m=>m.role==='kid'&&!m.deleted);
  const pending     = pendingApprovals();
  const pendingSpend = pendingSpendRequests();
  const readyGoals  = readyTeamGoalInboxItems();
  const cur         = D.settings.currency || '$';
  const t           = today();
  const inProgress = inProgressChores();
  const totalSavings = kids.reduce((sum, kid) => sum + (kid.savings || 0), 0);
  const totalDiamonds = kids.reduce((sum, kid) => sum + (kid.gems || 0), 0);
  const finishedToday = kids.reduce((sum, kid) => sum + D.chores.filter(c => c.assignedTo?.includes(kid.id) && choreStatus(c, kid.id) === 'done').length, 0);
  const quickActions = _parentQuickActions();
  const quickActionsHtml = quickActions.map(action => `
      <button class="hero-quick-action" data-action="${action.id}" style="--fan-tint:${action.tint}" type="button" onclick="runParentQuickAction('${action.id}', this)">
        <i class="ph-duotone ${action.icon}" style="font-size:1rem"></i>
        <span>${action.label}</span>
      </button>`).join('');

  if (D.settings.interestDayNotify !== false && isInterestDay()) {
    const unclaimedKids = kids.filter(k => (k.savings || 0) > 0 && k.savingsInterestLastDate !== t);
    if (unclaimedKids.length > 0 && !S._interestParentToastShown) {
      S._interestParentToastShown = true;
      const names = unclaimedKids.map(k => k.name).join(', ');
      setTimeout(() => toast(`Interest day! Have ${names} open the app to claim.`, 5000), 800);
    }
  }

  let html = `
    <div class="parent-hero">
      <div class="parent-hero-head">
        <div>
          <div class="parent-hero-kicker">Family Control Center</div>
          <div class="parent-hero-title">Today at a glance</div>
          <div class="parent-hero-sub">See what needs review, how your kids are progressing, and where family momentum stands right now.</div>
        </div>
        ${quickActions.length ? `
          <div
            id="parent-quick-launch"
            class="hero-quick-launch"
            aria-expanded="false"
          >
            <button class="hero-quick-trigger" type="button" aria-label="Quick actions" onclick="toggleParentQuickLaunch()">
              <i class="ph-duotone ph-lightning"></i>
            </button>
            <div class="hero-quick-fan" onclick="closeParentQuickFanIfBackdrop(event)">${quickActionsHtml}</div>
          </div>` : ''}
      </div>
      <div class="parent-summary-grid">
        <div class="parent-summary-tile">
          <div class="parent-summary-label">Needs Review</div>
          <div class="parent-summary-value">${pending.length + pendingSpend.length}</div>
          <div class="parent-summary-sub">${inProgress.length} in progress</div>
        </div>
        <div class="parent-summary-tile">
          <div class="parent-summary-label">Finished Today</div>
          <div class="parent-summary-value">${finishedToday}</div>
          <div class="parent-summary-sub">across all kids</div>
        </div>
        <div class="parent-summary-tile">
          <div class="parent-summary-label">Gem Balance</div>
          <div class="parent-summary-value">${totalDiamonds}</div>
          <div class="parent-summary-sub">across all kids</div>
        </div>
        <div class="parent-summary-tile">
          <div class="parent-summary-label">Family Savings</div>
          <div class="parent-summary-value">${cur}${totalSavings.toFixed(2)}</div>
          <div class="parent-summary-sub">current balance</div>
        </div>
      </div>
    </div>`;

  if (inProgress.length > 0 || pending.length > 0 || pendingSpend.length > 0 || readyGoals.length > 0) {
    const inboxCount = pending.length + pendingSpend.length + inProgress.length + readyGoals.length;
    html += `<div class="inbox-head">
      <div class="inbox-title"><i class="ph-duotone ph-tray" style="color:#1D6B57;font-size:1rem"></i> Family Inbox</div>
      <div class="inbox-count">${inboxCount} Item${inboxCount === 1 ? '' : 's'}</div>
    </div>
    <div class="inbox-list">`;

    const allItems = [
      ...inProgress.map(item => {
        const beforeEntry = normalizeCompletionEntries(item.chore.completions?.[item.memberId]).find(e => e.entryType === 'before');
        return { type: 'inprogress', sortKey: beforeEntry?.id || '', ...item };
      }),
      ...pending.map(item => ({ type: 'pending', sortKey: item.entry.id, ...item })),
    ].sort((a, b) => a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0);

    allItems.forEach(item => {
      if (item.type === 'inprogress') {
        const { chore, memberId } = item;
        const mem = getMember(memberId);
        if (!mem) return;
        html += `
          <div class="admin-card">
            <span class="admin-icon">${renderIcon(chore.icon, chore.iconColor, 'font-size:1.6rem')}</span>
            <div class="admin-info" style="flex:1;min-width:0">
              <div class="admin-name">${esc(chore.title)} <span style="background:#DBEAFE;color:#1D4ED8;border-radius:6px;padding:2px 8px;font-size:0.75rem;font-weight:700;margin-left:6px">IN PROGRESS</span></div>
              <div class="admin-meta">${renderMemberAvatarHtml(mem)} ${esc(mem.name)} &middot; waiting for after photo &middot; ${chore.diamonds} gems</div>
            </div>
          </div>`;
        return;
      }
      const {chore, memberId, entry} = item;
      const mem = getMember(memberId);
      if (!mem) return;
      const slotLabel = entry.slotId && chore.schedule?.slots ? (chore.schedule.slots.find(s=>s.id===entry.slotId)?.label || '') : '';
      const isBefore = entry.entryType === 'before';
      const entryBadge = isBefore
        ? `<span style="background:#EDE9FE;color:var(--purple);border-radius:6px;padding:2px 8px;font-size:0.75rem;font-weight:700;margin-left:6px">BEFORE</span>`
        : entry.entryType === 'after'
        ? `<span style="background:#DCFCE7;color:#166534;border-radius:6px;padding:2px 8px;font-size:0.75rem;font-weight:700;margin-left:6px">DONE</span>`
        : '';
      const ptsLabel = isBefore ? 'Approve to start' : `${chore.diamonds} gems`;
      const photoHtml = entry.photoUrl ? `<img src="${entry.photoUrl}" class="photo-approval-thumb" onclick="viewPhoto('${entry.photoUrl}')" alt="Photo" title="Click to view full size">` : '';
      html += `
        <div class="admin-card" style="flex-wrap:wrap;gap:10px">
          <span class="admin-icon">${renderIcon(chore.icon,chore.iconColor,'font-size:1.6rem')}</span>
          <div class="admin-info" style="flex:1;min-width:0">
            <div class="admin-name">${esc(chore.title)}${entryBadge}${slotLabel?` <span style="font-size:0.8rem;color:var(--muted)">(${esc(slotLabel)})</span>`:''}</div>
            <div class="admin-meta">${renderMemberAvatarHtml(mem)} ${esc(mem.name)} &middot; ${ptsLabel} &middot; ${fmtDate(entry.date)}</div>
            ${photoHtml}
          </div>
          <div class="admin-actions">
            <button class="btn-icon-sm btn-icon-approve" onclick="approveChore('${chore.id}','${memberId}','${entry.id}',this)"><i class="ph-duotone ph-check-circle" style="color:#16A34A;font-size:1rem"></i></button>
            <button class="btn-icon-sm btn-icon-reject" onclick="rejectChore('${chore.id}','${memberId}','${entry.id}')"><i class="ph-duotone ph-x" style="font-size:0.9rem"></i></button>
          </div>
        </div>`;
    });

    pendingSpend.forEach(req => {
      const mem = getMember(req.memberId);
      if (!mem) return;
      html += `
        <div class="admin-card" style="flex-wrap:wrap;gap:10px">
          <span class="admin-icon"><i class="ph-duotone ph-shopping-cart" style="color:#6C63FF;font-size:1.6rem"></i></span>
          <div class="admin-info" style="flex:1;min-width:0">
            <div class="admin-name">Spend Request <span style="background:#EDE9FE;color:var(--purple);border-radius:6px;padding:2px 8px;font-size:0.75rem;font-weight:700;margin-left:6px">${cur}${req.amount.toFixed(2)}</span></div>
            <div class="admin-meta">${renderMemberAvatarHtml(mem)} ${esc(mem.name)}${req.reason ? ` &middot; "${esc(req.reason)}"` : ''} &middot; ${fmtDate(req.date)}</div>
            <div style="font-size:0.8rem;color:var(--muted);margin-top:2px">Balance: ${cur}${(mem.savings||0).toFixed(2)}</div>
          </div>
          <div class="admin-actions">
            <button class="btn-icon-sm btn-icon-approve" onclick="approveSavingsRequest('${req.id}',this)"><i class="ph-duotone ph-check-circle" style="color:#16A34A;font-size:1rem"></i></button>
            <button class="btn-icon-sm btn-icon-reject" onclick="denySavingsRequest('${req.id}',this)"><i class="ph-duotone ph-x" style="font-size:0.9rem"></i></button>
          </div>
        </div>`;
    });
    readyGoals.forEach(item => {
      const { goal, total, target } = item;
      html += `
        <div class="admin-card" style="flex-wrap:wrap;gap:10px">
          <span class="admin-icon">${renderIcon(goal.icon, goal.iconColor, 'font-size:1.6rem')}</span>
          <div class="admin-info" style="flex:1;min-width:0">
            <div class="admin-name">${esc(goal.title)} <span style="background:#DCFCE7;color:#166534;border-radius:6px;padding:2px 8px;font-size:0.75rem;font-weight:700;margin-left:6px">READY</span></div>
            <div class="admin-meta">${total} / ${target} gems</div>
          </div>
          <div class="admin-actions" style="align-self:center">
            <button class="btn btn-secondary btn-sm" onclick="dismissTeamGoalInboxItem('${goal.id}')">Dismiss</button>
          </div>
        </div>`;
    });
    html += `</div>`;
  }

  let kidsHtml = '';
  if (kids.length === 0) {
    kidsHtml = `<div class="empty-state"><div class="empty-icon"><i class="ph-duotone ph-smiley" style="color:#9CA3AF;font-size:3rem"></i></div><div class="empty-text">No kids yet - go to Setup!</div></div>`;
  }
  kids.forEach((kid, idx) => {
    const myChores  = D.chores.filter(c=>c.assignedTo?.includes(kid.id)).sort((a,b)=>(a.gems||0)-(b.gems||0)||(a.title||'').localeCompare(b.title||'')); 
    const doneCount = myChores.filter(c=>choreStatus(c,kid.id)==='done').length;
    const pendCount = myChores.filter(c=>choreStatus(c,kid.id)==='pending').length;
    const partialCount = myChores.filter(c=>choreStatus(c,kid.id)==='partial').length;
    const laterCount = myChores.filter(c=>choreStatus(c,kid.id)==='unavailable').length;
    const side      = idx % 2 === 0 ? 'left' : 'right';
    const summaryStatuses = myChores.length === 0
      ? '<span class="snapshot-summary-status-empty">No rhythms assigned yet</span>'
      : [
          `<span class="snapshot-summary-status"><strong>${doneCount}/${myChores.length}</strong> Complete</span>`,
          ...(partialCount > 0 ? [`<span class="snapshot-summary-status"><strong>${partialCount}</strong> In Motion</span>`] : []),
          ...(pendCount > 0 ? [`<span class="snapshot-summary-status"><strong>${pendCount}</strong> Waiting</span>`] : []),
          ...(laterCount > 0 ? [`<span class="snapshot-summary-status"><strong>${laterCount}</strong> Later</span>`] : [])
        ].join('');
    const isHereToday = isMemberHereOnDate(kid, today());
    const summaryId = `summary_${kid.id}`;
    const savingsDisplay = fmtCurrencyVisual(kid.savings || 0, D.settings.currency || '$');
    kidsHtml += `
      <div class="snapshot-summary-shell ${_snapshotSummaryReveal.has(summaryId) ? 'revealed' : ''}" data-summary-id="${summaryId}">
        <div class="snapshot-summary-reveal ${isHereToday ? 'here' : 'away'}">
          <div class="snapshot-summary-toggle-row">
            <button class="snapshot-summary-toggle-btn home ${isHereToday ? 'active' : ''}" type="button" onpointerdown="return handleOverviewTodayStatusAction(event,'${kid.id}', true)" onclick="return false;">
              <i class="ph-duotone ph-house-line"></i><span>Home</span>
            </button>
            <button class="snapshot-summary-toggle-btn away ${!isHereToday ? 'active' : ''}" type="button" onpointerdown="return handleOverviewTodayStatusAction(event,'${kid.id}', false)" onclick="return false;">
              <i class="ph-duotone ph-house-line"></i><span>Away</span>
            </button>
          </div>
        </div>
        <button class="snapshot-summary-card" style="--snapshot-accent:${kid.color||'#6C63FF'}" type="button" onclick="handleSnapshotSummaryOpen('${kid.id}','${side}')" onpointerdown="startSnapshotSummarySwipe(event,'${summaryId}')" onpointermove="moveSnapshotSummarySwipe(event)" onpointerup="endSnapshotSummarySwipe(event)" onpointercancel="cancelSnapshotSummarySwipe()">
          <div class="snapshot-summary-name-row">
            <div class="snapshot-summary-name">${esc(kid.name)}</div>
            <span class="snapshot-summary-avatar">${renderMemberAvatarHtml(kid, '??')}</span>
          </div>
          <div class="snapshot-summary-sub">${summaryStatuses}</div>
          <div class="snapshot-summary-chips">
            <span class="snapshot-summary-chip"><strong>${kid.diamonds||0}</strong><small>Gems</small></span>
            ${D.settings.savingsEnabled!==false?`<span class="snapshot-summary-chip"><strong>${savingsDisplay}</strong><small>Savings</small></span>`:''}
          </div>
          <div class="snapshot-summary-swipe-note"><i class="ph-duotone ph-caret-double-down"></i></div>
        </button>
      </div>`;
  });
  const hasOverviewFollowups = (D.settings.notListeningEnabled !== false) || ((D.history || []).length > 0);
  html += `<div class="section-row"><span class="section-title"><i class="ph-duotone ph-users-three" style="color:#1D6B57;font-size:1rem;vertical-align:middle"></i> Family Snapshots</span></div>${kids.length>0?`<div class="overview-kids-grid${hasOverviewFollowups ? ' overview-kids-grid-spaced' : ''}">${kidsHtml}</div>`:kidsHtml}`;

  const secsPerDmd = D.settings.notListeningSecs || 60;
  const nlKids = D.family.members.filter(m => m.role === 'kid' && !m.deleted);
  const nlRows = nlKids.map(k => {
    normalizeMember(k);
    const todaySecs = (k.nlDate === t ? k.nlTodaySecs || 0 : 0);
    const pendingSecs = k.nlPendingSecs || 0;
    const pct = Math.min(100, Math.round(pendingSecs / secsPerDmd * 100));
    const wholeMinutes = Math.floor(todaySecs / 60);
      return `<button class="nl-meter-card" type="button" onclick="showNotListening('${k.id}')">
      <div class="nl-ring-wrap">
        <div class="nl-ring" style="--nl-progress:${pct}%">
          <div class="nl-ring-center">
            <div class="nl-meter-name">${esc(k.name)}</div>
            <strong>${wholeMinutes}</strong>
            <span>${wholeMinutes === 1 ? 'minute' : 'minutes'}</span>
          </div>
        </div>
      </div>
    </button>`;
  }).join('');
  if (D.settings.notListeningEnabled !== false) {
    html += `
    <div class="section-row"><span class="section-title"><i class="ph-duotone ph-speaker-slash" style="color:#EF4444;font-size:1rem;vertical-align:middle"></i> Not-Listening Time Today</span></div>
    <div class="card nl-grid-card">
      ${nlRows || '<div style="color:var(--muted);font-size:0.9rem">No kids added yet</div>'}
    </div>`;
  }

  const recentHistory = (D.history || []).slice(0, 5);
  if (recentHistory.length > 0) {
    const actRows = recentHistory.map(renderActivityRow).join('');
    html += `
      <div class="section-row"><span class="section-title"><i class="ph-duotone ph-clipboard-text" style="color:#9CA3AF;font-size:1rem;vertical-align:middle"></i> Recent Activity</span></div>
      <div class="card activity-card">${actRows}
        ${(D.history||[]).length > 5 ? `<div style="margin-top:10px;padding-top:10px;border-top:1px solid #f3f4f6"><button class="btn btn-secondary btn-sm btn-full" onclick="openFullHistory()">View All Activity</button></div>` : ''}
      </div>`;
  }

  document.getElementById('parent-content').innerHTML = html;
  _bindSnapshotSummaryAutoDismiss();
  if (_snapshotSummarySuppressHintBounceOnce) {
    _snapshotSummarySuppressHintBounceOnce = false;
    showBetaWelcomeIfNeeded();
    showChangelogIfNeeded();
    showWeekReviewIfNeeded();
    return;
  }
  if (D.settings.tooltipBounceEnabled !== false) {
    setTimeout(() => {
      const firstSummary = document.querySelector('.snapshot-summary-shell');
      if (!firstSummary) return;
      firstSummary.classList.remove('hint-bounce');
      firstSummary.classList.add('hint-bounce');
      setTimeout(() => firstSummary.classList.remove('hint-bounce'), 2200);
    }, 180);
  }
  showBetaWelcomeIfNeeded();
  showChangelogIfNeeded();
  showWeekReviewIfNeeded();
}

function _fadeOutAdminCard(btn, then) {
  const card = btn?.closest?.('.admin-card');
  if (!card) { then(); return; }
  card.style.transition = 'opacity 0.2s, transform 0.2s';
  card.style.opacity = '0';
  card.style.transform = 'scale(0.97)';
  setTimeout(then, 210);
}

function _flipAdminCard(btn, newInnerHTML, then) {
  const card = btn?.closest?.('.admin-card');
  if (!card) { then(); return; }
  card.style.transition = 'transform 0.18s ease-in, opacity 0.18s ease-in';
  card.style.transformOrigin = 'center';
  card.style.transform = 'rotateY(90deg)';
  card.style.opacity = '0.2';
  setTimeout(() => {
    card.innerHTML = newInnerHTML;
    card.style.transition = 'none';
    card.style.transform = 'rotateY(-90deg)';
    card.offsetHeight; // force reflow
    card.style.transition = 'transform 0.18s ease-out, opacity 0.18s ease-out';
    card.style.transform = 'rotateY(0deg)';
    card.style.opacity = '1';
    setTimeout(then, 200);
  }, 190);
}

function approveChore(choreId, memberId, entryId, btn) {
  const c = D.chores.find(x=>x.id===choreId);
  const m = getMember(memberId);
  const entry = c?.completions?.[memberId]?.find(e => e.id === entryId);
  const isBefore = entry?.entryType === 'before';

  if (isBefore) {
    const inProgressInner = `
      <span class="admin-icon">${renderIcon(c.icon, c.iconColor, 'font-size:1.6rem')}</span>
      <div class="admin-info" style="flex:1;min-width:0">
        <div class="admin-name">${esc(c.title)} <span style="background:#DBEAFE;color:#1D4ED8;border-radius:6px;padding:2px 8px;font-size:0.75rem;font-weight:700;margin-left:6px">IN PROGRESS</span></div>
        <div class="admin-meta">${renderMemberAvatarHtml(m)} ${esc(m.name)} &middot; waiting for after photo &middot; ${c.diamonds} gems</div>
      </div>`;
    _flipAdminCard(btn, inProgressInner, () => {
      doApproveChore(choreId, memberId, entryId);
      renderParentHeader();
      renderParentNav();
      syncAppBadge();
    });
  } else {
    _fadeOutAdminCard(btn, () => {
      doApproveChore(choreId, memberId, entryId);
      toast(`<i class="ph-duotone ph-check-circle" style="color:#16A34A;font-size:1rem;vertical-align:middle"></i> Approved "${c?.title}" for ${m?.name} (+${c?.diamonds} gems)`);
      renderParentHome();
      renderParentHeader();
      renderParentNav();
      syncAppBadge();
    });
  }
}

function rejectChore(choreId, memberId, entryId) {
  const m = getMember(memberId);
  const chore = D.chores.find(c => c.id === choreId);
  showQuickActionModal(`
    <div class="modal-title"><i class="ph-duotone ph-x-circle" style="color:#EF4444;font-size:1.2rem;vertical-align:middle"></i> Decline Chore</div>
    <p style="margin-bottom:16px;color:var(--muted);font-size:0.9rem">Declining <strong>${esc(chore?.title)}</strong> for ${esc(m?.name)}.</p>
    <div class="form-group">
      <label class="form-label">Reason (optional)</label>
      <input id="decline-reason-input" type="text" placeholder="e.g. Didn't do it properly" style="width:100%">
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" onclick="confirmRejectChore('${choreId}','${memberId}','${entryId}')">Decline</button>
    </div>`);
  setTimeout(() => document.getElementById('decline-reason-input')?.focus(), 100);
}

function confirmRejectChore(choreId, memberId, entryId) {
  const reason = document.getElementById('decline-reason-input')?.value?.trim() || '';
  closeModal();
  doRejectChore(choreId, memberId, entryId, reason);
  const m = getMember(memberId);
  toast(`Chore declined for ${m?.name}`);
  renderParentHome();
  renderParentHeader();
  renderParentNav();
  syncAppBadge();
}


// Parent directly marks a chore done for a kid (no kid submission required)
function parentMarkChoreDone(choreId, memberId) {
  const chore  = D.chores.find(c => c.id === choreId);
  const member = getMember(memberId);
  if (!chore || !member) return;

  const progress = getChoreProgress(chore, memberId);
  if (progress.status === 'done') {
    toast(`${renderIcon(chore.icon,chore.iconColor,'font-size:1rem;vertical-align:middle')} Already marked done for ${esc(member.name)}`);
    return;
  }

  if (!chore.completions) chore.completions = {};
  chore.completions[memberId] = normalizeCompletionEntries(chore.completions[memberId]);

  chore.completions[memberId] = chore.completions[memberId].filter(e => !(e.status === 'pending' && e.entryType !== 'before'));

  let totalPts = 0;

  if (progress.isSlotMode) {
    // Complete only the currently-available slot(s); if none are in-window, complete just the earliest waiting slot
    const available = (progress.slotStatuses || []).filter(s => s.status === 'available');
    const waiting   = (progress.slotStatuses || []).filter(s => s.status === 'waiting');
    const toComplete = available.length > 0 ? available : waiting.slice(0, 1);
    if (toComplete.length === 0) { toast(`${renderIcon(chore.icon,chore.iconColor,'font-size:1rem;vertical-align:middle')} All slots already submitted for ${esc(member.name)}`); return; }
    toComplete.forEach(({ slot }) => {
      chore.completions[memberId].push({
        id: genId(), status: 'done', date: today(), createdAt: Date.now(),
        slotId: slot.id, photoUrl: null, entryType: null,
      });
      totalPts += chore.gems;
    });
  } else {
    chore.completions[memberId].push({
      id: genId(), status: 'done', date: today(), createdAt: Date.now(),
      slotId: null, photoUrl: null, entryType: null,
    });
    totalPts = chore.gems;
  }

  member.gems      = (member.gems      || 0) + totalPts;
  member.totalEarned = (member.totalEarned || 0) + totalPts;
  addHistory('chore', memberId, chore.title, totalPts);
  checkAfterDiamondsAwarded(member, totalPts);
  checkChoreBadges(chore, memberId);
  // Auto-here: parent marking a chore done means the kid is home
  const _t = today();
  normalizeMember(member);
  if (!isMemberHereOnDate(member, _t)) {
    member.splitHousehold.overrides[_t] = true;
  }
  saveData();
  toast(`Marked "${chore.title}" done for ${member.name} (+${totalPts} gems)`);
  refreshOpenFamilySnapshot({ memberId, choreId, mode: 'mark-done' });
  renderParentHome();
  renderParentHeader();
  renderParentNav();
}

function parentUnmarkChoreDone(choreId, memberId) {
  const chore  = D.chores.find(c => c.id === choreId);
  const member = getMember(memberId);
  if (!chore || !member) return;

  const entries = normalizeCompletionEntries(chore.completions?.[memberId]);
  // Find the most recent 'done' entry that is NOT a 'before' photo entry
  const idx = [...entries].reverse().findIndex(e => e.status === 'done' && e.entryType !== 'before');
  if (idx === -1) { toast('No completion found to remove'); return; }
  const realIdx = entries.length - 1 - idx;

  entries.splice(realIdx, 1);
  if (entries.length === 0) delete chore.completions[memberId];
  else chore.completions[memberId] = entries;

  // Reverse the gems
  const deduct = Math.min(chore.gems, member.gems || 0);
  member.gems      = (member.gems      || 0) - deduct;
  member.totalEarned = Math.max(0, (member.totalEarned || 0) - chore.gems);
  if (D.settings.levelingEnabled !== false) member.xp = Math.max(0, (member.xp || 0) - chore.gems);
  addHistory('penalty', memberId, `Undo: ${chore.title}`, -deduct);
  saveData();
  toast(`Undo: "${chore.title}" for ${member.name} (-${deduct} gems)`);
  refreshOpenFamilySnapshot({ memberId, choreId });
  renderParentHome();
  renderParentHeader();
  renderParentNav();
}

function parentMarkSlotDone(choreId, memberId, slotId) {
  const chore  = D.chores.find(c => c.id === choreId);
  const member = getMember(memberId);
  if (!chore || !member) return;
  const progress = getChoreProgress(chore, memberId);
  const slotStatus = progress.slotStatuses?.find(s => s.slot.id === slotId);
  if (!slotStatus) { toast('Slot not found'); return; }
  if (slotStatus.status === 'done')    { toast('Already done'); return; }
  if (slotStatus.status === 'pending') { toast('Already submitted - waiting for approval'); return; }
  if (!chore.completions) chore.completions = {};
  chore.completions[memberId] = normalizeCompletionEntries(chore.completions[memberId]);
  chore.completions[memberId].push({
    id: genId(), status: 'done', date: today(), createdAt: Date.now(),
    slotId, photoUrl: null, entryType: null,
  });
  member.gems      = (member.gems      || 0) + chore.gems;
  member.totalEarned = (member.totalEarned || 0) + chore.gems;
  addHistory('chore', memberId, chore.title, chore.gems);
  checkAfterDiamondsAwarded(member, chore.gems);
  checkChoreBadges(chore, memberId);
  saveData();
  toast(`${renderIcon(chore.icon,chore.iconColor,'font-size:1rem;vertical-align:middle')} ${esc(formatSlotLabel(slotStatus.slot) || 'Slot')} done for ${esc(member.name)} (+${chore.diamonds} gems)`);
  refreshOpenFamilySnapshot({ memberId, choreId });
  renderParentHome();
  renderParentHeader();
  renderParentNav();
}

function parentUnmarkSlotDone(choreId, memberId, slotId) {
  const chore  = D.chores.find(c => c.id === choreId);
  const member = getMember(memberId);
  if (!chore || !member) return;
  const entries = normalizeCompletionEntries(chore.completions?.[memberId]);
  let idx = entries.findIndex(e => e.slotId === slotId && e.date === today() && e.entryType === 'after' && e.status === 'done');
  if (idx === -1) idx = entries.findIndex(e => e.slotId === slotId && e.date === today() && e.status === 'done' && e.entryType !== 'before');
  if (idx === -1) { toast('No completion found to remove'); return; }
  const slot = D.chores.find(c => c.id === choreId)?.schedule?.slots?.find(s => s.id === slotId);
  entries.splice(idx, 1);
  if (entries.length === 0) delete chore.completions[memberId];
  else chore.completions[memberId] = entries;
  const deduct = Math.min(chore.gems, member.gems || 0);
  member.gems      = (member.gems      || 0) - deduct;
  member.totalEarned = Math.max(0, (member.totalEarned || 0) - chore.gems);
  if (D.settings.levelingEnabled !== false) member.xp = Math.max(0, (member.xp || 0) - chore.gems);
  addHistory('penalty', memberId, `Undo: ${chore.title} (${slot?.label || 'slot'})`, -deduct);
  saveData();
  toast(`Undo: ${renderIcon(chore.icon,chore.iconColor,'font-size:1rem;vertical-align:middle')} ${esc(slot?.label || 'slot')} for ${esc(member.name)} (-${deduct} gems)`);
  refreshOpenFamilySnapshot({ memberId, choreId });
  renderParentHome();
  renderParentHeader();
  renderParentNav();
}

function applyChoreReorder(newOrderIds) {
  // Slot the reordered IDs back into the same positions they occupied in D.chores
  const idSet = new Set(newOrderIds);
  const positions = [];
  D.chores.forEach((c, i) => { if (idSet.has(c.id)) positions.push(i); });
  positions.sort((a, b) => a - b);
  const lookup = Object.fromEntries(D.chores.map(c => [c.id, c]));
  const newChores = [...D.chores];
  newOrderIds.forEach((id, rank) => { newChores[positions[rank]] = lookup[id]; });
  D.chores = newChores;
  saveData();
}

function initSortable(containerEl, onReorder) {
  if (!containerEl) return;
  const items = () => [...containerEl.querySelectorAll('[data-drag-id]')];

  let dragSrc = null;

  containerEl.addEventListener('dragstart', e => {
    dragSrc = e.target.closest('[data-drag-id]');
    if (!dragSrc) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragSrc.dataset.dragId);
    dragSrc.classList.add('drag-src');
  });
  containerEl.addEventListener('dragend', () => {
    items().forEach(el => el.classList.remove('drag-src', 'drag-over'));
    dragSrc = null;
  });
  containerEl.addEventListener('dragover', e => {
    const target = e.target.closest('[data-drag-id]');
    if (!target || !dragSrc || target === dragSrc) { e.preventDefault(); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    items().forEach(el => el.classList.remove('drag-over'));
    target.classList.add('drag-over');
  });
  containerEl.addEventListener('drop', e => {
    e.preventDefault();
    const target = e.target.closest('[data-drag-id]');
    if (!target || !dragSrc || target === dragSrc) return;
    items().forEach(el => el.classList.remove('drag-over'));
    const all = items();
    if (all.indexOf(dragSrc) < all.indexOf(target)) target.after(dragSrc);
    else target.before(dragSrc);
    dragSrc.classList.remove('drag-src');
    onReorder(items().map(el => el.dataset.dragId));
  });

  let touchSrc = null, touchOver = null;

  containerEl.addEventListener('touchstart', e => {
    const handle = e.target.closest('.drag-handle');
    if (!handle) return;
    touchSrc = handle.closest('[data-drag-id]');
    if (!touchSrc) return;
    touchSrc.classList.add('drag-src');
    e.preventDefault();
  }, { passive: false });

  containerEl.addEventListener('touchmove', e => {
    if (!touchSrc) return;
    e.preventDefault();
    const touch = e.touches[0];
    touchSrc.style.pointerEvents = 'none';
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    touchSrc.style.pointerEvents = '';
    const target = el?.closest('[data-drag-id]');
    if (touchOver && touchOver !== target) touchOver.classList.remove('drag-over');
    if (target && target !== touchSrc) { target.classList.add('drag-over'); touchOver = target; }
    else touchOver = null;
  }, { passive: false });

  containerEl.addEventListener('touchend', () => {
    if (!touchSrc) return;
    touchSrc.classList.remove('drag-src');
    if (touchOver) {
      touchOver.classList.remove('drag-over');
      const all = items();
      if (all.indexOf(touchSrc) < all.indexOf(touchOver)) touchOver.after(touchSrc);
      else touchOver.before(touchSrc);
      onReorder(items().map(el => el.dataset.dragId));
    }
    touchSrc = null; touchOver = null;
  });
}

function renderParentChores() {
  let html = `
    <div class="section-row">
      <span class="section-title"><i class="ph-duotone ph-clipboard-text" style="color:#9CA3AF;font-size:1rem;vertical-align:middle"></i> All Tasks (${D.chores.length})</span>
      <button class="btn btn-primary btn-sm" onclick="openAddChoreModal(this)">+ Add</button>
    </div>`;

  if (D.chores.length === 0) {
    html += `<div class="empty-state"><div class="empty-icon"><i class="ph-duotone ph-clipboard-text" style="color:#9CA3AF;font-size:3rem"></i></div><div class="empty-text">No tasks yet. Add one!</div></div>`;
  }

  html += `<div id="chore-sort-list" class="parent-chore-list">`;
  [...D.chores].sort((a,b) => (a.gems||0)-(b.gems||0) || (a.title||'').localeCompare(b.title||'')).forEach(chore => {
    const swipeKey = `parent_chore_${chore.id}`;
    html += `
      <div class="snapshot-routine-shell parent-chore-shell" data-drag-id="${chore.id}" data-swipe-id="${swipeKey}">
        <div class="snapshot-routine-reveal snapshot-routine-reveal-secondary parent-chore-reveal">
          <button class="snapshot-reveal-btn snapshot-reveal-btn-danger parent-chore-reveal-btn" type="button" title="Delete task" onpointerdown="event.preventDefault();event.stopPropagation();deleteChore('${chore.id}');return false;" onclick="return false;">
            <i class="ph-duotone ph-trash"></i>
            <span>Delete</span>
          </button>
          <button class="snapshot-reveal-btn snapshot-reveal-btn-secondary parent-chore-reveal-btn" type="button" title="Edit task" onpointerdown="event.preventDefault();event.stopPropagation();openChoreEditor('${chore.id}', this);return false;" onclick="return false;">
            <i class="ph-duotone ph-pencil-simple"></i>
            <span>Edit</span>
          </button>
        </div>
        <div class="snapshot-routine-card parent-chore-card" onpointerdown="startSnapshotSwipe(event,'${swipeKey}')" onpointermove="moveSnapshotSwipe(event)" onpointerup="endSnapshotSwipe(event)" onpointercancel="cancelSnapshotSwipe()" onclick="return handleSnapshotCardTap(event,'${swipeKey}')">
          <div class="snapshot-routine-top">
            <div class="snapshot-routine-main">
              <div class="snapshot-routine-title-row">
                <div class="parent-chore-copy">
                  <div class="snapshot-routine-title">${esc(chore.title)}</div>
                  <div class="parent-chore-meta">${esc(parentChoreMetaSummary(chore))}</div>
                </div>
                <div class="snapshot-routine-diamond-badge">
                  <span class="snapshot-routine-glyph-main">${renderIcon(chore.icon,chore.iconColor)}</span>
                  <span class="snapshot-routine-glyph-badge">${chore.diamonds || 0}</span>
                </div>
                <div class="snapshot-routine-utility">
                  <button class="snapshot-routine-swipe-hint" type="button" aria-label="Reveal actions" onclick="event.stopPropagation();toggleSnapshotSwipe('${swipeKey}')">
                    <i class="ph-duotone ph-caret-double-left"></i>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
  });
  html += `</div>`;

  document.getElementById('parent-content').innerHTML = html;
  initSortable(document.getElementById('chore-sort-list'), ids => applyChoreReorder(ids));
  if (D.settings.tooltipBounceEnabled !== false) {
    setTimeout(() => {
      const first = document.querySelector('.parent-chore-shell');
      if (!first) return;
      first.classList.remove('hint-bounce');
      first.classList.add('hint-bounce');
      setTimeout(() => first.classList.remove('hint-bounce'), 2200);
    }, 180);
  }
}
// Ephemeral slot state while modal is open
let _editSlots = [];

function openAddChoreModal(triggerEl) {
  const rect = triggerEl?.getBoundingClientRect?.();
  if (rect) _modalLaunchOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  showChoreModal(null, { quickAction: true });
}

function openChoreEditor(choreId, triggerEl) {
  const rect = triggerEl?.getBoundingClientRect?.();
  if (rect) _modalLaunchOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  const shell = triggerEl?.closest?.('.snapshot-routine-shell');
  if (shell?.classList.contains('revealed')) {
    shell.classList.remove('revealed');
    setTimeout(() => showChoreModal(choreId, { quickAction: true }), 180);
    return;
  }
  showChoreModal(choreId, { quickAction: true });
}

function showChoreModal(choreId, opts = {}) {
  const kids  = D.family.members.filter(m=>m.role==='kid'&&!m.deleted);
  const chore = choreId ? D.chores.find(c=>c.id===choreId) : null;
  const c     = normalizeChore(chore || {
    title:'', icon:'<i class="ph-duotone ph-star" style="color:#F59E0B"></i>', gems:10, frequency:'day', repeatCount:1,
    schedule: { period:'day', targetCount:1, daysOfWeek:ALL_DAYS.slice(), windows:{}, slots:null },
    assignedTo:kids.map(k=>k.id), description:'', completions:{}
  });

  // Init slot editor state from existing chore
  _editSlots = c.schedule.slots ? c.schedule.slots.map(s=>({...s})) : [];

  const choreColor = c.iconColor || '#6BCB77';
  const iconOpts = ICON_MAP.slice(0, 48).map(({n}) =>
    `<div class="icon-opt${n===c.icon?' sel':''}" onclick="selChoreIcon(this,'${n}')" data-icon="${n}"><i class="ph-duotone ph-${n}"></i></div>`
  ).join('');
  const colorSwatches = COLORS.map(col =>
    `<div class="icon-color-swatch${col===choreColor?' sel':''}" style="background:${col}" onclick="selChoreColor(this,'${col}')"></div>`
  ).join('');

  const assignOpts = kids.map(k => `
    <label class="chore-checkbox-row">
      <input type="checkbox" name="assign" value="${k.id}" ${c.assignedTo?.includes(k.id)?'checked':''}>
      <span class="chore-checkbox-icon">${k.avatar}</span>
      <span class="chore-checkbox-label">${esc(k.name)}</span>
    </label>`).join('');

  const scheduleRows = WEEKDAY_OPTIONS.map(day => {
    const checked = c.schedule.period !== 'once' && c.schedule.daysOfWeek.includes(day.value);
    const win = c.schedule.windows?.[day.value] || { start:'', end:'' };
    return `
      <div class="schedule-day-row">
        <label class="schedule-day-toggle">
          <input type="checkbox" id="cm-day-${day.value}" ${checked?'checked':''} onchange="toggleChoreDayRow(${day.value})">
          <span>${day.label}</span>
        </label>
        <div class="schedule-day-hours">
          <input type="time" id="cm-start-${day.value}" value="${win.start||''}" ${checked?'':'disabled'}>
          <span>to</span>
          <input type="time" id="cm-end-${day.value}" value="${win.end||''}" ${checked?'':'disabled'}>
          <button class="copy-time-btn" title="Copy this time to all days" onclick="copyDayTimeToAll(${day.value})"><i class="ph-duotone ph-copy" style="font-size:1rem;vertical-align:middle"></i></button>
        </div>
      </div>`;
  }).join('');

  const hasSlots = _editSlots.length > 0;

  const modalHtml = `
    <div class="modal-title" style="margin-bottom:14px">${choreId ? 'Edit Task' : 'Add Task'}</div>
    <input type="hidden" id="cm-icon" value="${esc(String(c.icon || ''))}">
    <input type="hidden" id="cm-icon-color" value="${esc(String(choreColor || ''))}">
    <div class="form-group">
      <label class="form-label">Task name</label>
      <input type="text" id="cm-title" placeholder="e.g. Brush Teeth" value="${esc(c.title)}">
    </div>
    <div class="form-group">
      <div class="icon-color-row">${colorSwatches}</div>
      <input type="text" class="icon-search-input" placeholder="Search icons (e.g. broom, teeth, dog)..." oninput="filterIcons(this.value)">
      <div class="icon-picker" id="icon-picker-grid" style="color:${choreColor}">${iconOpts}</div>
    </div>
    <div class="input-row">
      <div class="form-group mb-0">
        <label class="form-label">Gems <span class="form-label-hint">${hasSlots?'per slot':'total'}</span></label>
        <input type="number" id="cm-gems" min="1" max="500" value="${c.gems}">
      </div>
      <div class="form-group mb-0">
        <label class="form-label">Frequency</label>
        <select id="cm-freq" onchange="toggleChoreScheduleFields()">
          <option value="day"  ${c.schedule.period==='day'  ?'selected':''}>Per day</option>
          <option value="week" ${c.schedule.period==='week' ?'selected':''}>Per week</option>
          <option value="once" ${c.schedule.period==='once' ?'selected':''}>One-time</option>
        </select>
      </div>
    </div>
    <div id="cm-schedule-fields">
      <div class="form-group">
        <label class="form-label">Completion style</label>
        <div class="display-mode-row" style="grid-template-columns:1fr 1fr;margin-top:0">
          <button class="mode-opt${!hasSlots?' sel':''}" id="cm-style-simple" onclick="setChoreStyle('simple')"><span class="mode-opt-icon"><i class="ph-duotone ph-list-numbers" style="font-size:1.1rem"></i></span>Simple count</button>
          <button class="mode-opt${hasSlots?' sel':''}"  id="cm-style-slots"  onclick="setChoreStyle('slots')"><span class="mode-opt-icon"><i class="ph-duotone ph-clock" style="font-size:1.1rem"></i></span>Timed slots</button>
        </div>
        <div class="schedule-help" style="margin-top:6px" id="cm-style-help">${hasSlots?'Each slot earns gems independently when completed during its window.':'Complete this task the set number of times to earn gems - each completion counts toward the total.'}</div>
      </div>
      <div id="cm-simple-fields" style="display:${hasSlots?'none':'block'}">
        <div class="form-group">
          <label class="form-label">Required completions</label>
          <input type="number" id="cm-repeat" min="1" max="12" value="${c.schedule.targetCount||1}">
        </div>
        <div class="form-group">
          <label class="form-label">Available days and hours</label>
          <div class="schedule-help">Leave times blank for any time on that day.</div>
          <div class="schedule-day-grid">${scheduleRows}</div>
        </div>
      </div>
      <div id="cm-slots-fields" style="display:${hasSlots?'block':'none'}">
        <div class="form-group">
          <label class="form-label">Available days</label>
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px" id="cm-slot-days">
            ${WEEKDAY_OPTIONS.map(day => {
              const on = c.schedule.daysOfWeek.includes(day.value);
              return `<label style="display:flex;align-items:center;gap:5px;font-weight:600;font-size:0.88rem">
                <input type="checkbox" id="cm-sday-${day.value}" ${on?'checked':''}> ${day.label}
              </label>`;
            }).join('')}
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Time slots <span class="form-label-hint">each earns ${c.diamonds} gems</span></label>
          <div class="slot-editor" id="cm-slot-editor"></div>
          <button class="btn btn-secondary btn-sm" style="margin-top:10px" onclick="addChoreSlot()">+ Add slot</button>
        </div>
      </div>
    </div>
    ${kids.length>0?`<div class="form-group"><label class="form-label">Assign to</label>${assignOpts}</div>`:''}
    <div class="form-group">
      <label class="form-label"><i class="ph-duotone ph-camera" style="color:#6C63FF;font-size:1rem;vertical-align:middle"></i> Photo requirement</label>
      <select id="cm-photo">
        <option value="none"         ${c.photoMode==='none'        ||!c.photoMode?'selected':''}>No photo needed</option>
        <option value="after"        ${c.photoMode==='after'       ?'selected':''}>Completion photo (after only)</option>
        <option value="before_after" ${c.photoMode==='before_after'?'selected':''}>Before + after photos (shows it needed doing)</option>
      </select>
      <div class="schedule-help" style="margin-top:6px">
        "Before + after" has your child take a photo of the starting state (e.g. the messy room, the full trash) <em>before</em> you approve the start, then a done photo to earn gems.
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Description <span class="form-label-hint">optional</span></label>
      <textarea id="cm-desc" placeholder="Any instructions...">${esc(c.description||'')}</textarea>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveChore('${choreId||''}')">Save <i class="ph-duotone ph-check" style="font-size:0.95rem;vertical-align:middle"></i></button>
    </div>`;
  if (opts.quickAction) showQuickActionModal(modalHtml, 'quick-action-modal-wide chore-editor-modal');
  else showQuickActionModal(modalHtml, 'quick-action-modal-wide chore-editor-modal');

  toggleChoreScheduleFields();
  renderSlotEditor();
}


function filterIcons(query) {
  const q = query.toLowerCase().trim();
  const cur = document.getElementById('cm-icon')?.value;
  const grid = document.getElementById('icon-picker-grid');
  if (!grid) return;
  const matches = q ? ICON_MAP.filter(({k}) => k.includes(q)) : ICON_MAP.slice(0, 48);
  if (matches.length === 0) {
    grid.innerHTML = `<div style="color:var(--muted);font-size:0.85rem;padding:8px;grid-column:1/-1">No icons found - try different words.</div>`;
  } else {
    grid.innerHTML = matches.map(({n}) =>
      `<div class="icon-opt${n===cur?' sel':''}" onclick="selChoreIcon(this,'${n}')" data-icon="${n}"><i class="ph-duotone ph-${n}"></i></div>`
    ).join('');
  }
}

function selChoreIcon(el, icon) {
  document.getElementById('cm-icon').value = icon;
  el.closest('#icon-picker-grid, .icon-picker').querySelectorAll('.icon-opt').forEach(x=>x.classList.remove('sel'));
  el.classList.add('sel');
}

function setChoreStyle(style) {
  const isSlots = style === 'slots';
  document.getElementById('cm-style-simple')?.classList.toggle('sel', !isSlots);
  document.getElementById('cm-style-slots')?.classList.toggle('sel',  isSlots);
  document.getElementById('cm-simple-fields').style.display = isSlots ? 'none' : 'block';
  document.getElementById('cm-slots-fields').style.display  = isSlots ? 'block' : 'none';
  document.getElementById('cm-style-help').textContent = isSlots
    ? 'Each slot earns gems independently when completed during its window.'
    : 'Complete this task the set number of times to earn gems - each completion counts toward the total.';
  if (isSlots && _editSlots.length === 0) {
    _editSlots = [
      { id: genId(), label: 'Morning', start: '06:00', end: '09:00' },
      { id: genId(), label: 'Evening', start: '18:00', end: '21:00' },
    ];
    renderSlotEditor();
  }
}

function renderSlotEditor() {
  const container = document.getElementById('cm-slot-editor');
  if (!container) return;
  container.innerHTML = _editSlots.map((slot, i) => `
    <div class="slot-editor-row">
      <input type="text" placeholder="Label (e.g. Morning)" value="${esc(slot.label)}" oninput="_editSlots[${i}].label=this.value">
      <input type="time" value="${slot.start}" oninput="_editSlots[${i}].start=this.value">
      <input type="time" value="${slot.end}"   oninput="_editSlots[${i}].end=this.value">
      <button class="slot-remove-btn" onclick="removeChoreSlot(${i})"><i class="ph-duotone ph-x" style="font-size:0.9rem"></i></button>
    </div>`).join('');
}

function addChoreSlot() {
  _editSlots.push({ id: genId(), label: '', start: '', end: '' });
  renderSlotEditor();
}

function removeChoreSlot(i) {
  _editSlots.splice(i, 1);
  renderSlotEditor();
}

function toggleChoreScheduleFields() {
  const freq = document.getElementById('cm-freq')?.value || 'day';
  const wrap = document.getElementById('cm-schedule-fields');
  if (!wrap) return;
  wrap.style.display = freq === 'once' ? 'none' : 'block';
}

function copyDayTimeToAll(fromDay) {
  const start = document.getElementById(`cm-start-${fromDay}`)?.value || '';
  const end   = document.getElementById(`cm-end-${fromDay}`)?.value   || '';
  WEEKDAY_OPTIONS.forEach(d => {
    const cb = document.getElementById(`cm-day-${d.value}`);
    if (!cb?.checked) return;
    const s = document.getElementById(`cm-start-${d.value}`);
    const e = document.getElementById(`cm-end-${d.value}`);
    if (s) s.value = start;
    if (e) e.value = end;
  });
  toast('Time copied to all active days');
}

function toggleChoreDayRow(dayIndex) {
  const enabled = document.getElementById(`cm-day-${dayIndex}`)?.checked;
  const start = document.getElementById(`cm-start-${dayIndex}`);
  const end   = document.getElementById(`cm-end-${dayIndex}`);
  if (start) start.disabled = !enabled;
  if (end)   end.disabled   = !enabled;
}

function saveChore(choreId) {
  const title  = document.getElementById('cm-title')?.value.trim();
  const icon      = document.getElementById('cm-icon')?.value || 'broom';
  const iconColor = document.getElementById('cm-icon-color')?.value || '#6BCB77';
  const gems = parseInt(document.getElementById('cm-gems')?.value)||10;
  const freq   = document.getElementById('cm-freq')?.value || 'day';
  const photoMode = document.getElementById('cm-photo')?.value || 'none';
  const desc   = document.getElementById('cm-desc')?.value.trim();
  const assigned = [...document.querySelectorAll('input[name=assign]:checked')].map(x=>x.value);

  if (!title) { toast('Enter a task name'); return; }

  // Determine if using slot mode or simple mode
  const useSlots = document.getElementById('cm-slots-fields')?.style.display !== 'none' && _editSlots.length > 0;
  let scheduleObj;

  if (freq === 'once') {
    scheduleObj = { period:'once', targetCount:1, daysOfWeek:[], windows:{}, slots:null };
  } else if (useSlots) {
    if (_editSlots.length === 0) { toast('Add at least one time slot'); return; }
    const slotDays = WEEKDAY_OPTIONS.filter(d => document.getElementById(`cm-sday-${d.value}`)?.checked).map(d=>d.value);
    if (slotDays.length === 0) { toast('Select at least one day'); return; }
    scheduleObj = { period: freq, targetCount:1, daysOfWeek: slotDays, windows:{}, slots: _editSlots.map(s=>({...s})) };
  } else {
    const repeatCount = Math.max(1, parseInt(document.getElementById('cm-repeat')?.value, 10) || 1);
    const daysOfWeek = WEEKDAY_OPTIONS.filter(d => document.getElementById(`cm-day-${d.value}`)?.checked).map(d=>d.value);
    if (daysOfWeek.length === 0) { toast('Select at least one day for this task'); return; }
    const windows = {};
    daysOfWeek.forEach(day => {
      const start = document.getElementById(`cm-start-${day}`)?.value || '';
      const end   = document.getElementById(`cm-end-${day}`)?.value   || '';
      if (start || end) windows[day] = { start, end };
    });
    scheduleObj = { period: freq, targetCount: repeatCount, daysOfWeek, windows, slots:null };
  }

  const existingChore = choreId ? D.chores.find(x => x.id === choreId) : null;
  const badges = existingChore?.badges || [];
  const choreData = { title, icon, iconColor, gems, photoMode, frequency: freq,
    repeatCount: scheduleObj.targetCount, assignedTo: assigned, description: desc, schedule: scheduleObj, badges };

  if (choreId) {
    const index = D.chores.findIndex(x=>x.id===choreId);
    if (index >= 0) D.chores[index] = normalizeChore({ ...D.chores[index], ...choreData });
  } else {
    D.chores.push(normalizeChore({ id:genId(), completions:{}, ...choreData }));
  }
  saveData();
  closeModal();
  toast(choreId ? 'Task updated!' : 'Task added!');
  renderParentChores();
}

function deleteChore(choreId) {
  const chore = D.chores.find(c => c.id === choreId);
  showQuickActionModal(`
    <div class="modal-title">Delete Chore?</div>
    <p style="margin:0 0 20px;color:var(--muted);font-size:0.95rem;line-height:1.5">"${chore?.title || 'This task'}" will be permanently deleted.</p>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" onclick="closeModal();_doDeleteChore('${choreId}')">Delete</button>
    </div>`, 'quick-action-modal-wide');
}

function _doDeleteChore(choreId) {
  D.chores = D.chores.filter(c=>c.id!==choreId);
  for (const key of _expandedSlots) {
    if (key.startsWith(choreId + '_')) _expandedSlots.delete(key);
  }
  _expandedChores.delete(choreId);
  saveData();
  toast('Chore deleted');
  renderParentChores();
}

function renderParentPrizes() {
  const indiv = D.prizes.filter(p => p.type === 'individual').slice().sort((a,b) => (a.cost||a.targetPoints||0)-(b.cost||b.targetPoints||0) || (a.title||'').localeCompare(b.title||''));
  let html = `
    <div class="section-row">
      <span class="section-title"><i class="ph-duotone ph-gift" style="color:#FF6584;font-size:1rem;vertical-align:middle"></i> Individual Prizes (${indiv.length})</span>
      <button class="btn btn-primary btn-sm" onclick="openAddPrizeModal(this)">+ Add</button>
    </div>`;

  if (indiv.length === 0) {
    html += `<div class="empty-state"><div class="empty-icon"><i class="ph-duotone ph-gift" style="color:#FF6584;font-size:3rem"></i></div><div class="empty-text">No prizes yet. Add one!</div></div>`;
  }

  html += `<div class="parent-prize-list">`;
  indiv.forEach(p => {
    const swipeKey = `parent_prize_${p.id}`;
    html += `
      <div class="snapshot-routine-shell parent-prize-shell" data-swipe-id="${swipeKey}">
        <div class="snapshot-routine-reveal snapshot-routine-reveal-secondary parent-prize-reveal">
          <button class="snapshot-reveal-btn snapshot-reveal-btn-danger parent-prize-reveal-btn" type="button" title="Delete prize" onpointerdown="event.preventDefault();event.stopPropagation();deletePrize('${p.id}');return false;" onclick="return false;">
            <i class="ph-duotone ph-trash"></i>
            <span>Delete</span>
          </button>
          <button class="snapshot-reveal-btn snapshot-reveal-btn-secondary parent-prize-reveal-btn" type="button" title="Edit prize" onpointerdown="event.preventDefault();event.stopPropagation();openPrizeEditor('${p.id}', this);return false;" onclick="return false;">
            <i class="ph-duotone ph-pencil-simple"></i>
            <span>Edit</span>
          </button>
        </div>
        <div class="snapshot-routine-card parent-prize-card" onpointerdown="startSnapshotSwipe(event,'${swipeKey}')" onpointermove="moveSnapshotSwipe(event)" onpointerup="endSnapshotSwipe(event)" onpointercancel="cancelSnapshotSwipe()" onclick="return handleSnapshotCardTap(event,'${swipeKey}')">
          <div class="snapshot-routine-top">
            <div class="snapshot-routine-main">
              <div class="snapshot-routine-title-row">
                <div class="parent-chore-copy">
                  <div class="snapshot-routine-title">${esc(p.title)}</div>
                </div>
                <div class="snapshot-routine-diamond-badge">
                  <span class="snapshot-routine-glyph-main">${renderIcon(p.icon,p.iconColor)}</span>
                  <span class="snapshot-routine-glyph-badge">${p.cost || 0}</span>
                </div>
                <div class="snapshot-routine-utility">
                  <button class="snapshot-routine-swipe-hint" type="button" aria-label="Reveal actions" onclick="event.stopPropagation();toggleSnapshotSwipe('${swipeKey}')">
                    <i class="ph-duotone ph-caret-double-left"></i>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
  });
  html += `</div>`;

  // Team goals section
  const goals = (D.teamGoals || []).slice().sort((a,b) => (a.targetPoints||0)-(b.targetPoints||0) || (a.title||'').localeCompare(b.title||''));
  html += `<div style="height:14px"></div>
    <div class="section-row">
      <span class="section-title"><i class="ph-duotone ph-trophy" style="color:#D97706;font-size:1rem;vertical-align:middle"></i> Team Prizes (${goals.length})</span>
      <button class="btn btn-teal btn-sm" onclick="openAddGoalModal(this)">+ Add</button>
    </div>`;

  if (goals.length === 0) {
    html += `<div class="empty-state" style="padding:20px"><div class="empty-icon"><i class="ph-duotone ph-trophy" style="color:#D97706;font-size:3rem"></i></div><div class="empty-text">No team prizes yet</div></div>`;
  }

  html += `<div class="parent-prize-list">`;
  goals.forEach(g => {
    const total = goalTotal(g);
    const pct   = Math.min(100,Math.round(total/(g.targetPoints||1)*100));
    const swipeKey = `team_prize_${g.id}`;
    html += `
      <div class="snapshot-routine-shell parent-prize-shell" data-swipe-id="${swipeKey}">
        <div class="snapshot-routine-reveal snapshot-routine-reveal-secondary parent-prize-reveal">
          <button class="snapshot-reveal-btn snapshot-reveal-btn-danger parent-prize-reveal-btn" type="button" title="Delete team prize" onpointerdown="event.preventDefault();event.stopPropagation();clearGoal('${g.id}');return false;" onclick="return false;">
            <i class="ph-duotone ph-trash"></i>
            <span>Delete</span>
          </button>
          <button class="snapshot-reveal-btn snapshot-reveal-btn-secondary parent-prize-reveal-btn" type="button" title="Edit team prize" onpointerdown="event.preventDefault();event.stopPropagation();openGoalEditor('${g.id}', this);return false;" onclick="return false;">
            <i class="ph-duotone ph-pencil-simple"></i>
            <span>Edit</span>
          </button>
        </div>
        <div class="snapshot-routine-card parent-prize-card" onpointerdown="startSnapshotSwipe(event,'${swipeKey}')" onpointermove="moveSnapshotSwipe(event)" onpointerup="endSnapshotSwipe(event)" onpointercancel="cancelSnapshotSwipe()" onclick="return handleSnapshotCardTap(event,'${swipeKey}')">
          <div class="snapshot-routine-top">
            <div class="snapshot-routine-main">
              <div class="snapshot-routine-title-row">
                <div class="parent-chore-copy">
                  <div class="snapshot-routine-title">${esc(g.title)}</div>
                  <div class="parent-chore-meta">${esc(`${total} / ${g.targetPoints} gems\n${pct}% complete`)}</div>
                </div>
                <div class="snapshot-routine-diamond-badge">
                  <span class="snapshot-routine-glyph-main">${renderIcon(g.icon,g.iconColor)}</span>
                  <span class="snapshot-routine-glyph-badge">${g.targetPoints || 0}</span>
                </div>
                <div class="snapshot-routine-utility">
                  <button class="snapshot-routine-swipe-hint" type="button" aria-label="Reveal actions" onclick="event.stopPropagation();toggleSnapshotSwipe('${swipeKey}')">
                    <i class="ph-duotone ph-caret-double-left"></i>
                  </button>
                </div>
              </div>
              <div class="progress-wrap parent-prize-progress">
                <div class="progress-fill teal" style="width:${pct}%"></div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
  });
  html += `</div>`;

  document.getElementById('parent-content').innerHTML = html;
  if (D.settings.tooltipBounceEnabled !== false) {
    setTimeout(() => {
      const first = document.querySelector('.parent-prize-shell');
      if (!first) return;
      first.classList.remove('hint-bounce');
      first.classList.add('hint-bounce');
      setTimeout(() => first.classList.remove('hint-bounce'), 2200);
    }, 180);
  }
}

const LEVEL_ICON_OPTIONS = [
  { label:'Leaf',       html:'<i class="ph-duotone ph-leaf" style="color:#22C55E;font-size:1.4rem"></i>' },
  { label:'Gem',    html:'<i class="ph-duotone ph-diamond" style="color:#3B82F6;font-size:1.4rem"></i>' },
  { label:'Gem',        html:'<i class="ph-duotone ph-diamond" style="color:#7C3AED;font-size:1.4rem"></i>' },
  { label:'Trophy',     html:'<i class="ph-duotone ph-trophy" style="color:#D97706;font-size:1.4rem"></i>' },
  { label:'Fire',       html:'<i class="ph-duotone ph-fire" style="color:#EF4444;font-size:1.4rem"></i>' },
  { label:'Shield',     html:'<i class="ph-duotone ph-shield-star" style="color:#6C63FF;font-size:1.4rem"></i>' },
  { label:'Crown',      html:'<i class="ph-duotone ph-crown" style="color:#D97706;font-size:1.4rem"></i>' },
  { label:'Star',       html:'<i class="ph-duotone ph-star" style="color:#F59E0B;font-size:1.4rem"></i>' },
  { label:'Rocket',     html:'<i class="ph-duotone ph-rocket-launch" style="color:#6C63FF;font-size:1.4rem"></i>' },
  { label:'Lightning',  html:'<i class="ph-duotone ph-lightning" style="color:#F59E0B;font-size:1.4rem"></i>' },
  { label:'Medal',      html:'<i class="ph-duotone ph-medal" style="color:#D97706;font-size:1.4rem"></i>' },
  { label:'Sparkle',    html:'<i class="ph-duotone ph-sparkle" style="color:#EC4899;font-size:1.4rem"></i>' },
  { label:'Mountain',   html:'<i class="ph-duotone ph-mountains" style="color:#6B7280;font-size:1.4rem"></i>' },
  { label:'Sword',      html:'<i class="ph-duotone ph-sword" style="color:#EF4444;font-size:1.4rem"></i>' },
  { label:'Acorn',      html:'<i class="ph-duotone ph-acorn" style="color:#92400E;font-size:1.4rem"></i>' },
  { label:'Planet',     html:'<i class="ph-duotone ph-planet" style="color:#3B82F6;font-size:1.4rem"></i>' },
  { label:'Heart',      html:'<i class="ph-duotone ph-heart" style="color:#EF4444;font-size:1.4rem"></i>' },
  { label:'Gift',       html:'<i class="ph-duotone ph-gift" style="color:#FF6584;font-size:1.4rem"></i>' },
  { label:'Trophy',     html:'<i class="ph-duotone ph-trophy" style="color:#D97706;font-size:1.4rem"></i>' },
  { label:'Shield',     html:'<i class="ph-duotone ph-shield-star" style="color:#2563EB;font-size:1.4rem"></i>' },
  { label:'Flame',      html:'<i class="ph-duotone ph-fire" style="color:#F97316;font-size:1.4rem"></i>' },
  { label:'Rainbow',    html:'<i class="ph-duotone ph-rainbow" style="color:#14B8A6;font-size:1.4rem"></i>' },
  { label:'Moon',       html:'<i class="ph-duotone ph-moon-stars" style="color:#6366F1;font-size:1.4rem"></i>' },
  { label:'Gem',    html:'<i class="ph-duotone ph-diamond" style="color:#7C3AED;font-size:1.4rem"></i>' },
];

function renderParentLevels() {
  const _lvlContainer = document.getElementById('parent-content');
  const _lvlScroll = _lvlContainer ? _lvlContainer.scrollTop : 0;
  const s = D.settings;
  const levels = getLevels();
  const members = (D.family?.members || []).filter(m => m.role !== 'parent' && !m.deleted);

  let levelsHtml = levels.map((lvl, i) => `
    <div class="admin-card" style="margin-bottom:8px;gap:8px;align-items:flex-start">
      <button onclick="showLevelIconPicker(${i})" title="Change icon"
        style="font-size:1.4rem;background:none;border:1px dashed #D1D5DB;border-radius:8px;padding:4px 8px;cursor:pointer;min-width:44px;text-align:center;flex-shrink:0;line-height:1.4">${lvl.icon}</button>
      <div style="flex:1;display:flex;flex-direction:column;gap:6px">
        <input type="text" value="${esc(lvl.name)}" placeholder="Level name"
          style="font-size:0.9rem;padding:6px 10px;border:1px solid #E5E7EB;border-radius:8px;width:100%"
          onchange="saveCustomLevel(${i},'name',this.value)">
        <div style="display:flex;align-items:center;gap:6px">
          <input type="number" value="${lvl.minXp}" min="0" ${i===0?'disabled title="Level 1 always starts at 0 XP"':''}
            style="width:80px;font-size:0.9rem;padding:6px 10px;border:1px solid #E5E7EB;border-radius:8px"
            onchange="saveCustomLevel(${i},'minXp',parseInt(this.value)||0)">
          <span style="font-size:0.8rem;color:var(--muted)">XP to unlock</span>
        </div>
      </div>
      ${levels.length > 2 ? `<button class="btn-icon-sm btn-icon-delete" onclick="deleteCustomLevel(${i})" style="flex-shrink:0"><i class="ph-duotone ph-trash"></i></button>` : ''}
    </div>`).join('');

  const baseBadgesEnabled = s.baseBadgesEnabled !== false;
  const baseBadgeRows = BADGE_DEFS.map(def => {
    const merged = getBaseBadgeDef(def.id);
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:#FAFAFA;border-radius:10px;border:1px solid #E5E7EB;margin-bottom:6px">
      <span style="font-size:1.4rem;flex-shrink:0;line-height:1">${merged.icon}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:0.9rem;font-weight:600">${esc(merged.name)}</div>
        <div style="font-size:0.78rem;color:var(--muted)">${esc(merged.desc)}</div>
      </div>
    </div>`;
  }).join('');

  const chores = (D.chores || []);
  const choreBadgeCards = chores.length === 0
    ? `<div class="empty-state"><div class="empty-text">No tasks yet - add some from the Routine tab</div></div>`
    : chores.map(chore => {
        const badges = Array.isArray(chore.badges) ? chore.badges : [];
        const tierRows = badges.map((b, i) => `
          <div style="margin-bottom:8px;padding:10px 12px;background:${b.secret?'#fdf4ff':'#f9fafb'};border-radius:10px;border:1px solid ${b.secret?'#e9d5ff':'#e5e7eb'}">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
              <button onclick="showChoreBadgeIconPicker('${chore.id}',${i})"
                style="width:48px;height:44px;font-size:1.4rem;background:none;border:1px dashed #d1d5db;border-radius:8px;padding:2px;cursor:pointer;flex-shrink:0;line-height:1">
                ${b.icon||'<i class="ph-duotone ph-medal" style="color:#F59E0B"></i>'}</button>
              <input type="text" value="${esc(b.name||'')}" placeholder="Badge name"
                style="flex:1;border:1px solid #d1d5db;border-radius:8px;padding:8px 10px;font-size:0.9rem"
                onchange="saveChoreBadgeTier('${chore.id}',${i},'name',this.value)">
              <button onclick="removeChoreBadgeTier('${chore.id}',${i})"
                style="background:none;border:none;color:#EF4444;cursor:pointer;font-size:1.2rem;padding:4px;flex-shrink:0">
                <i class="ph-duotone ph-trash"></i></button>
            </div>
            <div style="display:flex;align-items:center;gap:10px">
              <div style="display:flex;align-items:center;gap:6px">
                <span style="font-size:0.8rem;color:var(--muted);white-space:nowrap">Earn after</span>
                <input type="number" value="${b.count||10}" min="1"
                  style="width:64px;border:1px solid #d1d5db;border-radius:8px;padding:6px 8px;font-size:0.9rem;text-align:center"
                  onchange="saveChoreBadgeTier('${chore.id}',${i},'count',parseInt(this.value)||1)">
                <span style="font-size:0.8rem;color:var(--muted);white-space:nowrap">completions</span>
              </div>
              <button onclick="saveChoreBadgeTier('${chore.id}',${i},'secret',${!b.secret});renderParentLevels()"
                style="margin-left:auto;background:${b.secret?'#ede9fe':'none'};border:1px solid ${b.secret?'#c4b5fd':'#e5e7eb'};border-radius:8px;padding:7px 10px;cursor:pointer;display:flex;align-items:center;gap:5px;color:${b.secret?'#7c3aed':'#9ca3af'}">
                <i class="ph-duotone ph-${b.secret?'eye-slash':'eye'}" style="font-size:1.1rem"></i>
                ${b.secret?`<span style="font-size:0.78rem;font-weight:600">Secret</span>`:''}
              </button>
            </div>
          </div>`).join('');

        return `<div style="margin-bottom:14px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <i class="ph-duotone ph-${chore.icon||'broom'}" style="color:${chore.iconColor||'#6BCB77'};font-size:1.2rem"></i>
            <span style="font-weight:600;font-size:0.95rem">${esc(chore.title)}</span>
            <span style="margin-left:auto;font-size:0.75rem;color:var(--muted)">${badges.length} tier${badges.length!==1?'s':''}</span>
          </div>
          ${tierRows}
          ${badges.length < 5 ? `<button class="btn btn-secondary btn-sm" onclick="addChoreBadgeTier('${chore.id}')">+ Add Badge Tier</button>` : ''}
          ${badges.length === 0 ? `<div style="height:16px"></div>` : ''}
        </div>`;
      }).join('');

  const html = `
    <div class="section-row">
      <span class="section-title"><i class="ph-duotone ph-rocket-launch" style="color:#6C63FF;font-size:1rem;vertical-align:middle"></i> Leveling System</span>
      <label class="toggle"><input type="checkbox" ${s.levelingEnabled!==false?'checked':''} onchange="saveSetting('levelingEnabled',this.checked);renderParentLevels()"><span class="toggle-track"></span></label>
    </div>
    <div class="card">
      <p style="font-size:0.83rem;color:var(--muted);margin-bottom:${s.levelingEnabled!==false?'14px':'0'}">Kids earn XP equal to their gems earned and unlock levels as they progress.</p>
      ${s.levelingEnabled!==false ? `${levelsHtml}
      <div style="display:flex;gap:8px;margin-top:4px">
        <button class="btn btn-primary btn-sm" onclick="addCustomLevel()">+ Add Level</button>
        <button class="btn btn-sm" style="background:#F3F4F6;color:#374151" onclick="resetLevelsToDefault()">Reset to Defaults</button>
      </div>` : ''}
    </div>

    <div class="section-row">
      <span class="section-title"><i class="ph-duotone ph-fire" style="color:#F97316;font-size:1rem;vertical-align:middle"></i> Streak Bonuses</span>
      <label class="toggle"><input type="checkbox" ${s.streakEnabled!==false?'checked':''} onchange="saveSetting('streakEnabled',this.checked);renderParentLevels()"><span class="toggle-track"></span></label>
    </div>
    <div class="card">
      <p style="font-size:0.83rem;color:var(--muted);margin-bottom:${s.streakEnabled!==false?'14px':'0'}">Bonus gems when a kid completes all the tasks in their rhythm every day in a row.</p>
      ${s.streakEnabled!==false ? `<div style="display:flex;flex-direction:column;gap:8px">
        ${[['3-day streak','streakBonus3',1],['7-day streak','streakBonus7',3],['14-day streak','streakBonus14',5],['30-day streak','streakBonus30',10]].map(([label,key,def]) => `
          <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:#FAFAFA;border-radius:10px;border:1px solid #E5E7EB">
            <span style="flex:1;font-size:0.9rem;font-weight:600">${label}</span>
            <input type="number" value="${s[key]||def}" min="0"
              style="width:64px;font-size:0.9rem;padding:6px 8px;border:1px solid #E5E7EB;border-radius:8px;text-align:center"
              onchange="saveSetting('${key}',parseInt(this.value)||0)">
            <span style="font-size:0.8rem;color:var(--muted);white-space:nowrap"><i class="ph-duotone ph-diamond" style="color:#7C3AED;font-size:0.9rem;vertical-align:middle"></i> bonus</span>
          </div>`).join('')}
      </div>` : ''}
    </div>

    <div class="section-row">
      <span class="section-title"><i class="ph-duotone ph-lightning" style="color:#F59E0B;font-size:1rem;vertical-align:middle"></i> Daily Combo</span>
      <label class="toggle"><input type="checkbox" ${s.comboEnabled!==false?'checked':''} onchange="saveSetting('comboEnabled',this.checked);renderParentLevels()"><span class="toggle-track"></span></label>
    </div>
    <div class="card">
      <p style="font-size:0.83rem;color:var(--muted);margin-bottom:${s.comboEnabled!==false?'14px':'0'}">Each kid gets a random set of 3 tasks per day for their Daily Combo - complete all 3 for double gems on those tasks.</p>
      ${s.comboEnabled!==false ? (() => {
        const kids = D.family.members.filter(m => m.role==='kid' && !m.deleted);
        if (!kids.length) return '';
        const multiplier = s.comboMultiplier || 2;
        return `
          <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#FFFBEB;border-radius:10px;border:1px solid #FDE68A;margin-bottom:14px">
            <i class="ph-duotone ph-lightning" style="color:#F59E0B;font-size:1.1rem;flex-shrink:0"></i>
            <span style="font-size:0.85rem;color:#92400E;flex:1">Complete all 3 for</span>
            <input type="number" value="${multiplier}" min="2" max="10"
              style="width:48px;font-size:0.9rem;padding:4px 6px;border:1.5px solid #FDE68A;border-radius:8px;text-align:center;font-weight:700;color:#92400E;background:white"
              onchange="saveSetting('comboMultiplier',Math.max(2,parseInt(this.value)||2));renderParentLevels()">
            <span style="font-size:0.85rem;color:#92400E;white-space:nowrap">x <i class="ph-duotone ph-diamond" style="color:#7C3AED;font-size:0.95rem;vertical-align:middle"></i></span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 14px">
          ${kids.map(kid => {
            const savedCombo = getDailyCombo(kid.id);
            const pending = (S.pendingComboOverrides || {})[kid.id] || {};
            const hasPending = Object.keys(pending).length > 0;
            const effectiveIds = [0, 1, 2].map(i => pending[i] || savedCombo[i]);
            const eligible = D.chores.filter(c => c.assignedTo?.includes(kid.id) && c.schedule?.period !== 'once');
            return `<div style="text-align:center">
              <div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:10px">
                <span style="font-weight:600;font-size:0.95rem">${esc(kid.name.split(' ')[0])}</span>
              </div>
              ${[0,1,2].map(i => {
                const otherIds = effectiveIds.filter((_, j) => j !== i);
                const slotEligible = eligible.filter(c => !otherIds.includes(c.id));
                return `
                  ${i > 0 ? `<div style="text-align:center;font-size:1.1rem;font-weight:800;color:#F59E0B;line-height:1;padding:3px 0">+</div>` : ''}
                  <select style="width:100%;text-align:center;text-align-last:center;font-size:0.85rem;padding:9px 10px;border-radius:10px;border:1.5px solid #E5E7EB;background:white;font-weight:500;color:var(--text)" onchange="stagePendingCombo('${kid.id}',${i},this.value)">
                    ${slotEligible.map(c => `<option value="${c.id}"${effectiveIds[i]===c.id?'selected':''}>${esc(c.title)}</option>`).join('')}
                  </select>`;
              }).join('')}
              ${hasPending ? `<div style="margin-top:8px"><button class="btn btn-primary btn-sm" onclick="saveComboOverride('${kid.id}')">Save Combo</button></div>` : ''}
            </div>`;
          }).join('')}
          </div>`;
      })() : ''}
    </div>

    <div class="section-row">
      <span class="section-title"><i class="ph-duotone ph-shield-check" style="color:#6C63FF;font-size:1rem;vertical-align:middle"></i> Base Badges</span>
      <label class="toggle"><input type="checkbox" ${s.baseBadgesEnabled!==false?'checked':''} onchange="saveSetting('baseBadgesEnabled',this.checked);renderParentLevels()"><span class="toggle-track"></span></label>
    </div>
    <div class="card">
      <p style="font-size:0.83rem;color:var(--muted);margin-bottom:${baseBadgesEnabled?'14px':'0'}">System-wide achievement badges earned automatically for streaks, levels, and milestones.</p>
      ${baseBadgesEnabled ? baseBadgeRows : ''}
    </div>

    <div class="section-row">
      <span class="section-title"><i class="ph-duotone ph-medal" style="color:#D97706;font-size:1rem;vertical-align:middle"></i> Task Badges</span>
      <label class="toggle"><input type="checkbox" ${s.choreBadgesEnabled!==false?'checked':''} onchange="saveSetting('choreBadgesEnabled',this.checked);renderParentLevels()"><span class="toggle-track"></span></label>
    </div>
    <div class="card">
      <p style="font-size:0.83rem;color:var(--muted);margin-bottom:${s.choreBadgesEnabled!==false?'14px':'0'}">Per-chore milestone badges. Kids earn these by completing a chore a set number of times. Use <i class="ph-duotone ph-eye" style="color:#9ca3af;vertical-align:middle"></i> to make a badge secret so it won't appear at all until earned, making it a surprise to discover.</p>
      ${s.choreBadgesEnabled!==false ? choreBadgeCards : ''}
    </div>`;

  if (_lvlContainer) { _lvlContainer.innerHTML = html; _lvlContainer.scrollTop = _lvlScroll; }
}

function saveCustomLevel(idx, field, value) {
  const levels = getLevels().map((l,i) => ({...l}));
  levels[idx][field] = value;
  // Enforce ascending XP
  if (field === 'minXp') {
    for (let i = 1; i < levels.length; i++) {
      if (levels[i].minXp <= levels[i-1].minXp) levels[i].minXp = levels[i-1].minXp + 1;
    }
  }
  D.settings.customLevels = levels;
  saveData();
  renderParentLevels();
}

function addCustomLevel() {
  const levels = getLevels().map(l => ({...l}));
  const last = levels[levels.length - 1];
  levels.push({ level: last.level + 1, name: 'New Level', icon: '<i class="ph-duotone ph-star" style="color:#F59E0B;font-size:1.4rem"></i>', minXp: last.minXp + 200 });
  D.settings.customLevels = levels;
  saveData();
  renderParentLevels();
}

function deleteCustomLevel(idx) {
  const levels = getLevels().map(l => ({...l}));
  if (levels.length <= 2) { toast('Need at least 2 levels'); return; }
  const levelName = levels[idx]?.name || 'this level';
  showQuickActionModal(`
    <div class="modal-title">Delete Level?</div>
    <p style="margin:0 0 20px;color:var(--muted);font-size:0.95rem;line-height:1.5">"${levelName}" will be permanently removed.</p>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" onclick="closeModal();_doDeleteCustomLevel(${idx})">Delete</button>
    </div>`);
}

function _doDeleteCustomLevel(idx) {
  const levels = getLevels().map(l => ({...l}));
  levels.splice(idx, 1);
  levels.forEach((l, i) => { l.level = i + 1; });
  D.settings.customLevels = levels;
  saveData();
  renderParentLevels();
}

function resetLevelsToDefault() {
  showQuickActionModal(`
    <div class="modal-title">Reset Levels?</div>
    <p style="margin:0 0 20px;color:var(--muted);font-size:0.95rem;line-height:1.5">All custom levels will be replaced with the defaults. This cannot be undone.</p>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" onclick="closeModal();_doResetLevelsToDefault()">Reset</button>
    </div>`);
}

function _doResetLevelsToDefault() {
  D.settings.customLevels = null;
  saveData();
  renderParentLevels();
}

function showLevelIconPicker(levelIdx) {
  const optionsHtml = LEVEL_ICON_OPTIONS.map((opt, i) =>
    `<button onclick="pickLevelIcon(${levelIdx},${i})" title="${opt.label}"
      style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;padding:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;width:44px;height:44px">
      ${opt.html}
    </button>`
  ).join('');
    showQuickActionModal(`
    <div class="modal-title">Choose Icon</div>
    <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-top:8px">${optionsHtml}</div>
  `);
}

function pickLevelIcon(levelIdx, optionIdx) {
  const opt = LEVEL_ICON_OPTIONS[optionIdx];
  if (!opt) return;
  const icon = opt.html.replace('font-size:1.4rem', 'font-size:1em');
  saveCustomLevel(levelIdx, 'icon', icon);
  closeModal();
}

function showBaseBadgeIconPicker(badgeId) {
  const optionsHtml = LEVEL_ICON_OPTIONS.map((opt, i) =>
    `<button onclick="pickBaseBadgeIcon('${badgeId}',${i})" title="${opt.label}"
      style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;padding:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;width:44px;height:44px">
      ${opt.html}
    </button>`
  ).join('');
  showQuickActionModal(`
    <div class="modal-title">Choose Icon</div>
    <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-top:8px">${optionsHtml}</div>
  `);
}

function pickBaseBadgeIcon(badgeId, optionIdx) {
  const opt = LEVEL_ICON_OPTIONS[optionIdx];
  if (!opt) return;
  saveBaseBadge(badgeId, 'icon', opt.html.replace('font-size:1.4rem', 'font-size:1em'));
  closeModal();
  renderParentLevels();
}

function saveBaseBadge(id, field, value) {
  D.settings.customBadgeDefs ??= {};
  D.settings.customBadgeDefs[id] ??= {};
  D.settings.customBadgeDefs[id][field] = value;
  saveData();
}


function saveChoreBadgeTier(choreId, tierIdx, field, value) {
  const chore = D.chores.find(c => c.id === choreId);
  if (!chore || !Array.isArray(chore.badges) || !chore.badges[tierIdx]) return;
  chore.badges[tierIdx][field] = value;
  saveData();
}

function addChoreBadgeTier(choreId) {
  const chore = D.chores.find(c => c.id === choreId);
  if (!chore) return;
  if (!Array.isArray(chore.badges)) chore.badges = [];
  if (chore.badges.length >= 5) { toast('Max 5 badge tiers per chore'); return; }
  const lastCount = chore.badges.at(-1)?.count || 0;
  chore.badges.push({ id: genId(), count: Math.max(10, lastCount + 10), name: '', icon: '<i class="ph-duotone ph-medal" style="color:#F59E0B"></i>' });
  chore.badges.sort((a, b) => a.count - b.count);
  saveData();
  renderParentLevels();
}

function removeChoreBadgeTier(choreId, tierIdx) {
  const chore = D.chores.find(c => c.id === choreId);
  if (!chore || !chore.badges) return;
  const badge = chore.badges[tierIdx];
  const badgeName = badge?.name || 'this badge tier';
  showQuickActionModal(`
    <div class="modal-title">Delete Badge Tier?</div>
    <p style="margin:0 0 20px;color:var(--muted);font-size:0.95rem;line-height:1.5">"${badgeName}" will be permanently removed from <strong>${chore.title}</strong>.</p>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" onclick="closeModal();_doRemoveChoreBadgeTier('${choreId}',${tierIdx})">Delete</button>
      </div>`);
}

function _doRemoveChoreBadgeTier(choreId, tierIdx) {
  const chore = D.chores.find(c => c.id === choreId);
  if (!chore || !chore.badges) return;
  chore.badges.splice(tierIdx, 1);
  saveData();
  renderParentLevels();
}

let _bip = { choreId: null, tierIdx: null, color: '#6BCB77' };

function showChoreBadgeIconPicker(choreId, tierIdx) {
  const chore = D.chores.find(c => c.id === choreId);
  const badge = chore?.badges?.[tierIdx];
  const curIcon = badge?.icon || '';
  const colorMatch = /color:(#[0-9a-fA-F]{3,6})/.exec(curIcon);
  _bip = { choreId, tierIdx, color: colorMatch?.[1] || COLORS[0] };
  const curName = /ph-duotone ph-([\w-]+)/.exec(curIcon)?.[1] || '';

  const colorSwatches = COLORS.map(col =>
    `<div class="icon-color-swatch${col===_bip.color?' sel':''}" style="background:${col}" onclick="selBadgeIconColor(this,'${col}')"></div>`
  ).join('');
  const iconOpts = ICON_MAP.slice(0, 48).map(({n}) =>
    `<div class="icon-opt${n===curName?' sel':''}" onclick="selBadgeIcon(this,'${n}')" data-icon="${n}"><i class="ph-duotone ph-${n}"></i></div>`
  ).join('');

  showQuickActionModal(`
    <div class="modal-title">Badge Icon</div>
    <div class="icon-color-row">${colorSwatches}</div>
    <input type="text" class="icon-search-input" placeholder="Search icons (e.g. trophy, star, fire)..." oninput="filterBadgeIcons(this.value,'${choreId}',${tierIdx})">
    <div class="icon-picker" id="badge-icon-picker-grid" style="color:${_bip.color}">${iconOpts}</div>
  `);
}

function selBadgeIconColor(el, color) {
  _bip.color = color;
  el.closest('.icon-color-row').querySelectorAll('.icon-color-swatch').forEach(x => x.classList.remove('sel'));
  el.classList.add('sel');
  const grid = document.getElementById('badge-icon-picker-grid');
  if (grid) grid.style.color = color;
}

function filterBadgeIcons(query, choreId, tierIdx) {
  const q = query.toLowerCase().trim();
  const chore = D.chores.find(c => c.id === choreId);
  const curName = /ph-duotone ph-([\w-]+)/.exec(chore?.badges?.[tierIdx]?.icon || '')?.[1] || '';
  const grid = document.getElementById('badge-icon-picker-grid');
  if (!grid) return;
  const matches = q ? ICON_MAP.filter(({k}) => k.includes(q)) : ICON_MAP.slice(0, 48);
  grid.innerHTML = matches.length === 0
    ? `<div style="color:var(--muted);font-size:0.85rem;padding:8px;grid-column:1/-1">No icons found - try different words.</div>`
    : matches.map(({n}) =>
        `<div class="icon-opt${n===curName?' sel':''}" onclick="selBadgeIcon(this,'${n}')" data-icon="${n}"><i class="ph-duotone ph-${n}"></i></div>`
      ).join('');
}

function selBadgeIcon(el, name) {
  const icon = `<i class="ph-duotone ph-${name}" style="color:${_bip.color};font-size:1em"></i>`;
  saveChoreBadgeTier(_bip.choreId, _bip.tierIdx, 'icon', icon);
  closeModal();
  renderParentLevels();
}

function showPrizeModal(prizeId, opts = {}) {
  const prize = prizeId ? D.prizes.find(p=>p.id===prizeId) : null;
  const p     = prize || { title:'', icon:'gift', iconColor:'#FF6584', cost:100, type:'individual' };

  const prizeColor = p.iconColor || '#FF6584';
  const iconOpts = ICON_MAP.slice(0, 48).map(({n}) =>
    `<div class="icon-opt${n===p.icon?' sel':''}" onclick="selPrizeIcon(this,'${n}')" data-icon="${n}"><i class="ph-duotone ph-${n}"></i></div>`
  ).join('');
  const colorSwatches = COLORS.map(col =>
    `<div class="icon-color-swatch${col===prizeColor?' sel':''}" style="background:${col}" onclick="selPrizeColor(this,'${col}')"></div>`
  ).join('');

  const modalHtml = `
    <input type="hidden" id="pm-icon" value="${p.icon}">
    <input type="hidden" id="pm-icon-color" value="${prizeColor}">
    <div class="form-group">
      <label class="form-label">Prize name</label>
      <input type="text" id="pm-title" placeholder="e.g. Movie Night Pick" value="${esc(p.title)}">
    </div>
    <div class="form-group">
      <div class="icon-color-row">${colorSwatches}</div>
      <input type="text" class="icon-search-input" placeholder="Search icons (e.g. movie, game, trophy)..." oninput="filterPrizeIcons(this.value)">
      <div class="icon-picker" id="prize-icon-picker-grid" style="color:${prizeColor}">${iconOpts}</div>
    </div>
    <div class="form-group">
      <label class="form-label">Gems cost</label>
      <input type="number" id="pm-cost" min="1" value="${p.cost}">
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="savePrize('${prizeId||''}')">Save <i class="ph-duotone ph-check" style="font-size:0.95rem;vertical-align:middle"></i></button>
    </div>`;
  if (opts.quickAction) {
    showQuickActionModal(modalHtml, 'quick-action-modal-wide prize-editor-modal');
  } else {
    showQuickActionModal(modalHtml, 'quick-action-modal-wide prize-editor-modal');
  }
}

function selPrizeIcon(el, icon) {
  document.getElementById('pm-icon').value = icon;
  el.closest('#prize-icon-picker-grid, .icon-picker').querySelectorAll('.icon-opt').forEach(x=>x.classList.remove('sel'));
  el.classList.add('sel');
}

function filterPrizeIcons(query) {
  const q = query.toLowerCase().trim();
  const cur = document.getElementById('pm-icon')?.value;
  const grid = document.getElementById('prize-icon-picker-grid');
  if (!grid) return;
  const matches = q ? ICON_MAP.filter(({k}) => k.includes(q)) : ICON_MAP.slice(0, 48);
  if (matches.length === 0) {
    grid.innerHTML = `<div style="color:var(--muted);font-size:0.85rem;padding:8px;grid-column:1/-1">No icons found - try different words.</div>`;
  } else {
    grid.innerHTML = matches.map(({n}) =>
      `<div class="icon-opt${n===cur?' sel':''}" onclick="selPrizeIcon(this,'${n}')" data-icon="${n}"><i class="ph-duotone ph-${n}"></i></div>`
    ).join('');
  }
}

function savePrize(prizeId) {
  const title     = document.getElementById('pm-title')?.value.trim();
  const icon      = document.getElementById('pm-icon')?.value || 'gift';
  const iconColor = document.getElementById('pm-icon-color')?.value || '#FF6584';
  const cost      = parseInt(document.getElementById('pm-cost')?.value)||100;
  if (!title) { toast('Enter a prize name'); return; }

  if (prizeId) {
    const p = D.prizes.find(x=>x.id===prizeId);
    if (p) Object.assign(p, { title, icon, iconColor, cost, type:'individual' });
  } else {
    D.prizes.push({ id:genId(), title, icon, iconColor, cost, type:'individual', redemptions:[] });
  }
  saveData();
  closeModal();
  toast(prizeId?'Prize updated!':'Prize added!');
  renderParentPrizes();
}

function deletePrize(prizeId) {
  const prize = D.prizes.find(p => p.id === prizeId);
  showQuickActionModal(`
    <div class="modal-title">Delete Prize?</div>
    <p style="margin:0 0 20px;color:var(--muted);font-size:0.95rem;line-height:1.5">"${prize?.title || 'This prize'}" will be permanently deleted.</p>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" onclick="closeModal();_doDeletePrize('${prizeId}')">Delete</button>
    </div>`, 'quick-action-modal-wide');
}

function _doDeletePrize(prizeId) {
  D.prizes = D.prizes.filter(p=>p.id!==prizeId);
  saveData();
  toast('Prize deleted');
  renderParentPrizes();
}

function openAddPrizeModal(triggerEl) {
  const rect = triggerEl?.getBoundingClientRect?.();
  if (rect) _modalLaunchOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  showPrizeModal(null, { quickAction: true });
}

function openPrizeEditor(prizeId, triggerEl) {
  const rect = triggerEl?.getBoundingClientRect?.();
  if (rect) _modalLaunchOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  const shell = triggerEl?.closest?.('.snapshot-routine-shell');
  if (shell?.classList.contains('revealed')) {
    shell.classList.remove('revealed');
    setTimeout(() => showPrizeModal(prizeId, { quickAction: true }), 180);
    return;
  }
  showPrizeModal(prizeId, { quickAction: true });
}

function openAddGoalModal(triggerEl) {
  const rect = triggerEl?.getBoundingClientRect?.();
  if (rect) _modalLaunchOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  showGoalModal(null, { quickAction: true });
}

function openGoalEditor(goalId, triggerEl) {
  const rect = triggerEl?.getBoundingClientRect?.();
  if (rect) _modalLaunchOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  const shell = triggerEl?.closest?.('.snapshot-routine-shell');
  if (shell?.classList.contains('revealed')) {
    shell.classList.remove('revealed');
    setTimeout(() => showGoalModal(goalId, { quickAction: true }), 180);
    return;
  }
  showGoalModal(goalId, { quickAction: true });
}

function showGoalModal(goalId, opts = {}) {
  const existing = goalId ? D.teamGoals?.find(g => g.id === goalId) : null;
  const g = existing || { title:'', icon:'trophy', iconColor:'#FFD93D', targetPoints:500 };
  const goalColor = g.iconColor || '#FFD93D';
  const iconOpts = ICON_MAP.slice(0, 48).map(({n}) =>
    `<div class="icon-opt${n===g.icon?' sel':''}" onclick="selGoalIcon(this,'${n}')" data-icon="${n}"><i class="ph-duotone ph-${n}"></i></div>`
  ).join('');
  const colorSwatches = COLORS.map(col =>
    `<div class="icon-color-swatch${col===goalColor?' sel':''}" style="background:${col}" onclick="selGoalColor(this,'${col}')"></div>`
  ).join('');

  const modalHtml = `
    <input type="hidden" id="gm-id" value="${goalId||''}">
    <input type="hidden" id="gm-icon" value="${g.icon||'trophy'}">
    <input type="hidden" id="gm-icon-color" value="${goalColor}">
    <div class="form-group">
      <label class="form-label">Prize name</label>
      <input type="text" id="gm-title" placeholder="e.g. Disney Trip!" value="${esc(g.title)}">
    </div>
    <div class="form-group">
      <div class="icon-color-row">${colorSwatches}</div>
      <input type="text" class="icon-search-input" placeholder="Search icons (e.g. trophy, trip, movie)..." oninput="filterGoalIcons(this.value)">
      <div class="icon-picker" id="goal-icon-picker-grid" style="color:${goalColor}">${iconOpts}</div>
    </div>
    <div class="form-group">
      <label class="form-label">Gems target</label>
      <input type="number" id="gm-target" min="1" value="${g.targetPoints||500}">
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-teal" onclick="saveGoal()">Save <i class="ph-duotone ph-check" style="font-size:0.95rem;vertical-align:middle"></i></button>
    </div>`;
  if (opts.quickAction) {
    showQuickActionModal(modalHtml, 'quick-action-modal-wide prize-editor-modal');
  } else {
    showQuickActionModal(modalHtml, 'quick-action-modal-wide prize-editor-modal');
  }
}

function selGoalIcon(el, icon) {
  document.getElementById('gm-icon').value = icon;
  el.closest('.icon-picker').querySelectorAll('.icon-opt').forEach(x=>x.classList.remove('sel'));
  el.classList.add('sel');
}

function selGoalColor(el, color) {
  document.getElementById('gm-icon-color').value = color;
  el.closest('.icon-color-row').querySelectorAll('.icon-color-swatch').forEach(x => x.classList.remove('sel'));
  el.classList.add('sel');
  const grid = document.getElementById('goal-icon-picker-grid');
  if (grid) grid.style.color = color;
}

function filterGoalIcons(query) {
  const q = query.toLowerCase().trim();
  const cur = document.getElementById('gm-icon')?.value;
  const grid = document.getElementById('goal-icon-picker-grid');
  if (!grid) return;
  const matches = q ? ICON_MAP.filter(({k}) => k.includes(q)) : ICON_MAP.slice(0, 48);
  if (matches.length === 0) {
    grid.innerHTML = `<div style="color:var(--muted);font-size:0.85rem;padding:8px;grid-column:1/-1">No icons found - try different words.</div>`;
  } else {
    grid.innerHTML = matches.map(({n}) =>
      `<div class="icon-opt${n===cur?' sel':''}" onclick="selGoalIcon(this,'${n}')" data-icon="${n}"><i class="ph-duotone ph-${n}"></i></div>`
    ).join('');
  }
}

function saveGoal() {
  const goalId = document.getElementById('gm-id')?.value;
  const title  = document.getElementById('gm-title')?.value.trim();
  const icon      = document.getElementById('gm-icon')?.value || 'trophy';
  const iconColor = document.getElementById('gm-icon-color')?.value || '#FFD93D';
  const target = parseInt(document.getElementById('gm-target')?.value)||500;
  if (!title) { toast('Enter a prize name'); return; }

  if (!D.teamGoals) D.teamGoals = [];
  if (goalId) {
    const g = D.teamGoals.find(x => x.id === goalId);
    if (g) Object.assign(g, { title, icon, iconColor, targetPoints: target });
  } else {
    D.teamGoals.push({ id: genId(), title, icon, iconColor, targetPoints: target, contributions: {} });
  }
  saveData();
  closeModal();
  toast(goalId ? 'Team prize updated!' : 'Team prize added!');
  renderParentPrizes();
}

function clearGoal(goalId) {
  const goal = (D.teamGoals||[]).find(g => g.id === goalId);
  showQuickActionModal(`
    <div class="modal-title">Delete Team Prize?</div>
    <p style="margin:0 0 20px;color:var(--muted);font-size:0.95rem;line-height:1.5">"${goal?.title || 'This team prize'}" will be permanently deleted.</p>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" onclick="closeModal();_doClearGoal('${goalId}')">Delete</button>
    </div>`, 'quick-action-modal-wide');
}

function _doClearGoal(goalId) {
  D.teamGoals = (D.teamGoals||[]).filter(g => g.id !== goalId);
  saveData();
  renderParentPrizes();
}


let _advBackup = null;

function showAdvancedEditor() {
  _advBackup = JSON.parse(JSON.stringify(D));
  const root = document.getElementById('adv-editor-root');
  root.classList.add('open');
  _advRender();
  root.scrollTop = 0;
}

function closeAdvancedEditor() {
  _advBackup = null;
  const root = document.getElementById('adv-editor-root');
  root.classList.remove('open');
  root.innerHTML = '';
}

function cancelAdvancedEditor() {
  if (_advBackup) {
    D = normalizeData(_advBackup);
    saveData();
  }
  closeAdvancedEditor();
}

function _advField(label, inputHtml) {
  return `<div class="adv-row">
    <span class="adv-label">${label}</span>
    ${inputHtml}
  </div>`;
}

function _advInput(type, val, onchange, extra='') {
  const v = val === null || val === undefined ? '' : val;
  return `<input type="${type}" class="adv-input" value="${esc(String(v))}" onchange="${onchange}" ${extra}>`;
}

function _advCheck(checked, onchange) {
  return `<label class="toggle" style="flex-shrink:0"><input type="checkbox" ${checked?'checked':''} onchange="${onchange}"><span class="toggle-track"></span></label>`;
}

function advSetMember(id, field, val) {
  const m = getMember(id);
  if (!m) return;
  if (field.includes('.')) {
    const [a, b] = field.split('.');
    if (!m[a] || typeof m[a] !== 'object') m[a] = {};
    m[a][b] = val;
  } else {
    m[field] = val;
  }
  saveData();
  _advRefreshStatus(`Member saved`);
}

function advSetRole(memberId, val, el) {
  if (val === 'kid' && D.family.members.filter(m => m.role === 'parent' && m.id !== memberId).length === 0) {
    if (el) el.value = 'parent';
    toast("Can't remove the last parent");
    return;
  }
  advSetMember(memberId, 'role', val);
}

function advToggleBadge(memberId, badgeId) {
  const m = getMember(memberId);
  if (!m) return;
  if (!Array.isArray(m.badges)) m.badges = [];
  const idx = m.badges.indexOf(badgeId);
  if (idx >= 0) m.badges.splice(idx, 1);
  else m.badges.push(badgeId);
  saveData();
  _advRenderPreserving();
  _advRefreshStatus('Badge updated');
}

function advSetChore(id, field, val) {
  const c = D.chores.find(x => x.id === id);
  if (!c) return;
  c[field] = val;
  saveData();
  _advRefreshStatus(`Task saved`);
}

function advSetPrize(id, field, val) {
  const p = D.prizes.find(x => x.id === id);
  if (!p) return;
  p[field] = val;
  saveData();
  _advRefreshStatus(`Prize saved`);
}

function advClearChoreCompletions(choreId, memberId) {
  const chore = D.chores.find(c => c.id === choreId);
  if (!chore) return;
  const member = memberId ? getMember(memberId) : null;
  const what = member ? `${esc(member.name)}'s completions for "${esc(chore.title)}"` : `all completions for "${esc(chore.title)}"`;
    showQuickActionModal(`
    <div class="modal-title">Clear Completions?</div>
    <p style="margin:0 0 20px;color:var(--muted);font-size:0.95rem;line-height:1.5">This will permanently clear ${what}. Task badge progress will be lost.</p>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" onclick="closeModal();_doAdvClearCompletions('${choreId}','${memberId||''}')">Clear</button>
      </div>`);
}

function _doAdvClearCompletions(choreId, memberId) {
  const chore = D.chores.find(c => c.id === choreId);
  if (!chore) return;
  if (memberId) {
    if (chore.completions) delete chore.completions[memberId];
  } else {
    chore.completions = {};
  }
  saveData();
  _advRenderPreserving();
  _advRefreshStatus('Completions cleared');
}

function advUpdateCompletion(choreId, memberId, entryId, field, rawValue) {
  const chore = D.chores.find(c => c.id === choreId);
  if (!chore) return;
  chore.completions = chore.completions || {};
  chore.completions[memberId] = normalizeCompletionEntries(chore.completions[memberId]);
  const entry = chore.completions[memberId].find(e => e.id === entryId);
  if (!entry) return;
  if (field === 'status') {
    entry.status = ['pending', 'approved', 'done'].includes(rawValue) ? rawValue : 'done';
  } else if (field === 'date') {
    entry.date = rawValue || today();
  } else if (field === 'entryType') {
    entry.entryType = rawValue === 'before' ? 'before' : rawValue === 'after' ? 'after' : null;
  }
  saveData();
  _advRefreshStatus('Completion updated');
}

function advDeleteCompletion(choreId, memberId, entryId) {
  const chore = D.chores.find(c => c.id === choreId);
  if (!chore) return;
  showQuickActionModal(`
    <div class="modal-title">Delete Completion?</div>
    <p style="margin:0 0 20px;color:var(--muted);font-size:0.95rem;line-height:1.5">This completion entry will be permanently deleted.</p>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" onclick="closeModal();_doAdvDeleteCompletion('${choreId}','${memberId}','${entryId}')">Delete</button>
    </div>`);
}

function _doAdvDeleteCompletion(choreId, memberId, entryId) {
  const chore = D.chores.find(c => c.id === choreId);
  if (!chore?.completions?.[memberId]) return;
  chore.completions[memberId] = normalizeCompletionEntries(chore.completions[memberId]).filter(e => e.id !== entryId);
  if (!chore.completions[memberId].length) delete chore.completions[memberId];
  saveData();
  _advRenderPreserving();
  _advRefreshStatus('Completion deleted');
}

function advDeleteHistory(entryId) {
  showQuickActionModal(`
    <div class="modal-title">Delete Entry?</div>
    <p style="margin:0 0 20px;color:var(--muted);font-size:0.95rem;line-height:1.5">This history entry will be permanently deleted.</p>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" onclick="closeModal();_doAdvDeleteHistory('${entryId}')">Delete</button>
    </div>`);
}

function _doAdvDeleteHistory(entryId) {
  const idx = D.history.findIndex(h => h.id === entryId);
  if (idx < 0) return;
  D.history.splice(idx, 1);
  saveData();
  const row = document.querySelector(`[data-hist-id="${entryId}"]`);
  if (row) row.remove();
  _advRefreshStatus('Deleted');
}

function _advRenderPreserving() {
  const root = document.getElementById('adv-editor-root');
  const scroll = root ? root.scrollTop : 0;
  const openIds = new Set([...(root?.querySelectorAll('details.adv-member-card[open]') || [])]
    .map(d => d.dataset.memberId).filter(Boolean));
  _advRender();
  if (root) {
    root.scrollTop = scroll;
    openIds.forEach(id => {
      const el = root.querySelector(`details.adv-member-card[data-member-id="${id}"]`);
      if (el) el.open = true;
    });
  }
}

function advApplyRawJson() {
  const ta = document.getElementById('adv-raw-json');
  const statusEl = document.getElementById('adv-json-status');
  try {
    const parsed = JSON.parse(ta.value);
    D = normalizeData(parsed);
    saveData();
    if (statusEl) { statusEl.className = 'adv-status ok'; statusEl.textContent = 'Applied & saved successfully'; }
    _advRenderPreserving();
  } catch(e) {
    if (statusEl) { statusEl.className = 'adv-status err'; statusEl.textContent = `JSON error: ${e.message}`; }
  }
}

function _advRefreshStatus(msg) {
  const el = document.getElementById('adv-save-status');
  if (!el) return;
  el.className = 'adv-status ok';
  el.textContent = `${msg}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.textContent = ''; el.className = ''; }, 2000);
}

function _advDeleteTeamGoal(idx) {
  const goal = (D.teamGoals||[])[idx];
  showQuickActionModal(`
    <div class="modal-title">Delete Team Prize?</div>
    <p style="margin:0 0 20px;color:var(--muted);font-size:0.95rem;line-height:1.5">"${goal?.title || 'This team prize'}" will be permanently deleted.</p>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" onclick="closeModal();D.teamGoals.splice(${idx},1);saveData();_advRender()">Delete</button>
    </div>`);
}

function _advRender() {
  const root = document.getElementById('adv-editor-root');
  if (!root) return;

  const members = D.family.members;
  const kids = members.filter(m => m.role === 'kid' && !m.deleted);

  const membersHtml = kids.map(m => {
    normalizeMember(m);
    const isKid = m.role === 'kid';
    const roleLabel = isKid ? 'Kid' : 'Parent';
    const subtitle = isKid ? `Kid &middot; ${m.gems||0} gems` : 'Parent &middot; Admin';


    const balanceFields = [
      _advField('Gems - Current',      _advInput('number', m.gems||0,    `advSetMember('${m.id}','diamonds',+this.value)`)),
      _advField('Gems - All Time',        _advInput('number', m.totalEarned||0, `advSetMember('${m.id}','totalEarned',+this.value)`)),
      _advField('Total XP',                 _advInput('number', m.xp||0,          `advSetMember('${m.id}','xp',+this.value)`)),
    ].join('');

    const savingsFields = isKid ? [
      _advField('Savings Balance',        _advInput('number', (m.savings||0).toFixed(2),        `advSetMember('${m.id}','savings',parseFloat(this.value)||0)`, 'step="0.01"')),
      _advField('Savings - Gifted',         _advInput('number', (m.savingsGifted||0).toFixed(2),  `advSetMember('${m.id}','savingsGifted',parseFloat(this.value)||0)`, 'step="0.01"')),
      _advField('Savings - Parent Matched', _advInput('number', (m.savingsMatched||0).toFixed(2), `advSetMember('${m.id}','savingsMatched',parseFloat(this.value)||0)`, 'step="0.01"')),
      _advField('Savings - Interest', _advInput('number', (m.savingsInterest||0).toFixed(2),`advSetMember('${m.id}','savingsInterest',parseFloat(this.value)||0)`, 'step="0.01"')),
      _advField('Savings Interest - Last Claimed',   _advInput('date',   m.savingsInterestLastDate||'',    `advSetMember('${m.id}','savingsInterestLastDate',this.value)`)),
    ].join('') : '';

    const streakFields = isKid ? [
      _advField('Streak - Current',        _advInput('number', m.streak?.current||0,  `advSetMember('${m.id}','streak.current',+this.value)`)),
      _advField('Streak - Best',      _advInput('number', m.streak?.best||0,     `advSetMember('${m.id}','streak.best',+this.value)`)),
      _advField('Streak - Last Date',      _advInput('date',   m.streak?.lastDate||'',`advSetMember('${m.id}','streak.lastDate',this.value)`)),
    ].join('') : '';

    const comboFields = isKid ? [
      _advField('Combo - Last Bonus Date',  _advInput('date',   m.comboBonusDate||'',         `advSetMember('${m.id}','comboBonusDate',this.value)`)),
      _advField('Combo Streak',           _advInput('number', m.comboStreak?.current||0,    `advSetMember('${m.id}','comboStreak.current',+this.value)`)),
      _advField('Combo Streak - Best',      _advInput('number', m.comboStreak?.best||0,       `advSetMember('${m.id}','comboStreak.best',+this.value)`)),
      _advField('Combo Streak - Date',      _advInput('date',   m.comboStreak?.lastDate||'',  `advSetMember('${m.id}','comboStreak.lastDate',this.value)`)),
    ].join('') : '';

    const nlFields = isKid ? [
      _advField('Not-Listening Today (secs)',   _advInput('number', m.nlTodaySecs||0,    `advSetMember('${m.id}','nlTodaySecs',+this.value)`)),
      _advField('Not-Listening Pending (secs)', _advInput('number', m.nlPendingSecs||0,  `advSetMember('${m.id}','nlPendingSecs',+this.value)`)),
      _advField('Not-Listening Lifetime (secs)',_advInput('number', m.nlLifetimeSecs||0, `advSetMember('${m.id}','nlLifetimeSecs',+this.value)`)),
      _advField('Not-Listening - Last Date',      _advInput('date',   m.nlDate||'',        `advSetMember('${m.id}','nlDate',this.value)`)),
    ].join('') : '';

    const badgesField = isKid ? (() => {
      const earned = m.badges || [];
      const allBaseBadges = BADGE_DEFS.map(b => ({ id: b.id, icon: b.icon, name: b.name }));
      const allSystemTaskBadges = Object.entries(CHORE_BADGE_PRESETS || {}).flatMap(([title, badges]) =>
        (badges || []).map((b, idx) => ({
          id: `sys_cb_${title}_${b.name || idx}`,
          icon: b.icon || '<i class="ph-duotone ph-medal" style="color:#F59E0B"></i>',
          name: b.name || ''
        }))
      );
      const allCustomTaskBadges = (D.chores || []).flatMap(c =>
        (c.badges || []).map(b => ({ id: `cb_${b.id}`, icon: b.icon || '<i class="ph-duotone ph-medal" style="color:#F59E0B"></i>', name: b.name || '' }))
      );
      const allBadges = [...allBaseBadges, ...allSystemTaskBadges, ...allCustomTaskBadges].filter((badge, idx, arr) =>
        idx === arr.findIndex(other => other.id === badge.id)
      );
      if (allBadges.length === 0) return '';
      const pills = allBadges.map(b => {
        const have = earned.includes(b.id);
        return `<div class="badge-chip ${have ? 'earned' : 'badge-chip-locked'}" style="cursor:pointer"
          onclick="advToggleBadge('${m.id}','${b.id}')">
          <span class="badge-chip-icon">${b.icon}</span>${esc(b.name)}
        </div>`;
      }).join('');
      return `<div class="adv-subhead">Badges <span style="font-weight:400;font-size:0.68rem">(tap to toggle)</span></div>
        <div class="badge-grid">${pills}</div>`;
    })() : '';

    return `<details class="adv-member-card" data-member-id="${m.id}">
      <summary class="adv-member-summary">
        <span style="font-size:1.5rem;flex-shrink:0">${renderMemberAvatarHtml(m)}</span>
        <span style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:0.95rem">${esc(m.name)}</div>
          <div style="font-size:0.75rem;color:var(--muted)">${subtitle}</div>
        </span>
        <i class="ph-duotone ph-caret-down adv-caret" style="font-size:1rem"></i>
      </summary>
      <div class="adv-member-body">
        ${!isKid ? `<div style="font-size:0.82rem;color:var(--muted);padding:4px 0">Parent profile - edit name, avatar, and PIN through Settings.</div>` : ''}
        ${isKid ? `<div class="adv-subhead">Balance</div>${balanceFields}` : ''}
        ${isKid ? `<div class="adv-subhead">Savings</div>${savingsFields}` : ''}
        ${isKid ? `<div class="adv-subhead">Streak</div>${streakFields}` : ''}
        ${isKid ? `<div class="adv-subhead">Daily Combo</div>${comboFields}` : ''}
        ${isKid ? `<div class="adv-subhead">Not Listening</div>${nlFields}` : ''}
        ${badgesField}
      </div>
    </details>`;
  });

  const choresHtml = D.chores.length === 0
    ? '<div style="color:var(--muted);font-size:0.85rem;padding:6px 0">No tasks yet</div>'
    : D.chores.map(c => {
      const completionRows = D.family.members.filter(m => {
        return normalizeCompletionEntries(c.completions?.[m.id]).length > 0;
      }).map(m => {
        const entries = normalizeCompletionEntries(c.completions[m.id]);
        const entryRows = entries.map(e => {
          const slotLabel = e.slotId && c.schedule?.slots ? (c.schedule.slots.find(s => s.id === e.slotId)?.label || e.slotId) : '';
          return `<div class="adv-row" style="align-items:center">
            <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:6px">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:nowrap;min-width:0;overflow-x:auto">
                <select class="adv-input" style="flex:0 0 90px" onchange="advUpdateCompletion('${c.id}','${m.id}','${e.id}','status',this.value)">
                  <option value="pending" ${e.status === 'pending' ? 'selected' : ''}>Pending</option>
                  <option value="approved" ${e.status === 'approved' ? 'selected' : ''}>Approved</option>
                  <option value="done" ${e.status === 'done' ? 'selected' : ''}>Done</option>
                </select>
                <input type="date" class="adv-input" style="flex:0 0 134px" value="${esc(e.date || '')}" onchange="advUpdateCompletion('${c.id}','${m.id}','${e.id}','date',this.value)">
                <select class="adv-input" style="flex:0 0 92px" onchange="advUpdateCompletion('${c.id}','${m.id}','${e.id}','entryType',this.value)">
                  <option value="" ${!e.entryType ? 'selected' : ''}>Standard</option>
                  <option value="before" ${e.entryType === 'before' ? 'selected' : ''}>Before</option>
                  <option value="after" ${e.entryType === 'after' ? 'selected' : ''}>After</option>
                </select>
              </div>
              <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:0.76rem;color:var(--muted);min-width:0">
                <span>ID: ${esc(e.id)}</span>
                ${slotLabel ? `<span>Slot: ${esc(formatSlotLabel(slotLabel))}</span>` : ''}
                ${e.photoUrl ? '<span>Photo attached</span>' : ''}
              </div>
            </div>
            <button class="btn-icon-sm btn-icon-delete" style="width:28px;height:28px;border-radius:6px;flex-shrink:0;align-self:center;margin-left:10px" onclick="advDeleteCompletion('${c.id}','${m.id}','${e.id}')"><i class="ph-duotone ph-trash" style="font-size:0.85rem"></i></button>
          </div>`;
        }).join('');
        return `<div style="padding:6px 0">
          <div style="display:flex;align-items:center;gap:8px;padding:2px 0 6px">
            <span style="font-size:1rem;flex-shrink:0">${renderMemberAvatarHtml(m)}</span>
            <span style="font-size:0.84rem;font-weight:700;flex:1;min-width:0">${esc(m.name)}</span>
            <button class="btn-icon-sm btn-icon-delete" style="width:28px;height:28px;border-radius:6px" onclick="advClearChoreCompletions('${c.id}','${m.id}')"><i class="ph-duotone ph-trash" style="font-size:0.85rem"></i></button>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px">${entryRows}</div>
        </div>`;
      }).join('');
      // Only render chores that have completions (or always show header, just no completions section)
      const iconDisplay = c.icon && [...c.icon].length <= 2
        ? c.icon
        : '<i class="ph-duotone ph-clipboard-text" style="color:#9CA3AF"></i>';
      const oncePill = (c.schedule||c).period==='once'
        ? `<span style="font-size:0.72rem;background:#FEF3C7;color:#92400E;border-radius:4px;padding:1px 5px;font-weight:600">once</span>`
        : '';
      return `<div style="padding:10px 0;border-bottom:1px solid #F3F4F6">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:1.3rem;width:28px;text-align:center;flex-shrink:0">${iconDisplay}</span>
          <span style="font-weight:600;font-size:0.9rem;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.title)}</span>
          ${oncePill}
          <span style="font-size:0.8rem;color:var(--muted);white-space:nowrap;flex-shrink:0">${c.gems||0} gems</span>
        </div>
        ${completionRows
          ? `<div style="margin-top:8px;padding-left:4px">${completionRows}</div>`
          : `<div style="margin-top:4px;padding-left:4px;font-size:0.78rem;color:var(--muted)">No completions</div>`}
      </div>`;
    }).join('');


  const teamGoals = D.teamGoals || [];
  const allKids = D.family.members.filter(m => m.role === 'kid' && !m.deleted);
  const goalHtml = teamGoals.length === 0
    ? '<div style="color:var(--muted);font-size:0.85rem;padding:6px 0">No team prizes yet</div>'
    : teamGoals.map((g,i) => {
      const total = goalTotal(g);
      const target = g.targetPoints || 0;
      const pct = target > 0 ? Math.min(100, Math.round(total / target * 100)) : 0;
      const contribRows = allKids.map(k => {
        const c = (g.contributions||{})[k.id] || 0;
        return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0">
          <span style="font-size:1rem;flex-shrink:0">${k.avatar||'<i class="ph-duotone ph-smiley" style="color:#9CA3AF"></i>'}</span>
          <span style="font-size:0.85rem;flex:1">${esc(k.name)}</span>
          <input type="number" class="adv-input" style="width:80px;flex:none;text-align:right" value="${c}" min="0"
            onchange="if(!D.teamGoals[${i}].contributions)D.teamGoals[${i}].contributions={};D.teamGoals[${i}].contributions['${k.id}']=+this.value;saveData();_advRefreshStatus('Saved')">
          <span style="font-size:0.82rem;color:var(--muted);flex-shrink:0">gems</span>
        </div>`;
      }).join('');
      return `<div style="padding:10px 0;border-bottom:1px solid #F3F4F6">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span style="font-size:1.3rem;flex-shrink:0;display:inline-flex;align-items:center">${renderIcon(g.icon, g.iconColor, 'font-size:1.4rem') || '<i class="ph-duotone ph-trophy" style="color:#D97706;font-size:1.4rem"></i>'}</span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:0.9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(g.title||'')}</div>
            <div style="font-size:0.78rem;color:var(--muted)">${total} / ${target} gems &middot; ${pct}%</div>
          </div>
          <button class="btn btn-danger btn-sm" onclick="_advDeleteTeamGoal(${i})">Delete</button>
        </div>
        <div style="height:5px;background:#F3F4F6;border-radius:99px;overflow:hidden;margin-bottom:8px">
          <div style="height:100%;width:${pct}%;background:var(--teal);border-radius:99px"></div>
        </div>
        ${contribRows}
      </div>`;
    }).join('');

  const histItems = (D.history || []).slice(0, 150);
  const histHtml = histItems.length === 0
    ? '<div style="color:var(--muted);font-size:0.85rem;padding:6px 0">No history yet</div>'
    : histItems.map(h => {
        const mem = getMember(h.memberId);
        const badge = historyBadge(h);
        const icon = historyIcon(h);
        const ptsStr = (h.gems||0) >= 0 ? `+${h.gems}` : `${h.gems}`;
        const ptsCol = (h.gems||0) >= 0 ? '#166534' : '#991b1b';
        return `<div class="adv-hist-row" data-hist-id="${h.id}">
          <span style="background:${badge.bg};color:${badge.color};border-radius:8px;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:0.85rem;flex-shrink:0">${icon}</span>
          <span style="font-size:1rem;flex-shrink:0">${mem?.avatar||'?'}</span>
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:0.85rem">${esc(h.title)}</span>
          <span style="color:${ptsCol};font-weight:700;white-space:nowrap;font-size:0.85rem">${ptsStr} gems</span>
          <span style="color:var(--muted);white-space:nowrap;font-size:0.75rem">${h.date}</span>
          <button class="btn-icon-sm btn-icon-delete" style="width:28px;height:28px;border-radius:6px;flex-shrink:0" onclick="advDeleteHistory('${h.id}')"><i class="ph-duotone ph-trash" style="font-size:0.9rem"></i></button>
        </div>`;
      }).join('');

  root.innerHTML = `
    <div class="adv-header">
      <i class="ph-duotone ph-database" style="font-size:1.3rem"></i>
      <span class="adv-header-title">Data Editor</span>
      <div class="adv-header-actions">
        <span id="adv-save-status" class="adv-status"></span>
        <button class="adv-header-btn" style="padding:5px 12px" onclick="cancelAdvancedEditor()">Cancel</button>
        <button class="adv-header-btn adv-header-btn-close" onclick="closeAdvancedEditor()" aria-label="Close advanced editor"><i class="ph-duotone ph-x" style="font-size:1rem"></i></button>
      </div>
    </div>
    <div class="adv-body">

      <div style="height:4px"></div>
      <div class="section-row"><span class="section-title"><i class="ph-duotone ph-users-three" style="vertical-align:middle;margin-right:6px"></i>Members</span></div>
      <div style="display:flex;flex-direction:column;gap:8px">${membersHtml.join('')}</div>

      <div style="height:14px"></div>
      <div class="section-row"><span class="section-title"><i class="ph-duotone ph-list-checks" style="vertical-align:middle;margin-right:6px"></i>Task Completions</span></div>
      <div class="card">${choresHtml}</div>

      <div style="height:14px"></div>
      <div class="section-row"><span class="section-title"><i class="ph-duotone ph-trophy" style="vertical-align:middle;margin-right:6px"></i>Team Prizes (${teamGoals.length})</span></div>
      <div class="card">${goalHtml}</div>

      <div style="height:14px"></div>
      <div class="section-row">
        <span class="section-title"><i class="ph-duotone ph-scroll" style="vertical-align:middle;margin-right:6px"></i>History</span>
        <span style="font-size:0.8rem;color:var(--muted)">(last 150)</span>
      </div>
      <div class="card">${histHtml}</div>

      <div style="height:14px"></div>
      <div class="section-row"><span class="section-title"><i class="ph-duotone ph-code" style="vertical-align:middle;margin-right:6px"></i>Raw JSON</span></div>
      <div class="card">
        <p style="font-size:0.82rem;color:var(--muted);margin:0 0 10px;line-height:1.5"><i class="ph-duotone ph-warning" style="color:#F59E0B;vertical-align:middle;margin-right:4px"></i>Clicking Apply overwrites all data. Invalid JSON will be rejected.</p>
        <textarea id="adv-raw-json" style="width:100%;min-height:240px;font-family:'Courier New',monospace;font-size:0.75rem;border:1px solid #D1D5DB;border-radius:8px;padding:10px;box-sizing:border-box;resize:vertical;line-height:1.5">${esc(JSON.stringify(D, null, 2))}</textarea>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px">
          <button class="btn btn-primary btn-sm" onclick="advApplyRawJson()">Apply</button>
          <button class="btn btn-secondary btn-sm" onclick="document.getElementById('adv-raw-json').value=JSON.stringify(D,null,2)"><i class="ph-duotone ph-arrow-clockwise" style="vertical-align:middle;margin-right:4px"></i>Reload</button>
          <span id="adv-json-status" class="adv-status"></span>
        </div>
      </div>

      <div style="height:30px"></div>
    </div>`;
}

function advSetSetting(key, val) {
  D.settings[key] = val;
  saveData();
  _advRefreshStatus('Setting saved');
}


function saveSetting(key, value) {
  D.settings[key] = value;
  saveData();
}


function showAdjustDiamondsQuick() {
  const kids = D.family.members.filter(m => m.role === 'kid' && !m.deleted);
  if (!kids.length) { toast('No kids yet'); return; }
  S.adjDmdsSign = 1;
  S.adjDmdsKids = new Set();
  showQuickActionModal('<div id="adj-dmds-body"></div>');
  _updateAdjDiamondsBody();
}

function _updateAdjDiamondsBody() {
  const el = document.getElementById('adj-dmds-body');
  if (!el) return;
  const kids = D.family.members.filter(m => m.role === 'kid' && !m.deleted);
  const sign = S.adjDmdsSign ?? 1;
  // Preserve typed values across updates
  const prevAmt    = document.getElementById('adj-dmds-q')?.value ?? '';
  const prevReason = document.getElementById('adj-dmds-reason')?.value ?? '';
  const kidChips = kids.length > 1 ? `
    <div style="margin-bottom:16px">
      <div class="form-label" style="margin-bottom:8px">Who</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${kids.map(k => {
          const sel = (S.adjDmdsKids || new Set()).has(k.id);
          return `<button onclick="_adjDmdsToggleKid('${k.id}')"
            style="padding:8px 16px;border-radius:99px;border:2px solid ${sel?'#6C63FF':'#E5E7EB'};
              background:${sel?'#EDE9FE':'#fff'};color:${sel?'#6C63FF':'var(--text)'};
              font-weight:700;font-size:0.95rem;cursor:pointer">
            ${k.avatar||'<i class="ph-duotone ph-smiley" style="color:#9CA3AF"></i>'} ${esc(k.name)}
          </button>`;
        }).join('')}
      </div>
    </div>` : '';
  el.innerHTML = `

    <div class="toggle-row" style="margin-bottom:16px">
      <span class="form-label" style="margin-bottom:0">Action</span>
      <div style="display:flex;gap:6px">
        <button onclick="_adjDmdsSetSign(1)"
          style="padding:8px 18px;border-radius:99px;border:2px solid ${sign===1?'#6C63FF':'#E5E7EB'};
            background:${sign===1?'#6C63FF':'#fff'};color:${sign===1?'#fff':'var(--text)'};font-weight:700;cursor:pointer">
          + Add
        </button>
        <button onclick="_adjDmdsSetSign(-1)"
          style="padding:8px 18px;border-radius:99px;border:2px solid ${sign===-1?'#EF4444':'#E5E7EB'};
            background:${sign===-1?'#EF4444':'#fff'};color:${sign===-1?'#fff':'var(--text)'};font-weight:700;cursor:pointer">
          Remove
        </button>
      </div>
    </div>
    ${kidChips}
    <div class="form-group">
      <label class="form-label">Amount (gems)</label>
      <input type="number" id="adj-dmds-q" min="1" value="${esc(prevAmt)}" placeholder="e.g. 5" style="font-size:1.1rem">
    </div>
    <div class="form-group">
      <label class="form-label">Reason <span class="form-label-hint">optional</span></label>
      <input type="text" id="adj-dmds-reason" value="${esc(prevReason)}" placeholder="${sign===1?'Bonus for helping...':'Adjustment...'}">
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="_doAdjDiamondsQuick()">Done</button>
    </div>`;
}

function _adjDmdsSetSign(sign) { S.adjDmdsSign = sign; _updateAdjDiamondsBody(); }

function _adjDmdsToggleKid(kidId) {
  if (!S.adjDmdsKids) S.adjDmdsKids = new Set();
  if (S.adjDmdsKids.has(kidId)) S.adjDmdsKids.delete(kidId);
  else S.adjDmdsKids.add(kidId);
  _updateAdjDiamondsBody();
}

function _doAdjDiamondsQuick() {
  const kids = D.family.members.filter(m => m.role === 'kid' && !m.deleted);
  const targets = kids.filter(k => (S.adjDmdsKids || new Set()).has(k.id));
  const amt = parseInt(document.getElementById('adj-dmds-q')?.value) || 0;
  const reason = document.getElementById('adj-dmds-reason')?.value.trim();
  const sign = S.adjDmdsSign ?? 1;
  if (!targets.length) { toast('Select at least one kid'); return; }
  if (amt <= 0) { toast('Enter an amount'); return; }
  const dmds = sign * amt;
  targets.forEach(m => {
    m.gems = Math.max(0, (m.gems || 0) + dmds);
    if (dmds > 0) m.totalEarned = (m.totalEarned || 0) + dmds;
    const label = reason || (dmds > 0 ? 'A special bonus from your parent!' : 'Gem adjustment');
    addHistory('bonus', m.id, label, dmds);
  });
  saveData();
  closeModal();
  const names = targets.map(m => m.name).join(' & ');
  toast(`${dmds > 0 ? '+' : ''}${dmds} gems for ${names}`);
  renderParentHome(); renderParentHeader(); renderParentNav();
}

function showAdjustSavingsQuick() {
  const kids = D.family.members.filter(m => m.role === 'kid' && !m.deleted);
  if (!kids.length) { toast('No kids yet'); return; }
  S.adjSavSign = 1;
  S.adjSavKids = new Set();
  showQuickActionModal('<div id="adj-sav-body"></div>');
  _updateAdjSavingsBody();
}

function _updateAdjSavingsBody() {
  const el = document.getElementById('adj-sav-body');
  if (!el) return;
  const kids = D.family.members.filter(m => m.role === 'kid' && !m.deleted);
  const sign = S.adjSavSign ?? 1;
  const cur = D.settings.currency || '$';
  // Preserve typed values across updates
  const prevAmt    = document.getElementById('adj-sav-q')?.value ?? '';
  const prevReason = document.getElementById('adj-sav-reason-q')?.value ?? '';
  const kidChips = kids.length > 1 ? `
    <div style="margin-bottom:16px">
      <div class="form-label" style="margin-bottom:8px">Who</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${kids.map(k => {
          const sel = (S.adjSavKids || new Set()).has(k.id);
          return `<button onclick="_adjSavToggleKid('${k.id}')"
            style="padding:8px 16px;border-radius:99px;border:2px solid ${sel?'#16A34A':'#E5E7EB'};
              background:${sel?'#DCFCE7':'#fff'};color:${sel?'#16A34A':'var(--text)'};
              font-weight:700;font-size:0.95rem;cursor:pointer">
            ${k.avatar||'<i class="ph-duotone ph-smiley" style="color:#9CA3AF"></i>'} ${esc(k.name)}
          </button>`;
        }).join('')}
      </div>
    </div>` : '';
  el.innerHTML = `

    <div class="toggle-row" style="margin-bottom:16px">
      <span class="form-label" style="margin-bottom:0">Action</span>
      <div style="display:flex;gap:6px">
        <button onclick="_adjSavSetSign(1)"
          style="padding:8px 18px;border-radius:99px;border:2px solid ${sign===1?'#16A34A':'#E5E7EB'};
            background:${sign===1?'#16A34A':'#fff'};color:${sign===1?'#fff':'var(--text)'};font-weight:700;cursor:pointer">
          + Deposit
        </button>
        <button onclick="_adjSavSetSign(-1)"
          style="padding:8px 18px;border-radius:99px;border:2px solid ${sign===-1?'#EF4444':'#E5E7EB'};
            background:${sign===-1?'#EF4444':'#fff'};color:${sign===-1?'#fff':'var(--text)'};font-weight:700;cursor:pointer">
          Withdraw
        </button>
      </div>
    </div>
    ${kidChips}
    <div class="form-group">
      <label class="form-label">Amount (${cur})</label>
      <input type="number" id="adj-sav-q" min="0.01" step="0.01" value="${esc(prevAmt)}" placeholder="e.g. 5.00" style="font-size:1.1rem">
    </div>
    <div class="form-group">
      <label class="form-label">Reason <span class="form-label-hint">optional</span></label>
      <input type="text" id="adj-sav-reason-q" value="${esc(prevReason)}" placeholder="${sign===1?'Birthday money, allowance...':'Spending...'}">
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="_doAdjSavingsQuick()">Done</button>
    </div>`;
}

function _adjSavSetSign(sign) { S.adjSavSign = sign; _updateAdjSavingsBody(); }

function _adjSavToggleKid(kidId) {
  if (!S.adjSavKids) S.adjSavKids = new Set();
  if (S.adjSavKids.has(kidId)) S.adjSavKids.delete(kidId);
  else S.adjSavKids.add(kidId);
  _updateAdjSavingsBody();
}

function _doAdjSavingsQuick() {
  const kids = D.family.members.filter(m => m.role === 'kid' && !m.deleted);
  const targets = kids.filter(k => (S.adjSavKids || new Set()).has(k.id));
  const amt = parseFloat(document.getElementById('adj-sav-q')?.value) || 0;
  const reason = document.getElementById('adj-sav-reason-q')?.value.trim();
  const sign = S.adjSavSign ?? 1;
  const cur = D.settings.currency || '$';
  if (!targets.length) { toast('Select at least one kid'); return; }
  if (amt <= 0) { toast('Enter an amount'); return; }
  const dollars = parseFloat((sign * amt).toFixed(2));
  targets.forEach(m => {
    normalizeMember(m);
    m.savings = parseFloat(Math.max(0, (m.savings || 0) + dollars).toFixed(2));
    if (sign > 0) {
      m.savingsGifted = parseFloat(((m.savingsGifted || 0) + amt).toFixed(2));
      addHistory('savings_deposit', m.id, reason || 'A savings deposit from your parent!', 0, { dollars: amt });
    } else {
      reduceSavingsBuckets(m, amt);
      addHistory('savings_withdraw', m.id, reason ? `Withdrawal: ${reason}` : 'Savings withdrawal', 0, { dollars: amt });
    }
  });
  saveData();
  closeModal();
  const names = targets.map(m => m.name).join(' & ');
  toast(`${dollars > 0 ? '+' : ''}${cur}${Math.abs(dollars).toFixed(2)} savings for ${names}`);
  renderParentHome(); renderParentHeader(); renderParentNav();
}

function showAddPointsModal(memberId, triggerEl = null) {
  const m = getMember(memberId);
  if (!m) return;
  const rect = triggerEl?.getBoundingClientRect?.();
  if (rect) _modalLaunchOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  showQuickActionModal(`
    <div class="modal-title">Adjust Gems &mdash; ${esc(m.name)}</div>
    <p style="color:var(--muted);font-size:0.9rem;margin-bottom:16px">Current balance: <strong>${m.gems||0} gems</strong></p>
    <div class="form-group">
      <label class="form-label">Amount</label>
      <input type="number" id="adj-dmds" min="1" placeholder="e.g. 25">
    </div>
    <div class="form-group">
      <label class="form-label">Reason <span class="form-label-hint">optional</span></label>
      <input type="text" id="adj-reason" placeholder="Bonus for helping...">
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn" style="background:#FEE2E2;color:#991B1B;font-weight:700" onclick="doAdjustPoints('${memberId}',-1)">Remove</button>
      <button class="btn btn-primary" onclick="doAdjustPoints('${memberId}',1)">+ Add</button>
    </div>`, 'quick-action-modal-wide');
}

function doAdjustPoints(memberId, sign) {
  const m      = getMember(memberId);
  const amt    = parseInt(document.getElementById('adj-dmds')?.value)||0;
  const reason = document.getElementById('adj-reason')?.value.trim() || 'A special bonus from your parent!';
  if (!m || amt <= 0) { toast('Enter an amount'); return; }
  const dmds = sign * amt;
  m.gems    = Math.max(0, (m.gems||0) + dmds);
  m.totalEarned = dmds>0 ? (m.totalEarned||0)+dmds : m.totalEarned;
  addHistory('bonus', memberId, reason, dmds);
  saveData();
  closeModal();
  toast(`${dmds>0?'+':''}${dmds} gems for ${m.name}`);
  renderSettings();
}

function showAdjustSavingsModal(memberId, triggerEl = null) {
  const m = getMember(memberId);
  if (!m) return;
  const cur = D.settings.currency || '$';
  const rect = triggerEl?.getBoundingClientRect?.();
  if (rect) _modalLaunchOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  showQuickActionModal(`
    <div class="modal-title"><i class="ph-duotone ph-piggy-bank" style="color:#16A34A;font-size:1.2rem;vertical-align:middle"></i> Adjust Savings for ${esc(m.name)}</div>
    <p style="color:var(--muted);font-size:0.9rem;margin-bottom:16px">Current balance: <strong>${cur}${(m.savings||0).toFixed(2)}</strong></p>
    <div class="form-group">
      <label class="form-label">Amount (${cur})</label>
      <input type="number" id="adj-sav" min="0.01" step="0.01" placeholder="e.g. 5.00">
    </div>
    <div class="form-group">
      <label class="form-label">Reason <span class="form-label-hint">optional</span></label>
      <input type="text" id="adj-sav-reason" placeholder="Birthday money, allowance...">
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-secondary" style="background:#FEE2E2;color:#991B1B;font-weight:700" onclick="doAdjustSavings('${memberId}',-1)">- Withdraw</button>
      <button class="btn btn-primary" onclick="doAdjustSavings('${memberId}',1)">+ Deposit</button>
    </div>`, 'quick-action-modal-wide');
}

function doAdjustSavings(memberId, sign) {
  const m      = getMember(memberId);
  const amt    = parseFloat(document.getElementById('adj-sav')?.value) || 0;
  const reason = document.getElementById('adj-sav-reason')?.value.trim();
  const cur    = D.settings.currency || '$';
  if (!m || amt <= 0) { toast('Enter an amount'); return; }
  const dollars = parseFloat((sign * amt).toFixed(2));
  normalizeMember(m);
  m.savings = parseFloat(Math.max(0, (m.savings || 0) + dollars).toFixed(2));
  if (sign > 0) {
    m.savingsGifted = parseFloat(((m.savingsGifted || 0) + amt).toFixed(2));
    const label = reason || 'A savings deposit from your parent!';
    addHistory('savings_deposit', memberId, label, 0, { dollars: amt });
  } else {
    reduceSavingsBuckets(m, amt);
    const label = reason ? `Withdrawal: ${reason}` : 'Savings withdrawal';
    addHistory('savings_withdraw', memberId, label, 0, { dollars: amt });
  }
  saveData();
  closeModal();
  toast(`${dollars > 0 ? '+' : ''}${cur}${Math.abs(dollars).toFixed(2)} savings for ${m.name}`);
  renderSettings();
}

function switchFamily() {
  showQuickActionModal(`
    <div class="modal-title"><i class="ph-duotone ph-link-break" style="color:#EF4444;font-size:1.2rem;vertical-align:middle"></i> Join Different Family?</div>
    <p style="color:var(--muted);font-size:0.88rem;margin-bottom:16px">
      This will disconnect this device from your current family. Your family's data stays safe in the cloud; you'll just need the family code to rejoin.
    </p>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" onclick="_confirmSwitchFamily()">Continue</button>
    </div>`);
}

function _confirmSwitchFamily() {
  closeModal();
  S.currentUser = null;
  setCurrentUserId('');
  setParentAuthUid(null);
  try { localStorage.removeItem(PARENT_AUTH_PROVIDER_KEY); } catch {}
  closeSettings();
  localStorage.removeItem(LS_KEY);
  localStorage.removeItem(FAMILY_CODE_KEY);
  if (firestoreUnsub) { firestoreUnsub(); firestoreUnsub = null; }
  D = defaultData();
  showScreen('screen-setup');
  renderSetupGate();
}

function resetAllData() {
  showQuickActionModal(`
    <div class="modal-title"><i class="ph-duotone ph-warning-circle" style="color:#DC2626;font-size:1.2rem;vertical-align:middle"></i> Reset All Data?</div>
    <p style="margin:0 0 12px;color:var(--muted);font-size:0.95rem;line-height:1.5">This will <strong>permanently erase all family data</strong>, including tasks, prizes, history, member profiles, and settings. This cannot be undone.</p>
    <p style="margin:0 0 12px;background:#FEF9C3;border:1.5px solid #F59E0B;border-radius:10px;padding:10px 12px;font-size:0.82rem;color:#78350F;line-height:1.5"><strong>Active subscription?</strong> Resetting does not cancel your subscription. Manage billing separately in your iPhone's subscription settings.</p>
    <p style="margin:0 0 10px;color:var(--muted);font-size:0.88rem">Type <strong>reset</strong> below to confirm:</p>
    <input id="reset-type-input" type="text" autocomplete="off" autocorrect="off" spellcheck="false"
      style="width:100%;box-sizing:border-box;padding:10px 12px;border:1.5px solid #E5E7EB;border-radius:10px;font-size:1rem;margin-bottom:20px;outline:none"
      placeholder=""
      oninput="document.getElementById('reset-type-btn').disabled=this.value.trim()!=='reset'">
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button id="reset-type-btn" class="btn btn-danger" disabled onclick="closeModal();_doResetAllData()">Reset Everything</button>
    </div>`);
}

async function _doResetAllData() {
  const docPath = getFamilyDoc();
  if (firestoreUnsub) { firestoreUnsub(); firestoreUnsub = null; }
  try { await db.doc(docPath).delete(); } catch(e) { console.warn('Firestore delete error:', e); }
  localStorage.removeItem(LS_KEY);
  location.reload();
}

/* Maintenance screen */

function showMaintenanceScreen(title, message, btnText, btnUrl) {
  showScreen('screen-auth');
  const el = document.getElementById('screen-auth');
  el.className = 'screen active loading';
  el.style.cssText = 'background:linear-gradient(145deg,#667eea,#764ba2);align-items:center;justify-content:center;display:flex;flex-direction:column;gap:20px;text-align:center;padding:32px';
  const btnAction = btnUrl ? `window.open(${JSON.stringify(btnUrl)},'_system')` : `window.location.reload()`;
  el.innerHTML = `
    <img src="gemsproutpadded.png" class="loading-img" style="width:120px;height:120px">
    <div style="color:#fff;font-size:1.6rem;font-weight:800;letter-spacing:-0.01em">${title}</div>
    <div style="color:rgba(255,255,255,0.85);font-size:1rem;max-width:300px;line-height:1.5">${message}</div>
    ${btnText ? `<button onclick="${btnAction}" style="margin-top:8px;padding:12px 28px;border-radius:12px;border:none;background:#fff;color:#6C63FF;font-weight:700;font-size:0.95rem;cursor:pointer">${btnText}</button>` : ''}`;
}

// Global Remote Config values populated on startup, safe to read anywhere after startApp()
const RC = {
  maintenanceMode:        false,
  maintenanceTitle:       'Down for Maintenance',
  maintenanceMessage:     'GemSprout is currently undergoing maintenance. Please check back soon.',
  maintenanceButtonText:  'Try Again',
  maintenanceButtonUrl:   '',
  betaMode:               true,
  appDownloadUrl:         'https://gemsprout.com/beta',
};

async function checkMaintenanceMode() {
  try {
    const rc = firebase.remoteConfig();
    rc.defaultConfig = { ...RC };
    rc.settings.minimumFetchIntervalMillis = 60000;
    await rc.fetchAndActivate();
    // Populate global RC from fetched values
    RC.maintenanceMode        = rc.getValue('maintenanceMode').asBoolean();
    RC.maintenanceTitle       = rc.getValue('maintenanceTitle').asString();
    RC.maintenanceMessage     = rc.getValue('maintenanceMessage').asString();
    RC.maintenanceButtonText  = rc.getValue('maintenanceButtonText').asString();
    RC.maintenanceButtonUrl   = rc.getValue('maintenanceButtonUrl').asString();
    RC.betaMode               = rc.getValue('betaMode').asBoolean();
    RC.appDownloadUrl         = rc.getValue('appDownloadUrl').asString();
    if (RC.maintenanceMode) {
      showMaintenanceScreen(RC.maintenanceTitle, RC.maintenanceMessage, RC.maintenanceButtonText, RC.maintenanceButtonUrl);
      return true;
    }
  } catch (e) {
    console.warn('Remote Config unavailable:', e);
  }
  return false;
}

function showParentSignIn(memberId, onSuccess) {
  showScreen('screen-auth');
  const el = document.getElementById('screen-auth');
  el.className = 'screen active';
  el.style.cssText = 'background:linear-gradient(145deg,#667eea,#764ba2);align-items:center;justify-content:center;display:flex;flex-direction:column;gap:0;padding:40px 28px';
  const member = getMember(memberId);
  el.innerHTML = `
    <img src="gemsproutpadded.png" style="width:90px;height:90px;margin-bottom:16px">
    <div style="color:#fff;font-size:1.6rem;font-weight:800;margin-bottom:6px">Welcome back!</div>
    <div style="color:rgba(255,255,255,0.8);font-size:0.95rem;margin-bottom:32px;text-align:center">Sign in to access the parent dashboard${member ? ' as <strong>' + esc(member.name) + '</strong>' : ''}</div>
    <div style="display:flex;flex-direction:column;gap:12px;width:100%;max-width:320px">
      <button id="btn-google-signin" class="btn" style="background:#fff;color:#3c4043;font-size:1rem;padding:14px 20px;border-radius:12px;display:flex;align-items:center;gap:12px;justify-content:center;font-weight:600;border:none" onclick="handleParentSignIn('google','${memberId}')">
        <svg width="20" height="20" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
        Continue with Google
      </button>
      <button id="btn-apple-signin" class="btn" style="background:#000;color:#fff;font-size:1rem;padding:14px 20px;border-radius:12px;display:flex;align-items:center;gap:12px;justify-content:center;font-weight:600;border:none" onclick="handleParentSignIn('apple','${memberId}')">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff" xmlns="http://www.w3.org/2000/svg"><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701z"/></svg>
        Continue with Apple&nbsp;
      </button>
    </div>
    <button style="margin-top:24px;background:none;border:none;color:rgba(255,255,255,0.6);font-size:0.9rem;cursor:pointer" onclick="renderHome()"><i class="ph-duotone ph-arrow-left" style="font-size:0.95rem;vertical-align:middle"></i> Back</button>
    ${RC.betaMode ? `
    <div style="margin-top:28px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.15);width:100%;max-width:320px">
      <div style="color:rgba(255,255,255,0.4);font-size:0.72rem;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px;text-align:center">Dev Only - skip real auth</div>
      <div style="display:flex;gap:8px">
        <input id="dev-parentsignin-email" type="email" placeholder="your setup email" autocomplete="off"
          style="flex:1;padding:10px 12px;border:none;border-radius:10px;font-size:0.9rem;background:rgba(255,255,255,0.15);color:#fff;outline:none">
        <button onclick="_devParentSignIn('${memberId}')" style="padding:10px 14px;border-radius:10px;background:rgba(255,255,255,0.2);color:#fff;border:none;font-size:0.85rem;font-weight:600;cursor:pointer;white-space:nowrap">Test Sign In</button>
      </div>
    </div>` : ''}`;
  S._parentSignInCallback = onSuccess || null;
}

function _devParentSignIn(memberId) {
  const email = (document.getElementById('dev-parentsignin-email')?.value || '').trim().toLowerCase();
  if (!email || !email.includes('@')) { toast('Enter a test email first'); return; }
  const member = getMember(memberId);
  const fakeUid = `dev-${email.replace(/[^a-z0-9]/g, '-')}`;
  const linked = member?.authUid === fakeUid ||
    (member?.authProviders || []).some(p => p.email?.toLowerCase() === email || p.uid === fakeUid);
  if (!linked) {
    toast("That email isn't linked to this profile; use the email you signed up with");
    return;
  }
  setParentAuthUid(fakeUid);
  const cb = S._parentSignInCallback;
  S._parentSignInCallback = null;
  proceedAsParent(memberId, cb);
}

async function handleParentSignIn(provider, memberId) {
  const btns = document.querySelectorAll('#btn-google-signin, #btn-apple-signin');
  btns.forEach(b => { b.disabled = true; b.style.opacity = '0.6'; });
  const firebaseUser = provider === 'google' ? await signInWithGoogle() : await signInWithApple();
  if (!firebaseUser) {
    btns.forEach(b => { b.disabled = false; b.style.opacity = '1'; });
    return;
  }
  await linkParentAuth(firebaseUser, memberId);
  const cb = S._parentSignInCallback;
  S._parentSignInCallback = null;
  proceedAsParent(memberId, cb);
}

function proceedAsParent(memberId, onComplete) {
  const member = getMember(memberId);
  if (!member) { renderHome(); return; }
  S.currentUser = member;
  setCurrentUserId(member.id);
  setAppUnlocked(true);
  if (onComplete) { onComplete(member); return; }
  routeToView(member);
}


function showLoading() {
  showScreen('screen-auth');
  const el = document.getElementById('screen-auth');
  el.className = 'screen active loading';
  el.style.cssText = 'background:linear-gradient(145deg,#667eea,#764ba2);align-items:center;justify-content:center;display:flex;flex-direction:column;gap:20px;text-align:center';
  el.innerHTML = `
    <style>
      @keyframes _ldot { 0%,80%,100%{opacity:0;transform:translateY(0)} 40%{opacity:1;transform:translateY(-3px)} }
    </style>
    <img src="gemsproutpadded.png" class="loading-img" style="width:160px;height:160px">
    <div style="color:#fff;font-size:1.8rem;font-weight:800;letter-spacing:-0.01em">GemSprout</div>
    <div class="loading-text" style="color:rgba(255,255,255,0.75);font-size:1rem;display:flex;align-items:center;gap:2px">
      Loading<span style="animation:_ldot 1.2s infinite 0s">.</span><span style="animation:_ldot 1.2s infinite 0.2s">.</span><span style="animation:_ldot 1.2s infinite 0.4s">.</span>
    </div>`;
}

function routeAfterLoad() {
  if (!D.setup || !D.family || D.family.members.length === 0) {
    S.setupMembers = [];
    S.setupStep    = 0;
    showScreen('screen-setup');
    renderSetupGate();
  } else {
    if (isAppUnlocked()) {
      const rememberedUser = getMember(getCurrentUserId());
      if (rememberedUser) {
        S.currentUser = rememberedUser;
        routeToView(rememberedUser);
      } else {
        const kids = D.family.members.filter(m => m.role !== 'parent' && !m.deleted);
        if (kids.length === 1) {
          selectProfile(kids[0].id);
        } else {
          renderHome();
        }
      }
    } else showAppPin();
  }
}

function init() {
  applyTestBuildBadge();
  window.speechSynthesis?.getVoices(); // prime async voice loading on iOS

  // Re-render settings if it's open when Firebase auth state resolves (async on app restore).
  // This fixes the "Link Account" flash when closing on kid profile and reopening.
  auth.onAuthStateChanged(() => {
    if (document.getElementById('settings-root')?.classList.contains('open')) renderSettings();
  });

  loadData();
  applyInterestForAllKids();
  scheduleHereCheck();

  const _needsMigrationPush = !getFamilyCode() && D.setup;
  if (_needsMigrationPush) setFamilyCode(genFamilyCode()); // temp sync code so getFamilyDoc() works; replaced with unique code before push below

  const hasLocalData = D.setup && D.family && D.family.members.length > 0;

  if (hasLocalData) {
    if (isAppUnlocked()) {
      const rememberedUser = getMember(getCurrentUserId());
      if (rememberedUser) {
        S.currentUser = rememberedUser;
        routeToView(rememberedUser);
        if (rememberedUser.role === 'kid') {
          savePendingSnapshot(rememberedUser.id);
          markBonusesSeen(rememberedUser.id);
          markSavingsSeen(rememberedUser.id);
          markSpendOutcomesSeen(rememberedUser.id);
        }
      } else {
        renderHome();
      }
    } else showAppPin();
    ensureFirestoreAuth()
      .then(async () => {
        if (_needsMigrationPush) {
          // Replace the temp sync code with a collision-checked unique code before pushing
          const safeCode = await genUniqueFamilyCode();
          setFamilyCode(safeCode);
          await pushToFirestore();
        }
        if (auth.currentUser && !getParentAuthUid() && getFamilyCode()) {
          db.doc(`users/${auth.currentUser.uid}`).set({ familyCode: getFamilyCode(), role: 'kid' }, { merge: true }).catch(() => {});
        }
        subscribeToFirestore();
      })
      .catch(err => console.warn('Firestore sync unavailable:', err));
  } else {
    // Slow path: no local data (fresh install or standalone PWA first launch)
    // Wait for Firestore before routing so we don't wrongly show setup wizard
    showLoading();
    ensureFirestoreAuth()
      .then(() => subscribeToFirestore(routeAfterLoad))
      .catch(err => {
        console.warn('Firestore unavailable, falling back to local data:', err);
        routeAfterLoad();
      });
  }
}

document.addEventListener('visibilitychange', () => {
  if (!D.settings?.lockOnBackground) return;
  if (document.visibilityState === 'hidden') {
    if (S.currentUser) setAppUnlocked(false);
  } else if (document.visibilityState === 'visible') {
    if (S.currentUser && !isAppUnlocked()) showAppPin();
  }
});

// Start on DOM ready
async function ensureFirestoreAuth() {
  if (auth.currentUser) return;
  await auth.signInAnonymously().catch(() => {});
}

async function startApp() {
  await checkBiometricAvailability();
  const inMaintenance = await checkMaintenanceMode();
  if (!inMaintenance) {
    await initRevenueCat();
    init();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startApp);
} else {
  startApp();
}

// Scroll to top when app is foregrounded (tab/app switch back)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const kc = document.getElementById('kid-content');
  const pc = document.getElementById('parent-content');
  if (kc) kc.scrollTop = 0;
  if (pc) pc.scrollTop = 0;
  if (S.currentUser?.role === 'parent') syncAppBadge();
});

console.log('GemSprout fully loaded!');








