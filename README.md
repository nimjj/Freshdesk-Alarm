# Freshdesk New Ticket Alarm

A Chrome extension (Manifest V3, vanilla JavaScript, no build step) that sounds a loud, repeating alarm when a **new ticket** shows up in a watched Freshdesk ticket view. It is built to run unattended for hours, and it raises a second, different alert if it stops being able to monitor.

Watched view (default): `https://voicify-support.freshdesk.com/a/tickets/filters/530853` ("My Open and Pending Tickets"). The path can be changed in the popup under **Settings & debug**.

---

## Important: this depends on an auto-refresh extension

> **This extension does not refresh the page itself.** It relies on a separate, manually installed **auto-refresh extension** that reloads the Freshdesk ticket tab (every 5 minutes in the current setup).

- Freshdesk only updates the ticket list when the page is reloaded, so without the refresher the extension has nothing new to read.
- The auto-refresh extension must be installed and running **on the same tab** as the watched view.
- If the refresher stops, the page just sits there unchanged. The extension treats that as "monitoring lost" and sounds the lost alarm after 12 minutes (editable).
- Reloads that show the same tickets never trigger the new-ticket alarm.

---

## Dependencies and requirements

| Requirement | Detail |
|---|---|
| Browser | Google Chrome 116 or newer (uses offscreen documents and `chrome.runtime.getContexts`) |
| Auto-refresh extension | Required, installed separately (see above) |
| Freshdesk session | Must stay signed in to `voicify-support.freshdesk.com` |
| Libraries / npm packages | **None.** Plain JavaScript, HTML and CSS. Nothing to install or build |
| Chrome permissions | `storage`, `alarms`, `notifications`, `offscreen`, `power`, plus host access to `https://voicify-support.freshdesk.com/*` |

---

## Quick start: clone and run

There is **no build step and nothing to install** (no npm, no bundler). The repository root is the extension, so cloning it and loading that folder in Chrome is all it takes.

### 1. Get the code

With git:

```bash
git clone https://github.com/nimjj/Freshdesk-Alarm.git
cd Freshdesk-Alarm
```

The default branch is `feature/freshdesk-alarm-extension`, so a plain clone checks it out. If a `main` branch is added later, add `-b feature/freshdesk-alarm-extension` to the clone command to get this one.

Without git: on the repository page choose **Code, Download ZIP**, then extract it somewhere permanent.

> **Keep the folder where it is.** Chrome loads an unpacked extension straight from its folder, so moving or deleting the folder breaks the extension.

### 2. Load it into Chrome

1. Open `chrome://extensions` in Chrome 116 or newer.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the folder that contains `manifest.json` (the cloned `Freshdesk-Alarm` folder, not a parent or a subfolder).
4. The extension **Freshdesk New Ticket Alarm** appears with a blue bell icon. Pin it from the puzzle-piece menu.

If Chrome says "Manifest file is missing or unreadable", the wrong folder was selected. Pick the folder that directly contains `manifest.json`.

### 3. Set up the auto-refresh extension

Install and start your auto-refresh extension on the Freshdesk tab (every 5 minutes). This extension does not refresh the page on its own. See the note at the top of this file.

### 4. Open the watched view and start monitoring

1. Sign in to Freshdesk and open the watched view in its own tab. The default is `https://voicify-support.freshdesk.com/a/tickets/filters/530853` ("My Open and Pending Tickets").
2. **Reload that tab once.** Chrome does not inject the extension into tabs that were already open when it was loaded.
3. Open the popup. After a few seconds it should say **Monitoring**, with a last-check time and a `maxSeenId`. That first scan is a silent baseline, so no alarm sounds.
4. Run the checks in [Testing](#testing) (Test alarm, then Simulate new ticket) before you leave it unattended.

### Using it with a different Freshdesk account or view

Two things are specific to this setup:

- **Domain.** `voicify-support.freshdesk.com` appears in `manifest.json` (`host_permissions` and the content script `matches`), in `FD_URL` in `background.js`, and in the ticket link in `popup.js`. Change those to your own Freshdesk domain.
- **Watched view.** `530853` is a saved view ID in this Freshdesk account. Open your own view and copy its path (for example `/a/tickets/filters/123456`) into **Settings & debug, Watched path** in the popup. Changing the path resets the baseline.

### Updating and editing

- To get changes: `git pull`, then click the reload icon on the extension card in `chrome://extensions`, then reload the Freshdesk tab.
- The same reload steps apply after you edit any file yourself.
- Your saved data (seen ticket IDs and settings) lives in `chrome.storage.local`, so it survives reloads and updates. It is cleared if you remove the extension.

### Troubleshooting

| Symptom | Fix |
|---|---|
| Popup says "Waiting for first check" | Reload the Freshdesk tab. Check that "Watched tab" in the popup says the tab is open and that the tab is on the watched path. |
| "Watched tab: NOT OPEN" | No tab is on exactly the watched path. Open the view, or correct **Watched path** in Settings. |
| Popup shows page state `parse-error` or `no-list` | Freshdesk's markup changed or the list has not rendered. See Limitations. |
| No sound on Test alarm | Check system volume and that Chrome is not muted in the Windows volume mixer. The popup shows a warning if the browser blocks audio. |
| No notifications | Turn off Windows Focus Assist / Do Not Disturb and allow Chrome notifications in Windows settings. The siren still plays. |
| "Monitoring lost" keeps sounding | No successful check in 12 minutes. Confirm you are signed in, the tab is open, and the auto-refresh extension is running. |

---

## How it works (the logic)

### Detection

1. **Scan.** `content.js` runs on every Freshdesk page load and also watches the page with a `MutationObserver`. On the watched path it reads ticket IDs from the main list only (`.ticket-list-container`): links matching `/a/tickets/<id>` plus the `data-test-ticket-content` attribute. The ticket detail sidebar is never scanned. Other Freshdesk tabs on other paths are ignored.
2. **Report.** The content script sends the list of IDs to the background service worker. It only sends when something changed (a signature of the state and IDs), so the observer cannot cause duplicate messages.
3. **Baseline.** On the first successful scan the visible IDs are saved silently. No alarm.
4. **Compare.** On later scans, any ID not already in the saved set is a new ticket. All IDs are stored in `chrome.storage.local`, so a page reload loses nothing and a reload showing the same tickets never alarms.
5. **Alarm.** New IDs are queued, the badge shows the count, a sticky notification appears, and the siren loops until you acknowledge.

### Alert rule

By default the alarm fires for **any ID not seen before**, including IDs lower than `maxSeenId`. This matters because tickets enter "My Open and Pending Tickets" by being assigned, so an older ticket can appear in the view. The setting **Alert on unseen IDs below maxSeenId** can be turned off to alarm only on IDs higher than `maxSeenId`.

A ticket that was already seen, left the view, and came back does not alarm again. **Reset baseline** clears the history.

### Empty view

Freshdesk shows a "No tickets here!" element when the view is empty. That counts as a successful check, so an empty view is healthy. A missing list or a login page is not.

### Monitoring-lost heartbeat

- A `chrome.alarms` heartbeat ticks every minute. It also calls `chrome.power.requestKeepAwake` and revives the alarm sound if the service worker was restarted.
- A scan only counts as "alive" on a **fresh page load** or when the **ticket list changed**. A tab that is sitting there unchanged because the refresher died does not count.
- If there has been no successful check for more than 12 minutes (editable, 1 to 60), the **monitoring lost** alarm sounds. This covers a closed tab, a logged-out Freshdesk, a dead refresher, or a broken selector.
- Acknowledging it silences it. If monitoring is still lost 15 minutes later, it sounds again. It clears automatically once a check succeeds.

### Sound

Alarms are synthesized with the Web Audio API in an **offscreen document** (reason `AUDIO_PLAYBACK`), so page reloads do not interrupt them and no audio files are needed.

| Alarm | Sound | When |
|---|---|---|
| New ticket | Fast two-tone siren (880 / 1320 Hz), loops | A new ID is found. Also a sticky notification and a red badge with the count |
| Monitoring lost | Slow low triple-beep (330 Hz), loops | No successful check for more than the lost-after time. Orange `!` badge |

Both loop until you click **Acknowledge** in the popup or the notification.

---

## Popup

- Status: Monitoring / Paused / Waiting for first check / ALARM / MONITORING LOST
- Last check time, background heartbeat time, `maxSeenId`, number of tracked IDs, pending new tickets, whether the watched tab is open
- **Acknowledge**, **Test alarm**, **Test lost alarm**, volume slider
- **Settings & debug**: enable/disable, alert-below-max toggle, lost-after minutes, watched path, **Simulate new ticket**, **Reset baseline**

---

## Testing

1. **Test alarm** and **Test lost alarm** in the popup. Confirm you can hear both, then Acknowledge.
2. **Simulate new ticket** (Settings & debug): injects a yellow "SIMULATED" row with ID `maxSeenId + 1` into the list and runs the real detection path. Simulated IDs are never saved as seen, so they cannot hide a real ticket. Acknowledge removes the row.
3. Press F5 on the watched view several times: no alarm.
4. Set "Monitoring lost after" to 1 minute and close the tab: the lost alarm sounds within about 2 minutes. Set it back to 12.
5. End to end: assign a ticket to yourself in Freshdesk and wait for the next refresh.

---

## Keeping the PC awake for long runs

- The extension asks Windows not to sleep while it is enabled. The screen may still turn off. This does not stop lid-close, a manual sleep, or a Windows Update restart.
- Plug in. In **Settings, System, Power & battery**, set "When plugged in, put my device to sleep after" to **Never**.
- If the lid will be closed, set the lid-close action (Control Panel, Power Options) to **Do nothing**.
- In `chrome://settings/performance`, add `voicify-support.freshdesk.com` under **Always keep these sites active** so Chrome never discards the tab.
- Keep Chrome running, speakers unmuted and the volume up. Turn off Windows Focus Assist / Do Not Disturb so notifications show.
- Stay signed in to Freshdesk. A logged-out page triggers the lost alarm.

---

## Project structure

| File | Role |
|---|---|
| `manifest.json` | Manifest V3 config, permissions, content script match |
| `content.js` | Scans the ticket list, reports IDs, handles the simulate row |
| `background.js` | Service worker: baseline, new-ticket detection, alarms, heartbeat, badge, notifications, offscreen lifecycle |
| `offscreen.html` / `offscreen.js` | Web Audio alarm player |
| `popup.html` / `popup.js` / `popup.css` | Status UI and controls |
| `icons/` | Extension and notification icons |

## Limitations

- Detection speed is bounded by the auto-refresh interval (5 minutes), unless Freshdesk updates the list live, which the `MutationObserver` catches immediately.
- The watched view must be sorted so new tickets appear on the first page. The current view is usually empty or has one or two tickets, so this is not an issue in practice.
- The selectors (`.ticket-list-container`, `data-test-ticket-content`, `.empty-results`) come from Freshdesk's current markup. If Freshdesk changes them, the popup shows a `parse-error` or `no-list` state and the lost alarm eventually fires.
