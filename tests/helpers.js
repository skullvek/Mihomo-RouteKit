'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = ['Clash-Verge-Rev-mihomoScript.js', 'Bettbox-mihomoScript.js', 'FlClash-mihomoScript.js'];
function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name + '.json'), 'utf8'));
}
function execute(file, input, options = {}) {
  const context = vm.createContext({
    input: JSON.parse(JSON.stringify(input)),
    console: {error(message) { if (options.diagnostics) options.diagnostics.push(String(message)); }},
    toggles: options.toggles || {}
  });
  if (options.noFromEntries) vm.runInContext('Object.fromEntries = undefined', context);
  new vm.Script(fs.readFileSync(path.join(ROOT, file), 'utf8'), {filename: file}).runInContext(context, {timeout: 5000});
  if (file.startsWith('Bettbox')) vm.runInContext('Object.assign(ruleOptionsEnable, toggles)', context);
  return JSON.parse(vm.runInContext('JSON.stringify(main(input))', context, {timeout: 5000}));
}
module.exports = {ROOT, SCRIPTS, fixture, execute};
