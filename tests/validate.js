'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {SCRIPTS, fixture, execute} = require('./helpers');
const BUILTINS = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL']);
function references(config) {
  const groups = config['proxy-groups'];
  const names = groups.map(g => g.name).concat((config.proxies || []).map(p => p.name));
  assert.equal(new Set(names).size, names.length, 'global names must be unique');
  const known = new Set([...names, ...BUILTINS]);
  const providers = config['rule-providers'];
  const paths = Object.values(providers).map(p => p.path).filter(Boolean);
  assert.equal(new Set(paths).size, paths.length, 'rule provider cache paths must be unique');
  for (const group of groups) {
    for (const ref of group.proxies || []) assert.ok(known.has(ref), `${group.name} -> ${ref}`);
    for (const ref of group.use || []) assert.ok(config['proxy-providers'][ref], `provider ${ref}`);
  }
  for (const proxy of config.proxies || []) {
    if (proxy['dialer-proxy']) assert.ok(known.has(proxy['dialer-proxy']));
  }
  for (const rule of config.rules) {
    const parts = rule.split(',');
    if (parts[0] === 'RULE-SET') assert.ok(providers[parts[1]], `RULE-SET ${parts[1]}`);
    // Logical rules contain nested commas; their outbound is still the last field.
    const target = parts.at(-1) === 'no-resolve' ? parts.at(-2) : parts.at(-1);
    assert.ok(known.has(target), `rule target ${target}`);
  }
  for (const [name, provider] of Object.entries(providers)) {
    if (provider.proxy) assert.ok(known.has(provider.proxy), `download proxy ${name}`);
    if (name.startsWith('SKULL_')) {
      assert.equal(new URL(provider.url).protocol, 'https:');
      assert.ok(provider['size-limit'] > 0);
    }
  }
  const dns = config.dns;
  for (const ref of [...dns['fake-ip-filter'], ...Object.keys(dns['nameserver-policy'])]) {
    if (ref.startsWith('rule-set:')) {
      for (const name of ref.slice(9).split(',')) {
        assert.ok(providers[name], `DNS provider ${name}`);
        assert.equal(providers[name].behavior, 'domain');
      }
    }
  }
  for (const urls of [dns.nameserver, ...Object.values(dns['nameserver-policy']), dns['direct-nameserver'], dns['proxy-server-nameserver']]) {
    for (const url of urls) if (url.includes('#')) assert.ok(known.has(url.split('#')[1]), `DNS exit ${url}`);
  }
}
const airports = [
  ['HKG', '香港'], ['TPE', '台湾'], ['TSA', '台湾'], ['KHH', '台湾'],
  ['SIN', '新加坡'], ['XSP', '新加坡'], ['ICN', '韩国'], ['GMP', '韩国'],
  ['NRT', '日本'], ['HND', '日本'], ['KIX', '日本'], ['CTS', '日本'], ['FUK', '日本'],
  ['LAX', '美国']
];
function matches(group, name) {
  const re = text => new RegExp(text.replace(/^\(\?i\)/, ''), 'i');
  return (!group.filter || re(group.filter).test(name)) &&
    (!group['exclude-filter'] || !re(group['exclude-filter']).test(name));
}
for (const file of SCRIPTS) {
  for (const name of ['direct-proxies', 'provider-only', 'mixed-provider', 'naming-conflict', 'dialer-loop']) {
    test(`${file}: references / ${name}`, () => references(execute(file, fixture(name))));
  }
  test(`${file}: empty subscription preserved`, () => {
    const input = {rules: ['MATCH,DIRECT'], dns: {enable: false}};
    assert.deepEqual(execute(file, input), input);
  });
  test(`${file}: core design contracts`, () => {
    const c = execute(file, fixture('direct-proxies'));
    // 香港 + 美国 两个地区：4 基础 + 3 AI + 9 服务 + 2 聚合 + 2 隐藏自动 = 20。
    assert.equal(c['proxy-groups'].length, 20);
    const regionNames = c['proxy-groups'].map(g => g.name).filter(name => /聚合$|^其他地区$/.test(name));
    assert.deepEqual(regionNames, ['香港聚合', '美国聚合']);
    for (const name of ['ChatGPT', 'Claude', 'Gemini / NotebookLM', 'Google', 'GitHub', 'Microsoft', 'Apple', 'Telegram', 'X', 'YouTube', 'Netflix', '游戏平台', '国外流量']) {
      const options = c['proxy-groups'].find(g => g.name === name).proxies;
      assert.deepEqual(options.filter(option => /聚合$|^其他地区$/.test(option)), ['香港聚合', '美国聚合'], name);
    }
    for (const name of ['ChatGPT', 'Claude', 'Gemini / NotebookLM', '国外流量']) {
      assert.ok(!c['proxy-groups'].find(g => g.name === name).proxies.includes('DIRECT'), name);
    }
    for (const name of ['ChatGPT', 'Claude', 'Gemini / NotebookLM', '国外流量']) {
      assert.equal(c['proxy-groups'].find(g => g.name === name)['default-selected'], '全球手动', name);
    }
    for (const name of ['Microsoft', 'Apple', '游戏平台']) assert.equal(c['proxy-groups'].find(g => g.name === name)['default-selected'], 'DIRECT');
    for (const name of ['Google', 'GitHub', 'X', 'YouTube', 'Netflix', 'Telegram']) {
      assert.equal(c['proxy-groups'].find(g => g.name === name)['default-selected'], '全球手动', name);
    }
    assert.equal(c['proxy-groups'].find(g => g.name === '漏网之鱼').proxies[0], '国外流量');
    assert.ok(c.rules.includes('RULE-SET,SKULL_ChinaIP,DIRECT'));
    assert.equal(c.rules.at(-1), 'MATCH,漏网之鱼');
    assert.ok(c.dns.nameserver.every(url => url.endsWith('#国外流量')));
    assert.ok(c.dns['proxy-server-nameserver'].every(url => url.endsWith('#DIRECT')));
    assert.equal(c.dns['direct-nameserver-follow-policy'], true);
    assert.ok(c.dns['direct-nameserver'].every(url => url.endsWith('#DIRECT')));
  });
  test(`${file}: airport tokens classified once with letter boundaries`, () => {
    // 9 个地区各放一个节点，保证 9 个地区组都存在，再用组自身的 filter 反查分类结果。
    const seed = ['香港01', '澳门01', '台湾01', '新加坡01', '韩国01', '日本01', '美国01', '英国01', '土耳其01']
      .map(name => ({name, type: 'ss'}));
    const c = execute(file, {proxies: seed});
    const groups = c['proxy-groups'].filter(g => /聚合$|^其他地区$/.test(g.name));
    for (const [code, region] of airports) {
      for (const name of [code + ' Premium 01', '线路-' + code.toLowerCase() + '02']) {
        assert.deepEqual(groups.filter(g => matches(g, name)).map(g => g.name), [region + '聚合'], name);
      }
    }
    for (const name of ['SINGLE Premium', 'XSPRESS', 'ATPEZ', 'AGMPZ', 'ANRTZ', 'HNDIRECT', 'KIXAMPLE', 'ACTSPEED', 'FUKUOKA', 'ICNODE', 'TOTALRecall', 'AUTHORity', 'EMAILite']) {
      assert.deepEqual(groups.filter(g => matches(g, name)).map(g => g.name), ['其他地区'], name);
    }
    assert.deepEqual(groups.filter(g => matches(g, 'HKG → NRT 01')).map(g => g.name), ['香港聚合']);
  });
  test(`${file}: information nodes removed without removing real nodes`, () => {
    const real = ['香港01｜不限流量', 'NRT Panel Premium', 'SIN Channel 01', 'TPE Author 02', '美国 USED Premium', '新加坡 TOTAL Premium', '机场专线 SIN 01'];
    const fake = ['USED: 12 GB', 'TOTAL: 100 GB', 'EXPIRE: 2027-01-01', 'EMAIL: support@example.com', 'Panel: https://example.com', 'Channel: @notice', 'Author: someone', '工单：https://example.com'];
    const c = execute(file, {proxies: [...real, ...fake].map(name => ({name, type: 'ss'}))});
    const manual = c['proxy-groups'].find(g => g.name === '全球手动');
    for (const name of real) assert.ok(manual.proxies.includes(name), name);
    for (const name of fake) assert.ok(!manual.proxies.includes(name), name);
    const automatic = c['proxy-groups'].find(g => g.name === '自动选择');
    for (const name of real) assert.ok(matches(automatic, name), name);
    for (const name of fake) assert.ok(!matches(automatic, name), name);
  });
  test(`${file}: support, subscription reminders and TG notices excluded on all node sources`, () => {
    const fake = [
      '客服邮箱：support@example.com', '客服邮箱: support@example.com',
      '⚠️节点不通请更新订阅', '节点不通请刷新订阅',
      '💬 TG交流群 | @example', '📣 TG频道 | @example',
      'Telegram 群组：@example', 'tg频道｜@example'
    ];
    const real = ['🇹🇷 土耳其 | 三网优化', '香港01｜不限流量', '香港 TG 专线 01', '美国 Telegram 优化 02', 'NRT Channel Premium', 'ATG频道优化 01'];
    for (const source of ['inline', 'provider', 'mixed']) {
      const input = source === 'inline' ? {} : fixture('provider-only');
      if (source !== 'provider') input.proxies = [...real, ...fake].map(name => ({name, type: 'ss'}));
      const c = execute(file, input);
      const manual = c['proxy-groups'].find(g => g.name === '全球手动');
      if (source !== 'provider') {
        for (const name of real) assert.ok(manual.proxies.includes(name), `${source}: keep ${name}`);
        for (const name of fake) assert.ok(!manual.proxies.includes(name), `${source}: exclude ${name}`);
      } else {
        for (const name of real) assert.ok(matches(manual, name), `${source}: keep ${name}`);
      }
      for (const group of c['proxy-groups'].filter(g => g['exclude-filter'])) {
        for (const name of fake) assert.ok(!matches(group, name), `${source}/${group.name}: exclude ${name}`);
      }
      const automatic = c['proxy-groups'].find(g => g.name === '自动选择');
      for (const name of real) assert.ok(matches(automatic, name), `${source}: keep ${name}`);
      // 其他地区 只在订阅里存在无法归类的节点时出现；provider-only 合成订阅只有 NRT。
      const other = c['proxy-groups'].find(g => g.name === '其他地区');
      if (source === 'provider') assert.equal(other, undefined, `${source}: no unclassified node, no 其他地区`);
      else assert.ok(matches(other, real[0]), 'Turkey route remains selectable');
    }
  });
  test(`${file}: custom patches preserve LAN and AI priority`, () => {
    const c = execute(file, fixture('direct-proxies'));
    const index = name => c.rules.findIndex(rule => rule.startsWith('RULE-SET,' + name + ','));
    const order = ['SKULL_Lan', 'SKULL_OpenAI', 'SKULL_Claude', 'SKULL_Gemini', 'SKULL_CustomDirect', 'SKULL_CustomProxy', 'SKULL_AppleCN', 'SKULL_China', 'SKULL_Foreign'];
    for (let i = 1; i < order.length; i++) assert.ok(index(order[i]) > index(order[i - 1]), order[i]);
    assert.ok(c.rules.includes('RULE-SET,SKULL_CustomDirect,DIRECT'));
    assert.ok(c.rules.includes('RULE-SET,SKULL_CustomProxy,国外流量'));
    assert.ok(c.dns['nameserver-policy']['rule-set:SKULL_CustomDirect'].every(url => url.endsWith('#DIRECT')));
    assert.ok(c.dns['nameserver-policy']['rule-set:SKULL_CustomProxy'].every(url => url.endsWith('#国外流量')));
    for (const [name, leaf] of [['SKULL_CustomDirect', 'direct.list'], ['SKULL_CustomProxy', 'proxy.list'], ['SKULL_FakeIPFilter', 'fake-ip-filter.list']]) {
      const p = c['rule-providers'][name];
      assert.equal(p.behavior, 'domain'); assert.equal(p.format, 'text');
      assert.equal(p.url, 'https://raw.githubusercontent.com/skullvek/Mihomo-RouteKit/main/rules/' + leaf);
      assert.equal(p.proxy, '国外流量');
    }
  });
  test(`${file}: Fake-IP patch keeps static fallback and blacklist inheritance`, () => {
    const input = fixture('direct-proxies');
    input.dns = {'fake-ip-filter': ['+.airport.example', '*.lan', 'rule-set:SKULL_FakeIPFilter']};
    const filter = execute(file, input).dns['fake-ip-filter'];
    for (const value of ['rule-set:SKULL_FakeIPFilter', '+.airport.example', '*.lan', '*.local', 'time.*.com', '+.pool.ntp.org']) assert.ok(filter.includes(value), value);
    assert.equal(filter.filter(x => x === 'rule-set:SKULL_FakeIPFilter').length, 1);
    for (const mode of ['whitelist', 'rule']) {
      input.dns['fake-ip-filter-mode'] = mode;
      const dns = execute(file, input).dns;
      assert.equal(dns['fake-ip-filter-mode'], 'blacklist');
      assert.ok(!dns['fake-ip-filter'].includes('+.airport.example'));
      assert.ok(dns['fake-ip-filter'].includes('rule-set:SKULL_FakeIPFilter'));
    }
  });
  test(`${file}: dialer loop fails closed`, () => {
    const c = execute(file, fixture('dialer-loop'));
    assert.equal(c.proxies[0]['dialer-proxy'], 'REJECT');
  });
  test(`${file}: explicit provider health-check respected`, () => {
    const c = execute(file, fixture('mixed-provider'));
    const health = c['proxy-providers'].airport['health-check'];
    assert.equal(health.enable, false); assert.equal(health.interval, 1200);
    assert.equal(health.url, 'https://example.com/check');
    assert.equal(health['expected-status'], undefined);
  });
  test(`${file}: malformed listener / tunnel / payload shapes never throw`, () => {
    const input = fixture('direct-proxies');
    input.listeners = {in: {type: 'mixed', port: 7890, proxy: 'DIRECT'}};
    input.tunnels = {t: {network: ['tcp'], proxy: 'DIRECT'}};
    input['proxy-providers'] = {p: {type: 'inline', payload: {a: {name: 'x', type: 'ss'}}}};
    assert.doesNotThrow(() => execute(file, input));
  });
  test(`${file}: Europe matches Chinese country and city names`, () => {
    const seed = ['香港01', '澳门01', '台湾01', '新加坡01', '韩国01', '日本01', '美国01', '英国01', '土耳其01']
      .map(name => ({name, type: 'ss'}));
    const c = execute(file, {proxies: seed});
    const groups = c['proxy-groups'].filter(g => /聚合$|^其他地区$/.test(g.name));
    const europe = ['丹麦 哥本哈根 01', '捷克 布拉格', '奥地利 维也纳', '比利时 布鲁塞尔', '葡萄牙 里斯本', '希腊 雅典', '冰岛 雷克雅未克', '卢森堡 01'];
    for (const name of europe) {
      assert.deepEqual(groups.filter(g => matches(g, name)).map(g => g.name), ['欧洲聚合'], name);
    }
    // Countries without any flag / airport-code coverage are a product decision; they stay 其他地区.
    assert.deepEqual(groups.filter(g => matches(g, '匈牙利 布达佩斯')).map(g => g.name), ['其他地区']);
  });
  test(`${file}: region groups follow the subscription`, () => {
    // 只有新加坡节点的机场：只建新加坡聚合，其余地区组与 其他地区 都不出现。
    const sg = execute(file, {proxies: ['🇸🇬 新加坡 原生 01', 'SIN IEPL 02'].map(name => ({name, type: 'ss'}))});
    assert.deepEqual(sg['proxy-groups'].filter(g => /聚合$|^其他地区$/.test(g.name)).map(g => g.name), ['新加坡聚合']);
    assert.ok(sg['proxy-groups'].some(g => g.name === '新加坡自动'), 'hidden auto group follows its aggregate');
    assert.ok(!sg['proxy-groups'].some(g => /^(?:香港|澳门|台湾|韩国|日本|美国|欧洲|其他)/.test(g.name)), 'no empty region groups');
    assert.equal(sg['proxy-groups'].length, 18);
    references(sg);

    // 只有无法归类的节点（土耳其）：只建 其他地区。
    const tr = execute(file, {proxies: [{name: '🇹🇷 土耳其 01', type: 'ss'}]});
    assert.deepEqual(tr['proxy-groups'].filter(g => /聚合$|^其他地区$/.test(g.name)).map(g => g.name), ['其他地区']);
    references(tr);

    // 远端 provider 的节点名枚举不到：保留全部 9 个地区组，不凭猜测删组。
    const remote = {proxies: [], 'proxy-providers': {airport: {type: 'http', url: 'https://example.com/sub.yaml', path: './providers/airport.yaml'}}};
    const unknown = execute(file, remote);
    assert.equal(unknown['proxy-groups'].filter(g => /聚合$|^其他地区$/.test(g.name)).length, 9);
    assert.equal(unknown['proxy-groups'].length, 34);

    // 旧配置引用了被跳过的地区组：改指 国外流量，不留悬空引用。
    const stale = {
      proxies: [{name: '香港01', type: 'ss'}, {name: '美国01', type: 'ss', 'dialer-proxy': '旧机场组'}],
      'proxy-groups': [{name: '旧机场组', type: 'select', proxies: ['香港聚合', '日本聚合', 'DIRECT']}]
    };
    const out = execute(file, stale);
    assert.deepEqual(out['proxy-groups'].find(g => g.name === '旧机场组').proxies, ['香港聚合', '国外流量', 'DIRECT']);
    references(out);
  });
  test(`${file}: non-object profile is replaced instead of spread`, () => {
    const c = execute(file, {...fixture('direct-proxies'), profile: 'oops'});
    assert.equal(c.profile['store-fake-ip'], true);
    assert.equal(Object.hasOwn(c.profile, '0'), false);
  });
}
for (const file of SCRIPTS.slice(1)) {
  test(`${file}: NTP routing overrides foreign classification after AI protection`, () => {
    for (const name of ['direct-proxies', 'provider-only', 'mixed-provider']) {
      const c = execute(file, fixture(name));
      const ntpDomain = c.rules.indexOf('DOMAIN-SUFFIX,pool.ntp.org,DIRECT');
      const ntpPort = c.rules.indexOf('AND,((NETWORK,UDP),(DST-PORT,123)),DIRECT');
      const foreign = c.rules.indexOf('RULE-SET,SKULL_Foreign,国外流量');
      assert.ok(ntpDomain >= 0, 'pool.ntp.org and its subdomains must have a direct route');
      assert.ok(ntpPort >= 0, 'UDP/123 must have a direct route even without a hostname');
      for (const provider of ['SKULL_OpenAI', 'SKULL_Claude', 'SKULL_Gemini']) {
        const ai = c.rules.findIndex(rule => rule.startsWith('RULE-SET,' + provider + ','));
        assert.ok(ai < ntpDomain && ai < ntpPort, provider + ': AI protection must win');
      }
      assert.ok(ntpDomain < foreign && ntpPort < foreign, 'NTP must precede foreign domains');
      assert.ok(!c.rules.includes('DST-PORT,123,DIRECT'), 'TCP/123 must not be bypassed');
      assert.ok(!c.rules.includes('NETWORK,UDP,DIRECT'), 'other UDP traffic must keep normal routing');
    }
  });
  test(`${file}: NTP DNS uses domestic direct resolvers with real IP compatibility`, () => {
    const c = execute(file, fixture('provider-only'));
    assert.deepEqual(c.dns['nameserver-policy']['+.pool.ntp.org'], [
      'https://dns.alidns.com/dns-query#DIRECT',
      'https://doh.pub/dns-query#DIRECT'
    ]);
    assert.ok(c.dns['fake-ip-filter'].includes('+.pool.ntp.org'));
    assert.ok(c.dns.nameserver.every(url => url.endsWith('#国外流量')));
  });
}
test('FlClash: defaults inherit Bettbox routing with current-repository patches', () => {
  for (const name of ['direct-proxies', 'provider-only', 'mixed-provider']) {
    const bettbox = execute(SCRIPTS[1], fixture(name));
    const flclash = execute(SCRIPTS[2], fixture(name), {noFromEntries: true});
    assert.deepEqual(flclash['proxy-groups'], bettbox['proxy-groups']);
    assert.deepEqual(flclash.rules, bettbox.rules);
    assert.equal(flclash.rules.length, 41);
    assert.deepEqual(flclash['rule-providers'], bettbox['rule-providers']);
    assert.deepEqual(flclash.dns['nameserver-policy'], bettbox.dns['nameserver-policy']);
    assert.equal(flclash.dns['direct-nameserver-follow-policy'], true);
    for (const domain of ['+.msftconnecttest.com', '+.msftncsi.com']) {
      assert.ok(flclash.dns['fake-ip-filter'].includes(domain));
    }
  }
});
test('FlClash: client-owned settings are preserved without inventing defaults', () => {
  const fields = ['tun', 'mode', 'ipv6', 'unified-delay', 'tcp-concurrent', 'find-process-mode'];
  const input = fixture('direct-proxies');
  Object.assign(input, {tun: {enable: false, stack: 'system', 'strict-route': false},
    mode: 'global', ipv6: true, 'unified-delay': false, 'tcp-concurrent': false, 'find-process-mode': 'strict',
    profile: {'store-selected': false, custom: true}});
  const output = execute(SCRIPTS[2], input);
  for (const key of fields) assert.deepEqual(output[key], input[key], key);
  assert.deepEqual(output.profile, {...input.profile, 'store-fake-ip': true});
  for (const key of fields) delete input[key];
  delete input.profile;
  const clean = execute(SCRIPTS[2], input);
  for (const key of fields) assert.ok(!Object.hasOwn(clean, key), key);
  assert.ok(!Object.hasOwn(clean.profile, 'store-selected'));
  assert.equal(clean.dns.enable, true);
  assert.ok(!clean.dns.nameserver.some(url => url.startsWith('system')));
  assert.deepEqual(clean.dns['nameserver-policy']['rule-set:SKULL_Lan'], ['system']);
});
test('Clash Verge / Bettbox: defaults agree except system NTP direct routes', () => {
  for (const name of ['direct-proxies', 'provider-only', 'mixed-provider']) {
    const a = execute(SCRIPTS[0], fixture(name));
    const b = execute(SCRIPTS[1], fixture(name));
    assert.deepEqual(a['proxy-groups'], b['proxy-groups']);
    const androidNtp = new Set([
      'DOMAIN-SUFFIX,pool.ntp.org,DIRECT',
      'AND,((NETWORK,UDP),(DST-PORT,123)),DIRECT'
    ]);
    assert.deepEqual(a.rules, b.rules.filter(rule => !androidNtp.has(rule)));
    assert.deepEqual(a['rule-providers'], b['rule-providers']);
  }
});
test('Bettbox: service and region toggles leave no broken references', () => {
  const names = ['ChatGPT', 'Claude', 'Gemini / NotebookLM', 'Google', 'GitHub', 'Microsoft', 'Apple', 'Telegram', 'X', 'YouTube', 'Netflix', '游戏平台', '地区分组'];
  for (const name of names) {
    const c = execute(SCRIPTS[1], fixture('provider-only'), {toggles: {[name]: false}, noFromEntries: true});
    references(c);
    if (name === '地区分组') assert.ok(!c['proxy-groups'].some(g => /聚合$|自动$|^其他地区$/.test(g.name)));
    else assert.ok(!c['proxy-groups'].some(g => g.name === name));
    assert.ok(c.rules.includes('RULE-SET,SKULL_CustomProxy,国外流量'));
  }
  references(execute(SCRIPTS[1], fixture('mixed-provider'), {toggles: Object.fromEntries(names.map(name => [name, false])), noFromEntries: true}));
});
test('platform TUN ownership preserved', () => {
  const input = fixture('direct-proxies');
  input.tun = {enable: false, stack: 'system', 'auto-route': false};
  assert.deepEqual(execute(SCRIPTS[1], input).tun, input.tun);
  const tun = execute(SCRIPTS[0], input).tun;
  assert.equal(tun.enable, false); assert.equal(tun.stack, 'system'); assert.equal(tun['auto-route'], false);
});

test('self-maintained rule files match their domain/text provider declarations', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const {ROOT} = require('./helpers');
  const config = execute(SCRIPTS[0], fixture('direct-proxies'));
  const lists = {};
  for (const [name, p] of Object.entries(config['rule-providers'])) {
    if (!p.url.startsWith('https://raw.githubusercontent.com/skullvek/Mihomo-RouteKit/main/rules/')) continue;
    const relative = new URL(p.url).pathname.split('/main/')[1];
    assert.ok(relative && relative.startsWith('rules/'));
    const text = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    const rules = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    assert.equal(new Set(rules).size, rules.length, name + ': duplicate domains');
    for (const domain of rules) {
      // Deliberately restrict manual lists to exact names / apex-and-subdomain suffixes.
      // Classical DOMAIN-SUFFIX rows, schemes, IPs, bare TLDs and broad wildcards are mistakes here.
      const value = domain.replace(/^\+\./, '');
      assert.ok(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(value), `${name}: invalid domain ${domain}`);
      assert.ok(value.length <= 253 && value.split('.').every(label => label.length <= 63));
    }
    lists[name] = rules;
  }
  assert.deepEqual(Object.keys(lists).sort(), ['SKULL_CustomDirect', 'SKULL_CustomProxy', 'SKULL_FakeIPFilter']);
  const base = value => value.replace(/^\+\./, '');
  for (const direct of lists.SKULL_CustomDirect) {
    for (const proxy of lists.SKULL_CustomProxy) {
      const a = base(direct), b = base(proxy);
      const conflict = a === b || (direct.startsWith('+.') && b.endsWith('.' + a)) || (proxy.startsWith('+.') && a.endsWith('.' + b));
      assert.ok(!conflict, `conflicting direct/proxy patches: ${direct} / ${proxy}`);
    }
  }
});

test('international patches cover overseas services without capturing domestic siblings or shared parents', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const {ROOT} = require('./helpers');
  const read = leaf => fs.readFileSync(path.join(ROOT, 'rules', leaf), 'utf8')
    .split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const matchesHost = (host, entries) => entries.some(entry => entry.startsWith('+.')
    ? host === entry.slice(2) || host.endsWith('.' + entry.slice(2))
    : host === entry);
  const proxy = read('proxy.list');
  const direct = read('direct.list');
  const overseas = [
    'www.workbuddy.ai', 'www.codebuddy.ai', 'qoder.com', 'api1.qoder.sh',
    'chat.qwen.ai', 'chat.qwenlm.ai', 'qwenlm.io', 'chat.z.ai', 'api.z.ai',
    'api.minimax.io', 'api.moonshot.ai', 'solo.trae.ai', 'traeapi.us',
    'trae-api-sg.mchost.guru', 'www.coze.com', 'cozecdn.com',
    'www.larksuite.com', 'open.larksuite.com', 'larksuitecdn.com', 'larkoffice.com',
    'www.wps.com', 'www.wpsoffice.com', 'voovmeeting.com', 'app.klingai.com',
    'wetv.vip', 'iq.com', 'www.bilibili.tv', 'joox.com',
    'video.tiktokrow-cdn.com', 'pikpakdrive.com', 'pikpak.me',
    'www.alibabacloud.com', 'console.tencentcloud.com',
    'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com',
    'llm-example.ap-southeast-1.maas.aliyuncs.com',
    'llm-example.ap-northeast-1.maas.aliyuncs.com'
  ];
  for (const host of overseas) {
    assert.ok(matchesHost(host, proxy), host + ': overseas exception missing');
    assert.ok(!matchesHost(host, direct), host + ': earlier direct patch must not win');
  }
  const unpatched = [
    'workbuddy.cn', 'copilot.tencent.com', 'qoder.cn', 'trae.com.cn', 'coze.cn',
    'chatglm.cn', 'open.bigmodel.cn', 'api.minimaxi.com', 'api.minimax.chat',
    'api.moonshot.cn', 'www.kimi.com', 'www.wps.cn',
    'mchost.guru', 'unrelated.mchost.guru', 'aliyuncs.com', 'oss-cn-beijing.aliyuncs.com',
    'dashscope.aliyuncs.com', 'llm-example.cn-beijing.maas.aliyuncs.com',
    'tencentcloudapi.com', 'cvm.tencentcloudapi.com', 'cloud.tencent.com',
    'evilworkbuddy.ai', 'workbuddy.ai.example.com',
    'not-ap-southeast-1.maas.aliyuncs.com', 'dashscope-intl.aliyuncs.com.example.com',
    'sub.trae-api-sg.mchost.guru'
  ];
  for (const host of unpatched) assert.ok(!matchesHost(host, proxy), host + ': exception too broad');
  const mustBeDirect = ['wise.com', 'api.wise.com', 'transferwise.com', 'wise.us', 'wise.jobs', 'wi.se'];
  for (const host of mustBeDirect) {
    assert.ok(matchesHost(host, direct), host + ': Wise must bypass the proxy');
    assert.ok(!matchesHost(host, proxy), host + ': Wise must not be captured by the proxy patch');
  }
});
