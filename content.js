// Scans the watched Freshdesk ticket list and reports ticket IDs to the background worker.
// Detection (new vs. seen) lives in background.js; this file only reads the DOM.
(() => {
  'use strict';
  if (window.__fdmAlarmLoaded) return;
  window.__fdmAlarmLoaded = true;

  const DEFAULT_PATH = '/a/tickets/filters/530853';
  const ID_RE = /^\/a\/tickets\/(\d+)(?:\/|$)/;
  const THROTTLE_MS = 300;

  let watchPath = DEFAULT_PATH;
  let ready = false;
  let lastSig = null;      // signature of the last scan we sent
  let freshPending = true; // first ok scan after load / navigation is flagged fresh
  let wasActive = false;
  const reportedSim = new Set();

  const normPath = (p) => (p || '').split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  const isActive = () => normPath(location.pathname) === normPath(watchPath);

  // Only looks inside the main list container, never the detail sidebar.
  function scan() {
    const container = document.querySelector('.ticket-list-container');
    if (!container) return { state: 'no-list', ids: [], sim: [] };

    const real = new Set();
    const sim = new Set();
    const put = (raw, el) => {
      const id = Number(raw);
      if (!Number.isInteger(id) || id <= 0) return;
      (el.closest('[data-fdm-fake]') ? sim : real).add(id);
    };
    container.querySelectorAll('a[href]').forEach((a) => {
      const m = ID_RE.exec(a.pathname);
      if (m) put(m[1], a);
    });
    container.querySelectorAll('[data-test-ticket-content]').forEach((el) => {
      put(el.getAttribute('data-test-ticket-content'), el);
    });

    let state;
    if (real.size) state = 'ok';
    else if (container.querySelector('.empty-results')) state = 'ok'; // confirmed empty view
    else if (container.querySelector('tbody.lt-body tr.lt-row')) state = 'parse-error'; // rows but no IDs
    else state = 'loading';

    return { state, ids: [...real].sort((a, b) => a - b), sim: [...sim] };
  }

  function check() {
    if (!ready || !chrome.runtime?.id) return;

    if (!isActive()) {
      wasActive = false;
      lastSig = null;
      return;
    }
    if (!wasActive) {
      wasActive = true;
      freshPending = true;
      lastSig = null;
    }

    const r = scan();
    const simNew = r.sim.filter((id) => !reportedSim.has(id));
    const sig = r.state + '|' + r.ids.join(',');
    if (sig === lastSig && !simNew.length) return; // nothing changed: no message

    const fresh = r.state === 'ok' && freshPending;
    lastSig = sig;
    if (fresh) freshPending = false;
    simNew.forEach((id) => reportedSim.add(id));

    const undo = () => {
      lastSig = null;
      if (fresh) freshPending = true;
      simNew.forEach((id) => reportedSim.delete(id));
    };
    try {
      chrome.runtime
        .sendMessage({ type: 'scan', state: r.state, ids: r.ids, simulatedIds: simNew, fresh, path: location.pathname })
        .then((res) => { if (!res || !res.ok) undo(); })
        .catch(undo);
    } catch (e) {
      undo();
    }
  }

  let lastRun = 0;
  let trailing = null;
  function run() {
    lastRun = performance.now();
    check();
  }
  function schedule() {
    const wait = THROTTLE_MS - (performance.now() - lastRun);
    if (wait <= 0) run();
    else if (!trailing) trailing = setTimeout(() => { trailing = null; run(); }, wait);
  }

  function injectFake(id) {
    const container = document.querySelector('.ticket-list-container');
    if (!container || !isActive()) return false;
    document.querySelectorAll('[data-fdm-fake]').forEach((e) => e.remove());
    reportedSim.delete(id);

    const box = document.createElement('div');
    box.setAttribute('data-fdm-fake', '1');
    box.style.cssText =
      'padding:10px 14px;margin:6px;background:#fff3cd;border:2px dashed #d39e00;color:#333;font:14px sans-serif;';
    const a = document.createElement('a');
    a.href = '/a/tickets/' + id;
    a.textContent = 'SIMULATED new ticket #' + id + ' (Freshdesk New Ticket Alarm test)';
    box.appendChild(a);
    container.prepend(box);
    run();
    return true;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.cmd) return;
    if (msg.cmd === 'simulate') {
      sendResponse({ ok: injectFake(Number(msg.id)) });
    } else if (msg.cmd === 'removeFake') {
      document.querySelectorAll('[data-fdm-fake]').forEach((e) => e.remove());
      reportedSim.clear();
      sendResponse({ ok: true });
    } else if (msg.cmd === 'rescan') {
      lastSig = null;
      freshPending = true;
      run();
      sendResponse({ ok: true });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const p = changes.settings.newValue && changes.settings.newValue.watchPath;
    if (p && p !== watchPath) {
      watchPath = p;
      wasActive = false;
      run();
    }
  });

  chrome.storage.local
    .get('settings')
    .then(({ settings }) => { if (settings && settings.watchPath) watchPath = settings.watchPath; })
    .catch(() => {})
    .finally(() => { ready = true; run(); });

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  // Safety net: catches URL changes with no DOM mutation, and covers throttled trailing timers.
  const poll = setInterval(() => {
    if (!chrome.runtime?.id) { // extension was reloaded; this script is orphaned
      observer.disconnect();
      clearInterval(poll);
      return;
    }
    schedule();
  }, 2000);
})();
