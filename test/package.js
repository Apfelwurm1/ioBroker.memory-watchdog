'use strict';

const path = require('path');
const { tests } = require('@iobroker/testing');

// Validate the package files (package.json, io-package.json, etc.)
tests.packageFiles(path.join(__dirname, '..'));
