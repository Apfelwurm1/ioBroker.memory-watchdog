'use strict';

const path = require('path');
const { expect } = require('chai');
const { tests } = require('@iobroker/testing');
const { sanitizeProcessArgs, escapeTelegramMarkdown, isFromToday } = require('../lib/helpers.js');

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

        it('should correctly mask RTSP stream credentials in URLs', () => {
            const input = 'ffmpeg -i rtsp://admin:secret123@192.168.1.50:554/ch0';
            expect(sanitizeProcessArgs(input)).to.equal('ffmpeg -i rtsp://***@192.168.1.50:554/ch0');
        });

        it('should correctly mask Bearer authorization tokens', () => {
            const input = 'curl -H "Authorization: Bearer my-secret-jwt-token" http://localhost';
            expect(sanitizeProcessArgs(input)).to.equal('curl -H "Authorization: Bearer *** http://localhost');
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
});

// Run legacy adapter mock startup tests
tests.unit(path.join(__dirname, '..'));
