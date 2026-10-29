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
 * Robustly sanitizes sensitive parameters, tokens, and RTSP passwords in command line arguments
 * @param {string} rawArgs
 * @returns {string}
 */
function sanitizeProcessArgs(rawArgs) {
    if (!rawArgs || typeof rawArgs !== 'string') return '';
    return rawArgs
        .replace(/\/\/[^@/]+@/g, '//***@')
        .replace(/Bearer\s+\S+/gi, 'Bearer ***')
        .replace(
            /\b([A-Z0-9_]*?(?:pass(?:word|wd)?|pwd|token|secret|api[-_]?key|auth))\b(["']?\s*[:=]\s*|\s+)("[^"]*"|'[^']*'|[^\s&,]+)/gi,
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

module.exports = {
    escapeTelegramMarkdown,
    sanitizeProcessArgs,
    isFromToday,
};
