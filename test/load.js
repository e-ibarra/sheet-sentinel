'use strict';
// Apps Script concatenates all files into one global scope; reproduce that.
const engine = require('../src/Engine.js');
Object.assign(global, engine);
const rules = require('../src/RulesSheet.js');
Object.assign(global, rules);
const adapter = require('../src/Sentinel.js');
Object.assign(global, adapter);
module.exports = { ...engine, ...rules, ...adapter };
