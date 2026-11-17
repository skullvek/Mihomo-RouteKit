'use strict';
// CI-only, real process lookup + first-hit routing. All DNS and outbounds are loopback fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const dgram = require('node:dgram');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {SCRIPTS, execute} = require('./helpers');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sockets = new Set();
function hold(socket) { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); }
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
async function freePort() { const server = net.createServer(); const port = await listen(server); await new Promise(resolve => server.close(resolve)); return port; }
async function stop(child, closed) {
  if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { await closed; } finally { clearTimeout(timer); }
}
async function fetchJSON(url) {
  const res = await fetch(url, {signal: AbortSignal.timeout(2000)});
  assert.equal(res.status, 200); return res.json();
}
async function eventually(label, child, log, check) {
  const deadline = Date.now() + 15000; let error;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) throw new Error(label + ': process exited\n' + log());
    try { return await check(); } catch (e) { error = e; }
    await sleep(100);
  }
  throw new Error(label + ': ' + error?.stack + '\n' + log());
}
const domainPayloads = {
  SKULL_Lan: ['+.local.example'], SKULL_OpenAI: ['+.openai.example'],
  SKULL_Claude: ['+.claude.example'], SKULL_Gemini: ['+.gemini.example'],
  SKULL_CustomDirect: ['+.override-direct.example'], SKULL_CustomProxy: ['+.override-proxy.example'],
  SKULL_China: ['+.domestic.example', '+.overlap.example'],
  SKULL_Foreign: ['+.microsoft.example', '+.overlap.example'],
  SKULL_Microsoft: ['+.microsoft.example']
};
const cases = [
  {host: 'telemetry.microsoft.example', process: 'Hermes.exe', exit: '国外流量', rule: 'AND', payload: 'SKULL_Foreign'},
  {host: 'api.domestic.example', process: 'Hermes.exe', exit: 'DIRECT', rule: 'AND', payload: 'SKULL_China'},
  {host: 'api.overlap.example', process: 'Hermes.exe', exit: 'DIRECT', rule: 'AND', payload: 'SKULL_China'},
  {host: 'api.openai.example', process: 'Hermes.exe', exit: 'ChatGPT', rule: 'RuleSet', payload: 'SKULL_OpenAI'},
  {host: 'override-direct.example', process: 'Hermes.exe', exit: 'DIRECT', rule: 'RuleSet', payload: 'SKULL_CustomDirect'},
  {host: 'override-proxy.example', process: 'Hermes.exe', exit: '国外流量', rule: 'RuleSet', payload: 'SKULL_CustomProxy'},
  {host: 'unknown-domestic.example', process: 'Hermes.exe', exit: 'DIRECT', rule: 'AND', payload: 'SKULL_ChinaIP'},
  {host: 'unknown-foreign.example', process: 'Hermes.exe', exit: '国外流量', rule: 'ProcessName', payload: 'Hermes.exe'},
  {host: '127.0.0.1', process: 'Hermes.exe', exit: 'DIRECT', rule: 'AND', payload: 'SKULL_LanIP'},
  {host: 'telemetry.microsoft.example', process: 'OtherClient.exe', exit: 'Microsoft', rule: 'RuleSet', payload: 'SKULL_Microsoft'},
  {host: 'telemetry.microsoft.example', process: 'python.exe', exit: 'Microsoft', rule: 'RuleSet', payload: 'SKULL_Microsoft'}
];
async function main() {
  assert.ok(process.env.CI, 'Routing runner is CI-only; never modify a running user core.');
  const binary = path.resolve(process.argv[2] || ''); assert.ok(process.argv[2] && fs.statSync(binary).isFile());
  const root = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'hermes-routing-ci-'));
  console.log('Synthetic routing artifacts: ' + root);
  // /proc/<pid>/exe must really have the requested basename; argv spoofing is not sufficient.
  for (const name of new Set(cases.map(item => item.process))) fs.copyFileSync(process.execPath, path.join(root, name));
  const clientFile = path.join(root, 'client.js');
  fs.writeFileSync(clientFile, "const net=require('node:net');const [port,host,dst]=process.argv.slice(2);const s=net.connect(Number(port),'127.0.0.1');s.on('connect',()=>{console.log(JSON.stringify({sourcePort:s.localPort}));s.write('CONNECT '+host+':'+dst+' HTTP/1.1\\r\\nHost: '+host+':'+dst+'\\r\\n\\r\\n');});let sent=false;s.on('data',()=>{if(!sent){sent=true;s.write('fixture-data');}});s.on('error',e=>{console.error(e.message);process.exitCode=1;});");
  const dnsQueries = [];
  const dns = dgram.createSocket('udp4');
  dns.on('message', (query, peer) => {
    try {
      let cursor = 12; const labels = [];
      while (query[cursor]) { const length = query[cursor++]; labels.push(query.subarray(cursor, cursor + length).toString('ascii')); cursor += length; }
      cursor += 1; const type = query.readUInt16BE(cursor); const end = cursor + 4;
      const host = labels.join('.'); dnsQueries.push(host);
      const header = Buffer.alloc(12); query.copy(header, 0, 0, 2); header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(1, 4); header.writeUInt16BE(type === 1 ? 1 : 0, 6);
      const answer = type === 1 ? Buffer.from([0xc0,0x0c,0,1,0,1,0,0,0,20,0,4,127,0,0,host === 'unknown-foreign.example' ? 2 : 1]) : Buffer.alloc(0);
      dns.send(Buffer.concat([header, query.subarray(12, end), answer]), peer.port, peer.address);
    } catch (error) { console.error('Synthetic DNS fixture: ' + error.message); }
  });
  dns.bind(0, '127.0.0.1'); await once(dns, 'listening');
  const resolver = '127.0.0.1:' + dns.address().port;
  const sink = net.createServer(hold);
  const forward = http.createServer((req, res) => res.end('fixture'));
  forward.on('connect', (req, socket) => { hold(socket); socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); });
  const evidence = [];
  try {
    const sinkPort = await listen(sink); const forwardPort = await listen(forward);
    for (const [index, script] of SCRIPTS.entries()) {
      const directory = path.join(root, String(index)); fs.mkdirSync(directory);
      const output = execute(script, {proxies: [{name: '香港01', type: 'http', server: '127.0.0.1', port: forwardPort}]});
      const controller = await freePort(); const mixed = await freePort();
      Object.assign(output, {port: 0, 'socks-port': 0, 'mixed-port': mixed, 'redir-port': 0, 'tproxy-port': 0,
        'allow-lan': false, 'bind-address': '127.0.0.1', 'external-controller': '127.0.0.1:' + controller,
        mode: 'rule', 'find-process-mode': 'strict', 'log-level': 'info', 'geo-auto-update': false,
        tun: {enable: false}, ntp: {enable: false}, profile: {'store-selected': false, 'store-fake-ip': false},
        dns: {enable: true, ipv6: false, 'enhanced-mode': 'normal', nameserver: [resolver],
          'direct-nameserver': [resolver], 'proxy-server-nameserver': [resolver], 'use-hosts': false, 'use-system-hosts': false}});
      for (const group of output['proxy-groups']) {
        group.type = 'select'; for (const key of ['url','interval','tolerance','timeout','lazy']) delete group[key];
      }
      for (const [name, provider] of Object.entries(output['rule-providers'])) {
        const file = path.join(directory, name + '.list');
        const payload = provider.behavior === 'ipcidr'
          ? ([ 'SKULL_LanIP', 'SKULL_ChinaIP' ].includes(name) ? ['127.0.0.1/32'] : ['192.0.2.0/24'])
          : (domainPayloads[name] || ['+.unmatched-' + name.toLowerCase() + '.example']);
        fs.writeFileSync(file, payload.join('\n') + '\n');
        output['rule-providers'][name] = {type: 'file', behavior: provider.behavior, format: 'text', path: file};
      }
      const configFile = path.join(directory, 'runtime.json'); fs.writeFileSync(configFile, JSON.stringify(output, null, 2));
      const core = spawn(binary, ['-d', directory, '-f', configFile], {stdio: ['ignore', 'pipe', 'pipe']});
      const closed = once(core, 'close'); let coreLog = '';
      core.stdout.on('data', data => { coreLog += data; }); core.stderr.on('data', data => { coreLog += data; });
      const endpoint = 'http://127.0.0.1:' + controller;
      try {
        await eventually(script + ': ready', core, () => coreLog, () => fetchJSON(endpoint + '/proxies'));
        for (const item of cases) {
          const queryCount = dnsQueries.filter(host => host === item.host).length;
          const child = spawn(path.join(root, item.process), [clientFile, String(mixed), item.host, String(sinkPort)], {stdio: ['ignore','pipe','pipe']});
          const clientClosed = once(child, 'close'); let stdout = ''; let stderr = '';
          child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
          try {
            const sourcePort = await eventually(item.host + ': client', child, () => stderr, () => JSON.parse(stdout.trim().split('\n')[0]).sourcePort);
            const connection = await eventually(script + ': ' + item.host, core, () => coreLog + '\n' + stderr, async () => {
              const all = (await fetchJSON(endpoint + '/connections')).connections;
              fs.writeFileSync(path.join(directory, 'connections.json'), JSON.stringify(all, null, 2));
              // Mihomo v1.19.33 encodes uint16 ports as JSON strings for compatibility.
              const match = all.find(c => Number(c.metadata.sourcePort) === sourcePort &&
                c.metadata.process === item.process && (c.metadata.host === item.host ||
                (net.isIP(item.host) && c.metadata.destinationIP === item.host)));
              assert.ok(match, 'connection must remain open');
              assert.equal(match.metadata.process, item.process, 'real OS process lookup');
              assert.equal(match.rule, item.rule);
              if (item.rule === 'AND') assert.ok(match.rulePayload.includes('(RuleSet,' + item.payload + ')'), match.rulePayload);
              else assert.equal(match.rulePayload, item.payload);
              assert.ok(match.chains.includes(item.exit), JSON.stringify(match.chains));
              if (item.exit === '国外流量') assert.ok(!match.chains.includes('DIRECT') && !match.chains.includes('Microsoft'));
              return match;
            });
            if (item.process === 'Hermes.exe' && item.payload === 'SKULL_Foreign') {
              assert.equal(dnsQueries.filter(host => host === item.host).length, queryCount,
                'known foreign domain must not trigger CN IP fallback DNS');
            }
            evidence.push({script, ...item, actualRule: connection.rule, actualPayload: connection.rulePayload, chains: connection.chains});
            console.log('ROUTING PASS ' + script + ' ' + item.process + ' ' + item.host + ' -> ' + item.exit);
          } finally { await stop(child, clientClosed); }
        }
      } finally { await stop(core, closed); fs.writeFileSync(path.join(directory, 'runtime.log'), coreLog); }
    }
    fs.writeFileSync(path.join(root, 'routing.json'), JSON.stringify({evidence, dnsQueries}, null, 2));
    assert.equal(evidence.length, SCRIPTS.length * cases.length);
    console.log('Real-core Hermes routing: ' + evidence.length + '/' + evidence.length + ' checks passed (synthetic loopback only)');
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise(resolve => sink.close(resolve)), new Promise(resolve => forward.close(resolve))]);
    await new Promise(resolve => dns.close(resolve));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
