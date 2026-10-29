'use strict';

const path = require('path');
const { tests } = require('@iobroker/testing');

// Run integration tests - see https://github.com/ioBroker/testing
// Exit code 11 is ADAPTER_REQUESTED_TERMINATION, which js-controller issues when terminating
// the adapter cleanly after the automated startup integration verification succeeds.
tests.integration(path.join(__dirname, '..'), {
    allowedExitCodes: [11],
});
