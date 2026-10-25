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

function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status ' + cls;
}

function render({ settings, st, now, watchTabs }) {
  const base = Math.max(st.lastCheckAt, st.monitoringSince);
  const lostNow = settings.enabled && now - base > settings.lostAfterMin * 60000;
  const alarming = st.alarmKind === 'new' || st.alarmKind === 'test';

  if (!settings.enabled) setStatus('Paused', 'off');
  else if (alarming) setStatus('ALARM: new ticket', 'alarm');
  else if (st.alarmKind === 'lost') setStatus('MONITORING LOST', 'lost');
  else if (lostNow) setStatus('Monitoring lost (acknowledged)', 'lost');
  else if (!st.lastCheckAt) setStatus('Waiting for first check…', 'wait');
  else setStatus('Monitoring', 'ok');

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
  if (idle($('enabled'))) $('enabled').checked = settings.enabled;
  if (idle($('belowMax'))) $('belowMax').checked = settings.alertOnUnseenBelowMax;
  if (idle($('lostAfter'))) $('lostAfter').value = settings.lostAfterMin;
  if (idle($('watchPath'))) $('watchPath').value = settings.watchPath;
}

async function refresh() {
  try {
    const res = await send('getState');
    if (res && res.ok) render(res);
  } catch (e) {
    setStatus('Background not responding', 'lost');
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
$('enabled').addEventListener('change', () => act('setSetting', { key: 'enabled', value: $('enabled').checked }));
$('belowMax').addEventListener('change', () => act('setSetting', { key: 'alertOnUnseenBelowMax', value: $('belowMax').checked }));
$('lostAfter').addEventListener('change', () => act('setSetting', { key: 'lostAfterMin', value: $('lostAfter').value }));
$('watchPath').addEventListener('change', () => act('setSetting', { key: 'watchPath', value: $('watchPath').value }));

refresh();
setInterval(refresh, 1000);
