'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');

const stopFile = String(process.env.OJ_MONITOR_STOP_FILE || '');
const outputFile = String(process.env.OJ_MONITOR_OUTPUT || '');
const contestId = Number(process.env.OJ_MONITOR_CONTEST_ID || 0);
const intervalMs = Number(process.env.OJ_MONITOR_INTERVAL_MS || 15000);
const timeoutMs = Number(process.env.OJ_MONITOR_TIMEOUT_MS || 15 * 60 * 1000);
const startedAt = Date.now();

function run(command, args) {
  return childProcess.execFileSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function memoryToMiB(value) {
  const match = /^([0-9.]+)([KMG]iB)$/.exec(String(value || '').trim());
  if (!match) return 0;
  const multipliers = { KiB: 1 / 1024, MiB: 1, GiB: 1024 };
  return Number(match[1]) * multipliers[match[2]];
}

function blankGroup() {
  return { instances: 0, cpuPercent: 0, memoryMiB: 0 };
}

function groupForName(name) {
  if (name.includes('-judge-runner-1-')) return 'runner';
  if (name.includes('-judge-daemon-')) return 'daemon';
  if (name.includes('-web-')) return 'web';
  if (name.includes('-mariadb-')) return 'mariadb';
  if (name.includes('-rabbitmq-')) return 'rabbitmq';
  return null;
}

function collectContainers() {
  const groups = {
    web: blankGroup(),
    mariadb: blankGroup(),
    rabbitmq: blankGroup(),
    daemon: blankGroup(),
    runner: blankGroup()
  };
  const output = run('docker', ['stats', '--no-stream', '--format', '{{json .}}']);
  for (const line of output.trim().split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    const groupName = groupForName(String(row.Name || ''));
    if (!groupName) continue;
    const group = groups[groupName];
    group.instances++;
    group.cpuPercent += Number.parseFloat(row.CPUPerc) || 0;
    group.memoryMiB += memoryToMiB(String(row.MemUsage || '').split('/')[0]);
  }
  return groups;
}

function collectSubmissions() {
  if (!contestId) return { total: 0, pending: 0, accepted: 0 };
  const sql = `SELECT COUNT(*),COALESCE(SUM(pending=1),0),COALESCE(SUM(status='Accepted'),0) FROM judge_state WHERE type=1 AND type_info=${contestId}`;
  const output = run('docker', [
    'compose', 'exec', '-T', 'mariadb', 'mariadb', '-N', '-B',
    '-usyzoj', '-psyzoj', 'syzoj', '-e', sql
  ]).trim();
  const values = output.split('\t').map(Number);
  return { total: values[0] || 0, pending: values[1] || 0, accepted: values[2] || 0 };
}

function summarize(samples) {
  const groups = ['web', 'mariadb', 'rabbitmq', 'daemon', 'runner'];
  const resources = {};
  for (const name of groups) {
    resources[name] = {
      maxInstances: Math.max(...samples.map(sample => sample.containers[name].instances)),
      maxCpuPercent: Math.max(...samples.map(sample => sample.containers[name].cpuPercent)),
      maxMemoryMiB: Math.max(...samples.map(sample => sample.containers[name].memoryMiB))
    };
  }
  return {
    samples: samples.length,
    durationMs: samples[samples.length - 1].timestamp - samples[0].timestamp,
    maxHostLoad1: Math.max(...samples.map(sample => sample.hostLoad[0])),
    maxPending: Math.max(...samples.map(sample => sample.submissions.pending)),
    finalSubmissions: samples[samples.length - 1].submissions,
    resources
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  if (!stopFile || !outputFile || !contestId) {
    throw new Error('OJ_MONITOR_STOP_FILE, OJ_MONITOR_OUTPUT and OJ_MONITOR_CONTEST_ID are required');
  }
  const samples = [];
  do {
    samples.push({
      timestamp: Date.now(),
      hostLoad: os.loadavg(),
      containers: collectContainers(),
      submissions: collectSubmissions()
    });
    if (fs.existsSync(stopFile) || Date.now() - startedAt >= timeoutMs) break;
    await sleep(intervalMs);
  } while (true);

  const report = {
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    contestId,
    summary: summarize(samples),
    samples
  };
  fs.writeFileSync(outputFile, JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report.summary, null, 2) + '\n');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
