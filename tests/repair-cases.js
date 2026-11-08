'use strict';
// Audit 2026-11-03 reproductions. Synthetic nodes only; shared by Node, QuickJS and core CI.
const regions = ['香港聚合', '澳门聚合', '台湾聚合', '新加坡聚合', '韩国聚合', '日本聚合', '美国聚合', '欧洲聚合', '其他地区'];
const node = (name, extra = {}) => ({name, type: 'ss', server: '192.0.2.1', port: 443,
  cipher: 'aes-128-gcm', password: 'synthetic-test', ...extra});
const dependency = (options = {}, name = 'x') => ({
  proxies: [node(name, {'dialer-proxy': 'g'})],
  'proxy-groups': [{name: 'g', type: 'select', proxies: [name, 'DIRECT'], ...options}]
});
const provider = options => ({'proxy-providers': {p: {type: 'inline', payload: [node('香港01')], ...options}}});
const cases = [
  {label: 'explicit-excluded', input: dependency({'exclude-filter': '^x$'}), dialers: {x: 'g'}, members: {g: ['DIRECT']}, rawMembers: {g: ['x', 'DIRECT']}},
  {label: 'explicit-type-excluded', input: dependency({'exclude-type': 'Shadowsocks'}), dialers: {x: 'g'}, members: {g: ['DIRECT']}, rawMembers: {g: ['x', 'DIRECT']}},
  {label: 'automatic-type-excluded', input: dependency({proxies: ['DIRECT'], 'include-all-proxies': true, 'exclude-type': 'Shadowsocks'}), dialers: {x: 'g'}, members: {g: ['DIRECT']}},
  {label: 'unicode-excluded', input: dependency({'exclude-filter': '\\w'}, '中文'), dialers: {'中文': 'g'}, members: {g: ['COMPATIBLE']}},
  {label: 'automatic-unicode-excluded', input: dependency({proxies: ['DIRECT'], 'include-all-proxies': true, 'exclude-filter': '\\w'}, '中文'), dialers: {'中文': 'g'}, members: {g: ['COMPATIBLE']}},
  // filter affects automatically included members, never the explicit proxies list.
  {label: 'explicit-filter-ignored', input: dependency({filter: '^never$'}), dialers: {x: 'REJECT'}, members: {g: ['x', 'DIRECT']}},
  {label: 'true-node-group-cycle', input: dependency(), dialers: {x: 'REJECT'}, members: {g: ['x', 'DIRECT']}},
  {label: 'default-is-preference', input: dependency({'exclude-filter': '^x$', 'default-selected': 'x'}), dialers: {x: 'g'}, members: {g: ['DIRECT']}},
  {label: 'prefix-filter', input: provider({filter: '^HK', override: {'additional-prefix': '日本-'}, payload: [node('HK01')]}), regions: ['香港聚合'], members: {'全球手动': ['日本-HK01'], '香港自动': ['日本-HK01']}},
  {label: 'raw-exclude-before-suffix', input: provider({'exclude-filter': 'DROP$', override: {'additional-suffix': '-DROP'}}), regions: ['香港聚合'], members: {'全球手动': ['香港01-DROP']}},
  {label: 'unicode-provider', input: provider({filter: '^\\p{L}+'}), regions, members: {'全球手动': ['香港01'], '香港自动': ['香港01']}},
  {label: 'provider-exclude-type', input: provider({'exclude-type': 'SS', payload: [node('香港-SS'), node('日本-HTTP', {type: 'http'})]}), regions: ['日本聚合'], members: {'全球手动': ['日本-HTTP'], '日本自动': ['日本-HTTP']}},
  {label: 'remote-fallback', input: provider({type: 'http', url: 'http://127.0.0.1:1/provider', path: './providers/p.json', proxy: 'DIRECT', payload: [node('香港备用')]}), regions},
  {label: 'file-fallback', input: provider({type: 'file', path: './providers/p.json', payload: [node('香港备用')]}), regions},
  {label: 'malformed-use-empty-providers', input: dependency({proxies: [], use: {p: true}, 'include-all-providers': true}), dialers: {x: 'g'}, members: {g: ['REJECT']}, rawMembers: {g: ['REJECT']}, diagnostic: 'use'},
  {label: 'malformed-use', input: {...dependency({proxies: [], use: {p: true}}), ...provider({})}, dialers: {x: 'g'}, members: {g: ['REJECT']}, diagnostic: 'use'},
  {label: 'malformed-use-include-all', input: {...dependency({proxies: [], use: {p: true}, 'include-all-providers': true}), ...provider({})}, dialers: {x: 'g'}, members: {g: ['香港01']}, diagnostic: 'use'},
  {label: 'pure-group-cycle', input: {proxies: [node('x', {'dialer-proxy': 'g'})], 'proxy-groups': [
    {name: 'g', type: 'select', proxies: ['h', 'DIRECT'], 'exclude-filter': '\\w'},
    {name: 'h', type: 'select', proxies: ['g', 'DIRECT']}
  ]}, acyclicGroups: true, dialers: {x: 'g'}},
  {label: 'node-node-cycle', input: {proxies: [node('x', {'dialer-proxy': 'y'}), node('y', {'dialer-proxy': 'x'})]}, brokenNodeCycle: true},
  {label: 'provider-dialer-cycle', input: {...provider({override: {'dialer-proxy': 'g'}}), 'proxy-groups': [{name: 'g', type: 'select', use: ['p']}]}, providerDialer: 'REJECT'}
];
cases.push({label: 'provider-type-vocabulary', input: provider({'exclude-type': 'Shadowsocks'}), regions: ['香港聚合'], members: {'全球手动': ['香港01']}});
cases.push({label: 'empty-rename-override', input: provider({override: {'proxy-name': [], 'override-expr': []}}), regions: ['香港聚合'], members: {'全球手动': ['香港01']}});
// Uncertain regexp2/JS semantics must never prove an inventory complete.
for (const filter of ['(?i:香港)', '[', '\\A香港', '^\\w+', '^\\d+', '^\\s+', '(?=香港)香港', '^.$', '(?i)香港']) {
  cases.push({label: 'uncertain-provider-' + cases.length, input: provider({filter}), regions, unitOnly: true});
}
cases.push({label: 'invalid-inline-inventory', input: provider({payload: [node('香港01'), {name: '日本01'}]}), regions, unitOnly: true});
cases.push({label: 'unpredictable-override', input: provider({override: {'proxy-name': [{pattern: '香港', target: '日本'}]}}), regions, unitOnly: true});
// Disabled services must not rename a now-valid original node, nor reintroduce a disabled group.
for (const enabled of [true, false]) cases.push({
  label: 'bettbox-collision-' + enabled, bettboxOnly: true,
  input: {proxies: [node('ChatGPT', {'dialer-proxy': 'g'})], 'proxy-groups': [{name: 'g', type: 'select', proxies: ['ChatGPT', 'DIRECT'], 'exclude-type': 'Shadowsocks'}]},
  options: {toggles: {ChatGPT: enabled, '地区分组': false}}, collisionEnabled: enabled
});
cases.push({label: 'excluded-provider-download', input: {'proxy-providers': {p: {type: 'http', url: 'http://127.0.0.1:1/provider', path: './providers/p.json', proxy: 'g', filter: '^JP', payload: [node('JP01')]}}, 'proxy-groups': [{name: 'g', type: 'select', proxies: ['DIRECT'], use: ['p'], 'exclude-filter': '^JP'}]}, providerProxy: 'g', regions, members: {g: ['DIRECT']}});
module.exports = {cases, regions, node};
