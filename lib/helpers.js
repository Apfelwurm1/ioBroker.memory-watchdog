'use strict';

/**
 * Escapes characters for Telegram Markdown format
 * @param {string} text
 * @returns {string}
 */
function escapeTelegramMarkdown(text) {
    if (!text || typeof text !== 'string') return '';
    return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/**
 * Robustly sanitizes sensitive parameters, tokens, credentials and RTSP passwords in command line arguments
 * @param {string} rawArgs
 * @returns {string}
 */
function sanitizeProcessArgs(rawArgs) {
    if (!rawArgs || typeof rawArgs !== 'string') return '';
    return rawArgs
        .replace(/\/\/[^@/]+@/g, '//***@')
        .replace(/Bearer\s+[^\s"']+/gi, 'Bearer ***')
        .replace(
            /\b([A-Z0-9_]*?(?:pass(?:word|wd|phrase)?|pwd|token|secret|credentials?|api[-_]?key|auth))\b(["']?\s*[:=]\s*|\s+)("[^"]*"|'[^']*'|[^\s&,]+)/gi,
            '$1$2***',
        )
        .slice(0, 100);
}

/**
 * Checks if a timestamp belongs to today
 * @param {number} ts
 * @returns {boolean}
 */
function isFromToday(ts) {
    if (!ts) return false;
    const d = new Date(ts);
    const now = new Date();
    return d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
}

/**
 * Determines whether an adapter instance is actively running in compact mode
 * State val is primary authority; common.runAsCompactMode is fallback
 * @param {boolean | null | undefined} compactStateVal
 * @param {any} [instCommon]
 * @returns {boolean}
 */
function isCompactMode(compactStateVal, instCommon) {
    if (typeof compactStateVal === 'boolean') {
        return compactStateVal;
    }
    if (instCommon && typeof instCommon.runAsCompactMode === 'boolean') {
        return instCommon.runAsCompactMode;
    }
    return false;
}

/**
 * Resolves compact group ID, preserving 0 (controller process)
 * @param {any} [instCommon]
 * @returns {number}
 */
function getCompactGroup(instCommon) {
    if (!instCommon || instCommon.compactGroup === undefined || instCommon.compactGroup === null) {
        return 1;
    }
    const parsed = Number(instCommon.compactGroup);
    return isNaN(parsed) ? 1 : parsed;
}

/**
 * Evaluates whether emergency RAM low-memory warning should trigger under hysteresis
 * @param {number} now
 * @param {number} lastWarnTs
 * @param {number} lastWarnMB
 * @param {number} freeMemMB
 * @param {number} [warnCooldownMs=3600000]
 * @param {number} [dropDeltaMB=25]
 * @returns {boolean}
 */
function shouldTriggerEmergencyWarn(now, lastWarnTs, lastWarnMB, freeMemMB, warnCooldownMs = 3600000, dropDeltaMB = 25) {
    if (!lastWarnTs) return true;
    if (now - lastWarnTs >= warnCooldownMs) return true;
    if ((lastWarnMB - freeMemMB) >= dropDeltaMB) return true;
    return false;
}

/**
 * Checks if adapter uptime indicates a provisional baseline (>30m / 1800s)
 * @param {number | null | undefined} uptimeSec
 * @returns {boolean}
 */
function isProvisionalBaseline(uptimeSec) {
    return typeof uptimeSec === 'number' && uptimeSec > 1800;
}

/**
 * Determines whether emergency low-RAM warning hysteresis should reset
 * Requires a margin (recoveryDeltaMB) above the threshold to avoid flapping
 * @param {number} freeMemMB
 * @param {number} emergencyMinMB
 * @param {number} [recoveryDeltaMB=25]
 * @returns {boolean}
 */
function shouldResetEmergencyWarn(freeMemMB, emergencyMinMB, recoveryDeltaMB = 25) {
    return typeof freeMemMB === 'number' && freeMemMB >= (emergencyMinMB + recoveryDeltaMB);
}

/**
 * Determines whether compact high-memory warning hysteresis should reset
 * Requires memory to drop below (effectiveMaxMB - recoveryDeltaMB)
 * @param {number} currentMem
 * @param {number} effectiveMaxMB
 * @param {number} [recoveryDeltaMB=25]
 * @returns {boolean}
 */
function shouldResetCompactWarn(currentMem, effectiveMaxMB, recoveryDeltaMB = 25) {
    return typeof currentMem === 'number' && currentMem <= (effectiveMaxMB - recoveryDeltaMB);
}

module.exports = {
    escapeTelegramMarkdown,
    sanitizeProcessArgs,
    isFromToday,
    isCompactMode,
    getCompactGroup,
    shouldTriggerEmergencyWarn,
    shouldResetEmergencyWarn,
    shouldResetCompactWarn,
    isProvisionalBaseline,
};
