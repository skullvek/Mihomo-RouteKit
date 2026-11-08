'use strict';
// CI-only: full synthetic configuration checks plus isolated runtime membership checks.
// Never run against a user profile or a real subscription.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {SCRIPTS, execute, fixture} = require('./helpers');
const {cases, node} = require('./repair-cases');
const binary = path.resolve(process.argv[2] || '');
let artifacts;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const clone = value => JSON.parse(JSON.stringify(value));

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function request(url, options = {}) {
  const response = await fetch(url, {...options, signal: AbortSignal.timeout(2000)});
  assert.ok(response.ok, `${options.method || 'GET'} ${url}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function eventually(label, child, logs, action) {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) throw new Error(`${label}: core exited\n${logs()}`);
    try { return await action(); } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`${label}: ${lastError?.stack}\n${logs()}`);
}
async function stop(child, closed) {
  if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { await closed; } finally { clearTimeout(timer); }
}
async function runCheck(configPath, directory) {
  const child = spawn(binary, ['-t', '-d', directory, '-f', configPath], {stdio: ['ignore', 'pipe', 'pipe']});
  let log = '';
  child.stdout.on('data', data => { log += data; });
  child.stderr.on('data', data => { log += data; });
  const closed = once(child, 'close');
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
  try {
    const [code] = await closed;
    fs.writeFileSync(path.join(directory, 'check.log'), log);
    assert.equal(code, 0, `-t failed: ${configPath}\n${log}`);
    assert.match(log, /test is successful/i, `-t lacks success marker: ${configPath}\n${log}`);
  } finally {
    clearTimeout(timer);
    await stop(child, closed);
  }
}

// Keep all generated rules, rule provider names and DNS policy references for -t.
// Replace remote rules with tiny file-backed synthetic rule sets; no geodata downloads.
function fullConfig(output, directory, origin) {
  const out = clone(output);
  Object.assign(out, {port: 0, 'socks-port': 0, 'mixed-port': 0, 'redir-port': 0, 'tproxy-port': 0,
    'allow-lan': false, 'bind-address': '127.0.0.1', 'external-controller': '',
    'geo-auto-update': false, 'log-level': 'info', tun: {enable: false}, ntp: {enable: false}});
  delete out.listeners;
  delete out.tunnels;
  delete out['external-ui'];
  out.profile = {'store-selected': false, 'store-fake-ip': false};
  const domainFile = path.join(directory, 'domains.list');
  const ipFile = path.join(directory, 'ips.list');
  fs.writeFileSync(domainFile, '+.synthetic.example\n');
  fs.writeFileSync(ipFile, '192.0.2.0/24\n');
  for (const [name, provider] of Object.entries(out['rule-providers'] || {})) {
    out['rule-providers'][name] = {type: 'file', behavior: provider.behavior, format: 'text',
      path: provider.behavior === 'ipcidr' ? ipFile : domainFile};
    // Each provider needs an independent path (Mihomo rejects shared cache paths).
    const uniquePath = path.join(directory, name + '.list');
    fs.copyFileSync(out['rule-providers'][name].path, uniquePath);
    out['rule-providers'][name].path = uniquePath;
  }
  for (const [name, provider] of Object.entries(out['proxy-providers'] || {})) {
    provider['health-check'] = {enable: false, url: origin + '/health', interval: 0};
    if (provider.type !== 'inline') {
      provider.path = path.join(directory, name + '.json');
      if (provider.type === 'file') fs.writeFileSync(provider.path, JSON.stringify({proxies: [node('日本远端01'), node('美国远端01')]}));
    }
  }
  return out;
}
function assertSource(item, output) {
  for (const [name, expected] of Object.entries(item.dialers || {})) {
    assert.equal(output.proxies.find(p => p.name === name)['dialer-proxy'], expected, item.label + ': output dialer ' + name);
  }
  if (item.regions) assert.deepEqual(output['proxy-groups'].filter(g => /聚合$|^其他地区$/.test(g.name)).map(g => g.name), item.regions, item.label + ': regions');
  if (item.providerProxy) assert.equal(output['proxy-providers'].p.proxy, item.providerProxy);
  if (item.providerDialer) assert.equal(output['proxy-providers'].p.override['dialer-proxy'], item.providerDialer);
  if (item.brokenNodeCycle) assert.ok(output.proxies.some(p => p['dialer-proxy'] === 'REJECT'));
  if ('collisionEnabled' in item) {
    assert.equal(output.proxies[0]['dialer-proxy'], 'g');
    assert.equal(output.proxies[0].name, item.collisionEnabled ? '__SKULL_NODE__ChatGPT' : 'ChatGPT');
    assert.equal(output['proxy-groups'].some(g => g.name === 'ChatGPT'), item.collisionEnabled);
  }
}
async function runtime(item, config, directory) {
  const portHolder = net.createServer();
  const port = await listen(portHolder);
  await new Promise(resolve => portHolder.close(resolve));
  const out = clone(config);
  out.dns = {enable: false};
  out.rules = ['MATCH,REJECT'];
  delete out['rule-providers'];
  out['external-controller'] = '127.0.0.1:' + port;
  // Membership uses the common group base. Select disables all periodic group probes;
  // interval:0 on url-test would be replaced by the core's 300-second default.
  for (const group of out['proxy-groups']) {
    group.type = 'select';
    for (const key of ['url', 'interval', 'tolerance', 'timeout', 'lazy']) delete group[key];
  }
  const configPath = path.join(directory, 'runtime.json');
  fs.writeFileSync(configPath, JSON.stringify(out, null, 2));
  const child = spawn(binary, ['-d', directory, '-f', configPath], {stdio: ['ignore', 'pipe', 'pipe']});
  let log = '';
  child.stdout.on('data', data => { log += data; });
  child.stderr.on('data', data => { log += data; });
  const closed = once(child, 'close');
  const endpoint = 'http://127.0.0.1:' + port;
  const snapshot = async () => (await request(endpoint + '/proxies')).proxies;
  try {
    await eventually(item.label + ': controller ready', child, () => log, snapshot);
    const expected = {...item.members};
    if (item.label === 'fixture-direct-proxies') expected['全球手动'] = ['香港01', '美国02'];
    if ('collisionEnabled' in item) expected.g = ['DIRECT'];
    if (item.label === 'file-fallback') {
      expected['日本自动'] = ['日本远端01'];
      expected['美国自动'] = ['美国远端01'];
    }
    await eventually(item.label + ': effective members', child, () => log, async () => {
      const proxies = await snapshot();
      for (const [name, members] of Object.entries(expected)) assert.deepEqual(proxies[name]?.all, members, item.label + ': ' + name);
      fs.writeFileSync(path.join(directory, 'proxies.json'), JSON.stringify(proxies, null, 2));
    });
    if (item.label === 'remote-fallback') {
      await eventually('HTTP initial fallback', child, () => log, async () => {
        assert.deepEqual((await snapshot())['全球手动'].all, ['香港备用']);
      });
      // The loopback server now serves a different, complete inventory. Force a real update.
      item.setRemote([node('日本远端01'), node('美国远端01')]);
      await request(endpoint + '/providers/proxies/p', {method: 'PUT'});
      await eventually('HTTP updated JP/US inventory', child, () => log, async () => {
        const proxies = await snapshot();
        assert.deepEqual(proxies['全球手动'].all, ['日本远端01', '美国远端01']);
        assert.deepEqual(proxies['日本自动'].all, ['日本远端01']);
        assert.deepEqual(proxies['美国自动'].all, ['美国远端01']);
        fs.writeFileSync(path.join(directory, 'updated-proxies.json'), JSON.stringify(proxies, null, 2));
      });
    }
  } finally {
    await stop(child, closed);
    fs.writeFileSync(path.join(directory, 'runtime.log'), log);
  }
}
async function main() {
  assert.ok(process.env.CI, 'Real-core runner is CI-only; do not run against local user settings.');
  assert.ok(process.argv[2] && fs.statSync(binary).isFile(), 'Pass the pinned Mihomo v1.19.33 binary path.');
  artifacts = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'mihomo-ci-'));
  console.log('Synthetic core artifacts: ' + artifacts);
  const version = spawn(binary, ['-v'], {stdio: ['ignore', 'pipe', 'pipe']});
  let versionLog = '';
  version.stdout.on('data', data => { versionLog += data; });
  version.stderr.on('data', data => { versionLog += data; });
  const versionClosed = once(version, 'close');
  const versionTimer = setTimeout(() => version.kill('SIGKILL'), 5000);
  try {
    const [versionCode] = await versionClosed;
    assert.equal(versionCode, 0);
    assert.match(versionLog, /v1\.19\.33\b/);
  } finally {
    clearTimeout(versionTimer);
    await stop(version, versionClosed);
  }
  let remoteNodes = [node('香港备用')];
  const server = http.createServer((req, res) => {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({proxies: remoteNodes}));
  });
  try {
    const origin = 'http://127.0.0.1:' + await listen(server);
    for (const [index, script] of SCRIPTS.entries()) {
      const all = ['direct-proxies', 'provider-only', 'mixed-provider', 'naming-conflict', 'dialer-loop']
        .map(name => ({label: 'fixture-' + name, input: fixture(name)}))
        .concat(cases.filter(item => !item.unitOnly && (!item.bettboxOnly || index === 1)));
      for (const source of all) {
        const item = {...source, input: clone(source.input)};
        if (item.label === 'remote-fallback') {
          remoteNodes = [node('香港备用')];
          item.input['proxy-providers'].p.url = origin + '/provider';
          item.setRemote = nodes => { remoteNodes = nodes; };
        }
        if (item.label === 'excluded-provider-download') {
          remoteNodes = [node('JP01')];
          item.input['proxy-providers'].p.url = origin + '/provider';
        }
        const directory = path.join(artifacts, index + '-' + item.label);
        fs.mkdirSync(directory);
        const output = execute(script, item.input, item.options);
        assertSource(item, output); // A correct core member list cannot detect an already-rewritten dialer.
        fs.writeFileSync(path.join(directory, 'script-output.json'), JSON.stringify(output, null, 2));
        const config = fullConfig(output, directory, origin);
        const configPath = path.join(directory, 'full.json');
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        await runCheck(configPath, directory);
        await runtime(item, config, directory);
        console.log(`${script}: ${item.label}: -t success marker + runtime assertions passed`);
      }
    }
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
