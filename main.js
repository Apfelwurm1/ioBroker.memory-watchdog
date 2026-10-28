'use strict';

/*
 * Created with @iobroker/create-adapter v2.6.0
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const utils = require('@iobroker/adapter-core');

/**
 * Escapes characters for Telegram Markdown format
 * @param {string} text
 * @returns {string}
 */
function escapeTelegramMarkdown(text) {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

class MemoryWatchdog extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options = {}) {
        super({
            ...options,
            name: 'memory-watchdog',
        });

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));

        /** @type {Map<string, { startRss: number, startedAt: number, lastRestart: number, highCycles: number, floodCycles: number, restartsToday: number, currentMem: number, lastOutputTs?: number, eventsPerSec?: number, silentFreeze?: boolean, baselineProvisional?: boolean, customConfig?: any }>} */
        this.adapterData = new Map();

        /** @type {Array<{ timestamp: string, time: string, adapter: string, baselineMB: number, memoryMB: number, reason: string, restartsToday: number }>} */
        this.restartHistory = [];

        /** @type {number} */
        this.lastCheckTimestamp = Date.now();

        /** @type {number} */
        this.prevLogSizeMB = 0;

        /** @type {number} */
        this.lastEmergencyRestartTs = 0;

        /** @type {NodeJS.Timeout | null} */
        this.checkTimer = null;

        /** @type {NodeJS.Timeout | null} */
        this.midnightTimer = null;

        /** @type {Map<string, NodeJS.Timeout>} */
        this.learningTimers = new Map();

        /** @type {Map<string, NodeJS.Timeout>} */
        this.verificationTimers = new Map();

        /** @type {Map<string, boolean>} Tracks alive state transitions (false -> true) */
        this.aliveCache = new Map();

        /** @type {Set<string>} Prevents concurrent overlapping restarts for the same instance */
        this.restarting = new Set();

        /** @type {number} Statistics interval in ms from system.config (default 15000) */
        this.statisticsInterval = 15000;
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        this.log.info('Smart Memory Watchdog starting up...');

        // Set connection status
        await this.setStateAsync('info.connection', true, true);

        if (!this.config.enabled) {
            this.log.warn('Memory Watchdog is disabled in configuration. Monitoring paused.');
            return;
        }

        // 1. Recover any adapters left disabled from an abrupt host shutdown or power failure
        await this.recoverPendingRestarts();

        // 2. Read system.config to get precise controller statistics interval
        try {
            const sysConfig = await this.getForeignObjectAsync('system.config');
            if (sysConfig && sysConfig.common && typeof sysConfig.common.statisticsInterval === 'number') {
                this.statisticsInterval = Math.max(5000, sysConfig.common.statisticsInterval);
            }
            this.log.debug(`Controller statistics interval: ${this.statisticsInterval}ms`);
        } catch (e) {
            this.log.debug(`Could not read system.config statisticsInterval, defaulting to 15000ms: ${e}`);
        }

        // 3. Restore persisted states and per-adapter budgets
        await this.restorePersistedState();

        // 4. Preload alive cache BEFORE subscribing to avoid spurious cold-start learning triggers on existing adapters
        await this.preloadAliveCache();

        // 5. Initialize scheduled midnight reset for daily restart budgets
        this.setupMidnightTimer();

        // 6. Subscribe to adapter alive states
        this.subscribeForeignStates('system.adapter.*.*.alive');

        // 7. Initial scan of active adapters after 10 seconds grace period
        this.setTimeout(() => {
            this.scanActiveAdapters().catch((err) => this.log.error(`Scan error: ${err}`));
        }, 10000);

        // 8. Periodic memory & system health check
        const intervalMs = Math.max(1, this.config.checkIntervalMin || 15) * 60 * 1000;
        this.checkTimer = this.setInterval(() => {
            this.checkMemory().catch((err) => this.log.error(`Periodic check error: ${err}`));
        }, intervalMs);

        // 9. Record initial free memory & storage metrics
        const initialFree = this.getSystemFreeMemMB();
        await this.setStateAsync('info.systemFreeMemMB', initialFree, true);
        await this.checkStorageHealth();

        this.log.info(
            `Memory Watchdog initialized. Interval: ${this.config.checkIntervalMin}m, Factor: ${this.config.memoryFactor}x, Max: ${this.config.absoluteMaxMB}MB, Flood threshold: ${this.config.floodThresholdEventsPerSec || 250} ev/s, Daily budget: ${this.config.maxRestartsPerDay}`,
        );
    }

    /**
     * Recovers adapters that were left disabled due to an abrupt shutdown during restart
     */
    async recoverPendingRestarts() {
        try {
            const state = await this.getStateAsync('info.pendingRestarts');
            if (state && typeof state.val === 'string' && state.val.length > 2) {
                const pending = JSON.parse(state.val);
                if (Array.isArray(pending) && pending.length > 0) {
                    this.log.warn(
                        `[Recovery] Found ${pending.length} adapter(s) left in pending-restart state: ${pending.join(', ')}. Restoring...`,
                    );
                    for (const instId of pending) {
                        try {
                            await this.extendForeignObjectAsync(`system.adapter.${instId}`, { common: { enabled: true } });
                            this.log.info(`[Recovery] [${instId}] Re-enabled successfully.`);
                        } catch (e) {
                            this.log.error(`[Recovery] Failed to re-enable [${instId}]: ${e}`);
                        }
                    }
                    await this.setStateAsync('info.pendingRestarts', JSON.stringify([]), true);
                }
            }
        } catch (err) {
            this.log.error(`Error in recoverPendingRestarts: ${err}`);
        }
    }

    /**
     * Marks an instance as pending restart in persistent state
     * @param {string} instanceId
     */
    async addPendingRestart(instanceId) {
        try {
            const state = await this.getStateAsync('info.pendingRestarts');
            let list = [];
            if (state && typeof state.val === 'string' && state.val.length > 2) {
                try {
                    list = JSON.parse(state.val);
                } catch (e) {
                    list = [];
                }
            }
            if (!list.includes(instanceId)) {
                list.push(instanceId);
                await this.setStateAsync('info.pendingRestarts', JSON.stringify(list), true);
            }
        } catch (e) {
            // Ignore state write errors
        }
    }

    /**
     * Clears an instance from pending restart in persistent state
     * @param {string} instanceId
     */
    async removePendingRestart(instanceId) {
        try {
            const state = await this.getStateAsync('info.pendingRestarts');
            if (state && typeof state.val === 'string' && state.val.length > 2) {
                let list = JSON.parse(state.val);
                if (Array.isArray(list)) {
                    list = list.filter((id) => id !== instanceId);
                    await this.setStateAsync('info.pendingRestarts', JSON.stringify(list), true);
                }
            }
        } catch (e) {
            // Ignore state write errors
        }
    }

    /**
     * Preloads aliveCache with all current active adapters before subscribing
     */
    async preloadAliveCache() {
        try {
            const states = await this.getForeignStatesAsync('system.adapter.*.*.alive');
            if (!states) return;
            for (const [id, state] of Object.entries(states)) {
                const instanceId = id.replace('system.adapter.', '').replace('.alive', '');
                this.aliveCache.set(instanceId, Boolean(state && state.val));
            }
            this.log.debug(`Preloaded aliveCache for ${this.aliveCache.size} adapter instances.`);
        } catch (e) {
            this.log.debug(`preloadAliveCache error: ${e}`);
        }
    }

    /**
     * Restores state from persistent datapoints after a watchdog restart
     */
    async restorePersistedState() {
        try {
            // Restore restart history
            const histState = await this.getStateAsync('info.restartHistory');
            if (histState && typeof histState.val === 'string' && histState.val.length > 2) {
                try {
                    const parsed = JSON.parse(histState.val);
                    if (Array.isArray(parsed)) {
                        this.restartHistory = parsed.slice(0, 20);
                        this.log.debug(`Restored ${this.restartHistory.length} entries into restart history.`);
                    }
                } catch (pe) {
                    // Ignore parse error
                }
            }

            // Restore per-adapter daily restart counters and lastRestart
            const states = await this.getStatesAsync('adapters.*');
            if (states) {
                for (const [id, state] of Object.entries(states)) {
                    if (!state || state.val === null) continue;
                    const match = id.match(/adapters\.(.+?)\.(restartsToday|lastRestart)/);
                    if (match) {
                        const inst = match[1];
                        const field = match[2];
                        let entry = this.adapterData.get(inst);
                        if (!entry) {
                            entry = {
                                startRss: 0,
                                startedAt: Date.now(),
                                lastRestart: 0,
                                highCycles: 0,
                                floodCycles: 0,
                                restartsToday: 0,
                                currentMem: 0,
                            };
                            this.adapterData.set(inst, entry);
                        }
                        if (field === 'restartsToday') {
                            entry.restartsToday = Number(state.val) || 0;
                        }
                    }
                }
            }
        } catch (err) {
            this.log.debug(`State restoration notice: ${err}`);
        }
    }

    /**
     * Calculates system available memory in MB (using /proc/meminfo MemAvailable on Linux when available)
     * @returns {number}
     */
    getSystemFreeMemMB() {
        try {
            if (process.platform === 'linux' && fs.existsSync('/proc/meminfo')) {
                const content = fs.readFileSync('/proc/meminfo', 'utf8');
                const match = content.match(/MemAvailable:\s+(\d+)\s+kB/);
                if (match && match[1]) {
                    return Math.round(parseInt(match[1], 10) / 1024);
                }
            }
        } catch (e) {
            // fallback to os.freemem
        }
        return Math.round(os.freemem() / (1024 * 1024));
    }

    /**
     * Setup recurring midnight timer for resetting daily restart counts
     */
    setupMidnightTimer() {
        const now = new Date();
        const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
        const msUntilMidnight = tomorrow.getTime() - now.getTime();

        this.midnightTimer = this.setTimeout(() => {
            this.resetDailyBudgets().catch((err) => this.log.error(`Reset daily budget error: ${err}`));
            this.setupMidnightTimer();
        }, msUntilMidnight);
    }

    /**
     * Resets daily restart counter for all adapters
     */
    async resetDailyBudgets() {
        this.log.info('Resetting daily restart budgets for all monitored adapters.');
        for (const [instanceId, data] of this.adapterData.entries()) {
            data.restartsToday = 0;
            await this.setStateAsync(`adapters.${instanceId}.restartsToday`, 0, true);
        }
        await this.setStateAsync('info.totalRestartsToday', 0, true);
        await this.updateStatsDatapoint();
    }

    /**
     * Resolves effective limits (custom rule override or global configuration)
     * @param {string} instanceId
     */
    getLimits(instanceId) {
        const custom = this.getCustomRule(instanceId);
        const effectiveFactor = custom && custom.customFactor > 0 ? custom.customFactor : this.config.memoryFactor || 2.5;
        const effectiveMaxMB = custom && custom.customMaxMB > 0 ? custom.customMaxMB : this.config.absoluteMaxMB || 450;
        return {
            custom,
            effectiveFactor,
            effectiveMaxMB,
            effFactor: effectiveFactor,
            effMaxMB: effectiveMaxMB,
        };
    }

    /**
     * Scans all currently running adapters in the system
     */
    async scanActiveAdapters() {
        try {
            const states = await this.getForeignStatesAsync('system.adapter.*.*.alive');
            if (!states) return;

            let count = 0;
            for (const [id, state] of Object.entries(states)) {
                const instanceId = id.replace('system.adapter.', '').replace('.alive', '');
                const isAlive = Boolean(state && state.val);
                this.aliveCache.set(instanceId, isAlive);

                if (!isAlive) continue;

                // Do not monitor ourselves or javascript engine directly
                if (instanceId.startsWith(this.namespace) || instanceId.startsWith('javascript.')) continue;

                // Check custom blacklist
                const { custom } = this.getLimits(instanceId);
                if (custom && custom.active === false) {
                    this.log.debug(`[${instanceId}] is blacklisted in custom rules. Skipping.`);
                    continue;
                }

                count++;
                await this.initAdapterStates(instanceId);

                // Fetch current memRss if available
                const memState = await this.getForeignStateAsync(`system.adapter.${instanceId}.memRss`);
                if (memState && memState.val && typeof memState.val === 'number' && memState.val > 0) {
                    const mem = Math.round(memState.val);
                    let data = this.adapterData.get(instanceId);

                    // Check adapter uptime to verify if baseline is fresh or provisional
                    let isProvisional = false;
                    try {
                        const uptimeState = await this.getForeignStateAsync(`system.adapter.${instanceId}.uptime`);
                        if (uptimeState && typeof uptimeState.val === 'number' && uptimeState.val > 1800) {
                            isProvisional = true;
                        }
                    } catch (ue) {
                        // Ignore uptime fetch error
                    }

                    if (!data || data.startRss === 0) {
                        data = {
                            startRss: mem,
                            startedAt: Date.now(),
                            lastRestart: 0,
                            highCycles: 0,
                            floodCycles: 0,
                            restartsToday: data ? data.restartsToday : 0,
                            currentMem: mem,
                            lastOutputTs: Date.now(),
                            baselineProvisional: isProvisional,
                            customConfig: custom,
                        };
                        this.adapterData.set(instanceId, data);
                        await this.setStateAsync(`adapters.${instanceId}.baselineMB`, mem, true);
                        await this.setStateAsync(`adapters.${instanceId}.currentMB`, mem, true);
                        await this.setStateAsync(`adapters.${instanceId}.ratio`, 1.0, true);
                        await this.setStateAsync(`adapters.${instanceId}.status`, 'ok', true);

                        if (isProvisional) {
                            this.log.info(
                                `[${instanceId}] Initialized provisional baseline: ${mem} MB (Adapter already running >30m; factor checks deferred until next cold start).`,
                            );
                        } else {
                            this.log.info(`[${instanceId}] Initialized fresh baseline memory: ${mem} MB`);
                        }
                    }
                }
            }

            await this.setStateAsync('info.monitoredAdapters', count, true);
            await this.updateStatsDatapoint();
        } catch (err) {
            this.log.error(`Error scanning active adapters: ${err}`);
        }
    }

    /**
     * Creates state channel and datapoints for a monitored adapter
     * @param {string} instanceId
     */
    async initAdapterStates(instanceId) {
        const channelId = `adapters.${instanceId}`;
        await this.setObjectNotExistsAsync(channelId, {
            type: 'channel',
            common: {
                name: `Monitoring for ${instanceId}`,
            },
            native: {},
        });

        const stateDefs = [
            { id: 'baselineMB', name: 'Baseline Startup Memory', type: 'number', unit: 'MB', role: 'value', def: 0 },
            { id: 'currentMB', name: 'Current Memory', type: 'number', unit: 'MB', role: 'value', def: 0 },
            { id: 'ratio', name: 'Current Memory Ratio to Baseline', type: 'number', role: 'value', def: 1.0 },
            { id: 'highCycles', name: 'Consecutive High Cycles Count', type: 'number', role: 'value', def: 0 },
            { id: 'restartsToday', name: 'Restarts Triggered Today', type: 'number', role: 'value', def: 0 },
            { id: 'status', name: 'Status', type: 'string', role: 'text', def: 'ok' },
            { id: 'lastRestart', name: 'Timestamp of Last Restart', type: 'string', role: 'text', def: '' },
        ];

        for (const s of stateDefs) {
            await this.setObjectNotExistsAsync(`${channelId}.${s.id}`, {
                type: 'state',
                common: {
                    name: s.name,
                    type: s.type,
                    unit: s.unit,
                    role: s.role,
                    read: true,
                    write: false,
                    def: s.def,
                },
                native: {},
            });
        }
    }

    /**
     * Finds custom rule configuration for a specific instance
     * @param {string} instanceId
     */
    getCustomRule(instanceId) {
        if (!this.config.customRules || !Array.isArray(this.config.customRules)) return null;
        return this.config.customRules.find(
            (r) => r.adapter === instanceId || r.adapter === instanceId.split('.')[0],
        );
    }

    /**
     * Checks if current time is within configured quiet hours
     * @returns {boolean}
     */
    isQuietHour() {
        if (!this.config.quietHoursEnabled) return false;
        const start = this.config.quietHoursStart || '22:00';
        const end = this.config.quietHoursEnd || '07:00';

        const parseTime = (str) => {
            const parts = str.split(':').map(Number);
            return (parts[0] || 0) * 60 + (parts[1] || 0);
        };

        const now = new Date();
        const currentMin = now.getHours() * 60 + now.getMinutes();
        const startMin = parseTime(start);
        const endMin = parseTime(end);

        if (startMin <= endMin) {
            return currentMin >= startMin && currentMin < endMin;
        } else {
            // Over midnight (e.g. 22:00 -> 07:00)
            return currentMin >= startMin || currentMin < endMin;
        }
    }

    /**
     * Inspects database file sizes and ioBroker log file growth
     */
    async checkStorageHealth() {
        try {
            const dataDir = utils.getAbsoluteDefaultDataDir();

            // Check objects.jsonl
            const objPath = path.join(dataDir, 'objects.jsonl');
            try {
                const objStat = await fs.promises.stat(objPath);
                const objMB = Math.round(objStat.size / (1024 * 1024));
                await this.setStateAsync('info.objectsDbSizeMB', objMB, true);
                if (this.config.dbMonitoringEnabled && objMB >= (this.config.dbSizeWarnThresholdMB || 100)) {
                    this.log.warn(
                        `[DB Health] objects.jsonl is large (${objMB} MB >= ${this.config.dbSizeWarnThresholdMB || 100} MB). Consider running "iob compress" if growth continues.`,
                    );
                }
            } catch (e) {
                // Ignore missing file if running on Redis
            }

            // Check states.jsonl
            const stPath = path.join(dataDir, 'states.jsonl');
            try {
                const stStat = await fs.promises.stat(stPath);
                const stMB = Math.round(stStat.size / (1024 * 1024));
                await this.setStateAsync('info.statesDbSizeMB', stMB, true);
            } catch (e) {
                // Ignore missing file if running on Redis
            }

            // Check log file
            const logDir = path.join(dataDir, '../log');
            let logFile = path.join(logDir, 'iobroker.current.log');
            if (!fs.existsSync(logFile)) {
                const today = new Date().toISOString().slice(0, 10);
                logFile = path.join(logDir, `iobroker.${today}.log`);
            }

            if (fs.existsSync(logFile)) {
                const logStat = await fs.promises.stat(logFile);
                const logSizeMB = Math.round(logStat.size / (1024 * 1024));
                await this.setStateAsync('info.logFileSizeMB', logSizeMB, true);

                if (this.prevLogSizeMB > 0) {
                    const growthMB = Math.max(0, logSizeMB - this.prevLogSizeMB);
                    await this.setStateAsync('info.logGrowthMB', growthMB, true);

                    if (this.config.logMonitoringEnabled && growthMB >= (this.config.logGrowthWarnMB || 25)) {
                        const warnLog = `[Log-Spam Alert] Log file grew by +${growthMB} MB in check interval (Current size: ${logSizeMB} MB). Check for error loops or spamming adapters!`;
                        this.log.warn(warnLog);
                        await this.sendNotification(`⚠️ ${warnLog}`);
                    }
                }
                this.prevLogSizeMB = logSizeMB;
            }
        } catch (err) {
            this.log.debug(`Storage health check note: ${err}`);
        }
    }

    /**
     * Checks for orphaned processes (PPID 1) such as abandoned go2rtc or ffmpeg instances.
     * Thoroughly sanitizes passwords, tokens, secrets and RTSP URLs.
     * @returns {Promise<{ count: number, processes: any[] }>}
     */
    async checkOrphanProcesses() {
        return new Promise((resolve) => {
            if (!this.config.orphanDetectionEnabled || process.platform !== 'linux') {
                return resolve({ count: 0, processes: [] });
            }

            execFile('ps', ['-eo', 'pid,ppid,comm,args', '--no-headers'], { timeout: 10000 }, (err, stdout) => {
                if (err || !stdout) return resolve({ count: 0, processes: [] });

                const orphans = [];
                const lines = stdout.split('\n');
                const targetBinaries = ['go2rtc', 'ffmpeg', 'python', 'node'];

                for (const line of lines) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length < 4) continue;
                    const pid = parseInt(parts[0], 10);
                    const ppid = parseInt(parts[1], 10);
                    const comm = parts[2];
                    const rawArgs = parts.slice(3).join(' ');

                    // Check if it is a target binary orphaned to init/systemd (PPID 1 or 0)
                    if ((ppid === 1 || ppid === 0) && targetBinaries.some((b) => comm.includes(b))) {
                        // Exclude legitimate root services and js-controller itself
                        if (
                            rawArgs.includes('iobroker.js-controller') ||
                            rawArgs.includes('systemd') ||
                            rawArgs.includes('containerd')
                        ) {
                            continue;
                        }

                        // Sanitize URLs and parameters containing credentials
                        const sanitizedArgs = rawArgs
                            .replace(/\/\/[^@/]+@/g, '//***@')
                            .replace(/(pass(word)?|token|secret|key)[=\s]+[^\s&]+/gi, '$1=***')
                            .slice(0, 100);

                        orphans.push({ pid, ppid, comm, args: sanitizedArgs });
                    }
                }

                resolve({ count: orphans.length, processes: orphans });
            });
        });
    }

    /**
     * Updates the comprehensive JSON statistics state for Dashboards (VIS, Grafana, Home Assistant)
     */
    async updateStatsDatapoint() {
        try {
            const stats = [];
            const requiredCycles = this.config.requiredHighCycles || 2;
            const maxDaily = this.config.maxRestartsPerDay || 4;

            for (const [instanceId, data] of this.adapterData.entries()) {
                const { effFactor, effMaxMB } = this.getLimits(instanceId);
                const ratio = data.startRss ? parseFloat((data.currentMem / data.startRss).toFixed(2)) : 1.0;

                let status = 'ok';
                if (data.silentFreeze) {
                    status = 'silent_freeze';
                } else if (data.restartsToday >= maxDaily) {
                    status = 'limit_reached';
                } else if (data.highCycles >= requiredCycles) {
                    status = 'critical';
                } else if (data.highCycles > 0) {
                    status = 'warning';
                }

                stats.push({
                    instance: instanceId,
                    baselineMB: data.startRss,
                    currentMB: data.currentMem,
                    ratio: ratio,
                    limitMB: effMaxMB,
                    factorLimitMB: Math.round(data.startRss * effFactor),
                    eventsPerSec: data.eventsPerSec || 0,
                    highCycles: data.highCycles || 0,
                    restartsToday: data.restartsToday || 0,
                    status: status,
                    lastRestart: data.lastRestart ? new Date(data.lastRestart).toLocaleTimeString() : '-',
                });
            }

            // Sort descending by current memory
            stats.sort((a, b) => b.currentMB - a.currentMB);

            await this.setStateAsync('info.adapterStats', JSON.stringify(stats), true);
        } catch (err) {
            this.log.error(`Error updating info.adapterStats: ${err}`);
        }
    }

    /**
     * Validates whether an adapter can safely be restarted right now
     * @param {string} instanceId
     * @param {any} data
     * @param {boolean} [isEmergency=false]
     * @returns {boolean}
     */
    canRestart(instanceId, data, isEmergency = false) {
        if (this.restarting.has(instanceId)) {
            return false;
        }

        const cooldownMs = (this.config.restartCooldownMin || 60) * 60 * 1000;
        const maxDaily = this.config.maxRestartsPerDay || 4;

        if (isEmergency) {
            // Enforce at least 30 minutes cooldown between emergency restarts on the same adapter
            const emergencyCooldownMs = Math.max(cooldownMs, 30 * 60 * 1000);
            if (Date.now() - (data.lastRestart || 0) < emergencyCooldownMs) {
                return false;
            }
            return true;
        }

        if (Date.now() - (data.lastRestart || 0) < cooldownMs) {
            return false;
        }

        if ((data.restartsToday || 0) >= maxDaily) {
            return false;
        }

        return true;
    }

    /**
     * Executes memory evaluation across all monitored adapters
     */
    async checkMemory() {
        if (!this.config.enabled) return;

        try {
            this.log.debug('Executing periodic memory check...');
            const now = Date.now();
            this.lastCheckTimestamp = now;

            // 1. Update system free memory state using MemAvailable
            const freeMemMB = this.getSystemFreeMemMB();
            await this.setStateAsync('info.systemFreeMemMB', freeMemMB, true);

            // 2. Storage health check (database sizes & log growth)
            await this.checkStorageHealth();

            // 3. Orphaned processes scan
            const orphanResult = await this.checkOrphanProcesses();
            await this.setStateAsync('info.orphanedCount', orphanResult.count, true);
            await this.setStateAsync('info.orphanedProcesses', JSON.stringify(orphanResult.processes), true);
            if (orphanResult.count > 0) {
                this.log.warn(
                    `[Process Health] Detected ${orphanResult.count} potentially orphaned process(es): ${JSON.stringify(orphanResult.processes)}`,
                );
            }

            // Read live alive states for active verification
            const aliveStates = await this.getForeignStatesAsync('system.adapter.*.*.alive');
            if (!aliveStates) return;

            // 4. Emergency Free-RAM protection check
            // Surgical approach: Identify the single absolute largest active memory consumer.
            if (this.config.emergencyFreeRamEnabled && freeMemMB < (this.config.emergencyFreeRamMinMB || 150)) {
                this.log.warn(
                    `🚨 EMERGENCY: Available system RAM is dangerously low (${freeMemMB} MB < ${this.config.emergencyFreeRamMinMB || 150} MB)! Evaluating largest active memory consumer...`,
                );

                let topInstance = null;
                let topMemory = 0;

                for (const [instId, data] of this.adapterData.entries()) {
                    const isAlive = Boolean(aliveStates[`system.adapter.${instId}.alive`]?.val);
                    if (!isAlive) continue;

                    const { custom } = this.getLimits(instId);
                    if (custom && custom.active === false) continue;

                    if (data.currentMem > topMemory) {
                        topMemory = data.currentMem;
                        topInstance = instId;
                    }
                }

                // Enforce global emergency cooldown (max 1 emergency restart per 30 minutes across entire system)
                const globalEmergencyCooldownMs = 30 * 60 * 1000;
                const canEmergencyGlobal = now - this.lastEmergencyRestartTs >= globalEmergencyCooldownMs;

                if (topInstance && topMemory > 100) {
                    const topData = this.adapterData.get(topInstance);
                    if (canEmergencyGlobal && this.canRestart(topInstance, topData, true)) {
                        this.lastEmergencyRestartTs = now;
                        const emergencyReason = `System Free-RAM Emergency: Available RAM at ${freeMemMB} MB (< ${this.config.emergencyFreeRamMinMB || 150} MB). Restarted largest active adapter [${topInstance}] (${topMemory} MB) to prevent OS crash.`;
                        this.log.error(emergencyReason);
                        await this.restartAdapter(topInstance, emergencyReason, topData, true);
                    } else {
                        this.log.warn(
                            `[RAM Emergency] Available RAM is critically low (${freeMemMB} MB), but largest consumer [${topInstance}] (${topMemory} MB) is on restart cooldown. No secondary adapters will be affected.`,
                        );
                    }
                }
            }

            const minCheckAgeMs = (this.config.minCheckAgeMin || 10) * 60 * 1000;
            const cooldownMs = (this.config.restartCooldownMin || 60) * 60 * 1000;
            const requiredCycles = this.config.requiredHighCycles || 2;
            const maxDaily = this.config.maxRestartsPerDay || 4;
            const floodSuspects = [];

            // Calculate rate divisor based on controller statisticsInterval (default 15s)
            const statsSec = Math.max(1, (this.statisticsInterval || 15000) / 1000);
            const defaultFloodThreshold = this.config.floodThresholdEventsPerSec || 250;

            for (const [id, aliveState] of Object.entries(aliveStates)) {
                const instanceId = id.replace('system.adapter.', '').replace('.alive', '');
                const isAlive = Boolean(aliveState && aliveState.val);
                this.aliveCache.set(instanceId, isAlive);

                if (!isAlive) continue;
                if (instanceId.startsWith(this.namespace) || instanceId.startsWith('javascript.')) continue;

                const { custom, effectiveFactor, effectiveMaxMB } = this.getLimits(instanceId);
                if (custom && custom.active === false) continue;

                // --- State-Flooding & Event-Rate Measurement ---
                const outCountState = await this.getForeignStateAsync(`system.adapter.${instanceId}.outputCount`);
                let data = this.adapterData.get(instanceId);

                if (outCountState && typeof outCountState.val === 'number' && data) {
                    const ratePerSec = Math.round(outCountState.val / statsSec);
                    data.eventsPerSec = ratePerSec;

                    if (outCountState.val > 1) {
                        data.lastOutputTs = now;
                    }

                    const effFloodThreshold =
                        custom && custom.customFloodThreshold > 0 ? custom.customFloodThreshold : defaultFloodThreshold;

                    if (this.config.floodDetectionEnabled && ratePerSec >= effFloodThreshold) {
                        data.floodCycles = (data.floodCycles || 0) + 1;
                        if (data.floodCycles >= 2) {
                            floodSuspects.push({
                                instance: instanceId,
                                eventsPerSec: ratePerSec,
                                threshold: effFloodThreshold,
                            });
                            const floodMsg = `[State-Flood Alert] [${instanceId}] is emitting ${ratePerSec} events/sec for ${data.floodCycles} consecutive cycles (threshold: ${effFloodThreshold})`;
                            this.log.warn(floodMsg);

                            if (this.config.floodAction === 'restart' && this.canRestart(instanceId, data, false)) {
                                await this.restartAdapter(
                                    instanceId,
                                    `Sustained state-flood protection triggered (${ratePerSec} events/sec)`,
                                    data,
                                );
                            }
                        }
                    } else if (data) {
                        data.floodCycles = 0;
                    }
                }

                // --- Silent Freeze (Scheintot) Detection ---
                if (this.config.silentDetectionEnabled && data) {
                    const maxSilenceMs = (this.config.maxSilenceHours || 3) * 3600 * 1000;
                    if (data.lastOutputTs && now - data.lastOutputTs > maxSilenceMs) {
                        data.silentFreeze = true;
                        this.log.warn(
                            `[Silent Freeze] [${instanceId}] has emitted 0 events for over ${Math.round((now - data.lastOutputTs) / 3600000)} hours despite being alive=true.`,
                        );
                    } else {
                        data.silentFreeze = false;
                    }
                }

                // --- Memory Evaluation ---
                const memState = await this.getForeignStateAsync(`system.adapter.${instanceId}.memRss`);
                if (!memState || typeof memState.val !== 'number' || memState.val <= 0) continue;

                const currentMem = Math.round(memState.val);

                if (!data) {
                    data = {
                        startRss: currentMem,
                        startedAt: Date.now(),
                        lastRestart: 0,
                        highCycles: 0,
                        floodCycles: 0,
                        restartsToday: 0,
                        currentMem: currentMem,
                        lastOutputTs: now,
                        customConfig: custom,
                    };
                    this.adapterData.set(instanceId, data);
                    await this.initAdapterStates(instanceId);
                    await this.setStateAsync(`adapters.${instanceId}.baselineMB`, currentMem, true);
                    continue;
                }

                data.currentMem = currentMem;
                const ratio = parseFloat((currentMem / (data.startRss || 1)).toFixed(2));
                await this.setStateAsync(`adapters.${instanceId}.currentMB`, currentMem, true);
                await this.setStateAsync(`adapters.${instanceId}.ratio`, ratio, true);

                // Skip check if adapter is still in startup grace period
                if (Date.now() - data.startedAt < minCheckAgeMs) continue;

                const minRestartMB = this.config.minRestartMB || 250;
                let isExceeded = false;
                let triggerReason = '';

                if (currentMem >= effectiveMaxMB) {
                    isExceeded = true;
                    triggerReason = `Absolute limit exceeded (${currentMem} MB >= ${effectiveMaxMB} MB)`;
                } else if (
                    !data.baselineProvisional &&
                    currentMem >= minRestartMB &&
                    currentMem >= Math.round(data.startRss * effectiveFactor)
                ) {
                    isExceeded = true;
                    triggerReason = `Factor ${ratio}x reached (Baseline: ${data.startRss} MB -> Current: ${currentMem} MB >= ${Math.round(data.startRss * effectiveFactor)} MB)`;
                }

                if (isExceeded) {
                    data.highCycles = (data.highCycles || 0) + 1;
                    await this.setStateAsync(`adapters.${instanceId}.highCycles`, data.highCycles, true);
                    await this.setStateAsync(`adapters.${instanceId}.status`, 'warning_high', true);

                    this.log.info(
                        `[${instanceId}] Memory elevated: ${currentMem} MB (Cycle ${data.highCycles}/${requiredCycles}) - ${triggerReason}`,
                    );
                } else {
                    if (data.highCycles > 0) {
                        this.log.debug(`[${instanceId}] Memory normalized (${currentMem} MB). Reset high cycle counter.`);
                        data.highCycles = 0;
                        await this.setStateAsync(`adapters.${instanceId}.highCycles`, 0, true);
                        await this.setStateAsync(`adapters.${instanceId}.status`, 'ok', true);
                    }
                }

                // Trigger restart only when sustained for required cycles
                if (data.highCycles >= requiredCycles) {
                    if (Date.now() - data.lastRestart < cooldownMs) {
                        this.log.debug(
                            `[${instanceId}] Restart on cooldown (${Math.round((cooldownMs - (Date.now() - data.lastRestart)) / 60000)}m remaining).`,
                        );
                        continue;
                    }

                    if (data.restartsToday >= maxDaily) {
                        await this.setStateAsync(`adapters.${instanceId}.status`, 'limit_reached', true);
                        const warnMsg = `[${instanceId}] Daily limit of ${maxDaily} restarts reached! Pausing automatic restarts today to prevent API locks.`;
                        this.log.warn(warnMsg);

                        if (this.config.notifyOnLimitReached) {
                            await this.sendNotification(warnMsg);
                        }
                        continue;
                    }

                    // Execute restart safely
                    if (this.canRestart(instanceId, data, false)) {
                        await this.restartAdapter(instanceId, triggerReason, data);
                    }
                }
            }

            // Update flood suspects state
            await this.setStateAsync('info.floodSuspects', JSON.stringify(floodSuspects), true);

            // Overall system stability calculation (Safe for Backups)
            let isSystemStable = true;
            let stableReason = `System healthy (${freeMemMB} MB available RAM, ${this.adapterData.size} adapters monitored)`;

            if (freeMemMB < (this.config.emergencyFreeRamMinMB || 150)) {
                isSystemStable = false;
                stableReason = `Critically low available RAM (${freeMemMB} MB < ${this.config.emergencyFreeRamMinMB || 150} MB)`;
            } else if (floodSuspects.length > 0) {
                isSystemStable = false;
                stableReason = `Active sustained state-flood detected (${floodSuspects.map((s) => `${s.instance}: ${s.eventsPerSec}/s`).join(', ')})`;
            } else if (orphanResult.count > 0) {
                stableReason += ` - Note: ${orphanResult.count} orphaned sub-process(es) present`;
            }

            await this.setStateAsync('info.systemStable', isSystemStable, true);
            await this.setStateAsync('info.systemStableReason', stableReason, true);

            await this.updateStatsDatapoint();
        } catch (err) {
            this.log.error(`Error during memory check execution: ${err}`);
        }
    }

    /**
     * Executes clean restart of a single adapter instance with state verification and persistent recovery tracking
     * @param {string} instanceId
     * @param {string} reason
     * @param {any} data
     * @param {boolean} [isEmergency=false]
     * @returns {Promise<boolean>}
     */
    async restartAdapter(instanceId, reason, data, isEmergency = false) {
        // Synchronously acquire restart lock to prevent any race condition
        if (this.restarting.has(instanceId)) {
            return false;
        }
        this.restarting.add(instanceId);

        const adapterObjId = `system.adapter.${instanceId}`;

        // Verify that adapter is currently enabled in ioBroker configuration before touching it!
        try {
            const obj = await this.getForeignObjectAsync(adapterObjId);
            if (!obj || !obj.common || obj.common.enabled === false) {
                this.log.warn(
                    `[${instanceId}] Skipping restart because adapter is currently DISABLED in system configuration.`,
                );
                this.restarting.delete(instanceId);
                return false;
            }
        } catch (e) {
            this.log.error(`Could not verify object status for [${instanceId}]: ${e}`);
            this.restarting.delete(instanceId);
            return false;
        }

        data.lastRestart = Date.now();
        data.restartsToday = (data.restartsToday || 0) + 1;
        data.highCycles = 0;
        data.floodCycles = 0;

        const restartCountToday = data.restartsToday;
        const maxDaily = this.config.maxRestartsPerDay || 4;
        const logMsg = `Memory Watchdog: [${instanceId}] Sustained high memory -> Triggering restart (${restartCountToday}/${maxDaily} today). Reason: ${reason}`;
        this.log.warn(logMsg);

        const timeStr = new Date().toLocaleTimeString();
        await this.setStateAsync(`adapters.${instanceId}.highCycles`, 0, true);
        await this.setStateAsync(`adapters.${instanceId}.restartsToday`, restartCountToday, true);
        await this.setStateAsync(`adapters.${instanceId}.lastRestart`, timeStr, true);
        await this.setStateAsync(`adapters.${instanceId}.status`, 'restarting', true);

        await this.setStateAsync('info.lastAction', `Restarted ${instanceId} (${reason})`, true);
        await this.setStateAsync('info.lastActionTime', new Date().toISOString(), true);
        await this.setStateAsync('info.lastRestarted', `${instanceId} (${timeStr} - ${reason})`, true);

        // Record history entry
        this.restartHistory.unshift({
            timestamp: new Date().toISOString(),
            time: timeStr,
            adapter: instanceId,
            baselineMB: data.startRss,
            memoryMB: data.currentMem,
            reason: reason,
            restartsToday: restartCountToday,
        });
        if (this.restartHistory.length > 20) {
            this.restartHistory = this.restartHistory.slice(0, 20);
        }
        await this.setStateAsync('info.restartHistory', JSON.stringify(this.restartHistory), true);

        // Update total restarts today
        const totalState = await this.getStateAsync('info.totalRestartsToday');
        const total = (totalState && typeof totalState.val === 'number' ? totalState.val : 0) + 1;
        await this.setStateAsync('info.totalRestartsToday', total, true);

        // Notify user if enabled
        if (this.config.notifyOnRestart || isEmergency) {
            await this.sendNotification(`Memory Watchdog restarted [${instanceId}]: ${reason}`, isEmergency);
        }

        // 1. Record pending restart into persistent storage to protect against host crash while adapter is disabled
        await this.addPendingRestart(instanceId);

        const pauseMs = Math.max(2, this.config.restartPauseSec || 4) * 1000;
        const verifySec = this.config.restartVerificationSec || 45;

        try {
            await this.extendForeignObjectAsync(adapterObjId, { common: { enabled: false } });

            this.setTimeout(async () => {
                try {
                    await this.extendForeignObjectAsync(adapterObjId, { common: { enabled: true } });
                    // Remove from persistent pending restarts as it is safely re-enabled
                    await this.removePendingRestart(instanceId);

                    this.log.info(`[${instanceId}] Cleanly restarted.`);
                    await this.updateStatsDatapoint();

                    // Verification check: ensure process actually comes back alive
                    if (this.verificationTimers.has(instanceId)) {
                        this.clearTimeout(this.verificationTimers.get(instanceId));
                    }

                    const vTimer = this.setTimeout(async () => {
                        try {
                            this.verificationTimers.delete(instanceId);
                            const aliveState = await this.getForeignStateAsync(`system.adapter.${instanceId}.alive`);
                            if (!aliveState || !aliveState.val) {
                                const errMsg = `Restart verification FAILED for [${instanceId}]: Adapter is still offline after ${verifySec}s!`;
                                this.log.error(errMsg);
                                await this.setStateAsync(`adapters.${instanceId}.status`, 'failed_restart', true);
                                await this.sendNotification(`⚠️ ${errMsg}`, true);
                            } else {
                                await this.setStateAsync(`adapters.${instanceId}.status`, 'ok', true);
                                this.log.debug(`[${instanceId}] Restart verified successfully. Adapter is alive.`);
                            }
                        } catch (ve) {
                            this.log.error(`Error during restart verification: ${ve}`);
                        }
                    }, verifySec * 1000);

                    this.verificationTimers.set(instanceId, vTimer);
                } catch (reEnableErr) {
                    this.log.error(`Failed to re-enable [${instanceId}]: ${reEnableErr}`);
                    await this.setStateAsync(`adapters.${instanceId}.status`, 'error', true);
                } finally {
                    this.restarting.delete(instanceId);
                }
            }, pauseMs);

            return true;
        } catch (disableErr) {
            this.log.error(`Failed to disable [${instanceId}] for restart: ${disableErr}`);
            await this.removePendingRestart(instanceId);
            await this.setStateAsync(`adapters.${instanceId}.status`, 'error', true);
            this.restarting.delete(instanceId);
            return false;
        }
    }

    /**
     * Send notification via configured notification service or custom state
     * @param {string} message
     * @param {boolean} [isEmergency=false]
     */
    async sendNotification(message, isEmergency = false) {
        try {
            if (this.config.notifyCustomState) {
                await this.setForeignStateAsync(this.config.notifyCustomState, message);
            }

            if (!this.config.notifyService || this.config.notifyService === 'none') return;
            const instance = this.config.notifyInstance;
            if (!instance) return;

            // Check quiet hours (emergencies always bypass quiet hours)
            if (this.config.quietHoursEnabled && !isEmergency && this.isQuietHour()) {
                this.log.info(
                    `[Quiet Hours] Notification muted (${this.config.quietHoursStart} - ${this.config.quietHoursEnd}): ${message}`,
                );
                return;
            }

            const priority = isEmergency ? 1 : 0;
            switch (this.config.notifyService) {
                case 'pushover':
                    this.sendTo(instance, 'send', {
                        message: message,
                        title: isEmergency ? '🚨 ioBroker Emergency Memory Watchdog' : 'ioBroker Memory Watchdog',
                        priority: priority,
                    });
                    break;
                case 'telegram': {
                    const escapedMsg = escapeTelegramMarkdown(message);
                    this.sendTo(instance, 'send', {
                        text: `${isEmergency ? '🚨 *EMERGENCY* ' : ''}*ioBroker Memory Watchdog*\n${escapedMsg}`,
                        parse_mode: 'Markdown',
                    });
                    break;
                }
                case 'email':
                    this.sendTo(instance, 'send', {
                        text: message,
                        subject: isEmergency ? '🚨 ioBroker Emergency Memory Alert' : 'ioBroker Memory Watchdog Alert',
                    });
                    break;
            }
        } catch (err) {
            this.log.error(`Error sending notification: ${err}`);
        }
    }

    /**
     * Is called if a subscribed state changes.
     * Evaluates alive transitions (false/null -> true) to trigger baseline learning.
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state) {
        if (id.endsWith('.alive')) {
            const instanceId = id.replace('system.adapter.', '').replace('.alive', '');
            if (instanceId.startsWith(this.namespace) || instanceId.startsWith('javascript.')) return;

            const isAlive = Boolean(state && state.val);
            const prevAlive = this.aliveCache.get(instanceId);
            this.aliveCache.set(instanceId, isAlive);

            // Only trigger baseline learning on genuine cold-starts (offline/false/null -> online/true)
            if (isAlive && prevAlive !== true) {
                const delayMs = Math.max(1, this.config.baselineDelayMin || 5) * 60 * 1000;

                if (this.learningTimers.has(instanceId)) {
                    this.clearTimeout(this.learningTimers.get(instanceId));
                }

                const timer = this.setTimeout(async () => {
                    try {
                        this.learningTimers.delete(instanceId);
                        const memState = await this.getForeignStateAsync(`system.adapter.${instanceId}.memRss`);
                        if (memState && typeof memState.val === 'number' && memState.val > 0) {
                            const mem = Math.round(memState.val);
                            let data = this.adapterData.get(instanceId);
                            if (!data) {
                                data = {
                                    startRss: mem,
                                    startedAt: Date.now(),
                                    lastRestart: 0,
                                    highCycles: 0,
                                    floodCycles: 0,
                                    restartsToday: 0,
                                    currentMem: mem,
                                    lastOutputTs: Date.now(),
                                    baselineProvisional: false,
                                };
                                this.adapterData.set(instanceId, data);
                            } else {
                                data.startRss = mem;
                                data.startedAt = Date.now();
                                data.highCycles = 0;
                                data.floodCycles = 0;
                                data.baselineProvisional = false;
                                data.lastOutputTs = Date.now();
                            }

                            await this.initAdapterStates(instanceId);
                            await this.setStateAsync(`adapters.${instanceId}.baselineMB`, mem, true);
                            await this.setStateAsync(`adapters.${instanceId}.currentMB`, mem, true);
                            await this.setStateAsync(`adapters.${instanceId}.ratio`, 1.0, true);
                            await this.setStateAsync(`adapters.${instanceId}.highCycles`, 0, true);
                            await this.setStateAsync(`adapters.${instanceId}.status`, 'ok', true);
                            this.log.info(`[${instanceId}] Learned fresh baseline memory after cold start: ${mem} MB`);
                            await this.updateStatsDatapoint();
                        }
                    } catch (learnErr) {
                        this.log.error(`Error learning baseline for [${instanceId}]: ${learnErr}`);
                    }
                }, delayMs);

                this.learningTimers.set(instanceId, timer);
            } else if (!isAlive) {
                // If adapter went offline, cancel any pending learning timer and update status
                if (this.learningTimers.has(instanceId)) {
                    this.clearTimeout(this.learningTimers.get(instanceId));
                    this.learningTimers.delete(instanceId);
                }
                const data = this.adapterData.get(instanceId);
                if (data) {
                    data.silentFreeze = false;
                }
            }
        }
    }

    /**
     * Handles message box calls from scripts, admin UI, or external adapters.
     * @param {ioBroker.Message} obj
     */
    async onMessage(obj) {
        if (!obj || typeof obj !== 'object') return;

        if (!obj.message) {
            if (obj.callback) this.sendTo(obj.from, obj.command, { error: 'Empty message' }, obj.callback);
            return;
        }

        try {
            if (obj.command === 'getStats') {
                const stats = {};
                for (const [key, val] of this.adapterData.entries()) {
                    stats[key] = {
                        baselineMB: val.startRss,
                        currentMB: val.currentMem,
                        ratio: val.startRss ? parseFloat((val.currentMem / val.startRss).toFixed(2)) : 1.0,
                        eventsPerSec: val.eventsPerSec || 0,
                        restartsToday: val.restartsToday,
                        highCycles: val.highCycles,
                    };
                }
                if (obj.callback) this.sendTo(obj.from, obj.command, stats, obj.callback);
            } else if (obj.command === 'restartInstance') {
                const target = obj.message.instance;
                if (target && this.adapterData.has(target)) {
                    const data = this.adapterData.get(target);
                    if (!this.canRestart(target, data, false)) {
                        if (obj.callback) {
                            this.sendTo(
                                obj.from,
                                obj.command,
                                { success: false, error: 'Restart on cooldown or daily budget reached' },
                                obj.callback,
                            );
                        }
                        return;
                    }

                    const ok = await this.restartAdapter(target, 'Manual trigger via message', data);
                    if (obj.callback) this.sendTo(obj.from, obj.command, { success: ok }, obj.callback);
                } else {
                    if (obj.callback) {
                        this.sendTo(obj.from, obj.command, { success: false, error: 'Instance not found' }, obj.callback);
                    }
                }
            }
        } catch (err) {
            this.log.error(`Error processing message command [${obj.command}]: ${err}`);
            if (obj.callback) this.sendTo(obj.from, obj.command, { error: String(err) }, obj.callback);
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            if (this.checkTimer) this.clearInterval(this.checkTimer);
            if (this.midnightTimer) this.clearTimeout(this.midnightTimer);
            for (const timer of this.learningTimers.values()) {
                this.clearTimeout(timer);
            }
            this.learningTimers.clear();
            for (const timer of this.verificationTimers.values()) {
                this.clearTimeout(timer);
            }
            this.verificationTimers.clear();
            this.restarting.clear();
            this.setState('info.connection', false, true);
            this.log.info('Cleaned up everything. Memory Watchdog stopped.');
            callback();
        } catch (e) {
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options) => new MemoryWatchdog(options);
} else {
    // otherwise start the instance directly
    new MemoryWatchdog();
}
