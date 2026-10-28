'use strict';

const path = require('path');
const { tests } = require('@iobroker/testing');

// Run unit tests using the adapter mock
tests.unit(path.join(__dirname, '..'));
