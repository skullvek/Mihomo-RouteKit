'use strict';
// Shared, fully synthetic inputs for comparison against real QuickJS execution.
const {SCRIPTS, fixture, execute} = require('./helpers');
const cases = [];
for (const script of SCRIPTS) for (const item of require('./repair-cases').cases) {
  if (!item.bettboxOnly || script === SCRIPTS[1]) cases.push({script, label: 'audit-' + item.label, input: item.input, options: item.options});
}
for (const script of SCRIPTS) {
  for (const name of ['direct-proxies', 'provider-only', 'mixed-provider', 'naming-conflict', 'dialer-loop']) {
    cases.push({script, label: name, input: fixture(name)});
  }
  for (const mode of ['blacklist', 'whitelist', 'rule']) {
    const input = fixture('direct-proxies');
    input.dns = {'fake-ip-filter-mode': mode, 'fake-ip-filter': ['+.airport.example']};
    cases.push({script, label: 'dns-' + mode, input});
  }
  cases.push({script, label: 'information-notices', input: {proxies: [
    '客服邮箱：support@example.com', '⚠️节点不通请更新订阅',
    '💬 TG交流群 | @example', '📣 TG频道 | @example',
    '🇹🇷 土耳其 | 三网优化', '香港 TG 专线 01'
  ].map(name => ({name, type: 'ss'}))}});
  cases.push({script, label: 'empty', input: {}});
  cases.push({script, label: 'pure-group-cycle-without-node-dialer', input: {
    proxies: [{name: '日本01', type: 'ss'}], listeners: [{name: 'synthetic', proxy: 'g'}],
    'proxy-groups': [{name: 'g', type: 'select', proxies: ['h', 'DIRECT']}, {name: 'h', type: 'select', proxies: ['g', 'DIRECT']}]
  }});
  for (const filter of ['(?i)^HK', '^HK$']) {
    cases.push({script, label: 'cache-name-dependent-' + filter, input: {
      'proxy-providers': {p: {type: 'inline', filter, payload: ['HK', 'hk', '香港', 'HK\n', 'HK\r', 'HK\u2028', 'x'].map(name => ({name, type: 'ss', 'dialer-proxy': 'DIRECT'}))}}
    }});
  }
}
const services = ['ChatGPT', 'Claude', 'Gemini / NotebookLM', 'Google', 'GitHub', 'Microsoft', 'Apple', 'Telegram', 'X', 'YouTube', '流媒体', 'WhatsApp', '游戏平台', '地区分组'];
for (const name of services) {
  cases.push({script: SCRIPTS[1], label: 'disabled-' + name, input: fixture('provider-only'), options: {toggles: {[name]: false}}});
}
cases.push({script: SCRIPTS[1], label: 'all-disabled', input: fixture('mixed-provider'), options: {toggles: Object.fromEntries(services.map(name => [name, false]))}});
module.exports = {cases};
if (require.main === module) {
  for (const item of cases) item.expected = execute(item.script, item.input, item.options);
  process.stdout.write(JSON.stringify(cases));
}
