'use strict';

/*
 * Created with @iobroker/create-adapter v2.6.0
 */

const os = require('os');
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

        /** @type {Map<string, { startRss: number, startedAt: number, lastRestart: number, highCycles: number, restartsToday: number, currentMem: number, customConfig?: any }>} */
        this.adapterData = new Map();

        /** @type {Array<{ timestamp: string, time: string, adapter: string, baselineMB: number, memoryMB: number, reason: string, restartsToday: number }>} */
        this.restartHistory = [];

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

        // Periodic memory check
        const intervalMs = Math.max(1, this.config.checkIntervalMin || 15) * 60 * 1000;
        this.checkTimer = this.setInterval(() => {
            this.checkMemory();
        }, intervalMs);

        // Record initial free memory
        const initialFree = Math.round(os.freemem() / (1024 * 1024));
        await this.setStateAsync('info.systemFreeMemMB', initialFree, true);

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
                if (data.restartsToday >= maxDaily) {
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

        // Update system free memory state
        const freeMemMB = Math.round(os.freemem() / (1024 * 1024));
        await this.setStateAsync('info.systemFreeMemMB', freeMemMB, true);

        // Emergency Free-RAM protection check
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

        for (const [id, aliveState] of Object.entries(aliveStates)) {
            if (!aliveState || !aliveState.val) continue;

            const instanceId = id.replace('system.adapter.', '').replace('.alive', '');
            if (instanceId.startsWith(this.namespace) || instanceId.startsWith('javascript.')) continue;

            const custom = this.getCustomRule(instanceId);
            if (custom && custom.active === false) continue;

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
                        };
                        this.adapterData.set(instanceId, data);
                    } else {
                        data.startRss = mem;
                        data.startedAt = Date.now();
                        data.highCycles = 0;
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
