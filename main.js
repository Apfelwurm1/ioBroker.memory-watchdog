'use strict';

/*
 * Created with @iobroker/create-adapter v2.6.0
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const utils = require('@iobroker/adapter-core');

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

        /** @type {Map<string, { startRss: number, startedAt: number, lastRestart: number, highCycles: number, restartsToday: number, currentMem: number, prevOutputCount?: number, lastOutputTs?: number, eventsPerSec?: number, silentFreeze?: boolean, customConfig?: any }>} */
        this.adapterData = new Map();

        /** @type {Array<{ timestamp: string, time: string, adapter: string, baselineMB: number, memoryMB: number, reason: string, restartsToday: number }>} */
        this.restartHistory = [];

        /** @type {number} */
        this.lastCheckTimestamp = Date.now();

        /** @type {number} */
        this.prevLogSizeMB = 0;

        /** @type {NodeJS.Timeout | null} */
        this.checkTimer = null;

        /** @type {NodeJS.Timeout | null} */
        this.midnightTimer = null;

        /** @type {Map<string, NodeJS.Timeout>} */
        this.learningTimers = new Map();

        /** @type {Map<string, NodeJS.Timeout>} */
        this.verificationTimers = new Map();
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

        // Initialize scheduled midnight reset for daily restart budgets
        this.setupMidnightTimer();

        // Subscribe only to adapter alive states (not memRss, to avoid processing hundreds of events per minute)
        this.subscribeForeignStates('system.adapter.*.*.alive');

        // Initial scan of active adapters after 30 seconds
        this.setTimeout(() => {
            this.scanActiveAdapters();
        }, 30000);

        // Periodic memory & system health check
        const intervalMs = Math.max(1, this.config.checkIntervalMin || 15) * 60 * 1000;
        this.checkTimer = this.setInterval(() => {
            this.checkMemory();
        }, intervalMs);

        // Record initial free memory & storage metrics
        const initialFree = Math.round(os.freemem() / (1024 * 1024));
        await this.setStateAsync('info.systemFreeMemMB', initialFree, true);
        await this.checkStorageHealth();

        this.log.info(
            `Memory Watchdog initialized. Interval: ${this.config.checkIntervalMin}m, Factor: ${this.config.memoryFactor}x, Max: ${this.config.absoluteMaxMB}MB, Cycles: ${this.config.requiredHighCycles}, Daily budget: ${this.config.maxRestartsPerDay}`,
        );
    }

    /**
     * Setup recurring midnight timer for resetting daily restart counts
     */
    setupMidnightTimer() {
        const now = new Date();
        const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
        const msUntilMidnight = tomorrow.getTime() - now.getTime();

        this.midnightTimer = this.setTimeout(() => {
            this.resetDailyBudgets();
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
     * Scans all currently running adapters in the system
     */
    async scanActiveAdapters() {
        try {
            const states = await this.getForeignStatesAsync('system.adapter.*.*.alive');
            if (!states) return;

            let count = 0;
            for (const [id, state] of Object.entries(states)) {
                if (!state || !state.val) continue;

                const instanceId = id.replace('system.adapter.', '').replace('.alive', '');
                // Do not monitor ourselves or javascript engine directly
                if (instanceId.startsWith(this.namespace) || instanceId.startsWith('javascript.')) continue;

                // Check custom blacklist
                const custom = this.getCustomRule(instanceId);
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
                    if (!this.adapterData.has(instanceId)) {
                        this.adapterData.set(instanceId, {
                            startRss: mem,
                            startedAt: Date.now(),
                            lastRestart: 0,
                            highCycles: 0,
                            restartsToday: 0,
                            currentMem: mem,
                            lastOutputTs: Date.now(),
                            customConfig: custom,
                        });
                        await this.setStateAsync(`adapters.${instanceId}.baselineMB`, mem, true);
                        await this.setStateAsync(`adapters.${instanceId}.currentMB`, mem, true);
                        await this.setStateAsync(`adapters.${instanceId}.ratio`, 1.0, true);
                        await this.setStateAsync(`adapters.${instanceId}.status`, 'ok', true);
                        this.log.info(`[${instanceId}] Learned initial baseline memory: ${mem} MB`);
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

        await this.setObjectNotExistsAsync(`${channelId}.baselineMB`, {
            type: 'state',
            common: {
                name: 'Baseline Startup Memory',
                type: 'number',
                unit: 'MB',
                role: 'value',
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${channelId}.currentMB`, {
            type: 'state',
            common: {
                name: 'Current Memory',
                type: 'number',
                unit: 'MB',
                role: 'value',
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${channelId}.ratio`, {
            type: 'state',
            common: {
                name: 'Current Memory Ratio to Baseline',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
                def: 1.0,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${channelId}.highCycles`, {
            type: 'state',
            common: {
                name: 'Consecutive High Cycles Count',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${channelId}.restartsToday`, {
            type: 'state',
            common: {
                name: 'Restarts Triggered Today',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${channelId}.status`, {
            type: 'state',
            common: {
                name: 'Status',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
                def: 'ok',
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${channelId}.lastRestart`, {
            type: 'state',
            common: {
                name: 'Timestamp of Last Restart',
                type: 'string',
                role: 'date',
                read: true,
                write: false,
                def: '',
            },
            native: {},
        });
    }

    /**
     * Finds custom rule configuration for a specific instance
     * @param {string} instanceId
     */
    getCustomRule(instanceId) {
        if (!this.config.customRules || !Array.isArray(this.config.customRules)) return null;
        return this.config.customRules.find(r => r.adapter === instanceId || r.adapter === instanceId.split('.')[0]);
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
                    this.log.warn(`[DB Health] objects.jsonl is large (${objMB} MB >= ${this.config.dbSizeWarnThresholdMB || 100} MB). Consider running "iob compress" if growth continues.`);
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
                // Fallback to today's date
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
     * Checks for orphaned processes (PPID 1) such as abandoned go2rtc or ffmpeg instances
     * @returns {Promise<{ count: number, processes: any[] }>}
     */
    async checkOrphanProcesses() {
        return new Promise((resolve) => {
            if (!this.config.orphanDetectionEnabled || process.platform !== 'linux') {
                return resolve({ count: 0, processes: [] });
            }

            exec('ps -eo pid,ppid,comm,args --no-headers', (err, stdout) => {
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
                    const args = parts.slice(3).join(' ');

                    // Check if it is a target binary orphaned to init/systemd (PPID 1 or 0)
                    if ((ppid === 1 || ppid === 0) && targetBinaries.some(b => comm.includes(b))) {
                        // Exclude legitimate root services and js-controller itself
                        if (args.includes('iobroker.js-controller') || args.includes('systemd') || args.includes('containerd')) {
                            continue;
                        }
                        orphans.push({ pid, ppid, comm, args: args.slice(0, 120) });
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
                const custom = this.getCustomRule(instanceId);
                const effFactor = (custom && custom.customFactor > 0) ? custom.customFactor : (this.config.memoryFactor || 2.5);
                const effMaxMB = (custom && custom.customMaxMB > 0) ? custom.customMaxMB : (this.config.absoluteMaxMB || 450);
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
     * Executes memory evaluation across all monitored adapters
     */
    async checkMemory() {
        if (!this.config.enabled) return;

        this.log.debug('Executing periodic memory check...');
        const now = Date.now();
        const deltaSeconds = Math.max(1, Math.round((now - this.lastCheckTimestamp) / 1000));
        this.lastCheckTimestamp = now;

        // 1. Update system free memory state
        const freeMemMB = Math.round(os.freemem() / (1024 * 1024));
        await this.setStateAsync('info.systemFreeMemMB', freeMemMB, true);

        // 2. Storage health check (database sizes & log growth)
        await this.checkStorageHealth();

        // 3. Orphaned processes scan
        const orphanResult = await this.checkOrphanProcesses();
        await this.setStateAsync('info.orphanedCount', orphanResult.count, true);
        await this.setStateAsync('info.orphanedProcesses', JSON.stringify(orphanResult.processes), true);
        if (orphanResult.count > 0) {
            this.log.warn(`[Process Health] Detected ${orphanResult.count} potentially orphaned process(es): ${JSON.stringify(orphanResult.processes)}`);
        }

        // 4. Emergency Free-RAM protection check
        if (this.config.emergencyFreeRamEnabled && freeMemMB < (this.config.emergencyFreeRamMinMB || 150)) {
            this.log.warn(`🚨 EMERGENCY: Free system RAM is dangerously low (${freeMemMB} MB < ${this.config.emergencyFreeRamMinMB || 150} MB)! Evaluating highest memory consumer...`);

            let topInstance = null;
            let topMemory = 0;

            for (const [instId, data] of this.adapterData.entries()) {
                const custom = this.getCustomRule(instId);
                if (custom && custom.active === false) continue;

                if (data.currentMem > topMemory) {
                    topMemory = data.currentMem;
                    topInstance = instId;
                }
            }

            if (topInstance && topMemory > 100) {
                const emergencyReason = `System Free-RAM Emergency: Host RAM at ${freeMemMB} MB (< ${this.config.emergencyFreeRamMinMB || 150} MB). Restarted largest adapter [${topInstance}] (${topMemory} MB) to prevent OS crash.`;
                this.log.error(emergencyReason);
                await this.restartAdapter(topInstance, emergencyReason, this.adapterData.get(topInstance), true);
            }
        }

        const aliveStates = await this.getForeignStatesAsync('system.adapter.*.*.alive');
        if (!aliveStates) return;

        const minCheckAgeMs = (this.config.minCheckAgeMin || 10) * 60 * 1000;
        const cooldownMs = (this.config.restartCooldownMin || 60) * 60 * 1000;
        const requiredCycles = this.config.requiredHighCycles || 2;
        const maxDaily = this.config.maxRestartsPerDay || 4;
        const floodSuspects = [];

        for (const [id, aliveState] of Object.entries(aliveStates)) {
            if (!aliveState || !aliveState.val) continue;

            const instanceId = id.replace('system.adapter.', '').replace('.alive', '');
            if (instanceId.startsWith(this.namespace) || instanceId.startsWith('javascript.')) continue;

            const custom = this.getCustomRule(instanceId);
            if (custom && custom.active === false) continue;

            // --- State-Flooding & Event-Rate Measurement ---
            const outCountState = await this.getForeignStateAsync(`system.adapter.${instanceId}.outputCount`);
            if (outCountState && typeof outCountState.val === 'number') {
                let data = this.adapterData.get(instanceId);
                if (data) {
                    if (data.prevOutputCount !== undefined) {
                        const countDelta = outCountState.val >= data.prevOutputCount ? (outCountState.val - data.prevOutputCount) : outCountState.val;
                        const ratePerSec = Math.round(countDelta / deltaSeconds);
                        data.eventsPerSec = ratePerSec;

                        if (countDelta > 0) {
                            data.lastOutputTs = now;
                        }

                        if (this.config.floodDetectionEnabled && ratePerSec >= (this.config.floodThresholdEventsPerSec || 50)) {
                            floodSuspects.push({ instance: instanceId, eventsPerSec: ratePerSec, threshold: this.config.floodThresholdEventsPerSec || 50 });
                            const floodMsg = `[State-Flood Alert] [${instanceId}] is emitting ${ratePerSec} events/sec (threshold: ${this.config.floodThresholdEventsPerSec || 50})`;
                            this.log.warn(floodMsg);

                            if (this.config.floodAction === 'restart') {
                                await this.restartAdapter(instanceId, `State-Flood protection triggered (${ratePerSec} events/sec)`, data);
                            }
                        }
                    }
                    data.prevOutputCount = outCountState.val;
                }
            }

            // --- Silent Freeze (Scheintot) Detection ---
            if (this.config.silentDetectionEnabled) {
                const maxSilenceMs = (this.config.maxSilenceHours || 3) * 3600 * 1000;
                const data = this.adapterData.get(instanceId);
                if (data && data.lastOutputTs && (now - data.lastOutputTs > maxSilenceMs)) {
                    data.silentFreeze = true;
                    this.log.warn(`[Silent Freeze] [${instanceId}] has emitted 0 events for over ${(now - data.lastOutputTs) / 3600000} hours despite being alive=true.`);
                } else if (data) {
                    data.silentFreeze = false;
                }
            }

            // --- Memory Evaluation ---
            const memState = await this.getForeignStateAsync(`system.adapter.${instanceId}.memRss`);
            if (!memState || typeof memState.val !== 'number' || memState.val <= 0) continue;

            const currentMem = Math.round(memState.val);
            let data = this.adapterData.get(instanceId);

            if (!data) {
                data = {
                    startRss: currentMem,
                    startedAt: Date.now(),
                    lastRestart: 0,
                    highCycles: 0,
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

            // Evaluate limits (custom overrides take precedence over global settings)
            const effectiveFactor = (custom && custom.customFactor > 0) ? custom.customFactor : (this.config.memoryFactor || 2.5);
            const effectiveMaxMB = (custom && custom.customMaxMB > 0) ? custom.customMaxMB : (this.config.absoluteMaxMB || 450);
            const minRestartMB = this.config.minRestartMB || 250;

            let isExceeded = false;
            let triggerReason = '';

            if (currentMem >= effectiveMaxMB) {
                isExceeded = true;
                triggerReason = `Absolute limit exceeded (${currentMem} MB >= ${effectiveMaxMB} MB)`;
            } else if (currentMem >= minRestartMB && currentMem >= Math.round(data.startRss * effectiveFactor)) {
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
                    this.log.debug(`[${instanceId}] Restart on cooldown (${Math.round((cooldownMs - (Date.now() - data.lastRestart)) / 60000)}m remaining).`);
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

                // Execute restart
                await this.restartAdapter(instanceId, triggerReason, data);
            }
        }

        // Update flood suspects state
        await this.setStateAsync('info.floodSuspects', JSON.stringify(floodSuspects), true);

        // Overall system stability calculation (Safe for Backups)
        let isSystemStable = true;
        let stableReason = `System healthy (${freeMemMB} MB free RAM, ${this.adapterData.size} adapters monitored)`;

        if (freeMemMB < (this.config.emergencyFreeRamMinMB || 150)) {
            isSystemStable = false;
            stableReason = `Critically low free RAM (${freeMemMB} MB < ${this.config.emergencyFreeRamMinMB || 150} MB)`;
        } else if (floodSuspects.length > 0) {
            isSystemStable = false;
            stableReason = `Active state-flood detected (${floodSuspects.map(s => `${s.instance}: ${s.eventsPerSec}/s`).join(', ')})`;
        } else if (orphanResult.count > 0) {
            stableReason += ` - Note: ${orphanResult.count} orphaned sub-process(es) present`;
        }

        await this.setStateAsync('info.systemStable', isSystemStable, true);
        await this.setStateAsync('info.systemStableReason', stableReason, true);

        await this.updateStatsDatapoint();
    }

    /**
     * Executes clean restart of a single adapter instance
     * @param {string} instanceId
     * @param {string} reason
     * @param {any} data
     * @param {boolean} [isEmergency=false]
     */
    async restartAdapter(instanceId, reason, data, isEmergency = false) {
        data.lastRestart = Date.now();
        data.restartsToday = (data.restartsToday || 0) + 1;
        data.highCycles = 0;

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

        // Perform clean disable -> wait -> enable
        const pauseMs = (this.config.restartPauseSec || 4) * 1000;
        const verifySec = this.config.restartVerificationSec || 45;
        const adapterObjId = `system.adapter.${instanceId}`;

        try {
            await this.extendForeignObjectAsync(adapterObjId, { common: { enabled: false } });
            this.setTimeout(async () => {
                await this.extendForeignObjectAsync(adapterObjId, { common: { enabled: true } });
                this.log.info(`[${instanceId}] Cleanly restarted.`);
                await this.setStateAsync(`adapters.${instanceId}.status`, 'ok', true);
                await this.updateStatsDatapoint();

                // Verification check: ensure process actually comes back alive
                if (this.verificationTimers.has(instanceId)) {
                    this.clearTimeout(this.verificationTimers.get(instanceId));
                }

                const vTimer = this.setTimeout(async () => {
                    this.verificationTimers.delete(instanceId);
                    const aliveState = await this.getForeignStateAsync(`system.adapter.${instanceId}.alive`);
                    if (!aliveState || !aliveState.val) {
                        const errMsg = `Restart verification FAILED for [${instanceId}]: Adapter is still offline after ${verifySec}s!`;
                        this.log.error(errMsg);
                        await this.setStateAsync(`adapters.${instanceId}.status`, 'failed_restart', true);
                        await this.sendNotification(`⚠️ ${errMsg}`, true);
                    } else {
                        this.log.debug(`[${instanceId}] Restart verified successfully. Adapter is alive.`);
                    }
                }, verifySec * 1000);

                this.verificationTimers.set(instanceId, vTimer);
            }, pauseMs);
        } catch (err) {
            this.log.error(`Failed to restart [${instanceId}]: ${err}`);
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
                this.log.info(`[Quiet Hours] Notification muted (${this.config.quietHoursStart} - ${this.config.quietHoursEnd}): ${message}`);
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
                case 'telegram':
                    this.sendTo(instance, 'send', {
                        text: `${isEmergency ? '🚨 *EMERGENCY* ' : ''}*ioBroker Memory Watchdog*\n${message}`,
                        parse_mode: 'Markdown',
                    });
                    break;
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
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state) {
        if (!state) return;

        // When an adapter comes back alive, schedule learning delay for new baseline
        if (id.endsWith('.alive') && state.val === true && state.ack) {
            const instanceId = id.replace('system.adapter.', '').replace('.alive', '');
            if (instanceId.startsWith(this.namespace) || instanceId.startsWith('javascript.')) return;

            const delayMs = Math.max(1, this.config.baselineDelayMin || 5) * 60 * 1000;

            if (this.learningTimers.has(instanceId)) {
                this.clearTimeout(this.learningTimers.get(instanceId));
            }

            const timer = this.setTimeout(async () => {
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
                            restartsToday: 0,
                            currentMem: mem,
                            lastOutputTs: Date.now(),
                        };
                        this.adapterData.set(instanceId, data);
                    } else {
                        data.startRss = mem;
                        data.startedAt = Date.now();
                        data.highCycles = 0;
                        data.lastOutputTs = Date.now();
                    }

                    await this.initAdapterStates(instanceId);
                    await this.setStateAsync(`adapters.${instanceId}.baselineMB`, mem, true);
                    await this.setStateAsync(`adapters.${instanceId}.currentMB`, mem, true);
                    await this.setStateAsync(`adapters.${instanceId}.ratio`, 1.0, true);
                    await this.setStateAsync(`adapters.${instanceId}.highCycles`, 0, true);
                    await this.setStateAsync(`adapters.${instanceId}.status`, 'ok', true);
                    this.log.info(`[${instanceId}] Learned fresh baseline memory after start: ${mem} MB`);
                    await this.updateStatsDatapoint();
                }
            }, delayMs);

            this.learningTimers.set(instanceId, timer);
        }
    }

    /**
     * Some message was sent to this instance over message box. Used by frontends/scripts.
     * @param {ioBroker.Message} obj
     */
    async onMessage(obj) {
        if (typeof obj === 'object' && obj.message) {
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
                    await this.restartAdapter(target, 'Manual trigger via message', this.adapterData.get(target));
                    if (obj.callback) this.sendTo(obj.from, obj.command, { success: true }, obj.callback);
                } else {
                    if (obj.callback) this.sendTo(obj.from, obj.command, { success: false, error: 'Instance not found' }, obj.callback);
                }
            }
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
