'use strict';

const HEARTBEAT = 'heartbeat';
const FD_URL = 'https://voicify-support.freshdesk.com/*';
const SEEN_CAP = 5000;
const LOST_REMIND_MS = 15 * 60 * 1000; // re-sound "lost" this long after it was acknowledged, if still lost
const AUTO_OFF = 'autoOff'; // one-shot alarm that ends a "turn on for…" timer
const MAX_TIMER_MIN = 7 * 24 * 60;
const NOTIF = { new: 'fdm-new', lost: 'fdm-lost', test: 'fdm-test', off: 'fdm-off' };
const ICONS = {
  on: { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
  off: { 16: 'icons/off16.png', 48: 'icons/off48.png', 128: 'icons/off128.png' },
};

const DEFAULT_SETTINGS = {
  enabled: false, // always OFF on a fresh install and after every browser start
  watchPath: '/a/tickets/filters/530853',
  alertOnUnseenBelowMax: true,
  volume: 0.8,
  lostAfterMin: 12,
};
const DEFAULT_STATE = {
  baselineSet: false,
  maxSeenId: 0,
  seenIds: [],
  lastIds: [],
  pendingNew: [],
  pendingSim: [],
  newTotal: 0,
  alarmKind: null, // null | 'new' | 'lost' | 'test' | 'testlost'
  lastCheckAt: 0,
  lastCheckState: null,
  lastCheckCount: 0,
  issueState: null,
  issueAt: 0,
  monitoringSince: 0,
  enabledUntil: 0, // end of the "turn on for…" timer; 0 = no limit
  timerMin: 0,     // length of that timer in minutes (popup highlights the matching chip)
  lostAckedAt: 0,
  lastHeartbeatAt: 0,
  audioState: null,
};

// ---------- storage ----------

async function load() {
  const { settings, state } = await chrome.storage.local.get(['settings', 'state']);
  return {
    settings: { ...DEFAULT_SETTINGS, ...settings },
    st: { ...DEFAULT_STATE, ...state },
  };
}
async function patchState(p) {
  const { st } = await load();
  await chrome.storage.local.set({ state: { ...st, ...p } });
}
async function patchSettings(p) {
  const { settings } = await load();
  await chrome.storage.local.set({ settings: { ...settings, ...p } });
}

// One promise chain: scans, heartbeats and commands never interleave, so nothing fires twice.
let queue = Promise.resolve();
function enqueue(fn) {
  const p = queue.then(fn);
  queue = p.catch((e) => console.error('[fdm]', e));
  return p;
}

// ---------- helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uniq = (a) => [...new Set(a)];
const normPath = (p) => (p || '').split(/[?#]/)[0].replace(/\/+$/, '') || '/';
const soundFor = (kind) => (kind === 'lost' || kind === 'testlost' ? 'lost' : 'new');
const safe = async (fn) => { try { await fn(); } catch (e) { console.error('[fdm]', e); } };

async function watchTabs() {
  const { settings } = await load();
  const want = normPath(settings.watchPath);
  const tabs = await chrome.tabs.query({ url: FD_URL });
  return tabs.filter((t) => {
    try { return normPath(new URL(t.url).pathname) === want; } catch (e) { return false; }
  });
}
async function pokeTabs(cmd) {
  const tabs = await chrome.tabs.query({ url: FD_URL });
  await Promise.all(tabs.map((t) => chrome.tabs.sendMessage(t.id, { cmd }).catch(() => null)));
}

// ---------- badge + notifications ----------

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}
// Derives the toolbar badge from stored state: alarm count / "!" while alarming, grey "OFF" when off, else blank.
async function syncBadge() {
  const { settings, st } = await load();
  if (st.alarmKind === 'new') setBadge(String(st.pendingNew.length + st.pendingSim.length), '#d93025');
  else if (st.alarmKind === 'lost') setBadge('!', '#b06000');
  else if (!settings.enabled) setBadge('OFF', '#757575');
  else setBadge('', null);
}
// Colour bell while monitoring, grey bell while off.
async function syncIcon() {
  const { settings } = await load();
  await chrome.action.setIcon({ path: settings.enabled ? ICONS.on : ICONS.off });
}
const syncUi = () => Promise.all([syncBadge(), syncIcon()]);
// Sticky notifications (default) carry an Acknowledge button; { sticky: false } is an FYI that times out.
function notify(id, title, message, { sticky = true } = {}) {
  return new Promise((resolve) => {
    chrome.notifications.clear(id, () => {
      void chrome.runtime.lastError;
      const opts = {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title,
        message,
        priority: sticky ? 2 : 0,
        requireInteraction: sticky,
        silent: true, // the offscreen alarm is the sound
      };
      if (sticky) opts.buttons = [{ title: 'Acknowledge' }];
      chrome.notifications.create(id, opts, () => { void chrome.runtime.lastError; resolve(); });
    });
  });
}
function clearAllNotifications() {
  return new Promise((resolve) => {
    chrome.notifications.getAll((all) => {
      const ids = Object.keys(all || {}).filter((i) => i.startsWith('fdm-'));
      Promise.all(ids.map((i) => new Promise((r) => chrome.notifications.clear(i, () => r())))).then(resolve);
    });
  });
}

// ---------- offscreen audio ----------

let creatingOffscreen = null;
async function hasOffscreen() {
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return ctxs.length > 0;
}
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Play a looping alarm sound until the user acknowledges it',
      })
      .finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}
async function sendOffscreen(cmd, extra = {}) {
  for (let i = 0; i < 6; i++) {
    try {
      return await chrome.runtime.sendMessage({ target: 'offscreen', cmd, ...extra });
    } catch (e) {
      await sleep(150);
    }
  }
  return null;
}
async function playAlarm(kind) {
  const { settings } = await load();
  await ensureOffscreen();
  const res = await sendOffscreen('play', { sound: soundFor(kind), volume: settings.volume });
  await patchState({ audioState: res ? res.audio : 'no-offscreen' });
}
async function stopAlarm() {
  if (!(await hasOffscreen())) return;
  await sendOffscreen('stop');
  try { await chrome.offscreen.closeDocument(); } catch (e) { /* already closed */ }
}

// ---------- alarms ----------

async function raiseNew(pending, pendingSim) {
  const all = [...pending.map((id) => '#' + id), ...pendingSim.map((id) => '#' + id + ' (simulated)')];
  const title = all.length === 1 ? 'New Freshdesk ticket ' + all[0] : all.length + ' new Freshdesk tickets';
  await safe(() => setBadge(String(all.length), '#d93025'));
  await safe(() => notify(NOTIF.new, title, all.join(', ') + '\nAcknowledge to silence the alarm.'));
  await safe(() => playAlarm('new'));
}
async function raiseLost(gapMin) {
  await safe(() => setBadge('!', '#b06000'));
  await safe(() =>
    notify(
      NOTIF.lost,
      'Freshdesk monitoring lost',
      'No successful ticket check for ' + gapMin + ' min. Check that the ticket view is open, logged in and refreshing.'
    )
  );
  await safe(() => playAlarm('lost'));
}
async function acknowledge() {
  const { st } = await load();
  const patch = { pendingNew: [], pendingSim: [], alarmKind: null };
  if (st.alarmKind === 'lost') patch.lostAckedAt = Date.now();
  await patchState(patch);
  await safe(stopAlarm);
  await safe(syncBadge);
  await safe(clearAllNotifications);
  await safe(() => pokeTabs('removeFake'));
}

// Single entry point for turning monitoring ON (optionally for `minutes`) or OFF.
async function setPower(on, minutes, reason) {
  if (on) {
    const mins = Math.min(Number(minutes) || 0, MAX_TIMER_MIN);
    const now = Date.now();
    const until = mins > 0 ? now + mins * 60000 : 0;
    await patchSettings({ enabled: true });
    // restart the lost-alarm clock so there is a full grace period to open the tab
    await patchState({ monitoringSince: now, lostAckedAt: 0, enabledUntil: until, timerMin: mins > 0 ? mins : 0 });
    if (until) chrome.alarms.create(AUTO_OFF, { when: until });
    else chrome.alarms.clear(AUTO_OFF);
    try { chrome.power.requestKeepAwake('system'); } catch (e) { /* ignore */ }
    await safe(syncUi);
    await safe(() => pokeTabs('rescan'));
  } else {
    await patchSettings({ enabled: false });
    await patchState({ enabledUntil: 0, timerMin: 0 });
    chrome.alarms.clear(AUTO_OFF);
    await acknowledge(); // silences any active alarm and refreshes the badge
    try { chrome.power.releaseKeepAwake(); } catch (e) { /* ignore */ }
    await safe(syncUi);
    if (reason === 'timer') {
      await safe(() =>
        notify(NOTIF.off, 'Freshdesk monitoring turned OFF', 'The "turn on for…" timer ended. Switch it back on in the popup when you need it.', { sticky: false })
      );
    }
  }
}

// Turns monitoring off when the timer has run out (alarm fired, or the heartbeat noticed first).
async function expireTimerIfDue() {
  const { settings, st } = await load();
  if (settings.enabled && st.enabledUntil && Date.now() >= st.enabledUntil - 1000) {
    await setPower(false, 0, 'timer');
    return true;
  }
  return false;
}
async function rearmAutoOff() {
  const { settings, st } = await load();
  if (settings.enabled && st.enabledUntil > Date.now()) {
    chrome.alarms.get(AUTO_OFF, (a) => {
      if (!a) chrome.alarms.create(AUTO_OFF, { when: st.enabledUntil });
    });
  }
}

// ---------- scan handling ----------

async function handleScan(msg) {
  const { settings, st } = await load();
  if (!settings.enabled) return { ok: true, paused: true };
  const now = Date.now();

  if (msg.state !== 'ok') {
    await patchState({ issueState: msg.state, issueAt: now });
    return { ok: true };
  }

  const ids = uniq((msg.ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0));
  const sim = uniq((msg.simulatedIds || []).map(Number).filter(Number.isInteger));
  const sameAsLast = ids.length === st.lastIds.length && ids.every((id) => st.lastIds.includes(id));
  // A check only counts as "alive" on a fresh page load or when the ID set changed. A page that is
  // just sitting there (refresher dead) must not keep resetting the lost timer.
  const heartbeat = !!msg.fresh || !sameAsLast;

  const patch = { issueState: null, lastCheckState: 'ok', lastCheckCount: ids.length, lastIds: ids };
  let alarmKind = st.alarmKind;
  let pending = st.pendingNew;
  let pendingSim = st.pendingSim;
  let clearedLost = false;

  if (heartbeat) {
    patch.lastCheckAt = now;
    patch.lostAckedAt = 0;
    if (alarmKind === 'lost') { // monitoring is back
      alarmKind = null;
      clearedLost = true;
      await safe(stopAlarm);
      await safe(clearAllNotifications);
    }
  }

  const seen = new Set(st.seenIds);
  let max = st.maxSeenId;
  let newIds = [];
  if (!st.baselineSet) {
    patch.baselineSet = true; // first run: silent baseline
  } else {
    newIds = ids.filter((id) => !seen.has(id) && (settings.alertOnUnseenBelowMax || id > max));
  }
  ids.forEach((id) => {
    seen.add(id);
    if (id > max) max = id;
  });
  patch.seenIds = [...seen].slice(-SEEN_CAP);
  patch.maxSeenId = max;

  const raise = newIds.length > 0 || sim.length > 0;
  if (raise) {
    pending = uniq([...pending, ...newIds]);
    pendingSim = uniq([...pendingSim, ...sim]); // simulated IDs never enter seenIds / maxSeenId
    patch.pendingNew = pending;
    patch.pendingSim = pendingSim;
    patch.newTotal = st.newTotal + newIds.length;
    alarmKind = 'new';
  }
  patch.alarmKind = alarmKind;

  await patchState(patch); // persist before side effects
  if (raise) {
    console.log('[fdm] new tickets', newIds, 'simulated', sim);
    await raiseNew(pending, pendingSim);
  } else if (clearedLost) {
    await safe(syncBadge); // state is saved now, so the badge reflects "lost" being cleared
  }
  return { ok: true };
}

// ---------- heartbeat ----------

async function onHeartbeat() {
  const { settings, st } = await load();
  const now = Date.now();
  await patchState({ lastHeartbeatAt: now });

  if (await expireTimerIfDue()) return; // backup for the autoOff alarm
  if (!settings.enabled) return;
  try { chrome.power.requestKeepAwake('system'); } catch (e) { /* ignore */ }

  if (st.alarmKind) {
    await safe(() => playAlarm(st.alarmKind)); // idempotent: revives sound after a worker/offscreen restart
    return;
  }

  const base = Math.max(st.lastCheckAt, st.monitoringSince);
  const gap = now - base;
  const remindOk = !st.lostAckedAt || now - st.lostAckedAt > LOST_REMIND_MS;
  if (gap > settings.lostAfterMin * 60000 && remindOk) {
    await patchState({ alarmKind: 'lost' });
    await raiseLost(Math.round(gap / 60000));
  }
}

function ensureHeartbeatAlarm() {
  chrome.alarms.get(HEARTBEAT, (a) => {
    if (!a) chrome.alarms.create(HEARTBEAT, { delayInMinutes: 1, periodInMinutes: 1 });
  });
}

// ---------- commands (popup) ----------

async function handleCmd(msg) {
  const { settings, st } = await load();
  switch (msg.cmd) {
    case 'getState':
      return { ok: true, settings, st, now: Date.now(), watchTabs: (await watchTabs()).length };

    case 'ack':
      await acknowledge();
      return { ok: true };

    case 'testAlarm':
    case 'testLost': {
      if (st.alarmKind === 'new' || st.alarmKind === 'lost') return { ok: true, note: 'a real alarm is already active' };
      const lost = msg.cmd === 'testLost';
      await patchState({ alarmKind: lost ? 'testlost' : 'test' });
      await safe(() => notify(NOTIF.test, lost ? 'TEST: monitoring lost' : 'TEST: new ticket alarm', 'This is a test. Acknowledge to stop.'));
      await safe(() => playAlarm(lost ? 'testlost' : 'test'));
      return { ok: true };
    }

    case 'simulate': {
      const tabs = await watchTabs();
      if (!tabs.length) return { ok: false, error: 'No tab is open on the watched view (' + settings.watchPath + ').' };
      const id = st.maxSeenId + 1;
      const results = await Promise.all(tabs.map((t) => chrome.tabs.sendMessage(t.id, { cmd: 'simulate', id }).catch(() => null)));
      return results.some((r) => r && r.ok)
        ? { ok: true, id }
        : { ok: false, error: 'The ticket list was not found on the page (still loading?).' };
    }

    case 'setVolume': {
      const v = Math.min(1, Math.max(0, Number(msg.value)));
      await patchSettings({ volume: v });
      if (st.alarmKind && (await hasOffscreen())) await sendOffscreen('volume', { volume: v });
      return { ok: true };
    }

    case 'setPower':
      await setPower(!!msg.on, msg.minutes, 'user');
      return { ok: true };

    case 'setSetting': {
      const { key, value } = msg;
      if (key === 'alertOnUnseenBelowMax') {
        await patchSettings({ alertOnUnseenBelowMax: !!value });
      } else if (key === 'lostAfterMin') {
        await patchSettings({ lostAfterMin: Math.min(60, Math.max(1, Math.round(Number(value)) || 12)) });
      } else if (key === 'watchPath') {
        let p = String(value || '').trim();
        try { p = new URL(p).pathname; } catch (e) { /* not a full URL */ }
        if (!p.startsWith('/')) return { ok: false, error: 'Path must start with /' };
        await patchSettings({ watchPath: normPath(p) });
        await patchState({ baselineSet: false, seenIds: [], lastIds: [], maxSeenId: 0, lastCheckAt: 0, monitoringSince: Date.now() });
        await pokeTabs('rescan');
      } else {
        return { ok: false, error: 'Unknown setting' };
      }
      return { ok: true };
    }

    case 'resetBaseline':
      await acknowledge();
      await patchState({ baselineSet: false, seenIds: [], lastIds: [], maxSeenId: 0, newTotal: 0 });
      await pokeTabs('rescan');
      return { ok: true };

    default:
      return { ok: false, error: 'Unknown command' };
  }
}

// ---------- wiring (all listeners registered synchronously at top level) ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return;
  let job;
  if (msg.type === 'scan') job = () => handleScan(msg);
  else if (msg.type === 'cmd') job = () => handleCmd(msg);
  else return;
  enqueue(job)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true; // async response
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === HEARTBEAT) enqueue(onHeartbeat);
  else if (a.name === AUTO_OFF) enqueue(expireTimerIfDue);
});

chrome.notifications.onButtonClicked.addListener(() => enqueue(acknowledge));
chrome.notifications.onClicked.addListener((id) =>
  enqueue(async () => {
    if (id === NOTIF.off) { // FYI notice: just dismiss it
      await new Promise((r) => chrome.notifications.clear(id, () => r()));
      return;
    }
    await acknowledge();
    const tabs = await watchTabs();
    if (tabs[0]) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      await chrome.windows.update(tabs[0].windowId, { focused: true });
    }
  })
);

// Install / reload: a fresh install starts OFF (default); a reload keeps whatever state was saved.
chrome.runtime.onInstalled.addListener(() =>
  enqueue(async () => {
    const { settings } = await load();
    await chrome.storage.local.set({ settings });
    await patchState({ monitoringSince: Date.now() });
    ensureHeartbeatAlarm();
    await rearmAutoOff();
    if (settings.enabled) {
      try { chrome.power.requestKeepAwake('system'); } catch (e) { /* ignore */ }
    }
    await safe(syncUi);
  })
);
// Every browser launch starts OFF, so a forgotten ON can never scream the next day.
chrome.runtime.onStartup.addListener(() =>
  enqueue(async () => {
    await patchSettings({ enabled: false });
    await patchState({ enabledUntil: 0, monitoringSince: Date.now(), lostAckedAt: 0 });
    chrome.alarms.clear(AUTO_OFF);
    await acknowledge();
    try { chrome.power.releaseKeepAwake(); } catch (e) { /* ignore */ }
    ensureHeartbeatAlarm();
    await safe(syncUi);
  })
);
ensureHeartbeatAlarm();
rearmAutoOff();
