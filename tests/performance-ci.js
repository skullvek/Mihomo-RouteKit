'use strict';
// Release audit: fixed pre-optimization revision. Advance only after an intentional
// behavior change has its own contracts; never omit fields/diagnostics to hide drift.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const {performance} = require('node:perf_hooks');
const {ROOT, SCRIPTS} = require('./helpers');
const {node} = require('./repair-cases');
const BASELINE = '3b869b557381110754b8768b39d104be63ee03b2';
const baselineOnly = process.argv.includes('--baseline-only');
if (!process.env.CI) throw new Error('Performance/equivalence audit runs in cloud CI only');

function prepare(file, source, options = {}, metrics) {
  const diagnostics = [];
  const context = vm.createContext({console: {error: message => diagnostics.push(String(message))}});
  if (metrics) {
    context.metrics = metrics;
    vm.runInContext(`RegExp = new Proxy(RegExp, {
      construct(target, args) { metrics.compiles += 1; return Reflect.construct(target, args); },
      apply(target, self, args) { metrics.compiles += 1; return Reflect.apply(target, self, args); }
    });`, context);
  }
  if (file.startsWith('FlClash')) vm.runInContext('Object.fromEntries = undefined', context);
  new vm.Script(source, {filename: file}).runInContext(context, {timeout: 5000});
  if (file.startsWith('Bettbox')) {
    context.toggles = options.toggles || {};
    vm.runInContext('Object.assign(ruleOptionsEnable, toggles)', context);
  }
  context.input = null;
  const run = new vm.Script('JSON.stringify(main(input))');
  return {diagnostics, run(input) {
    diagnostics.length = 0;
    context.input = JSON.parse(JSON.stringify(input));
    return JSON.parse(run.runInContext(context, {timeout: 15000}));
  }};
}

const labels = ['香港', '澳门', '台湾', '新加坡', '韩国', '日本', '美国', '🇩🇪德国', '🇧🇷巴西'];
function largeInput(count, inline = false, dialer = false) {
  const payload = Array.from({length: count}, (_, i) => node(`${labels[i % labels.length]}-${i}｜HK｜线路`));
  if (dialer) payload[0]['dialer-proxy'] = 'DIRECT';
  return inline ? {'proxy-providers': {p: {type: 'inline', filter: '(?i)HK`香港`澳门`台湾`新加坡`韩国`日本`美国`德国`巴西', payload}}} : {proxies: payload};
}
const workloads = [
  {label: 'direct-1000', input: largeInput(1000)},
  {label: 'inline-1000', input: largeInput(1000, true)},
  {label: 'dialer-1000', input: largeInput(1000, false, true)}
];
const sources = new Map(SCRIPTS.map(file => [file, {
  before: execFileSync('git', ['show', `${BASELINE}:${file}`], {cwd: ROOT, encoding: 'utf8'}),
  after: fs.readFileSync(path.join(ROOT, file), 'utf8')
}]));

function compilationCount(file, source, input) {
  const metrics = {compiles: 0};
  prepare(file, source, {}, metrics).run(input);
  return metrics.compiles;
}
function budget(compiles) {
  assert.ok(compiles <= 64, `RegExp compilations must be bounded by patterns, not nodes: ${compiles} > 64`);
}
const evidence = {baseline: BASELINE, node: process.version, red: [], equivalence: 0, benchmarks: []};
for (const file of SCRIPTS) for (const workload of workloads) {
  const {before, after} = sources.get(file);
  const oldCount = compilationCount(file, before, workload.input);
  // This must reject the old implementation, proving the regression gate is live.
  assert.throws(() => budget(oldCount), /RegExp compilations must be bounded/);
  console.log(`BASELINE RED ${file} ${workload.label}: ${oldCount} compilations exceeds 64`);
  evidence.red.push({file, label: workload.label, compiles: oldCount});
  if (!baselineOnly) {
    const newCount = compilationCount(file, after, workload.input);
    budget(newCount);
    console.log(`CANDIDATE GREEN ${file} ${workload.label}: ${newCount} compilations`);
  }
}
if (baselineOnly) {
  console.log('Baseline RED reproduced in cloud; production scripts are unchanged.');
  process.exit(0);
}

// Compare complete serialized configs AND ordered diagnostics, including every
// shared QuickJS case, collisions, uncertain regexp2 semantics and Bettbox toggles.
const cases = require('./engine-cases').cases.slice();
for (const file of SCRIPTS) {
  for (const workload of workloads) cases.push({script: file, label: workload.label, input: workload.input});
  cases.push({script: file, label: 'pure-group-cycle-without-node-dialer', input: {
    proxies: [node('日本01')], listeners: [{name: 'synthetic', proxy: 'g'}],
    'proxy-groups': [{name: 'g', type: 'select', proxies: ['h', 'DIRECT']}, {name: 'h', type: 'select', proxies: ['g', 'DIRECT']}]
  }});
  for (const filter of ['(?i)^HK', '^HK$', '(?i)香港', '[', '^x`HK', '\\w', '^.$']) {
    cases.push({script: file, label: 'cache-name-dependent-' + filter, input: {
      'proxy-providers': {p: {type: 'inline', filter, payload: ['HK', 'hk', '香港', 'HK\n', 'HK\r', 'HK\u2028', 'x', 'y'].map(name => node(name, {'dialer-proxy': 'DIRECT'}))}}
    }});
  }
  // Deterministic combinations cover order ties, aliases, duplicates, pseudo nodes,
  // mixed region labels, and bypass adapters; no real subscription is ever loaded.
  let seed = 0x5eed;
  const names = [...labels, 'HK-JP', '日本01｜HK', '线路-hkg02', '香港→美国', 'ChatGPT', 'DIRECT', '剩余流量：10G', '', '🇫🇷法国', '🇩🇪德国'];
  for (let trial = 0; trial < 30; trial += 1) {
    const proxies = Array.from({length: 25}, (_, i) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return node(names[seed % names.length] + (i % 3 ? '-' + i : ''), {type: i % 11 ? 'ss' : 'direct'});
    });
    cases.push({script: file, label: 'seeded-' + trial, input: {proxies}, options: {toggles: {'地区分组': trial % 2 === 0, ChatGPT: trial % 3 === 0}}});
  }
}
for (const item of cases) {
  const {before, after} = sources.get(item.script);
  const oldRun = prepare(item.script, before, item.options);
  const newRun = prepare(item.script, after, item.options);
  assert.deepEqual(newRun.run(item.input), oldRun.run(item.input), item.script + ': ' + item.label);
  assert.deepEqual(newRun.diagnostics, oldRun.diagnostics, item.script + ': diagnostics / ' + item.label);
  evidence.equivalence += 1;
}
console.log(`Full output + ordered diagnostics equivalence: ${evidence.equivalence}/${cases.length}`);

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
for (const file of SCRIPTS) for (const workload of workloads) {
  const {before, after} = sources.get(file);
  const runners = {before: prepare(file, before), after: prepare(file, after)};
  for (let i = 0; i < 3; i += 1) for (const runner of Object.values(runners)) runner.run(workload.input);
  const samples = {before: [], after: []};
  for (let i = 0; i < 9; i += 1) {
    // Alternate order to reduce one-sided warmup/CPU scheduling bias.
    for (const key of i % 2 ? ['after', 'before'] : ['before', 'after']) {
      const start = performance.now();
      runners[key].run(workload.input);
      samples[key].push(performance.now() - start);
    }
  }
  const beforeMs = median(samples.before);
  const afterMs = median(samples.after);
  const result = {file, label: workload.label, beforeMs, afterMs,
    reductionPct: (1 - afterMs / beforeMs) * 100, speedup: beforeMs / afterMs,
    beforeCompiles: compilationCount(file, before, workload.input), afterCompiles: compilationCount(file, after, workload.input)};
  evidence.benchmarks.push(result);
  console.log(`BENCH ${JSON.stringify(result)}`);
}
// Wall time is evidence, not a flaky gate. Deterministic compile budgets and exact
// output equality are the gates; timings include input cloning and JSON roundtrip,
// but exclude source loading, compilation and VM creation on both sides.
if (process.env.RUNNER_TEMP) {
  const target = path.join(process.env.RUNNER_TEMP, 'routekit-performance.json');
  fs.writeFileSync(target, JSON.stringify(evidence, null, 2));
  console.log('Performance evidence: ' + target);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = evidence.benchmarks.map(row => `| ${row.file} | ${row.label} | ${row.beforeMs.toFixed(2)} | ${row.afterMs.toFixed(2)} | ${row.reductionPct.toFixed(1)}% | ${row.beforeCompiles} → ${row.afterCompiles} |`);
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Non-reducing performance audit\n\nBaseline: ${BASELINE}; full output + diagnostics: ${evidence.equivalence}/${cases.length}. Node ${process.version}, same runner, 3 warmups + median of 9 alternating measurements; includes clone/JSON, excludes VM/source setup. Not client latency or network throughput.\n\n| Script | Input | Before ms | After ms | Reduction | RegExp compilations |\n|---|---|---:|---:|---:|---:|\n${rows.join('\n')}\n`);
}
