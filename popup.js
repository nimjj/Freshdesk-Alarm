'use strict';

const $ = (id) => document.getElementById(id);
const send = (cmd, extra = {}) => chrome.runtime.sendMessage({ type: 'cmd', cmd, ...extra });

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's ago';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm ago';
}
const clock = (t) => new Date(t).toLocaleTimeString();

// "3h 12m", "12m 05s", "45s"
function remaining(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return h + 'h ' + m + 'm';
  if (m) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
  return s + 's';
}

// cls drives the hero colour: ok | wait | alarm | lost | off
function setHero(text, sub, cls) {
  $('statusText').textContent = text;
  $('statusSub').textContent = sub;
  $('hero').className = 'hero ' + cls;
  document.body.classList.toggle('off', cls === 'off');
}

function render({ settings, st, now, watchTabs }) {
  const base = Math.max(st.lastCheckAt, st.monitoringSince);
  const lostNow = settings.enabled && now - base > settings.lostAfterMin * 60000;
  const alarming = st.alarmKind === 'new' || st.alarmKind === 'test';
  const lastCheck = st.lastCheckAt ? 'Last check ' + ago(now - st.lastCheckAt) + ', ' + st.lastCheckCount + ' in view' : '';

  if (alarming) setHero('ALARM: new ticket', 'Acknowledge to silence it.', 'alarm');
  else if (st.alarmKind === 'lost') setHero('MONITORING LOST', 'No successful check for ' + Math.round((now - base) / 60000) + ' min.', 'lost');
  else if (!settings.enabled) setHero('Monitoring is OFF', 'No alarms will sound.', 'off');
  else if (lostNow) setHero('Monitoring lost', 'Acknowledged. Check the Freshdesk tab.', 'lost');
  else if (!st.lastCheckAt) setHero('Waiting for first check…', 'Open or reload the watched Freshdesk tab.', 'wait');
  else setHero('Monitoring', lastCheck, 'ok');

  // power switch, run-for chips and countdown
  const power = $('power');
  power.setAttribute('aria-checked', String(settings.enabled));
  power.querySelector('.switch-label').textContent = settings.enabled ? 'ON' : 'OFF';
  document.querySelectorAll('.chip').forEach((c) => {
    c.classList.toggle('active', settings.enabled && Number(c.dataset.min) === (st.timerMin || 0));
  });
  const timer = $('timerLine');
  timer.hidden = !(settings.enabled && st.enabledUntil);
  if (!timer.hidden) timer.textContent = 'Turns off automatically in ' + remaining(st.enabledUntil - now);

  $('simulate').disabled = !settings.enabled;
  $('simHint').hidden = settings.enabled;

  const warn = [];
  if (st.audioState && st.audioState !== 'running' && st.alarmKind) warn.push('Audio is ' + st.audioState + ': the alarm may be silent.');
  if (settings.enabled && st.issueState) warn.push('Last page state: ' + st.issueState + ' (' + ago(now - st.issueAt) + ')');
  $('warn').hidden = warn.length === 0;
  $('warn').textContent = warn.join(' ');

  $('lastCheck').textContent = st.lastCheckAt
    ? ago(now - st.lastCheckAt) + ' (' + clock(st.lastCheckAt) + '), ' + st.lastCheckCount + ' in view'
    : 'never';
  $('heartbeat').textContent = st.lastHeartbeatAt ? ago(now - st.lastHeartbeatAt) : 'not yet';
  $('maxSeen').textContent = st.baselineSet ? st.maxSeenId : 'baseline not set';
  $('seenCount').textContent = st.seenIds.length;
  const pending = st.pendingNew.length + st.pendingSim.length;
  $('newCount').textContent = pending + ' pending (' + st.newTotal + ' since reset)';
  $('tabs').textContent = watchTabs ? watchTabs + ' open' : 'NOT OPEN';

  const list = $('newList');
  list.replaceChildren();
  st.pendingNew.forEach((id) => {
    const a = document.createElement('a');
    a.href = 'https://voicify-support.freshdesk.com/a/tickets/' + id;
    a.target = '_blank';
    a.textContent = '#' + id;
    list.appendChild(a);
  });
  st.pendingSim.forEach((id) => {
    const s = document.createElement('span');
    s.textContent = '#' + id + ' (simulated)';
    list.appendChild(s);
  });

  $('ack').disabled = !st.alarmKind;

  // Don't overwrite a control while the user is editing it.
  const idle = (el) => document.activeElement !== el;
  if (idle($('vol'))) { $('vol').value = Math.round(settings.volume * 100); }
  $('volVal').textContent = Math.round(settings.volume * 100) + '%';
  if (idle($('belowMax'))) $('belowMax').checked = settings.alertOnUnseenBelowMax;
  if (idle($('lostAfter'))) $('lostAfter').value = settings.lostAfterMin;
  if (idle($('watchPath'))) $('watchPath').value = settings.watchPath;
}

async function refresh() {
  try {
    const res = await send('getState');
    if (res && res.ok) render(res);
  } catch (e) {
    setHero('Background not responding', 'Reload the extension in chrome://extensions.', 'lost');
  }
}

async function act(cmd, extra) {
  const res = await send(cmd, extra);
  $('msg').textContent = res && !res.ok ? res.error || 'Failed' : '';
  refresh();
}

$('ack').addEventListener('click', () => act('ack'));
$('test').addEventListener('click', () => act('testAlarm'));
$('testLost').addEventListener('click', () => act('testLost'));
$('simulate').addEventListener('click', () => act('simulate'));
$('reset').addEventListener('click', () => {
  if (confirm('Forget all seen tickets? The next scan becomes the new silent baseline.')) act('resetBaseline');
});
$('vol').addEventListener('input', () => {
  $('volVal').textContent = $('vol').value + '%';
  send('setVolume', { value: $('vol').value / 100 });
});
$('power').addEventListener('click', () => {
  const on = $('power').getAttribute('aria-checked') !== 'true';
  act('setPower', { on }); // switch ON = no time limit
});
document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => act('setPower', { on: true, minutes: Number(chip.dataset.min) }));
});
$('belowMax').addEventListener('change', () => act('setSetting', { key: 'alertOnUnseenBelowMax', value: $('belowMax').checked }));
$('lostAfter').addEventListener('change', () => act('setSetting', { key: 'lostAfterMin', value: $('lostAfter').value }));
$('watchPath').addEventListener('change', () => act('setSetting', { key: 'watchPath', value: $('watchPath').value }));

refresh();
setInterval(refresh, 1000);
