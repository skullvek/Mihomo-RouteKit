'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {SCRIPTS, execute} = require('./helpers');
const {cases} = require('./repair-cases');

function assertOutput(item, out) {
  const groups = out['proxy-groups'];
  for (const [name, expected] of Object.entries(item.dialers || {})) {
    assert.equal(out.proxies.find(p => p.name === name)['dialer-proxy'], expected, name + ' dialer');
  }
  for (const [name, refs] of Object.entries(item.rawMembers || {})) {
    assert.deepEqual(groups.find(g => g.name === name).proxies, refs, 'excluded references must still be retained');
  }
  if (item.regions) assert.deepEqual(groups.filter(g => /聚合$|^其他地区$/.test(g.name)).map(g => g.name), item.regions);
  if (item.providerProxy) assert.equal(out['proxy-providers'].p.proxy, item.providerProxy);
  if (item.providerDialer) assert.equal(out['proxy-providers'].p.override['dialer-proxy'], item.providerDialer);
  if (item.brokenNodeCycle) assert.ok(out.proxies.some(p => p['dialer-proxy'] === 'REJECT'));
  if (item.label.startsWith('malformed-use')) {
    const g = groups.find(g => g.name === 'g');
    assert.ok(!('use' in g) || Array.isArray(g.use), 'use must be core-loadable');
    if (!g['include-all-providers']) assert.deepEqual(g.proxies, ['REJECT']);
  }
  if (item.acyclicGroups) {
    const byName = new Map(groups.map(g => [g.name, g]));
    const visit = (name, path = new Set()) => {
      if (!byName.has(name)) return;
      assert.ok(!path.has(name), 'raw group cycle: ' + [...path, name].join(' -> '));
      for (const ref of byName.get(name).proxies || []) visit(ref, new Set([...path, name]));
    };
    for (const name of byName.keys()) visit(name);
  }
  if ('collisionEnabled' in item) {
    assert.equal(groups.some(g => g.name === 'ChatGPT'), item.collisionEnabled);
    assert.equal(out.proxies[0].name, item.collisionEnabled ? '__SKULL_NODE__ChatGPT' : 'ChatGPT');
    assert.equal(out.proxies[0]['dialer-proxy'], 'g');
    assert.ok(!groups.some(g => /聚合$|^其他地区$/.test(g.name)));
  }
}
for (const script of SCRIPTS) for (const item of cases) {
  if (item.bettboxOnly && script !== SCRIPTS[1]) continue;
  test(`${script}: audit regression / ${item.label}`, () => {
    const diagnostics = [];
    const out = execute(script, item.input, {...item.options, diagnostics});
    assertOutput(item, out);
    if (item.diagnostic) assert.ok(diagnostics.some(message => message.includes('[SKULL]') && message.includes(item.diagnostic)), 'normalization diagnostic');
  });
}
test('audit edge cases have identical group/provider/node behavior across clients', () => {
  for (const item of cases.filter(c => !c.bettboxOnly)) {
    const outputs = SCRIPTS.map(script => execute(script, item.input));
    for (const out of outputs.slice(1)) for (const field of ['proxies', 'proxy-providers', 'proxy-groups']) {
      assert.deepEqual(out[field], outputs[0][field], item.label + ': ' + field);
    }
  }
});
