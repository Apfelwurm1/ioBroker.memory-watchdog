![Logo](admin/memory-watchdog.png)
# ioBroker.memory-watchdog

[![NPM version](https://img.shields.io/npm/v/iobroker.memory-watchdog.svg)](https://www.npmjs.com/package/iobroker.memory-watchdog)
[![Downloads](https://img.shields.io/npm/dm/iobroker.memory-watchdog.svg)](https://www.npmjs.com/package/iobroker.memory-watchdog)
![Number of Installations](https://iobroker.live/badges/memory-watchdog-installed.svg)
[![Translation status](https://weblate.iobroker.net/widgets/adapters/-/memory-watchdog/svg-badge.svg)](https://weblate.iobroker.net/engage/adapters/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Smart memory watchdog, baseline learner, and leak prevention for ioBroker adapter instances.**

[Deutsche Dokumentation siehe unten](#deutsche-dokumentation)

---

## English Documentation

### What is ioBroker.memory-watchdog?
In larger ioBroker installations running dozens of adapter instances, Node.js memory leaks and lazy V8 garbage collection can gradually consume all available system RAM. Over days or weeks, this leads to heavy swap thrashing (high load averages) and total host freezes.

`iobroker.memory-watchdog` solves this autonomously and safely:
1. **Dynamic Baseline Learning**: Automatically records the healthy baseline memory consumption for each adapter instance after its startup grace period.
2. **Relative Factor & Absolute Thresholds**: Detects when an adapter inflates to e.g. 2.5x of its normal startup size or crosses a hard ceiling (e.g. 450 MB).
3. **Sustained Load Filter (Duration)**: Only triggers when memory is elevated for multiple consecutive check cycles (e.g. 20-30 minutes), preventing false alarms from short temporary spikes (rendering maps, chart queries).
4. **Daily Restart Budget (Cloud Protection)**: Restricts restarts to a configurable maximum (e.g. 4 times per 24h) to avoid cloud API lockout (Rate Limits from Alexa, Tuya, Roborock, etc.).
5. **Targeted Surgical Restart**: Only the leaking adapter is restarted in ~4 seconds. The rest of ioBroker, Home Assistant, Zigbee, and MQTT remain 100% online.
6. **Built-in Notifications & Quiet Hours**: Directly alerts you via Pushover, Telegram, E-Mail, or custom state. Includes configurable Quiet Hours (e.g. 22:00-07:00) to mute smartphone alerts during the night while keeping protection fully active.
7. **System Free-RAM Emergency Protection**: Monitors container/host free memory (`info.systemFreeMemMB`) and automatically restarts the largest consumer before a fatal Linux Kernel OOM crash occurs.
8. **Restart Verification (Stalled Process Detection)**: Validates that an adapter came back online cleanly within 45s after a restart, alerting immediately if a process is frozen or hung.
9. **Dashboard JSON Statistics & Leak History**: Provides `info.adapterStats` (formatted JSON array for VIS-2, Grafana, and Home Assistant) and `info.restartHistory` (log of recent restarts with baseline, peak memory, and trigger reasons).

---

### Configuration
All settings are comfortably configured in the modern Admin JSON-Config interface:

- **General Settings**:
  - `Check Interval`: How often memory is evaluated (default: 15 minutes).
  - `Learning Delay`: Time to wait after an adapter starts before recording its baseline (default: 5 minutes).
  - `Memory Factor`: Multiplier of baseline RAM to trigger warning/restart (default: 2.5x).
  - `Minimum RAM for Factor`: Minimum memory in MB before factor check engages (default: 250 MB).
  - `Absolute Hard Limit`: Maximum allowable memory regardless of baseline (default: 450 MB).
  - `Consecutive High Cycles`: How many cycles memory must stay high before restarting (default: 2).
  - `Max Restarts per Day`: Daily restart allowance per adapter, resets at 00:00 (default: 4).
  - `Cooldown`: Minimum time between restarts of the exact same adapter (default: 60 minutes).

- **Per-Adapter Overrides & Blacklist**:
  - You can define custom limits for heavy adapters (e.g. allowing `admin.0` up to 600 MB) or completely disable watchdog monitoring for sensitive adapters (e.g. security alarms).

- **Notifications**:
  - Receive push notifications on restarts or when an adapter exhausts its daily budget.

---

### Datapoints (`memory-watchdog.0.*`)
For every monitored adapter instance, datapoints are created:
- `adapters.<instance>.baselineMB`: Learned baseline memory
- `adapters.<instance>.currentMB`: Current memory consumption
- `adapters.<instance>.ratio`: Ratio of current memory to baseline (e.g. 1.45)
- `adapters.<instance>.highCycles`: Consecutive cycles above threshold
- `adapters.<instance>.restartsToday`: Restarts triggered today
- `adapters.<instance>.lastRestart`: Timestamp of the last restart
- `adapters.<instance>.status`: Current state (`ok`, `warning_high`, `restarting`, `limit_reached`)

Global statistics under `info.*`:
- `info.monitoredAdapters`: Total count of active instances
- `info.totalRestartsToday`: Cumulative restarts across all adapters
- `info.lastAction`: Last action description and timestamp

---

## Deutsche Dokumentation

### Was ist ioBroker.memory-watchdog?
In größeren ioBroker-Installationen mit vielen Adaptern führen schleichende Speicherlecks in Node.js-Prozessen dazu, dass nach einigen Tagen der gesamte RAM vollläuft. Der Linux-Kernel beginnt dann massiv auf die SSD zu swappen, der Load Average schießt in die Höhe und der Server friert ein.

`iobroker.memory-watchdog` überwacht alle Instanzen vollautomatisch und greift gezielt und schonend ein:
1. **Automatisches Lernen der Startwerte**: Erfasst nach einer kurzen Einlaufphase den gesunden Grundverbrauch jedes Adapters.
2. **Dynamischer Faktor & Notfall-Limit**: Erkennt, wenn ein Adapter z. B. auf das 2,5-fache seiner Startgröße wächst oder ein absolutes Limit (z. B. 450 MB) überschreitet.
3. **Dauer-Filter (Last vs. Leck)**: Verhindert Fehlalarme bei kurzen Lastspitzen (wie Staubsaugerkarten berechnen oder Grafana-Abfragen). Erst wenn der Speicher über z. B. 20–30 Minuten dauerhaft zu hoch bleibt, greift der Wächter ein.
4. **Tages-Budget (Schutz vor Cloud-Sperren)**: Begrenzt die Neustarts auf max. 4 pro Tag und Adapter, um Kontensperren bei Cloud-Diensten (Alexa, Tuya etc.) zuverlässig zu verhindern.
5. **Chirurgischer Einzel-Neustart**: Es wird **nur der betroffene Adapter** in ca. 4 Sekunden neu gestartet. Alle anderen Adapter und Verbindungen bleiben ununterbrochen online!
6. **Integrierte Benachrichtigungen & Ruhezeiten**: Sendet auf Wunsch sofort eine Nachricht via Pushover, Telegram, E-Mail oder Datenpunkt. Einstellbare Ruhezeiten (z. B. 22:00–07:00 Uhr) verhindern störende Smartphone-Pushes mitten in der Nacht.
7. **Notfall-Schutz bei akutem RAM-Mangel**: Überwacht den freien Containerspeicher (`info.systemFreeMemMB`) und startet bei Unterschreiten der Notgrenze (z. B. < 150 MB) den größten Speicherfresser neu, bevor der Linux OOM-Killer zuschlägt.
8. **Neustart-Erfolgsprüfung (Hänger-Erkennung)**: Prüft 45 Sekunden nach einem Neustart, ob der Adapter wirklich wieder online ist, und warnt bei Deadlocks oder Hängern.
9. **Dashboard-JSON & Leak-Report**: Stellt formatierte JSON-Objekte (`info.adapterStats` und `info.restartHistory`) für VIS-2, Home Assistant oder Grafana bereit.

---

### Compact Mode & Recovery Behavior
- **Compact Mode Protection**: When monitored adapter instances run in ioBroker compact mode (`system.adapter.X.compactMode === true` or configured via `runAsCompactMode`), multiple instances share a single Node.js OS process. Automatic restarts for such instances are deliberately suppressed (status `compact`) to prevent terminating the shared process or innocent sibling adapters. High-memory warnings are throttled to once per hour unless memory grows significantly.
- **Pending Restarts & Ownership Verification (`obj.from`)**: If the watchdog initiates an adapter restart and the host or watchdog crashes before the adapter can be re-enabled, `recoverPendingRestarts()` runs on startup. It checks `obj.from`: if the disabling entity was the watchdog (`system.adapter.memory-watchdog.0`), it safely re-enables the adapter. If an administrator, another tool, or an adapter update (e.g. `system.host.X.cli`) modified the adapter in the meantime, the watchdog leaves the adapter disabled and sends a push notification so the user is aware.

---

## Changelog
### 0.1.8 (2026-10-29)
* (Apfelwurm1) Hysteresis: Require +25 MB recovery margin before resetting emergency RAM alerts to prevent boundary flapping
* (Apfelwurm1) Compact: Require -25 MB recovery margin before resetting compact high-memory warning throttle
* (Apfelwurm1) CI: Add explicit `npm run test:integration` step in GitHub Actions workflow for automated integration verification
* (Apfelwurm1) Architecture: Consolidate compact mode detection and state reconciliation into `refreshCompactInfo` helper
* (Apfelwurm1) State: Allow `compact` status to cleanly revert back to `ok` if an adapter is switched to standalone mode
* (Apfelwurm1) Testing: Document exit code 11 explanation in integration test suite and expand unit tests to 28 passing cases

### 0.1.7 (2026-10-29)
* (Apfelwurm1) Compact: State `compactMode` is primary authority for compact detection with `runAsCompactMode` fallback
* (Apfelwurm1) Compact: Preserve group 0 (controller process) using nullish coalescing `compactGroup ?? 1`
* (Apfelwurm1) Compact: Dynamic compact mode status sync on every scan cycle and cold start
* (Apfelwurm1) Compact: Throttle high-memory warning logs to prevent log spam
* (Apfelwurm1) Safety: canRestart unconditionally returns false for compact instances across flood, memory, and emergency checks
* (Apfelwurm1) Telemetry: Reset emergency RAM warning hysteresis immediately when free RAM recovers to healthy levels
* (Apfelwurm1) Architecture: Modularize decision helpers into lib/helpers.js and expand unit test suite to 24 tests
* (Apfelwurm1) Testing: Integration test suite with `@iobroker/testing` verifying clean startup and lifecycle
* (Apfelwurm1) Engine: Drop end-of-life Node 18, require Node >= 20.0.0

### 0.1.6 (2026-10-29)
* (Apfelwurm1) Compact: Detect monitored instances in compact mode and assign status `compact`
* (Apfelwurm1) Safety: Ownership validation via `obj.from` in pendingRestarts recovery
* (Apfelwurm1) Alerts: Hysteresis for emergency low-RAM alerts
* (Apfelwurm1) Config: Configurable JavaScript engine exclusion (`ignoreJavascriptAdapters`)
* (Apfelwurm1) Admin: Add required `size: 5` property to all jsonConfig headers
* (Apfelwurm1) Dependencies: Raise minimum js-controller dependency to >= 6.0.11

### 0.1.5 (2026-10-29)
* (Apfelwurm1) Safety: Timestamped info.pendingRestarts with 10-minute expiry window prevents unprompted re-enabling
* (Apfelwurm1) Security: Extended credentials masking regex covering passphrase, credentials and preserving Bearer quotes
* (Apfelwurm1) Stability: Pre-initialize adapter states before memRss verification during startup scans
* (Apfelwurm1) Telemetry: Update dashboard stats directly following cold-start baseline learning
* (Apfelwurm1) Config: Default floodMigrated to true for clean initial installations
* (Apfelwurm1) Packaging: Set compact to false for dedicated process and memory inspection isolation

### 0.1.4 (2026-10-29)
* (Apfelwurm1) Fix: Use extendForeignObject in onUnload for reliable process recovery during shutdown
* (Apfelwurm1) Fix: Correct non-capturing groups in credentials sanitization regex to prevent double word artifacts
* (Apfelwurm1) Fix: Add floodMigrated flag to prevent re-triggering migration if user deliberately chooses 50 ev/s
* (Apfelwurm1) State: Save lastRestartTs timestamp persistently in state for cooldown tracking across watchdog restarts
* (Apfelwurm1) Architecture: Modularize pure helpers into lib/helpers.js and add automated Mocha unit test suite

### 0.1.3 (2026-10-28)
* (Apfelwurm1) Auto-migrate legacy flood threshold from 50 to 250 ev/s on existing instances
* (Apfelwurm1) Robustness: Immediate shutdown recovery in onUnload for all pending adapters
* (Apfelwurm1) Robustness: Execute recoverPendingRestarts prior to checking adapter enabled status
* (Apfelwurm1) Concurrency: In-memory pendingRestartsSet eliminates async read/modify/write race conditions
* (Apfelwurm1) Budget: Verify state timestamp when restoring restartsToday to prevent counting yesterday's budget
* (Apfelwurm1) Security: Advanced regex credentials sanitization for URLs, auth headers, token parameters and secrets
* (Apfelwurm1) UI: Add customFloodThreshold column to Custom Rules table in jsonConfig
* (Apfelwurm1) Telemetry: Selective emergency RAM targeting requiring ratio > 1.3 to avoid restarting healthy adapters

### 0.1.2 (2026-10-28)
* (Apfelwurm1) Hotfix: Fix missing limitMB and factorLimitMB in info.adapterStats JSON
* (Apfelwurm1) Hotfix: Restrict emergency RAM restarts strictly to the single largest consumer (no cascading restarts)
* (Apfelwurm1) Hotfix: Global 30-minute emergency restart cooldown prevents cycling across secondary adapters
* (Apfelwurm1) Hotfix: Increase default flood threshold to 250 events/s with sustained-cycle hysteresis
* (Apfelwurm1) Hotfix: Set restart lock synchronously to eliminate race conditions with incoming message commands
* (Apfelwurm1) Safety: Persistent info.pendingRestarts tracks restarts across host crashes/reboots for guaranteed re-enablement
* (Apfelwurm1) Telemetry: Mark >30m running adapter baselines as provisional to defer factor checks until next cold start

### 0.1.1 (2026-10-28)
* (Apfelwurm1) Fix: Event-rate calculation using `system.config` statisticsInterval window
* (Apfelwurm1) Fix: Cold-start baseline learning triggering only on actual `false -> true` state transitions
* (Apfelwurm1) Fix: Prevent reviving manually disabled adapters during emergency RAM recovery
* (Apfelwurm1) Fix: Bound emergency and flood restarts to restart cooldown and budgets
* (Apfelwurm1) Fix: Prevent concurrent overlapping restarts using active instance locks
* (Apfelwurm1) Fix: Add `messagebox: true` and `tier: 1` to `io-package.json` for external script commands
* (Apfelwurm1) Security: Sanitize camera and RTSP passwords in orphaned process inspection arguments
* (Apfelwurm1) Robustness: Use `execFile` instead of subshell `exec` for process inspection
* (Apfelwurm1) Robustness: Proper escaping of Telegram Markdown special characters
* (Apfelwurm1) Telemetry: Read `/proc/meminfo` MemAvailable on Linux for container-accurate RAM metrics

### 0.1.0 (2026-10-28)
* (Apfelwurm1) Initial public release
* Dynamic baseline learning per adapter instance
* Sustained load duration filter
* Daily restart allowance / rate limit protection
* Modern Admin JSON-Config with per-adapter override table
* Full multi-language support (11 languages)
* Notification dispatching via Pushover, Telegram, E-Mail
* Quiet hours night mode for muted alerts
* System emergency free-RAM protection against OOM crashes
* Stalled process restart verification
* Dashboard JSON statistics and leak history log
* State-flooding & event-rate monitoring (prevents bus overload)
* Silent freeze / unresponsive adapter detection
* JSONL database size and rapid log file growth alerts
* Orphaned sub-process detection (abandoned go2rtc/ffmpeg instances)
* Overall system stability indicator for automated backups (info.systemStable)

---

## License
MIT License

Copyright (c) 2026 Apfelwurm1

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
