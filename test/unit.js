'use strict';

const { expect } = require('chai');
const {
    sanitizeProcessArgs,
    escapeTelegramMarkdown,
    isFromToday,
    isCompactMode,
    getCompactGroup,
    shouldTriggerEmergencyWarn,
    shouldResetEmergencyWarn,
    shouldResetCompactWarn,
    isProvisionalBaseline,
} = require('../lib/helpers.js');

describe('Helper unit tests', () => {
    describe('sanitizeProcessArgs', () => {
        it('should correctly mask standard password arguments without doubling word', () => {
            const input = 'go2rtc --password geheim';
            expect(sanitizeProcessArgs(input)).to.equal('go2rtc --password ***');
        });

        it('should correctly mask password=value syntax', () => {
            const input = 'node x.js --password=geheim';
            expect(sanitizeProcessArgs(input)).to.equal('node x.js --password=***');
        });

        it('should correctly mask JSON formatted credentials', () => {
            const input = 'x {"password":"geheim"}';
            expect(sanitizeProcessArgs(input)).to.equal('x {"password":***}');
        });

        it('should correctly mask apiKey and tokens', () => {
            const input = 'node srv --apiKey=abc12345';
            expect(sanitizeProcessArgs(input)).to.equal('node srv --apiKey=***');
        });

        it('should correctly mask passphrase and credentials flags', () => {
            expect(sanitizeProcessArgs('x --passphrase secret')).to.equal('x --passphrase ***');
            expect(sanitizeProcessArgs('x --credentials=secret')).to.equal('x --credentials=***');
        });

        it('should correctly mask RTSP stream credentials in URLs', () => {
            const input = 'ffmpeg -i rtsp://admin:secret123@192.168.1.50:554/ch0';
            expect(sanitizeProcessArgs(input)).to.equal('ffmpeg -i rtsp://***@192.168.1.50:554/ch0');
        });

        it('should correctly mask Bearer authorization tokens preserving quotes', () => {
            const input = 'curl ... "Authorization: Bearer my-secret-jwt-token" http';
            expect(sanitizeProcessArgs(input)).to.equal('curl ... "Authorization: Bearer ***" http');
        });

        it('should correctly mask environment variables with underscore like MQTT_PASS', () => {
            const input = 'python app.py MQTT_PASS=secret123';
            expect(sanitizeProcessArgs(input)).to.equal('python app.py MQTT_PASS=***');
        });
    });

    describe('escapeTelegramMarkdown', () => {
        it('should escape markdown special characters', () => {
            const input = 'restart_shelly.0 [warning] *alert*';
            expect(escapeTelegramMarkdown(input)).to.equal('restart\\_shelly\\.0 \\[warning\\] \\*alert\\*');
        });
    });

    describe('isFromToday', () => {
        it('should return true for current timestamp', () => {
            expect(isFromToday(Date.now())).to.be.true;
        });

        it('should return false for timestamp from 2 days ago', () => {
            const twoDaysAgo = Date.now() - 48 * 3600 * 1000;
            expect(isFromToday(twoDaysAgo)).to.be.false;
        });

        it('should return false for null or undefined', () => {
            expect(isFromToday(null)).to.be.false;
            expect(isFromToday(0)).to.be.false;
        });
    });

    describe('isCompactMode', () => {
        it('should treat compactMode state as primary authority when boolean', () => {
            expect(isCompactMode(true, { runAsCompactMode: false })).to.be.true;
            expect(isCompactMode(false, { runAsCompactMode: true })).to.be.false;
        });

        it('should fallback to common.runAsCompactMode when state is null/undefined', () => {
            expect(isCompactMode(null, { runAsCompactMode: true })).to.be.true;
            expect(isCompactMode(undefined, { runAsCompactMode: false })).to.be.false;
        });

        it('should return false when neither is set', () => {
            expect(isCompactMode(null, null)).to.be.false;
            expect(isCompactMode(undefined, {})).to.be.false;
        });
    });

    describe('getCompactGroup', () => {
        it('should preserve group 0 for controller process', () => {
            expect(getCompactGroup({ compactGroup: 0 })).to.equal(0);
        });

        it('should return defined group number', () => {
            expect(getCompactGroup({ compactGroup: 2 })).to.equal(2);
        });

        it('should default to 1 when undefined or null', () => {
            expect(getCompactGroup(null)).to.equal(1);
            expect(getCompactGroup({})).to.equal(1);
        });
    });

    describe('shouldTriggerEmergencyWarn (hysteresis)', () => {
        const now = 1000000;
        const oneHour = 3600000;

        it('should trigger on first alert when lastWarnTs is 0', () => {
            expect(shouldTriggerEmergencyWarn(now, 0, 0, 140)).to.be.true;
        });

        it('should suppress alert during cooldown if memory drop is insignificant', () => {
            expect(shouldTriggerEmergencyWarn(now + 60000, now, 140, 135)).to.be.false;
        });

        it('should trigger alert during cooldown if memory drops by >= 25MB', () => {
            expect(shouldTriggerEmergencyWarn(now + 60000, now, 140, 110)).to.be.true;
        });

        it('should trigger alert once cooldown expires', () => {
            expect(shouldTriggerEmergencyWarn(now + oneHour + 1000, now, 140, 140)).to.be.true;
        });
    });

    describe('isProvisionalBaseline', () => {
        it('should return true when uptime > 1800s (30m)', () => {
            expect(isProvisionalBaseline(1801)).to.be.true;
            expect(isProvisionalBaseline(7200)).to.be.true;
        });

        it('should return false on fresh cold start (<= 1800s or null)', () => {
            expect(isProvisionalBaseline(1800)).to.be.false;
            expect(isProvisionalBaseline(60)).to.be.false;
            expect(isProvisionalBaseline(null)).to.be.false;
            expect(isProvisionalBaseline(undefined)).to.be.false;
        });
    });

    describe('shouldResetEmergencyWarn (recovery hysteresis band)', () => {
        it('should return false when free RAM is still below or barely above threshold', () => {
            expect(shouldResetEmergencyWarn(145, 150, 25)).to.be.false;
            expect(shouldResetEmergencyWarn(155, 150, 25)).to.be.false;
            expect(shouldResetEmergencyWarn(174, 150, 25)).to.be.false;
        });

        it('should return true once free RAM crosses threshold + delta margin (150 + 25 = 175 MB)', () => {
            expect(shouldResetEmergencyWarn(175, 150, 25)).to.be.true;
            expect(shouldResetEmergencyWarn(250, 150, 25)).to.be.true;
        });
    });

    describe('shouldResetCompactWarn (recovery margin)', () => {
        it('should return false when memory is above or barely below limit', () => {
            expect(shouldResetCompactWarn(455, 450, 25)).to.be.false;
            expect(shouldResetCompactWarn(440, 450, 25)).to.be.false;
        });

        it('should return true once memory drops below limit - margin (450 - 25 = 425 MB)', () => {
            expect(shouldResetCompactWarn(425, 450, 25)).to.be.true;
            expect(shouldResetCompactWarn(300, 450, 25)).to.be.true;
        });
    });
});
