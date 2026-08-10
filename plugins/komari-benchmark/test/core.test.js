"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../lib/core");

function fioPayload(readBw, writeBw, readIops, writeIops) {
  return JSON.stringify({ jobs: [{ read: { bw: readBw, iops: readIops }, write: { bw: writeBw, iops: writeIops } }] });
}

test("builds one pinned command for each benchmark", () => {
  assert.deepEqual(Object.keys(core.BENCHMARK_COMMANDS), core.TEST_KEYS);
  for (const name of core.TEST_KEYS) assert.match(core.BENCHMARK_COMMANDS[name], new RegExp(`TEST_NAME="${name}"`));
  assert.match(core.BENCHMARK_COMMANDS.geekbench5, /Geekbench-5\.5\.1-Linux\.tar\.gz/);
  assert.match(core.BENCHMARK_COMMANDS.geekbench5, /32037e55c3dc8f360fe16b7fbb188d31387ea75980e48d8cf028330e3239c404/);
  assert.match(core.BENCHMARK_COMMANDS.geekbench5, /GB_URL_RESULT\.csv/);
  assert.ok(core.BENCHMARK_COMMANDS.geekbench5.indexOf("GB_URL_RESULT.csv") < core.BENCHMARK_COMMANDS.geekbench5.indexOf("GB_PAGE="));
  assert.doesNotMatch(core.benchmarkCommand("geekbench5", "manual"), /KMB_CPU_GUARD_USAGE/);
  assert.match(core.benchmarkCommand("geekbench5", "schedule"), /KMB_CPU_GUARD_USAGE/);
  assert.match(core.benchmarkCommand("geekbench5", "schedule"), /CPU usage .* >= 60%/);
});

test("parses independent sysbench CPU and memory results", () => {
  const cpu = core.parseBenchmarkOutput([
    "KMB_TEST=sysbench", "KMB_TIME=2026-08-10T00:00:00Z", "KMB_CPU_THREADS=4",
    "KMB_CPU_SINGLE_EPS=400.5", "KMB_CPU_MULTI_EPS=1500.25", "KMB_STATUS=ok",
  ].join("\n"), 0);
  assert.equal(cpu.test, "sysbench");
  assert.equal(cpu.sysbench.cpu.single_eps, 400.5);
  assert.equal(cpu.sysbench.cpu.multi_eps, 1500.25);

  const memory = core.parseBenchmarkOutput([
    "KMB_TEST=memory", "KMB_MEMORY_READ_MIB_S=20000", "KMB_MEMORY_WRITE_MIB_S=12000", "KMB_STATUS=ok",
  ].join("\n"), 0);
  assert.equal(memory.test, "memory");
  assert.equal(memory.sysbench.memory.read_mib_s, 20000);
});

test("parses a complete fio result", () => {
  const output = [
    "KMB_TEST=fio",
    `KMB_FIO_4K_BEGIN\n${fioPayload(1024, 2048, 100, 200)}\nKMB_FIO_4K_END`,
    `KMB_FIO_64K_BEGIN\n${fioPayload(2048, 3072, 40, 50)}\nKMB_FIO_64K_END`,
    `KMB_FIO_512K_BEGIN\n${fioPayload(4096, 5120, 8, 10)}\nKMB_FIO_512K_END`,
    `KMB_FIO_1M_BEGIN\n${fioPayload(8192, 9216, 8, 9)}\nKMB_FIO_1M_END`,
    "KMB_STATUS=ok",
  ].join("\n");
  const result = core.parseBenchmarkOutput(output, 0);
  assert.equal(result.fio["4k"].read_mib_s, 1);
  assert.equal(result.fio["4k"].total_iops, 300);
});

test("parses Geekbench 5 scores and public URL", () => {
  const result = core.parseBenchmarkOutput([
    "KMB_TEST=geekbench5", "KMB_GB5_VERSION=5.5.1", "KMB_GB5_SINGLE=952", "KMB_GB5_MULTI=1677",
    "KMB_GB5_URL=https://browser.geekbench.com/v5/cpu/12345678", "KMB_STATUS=ok",
  ].join("\n"), 0);
  assert.equal(result.geekbench5.single_score, 952);
  assert.equal(result.geekbench5.multi_score, 1677);
  assert.equal(result.geekbench5.url, "https://browser.geekbench.com/v5/cpu/12345678");
  assert.equal(result.meta.geekbench_version, "5.5.1");
});

test("preserves an unsupported result without fabricated metrics", () => {
  const result = core.parseBenchmarkOutput("KMB_TEST=fio\nKMB_STATUS=unsupported\nKMB_ERROR=missing tools: fio", 0);
  assert.equal(result.status, "unsupported");
  assert.equal(result.error, "missing tools: fio");
  assert.equal(result.fio, undefined);
});

test("preserves a Geekbench result URL when score parsing is blocked", () => {
  const result = core.parseBenchmarkOutput([
    "KMB_TEST=geekbench5", "KMB_STATUS=error", "KMB_ERROR=Geekbench Browser scores could not be parsed",
    "KMB_GB5_URL=https://browser.geekbench.com/v5/cpu/24522614",
  ].join("\n"), 0);
  assert.equal(result.status, "error");
  assert.equal(result.result_url, "https://browser.geekbench.com/v5/cpu/24522614");
});

test("preserves a scheduled Geekbench CPU guard skip", () => {
  const result = core.parseBenchmarkOutput([
    "KMB_TEST=geekbench5", "KMB_CPU_GUARD_USAGE=63.25", "KMB_STATUS=skipped",
    "KMB_ERROR=scheduled Geekbench 5 skipped: CPU usage 63.25% >= 60%",
  ].join("\n"), 0);
  assert.equal(result.status, "skipped");
  assert.equal(result.meta.cpu_guard_usage, 63.25);
  assert.match(result.error, /63\.25%/);
});

test("preserves an agent execution error", () => {
  const result = core.parseBenchmarkOutput("Remote control is disabled.\n", -1, undefined, "sysbench");
  assert.equal(result.status, "failed");
  assert.equal(result.test, "sysbench");
  assert.equal(result.error, "Remote control is disabled.");
});

test("migrates combined version 1 history into independent series", () => {
  const history = core.normalizeHistory({
    version: 1,
    updated_at: "2026-08-10T00:00:00Z",
    records: { node: [{
      time: "2026-08-10T00:00:00Z", status: "ok",
      sysbench: { cpu: { single_eps: 1 }, memory: { read_mib_s: 2 } },
      fio: { "4k": { read_mib_s: 3 } },
    }] },
  });
  assert.equal(history.version, 2);
  assert.deepEqual(history.records.node.map((record) => record.test), ["sysbench", "memory", "fio"]);
  assert.equal(history.records.node[0].sysbench.memory, undefined);
});

test("drops records older than 30 days", () => {
  const history = { version: 2, updated_at: null, records: { node: [{ test: "fio", time: "2026-06-01T00:00:00Z", status: "ok" }] } };
  const merged = core.mergeHistory(history, "node", { test: "fio", time: "2026-08-10T00:00:00Z", status: "ok" }, new Date("2026-08-10T01:00:00Z"));
  assert.deepEqual(merged.records.node.map((record) => record.time), ["2026-08-10T00:00:00Z"]);
});

test("normalizes per-test schedule configuration", () => {
  const config = core.normalizeConfig({ schedules: {
    fio: { enabled: false, frequency: "monthly", time: "23:15", day: 31 },
    geekbench5: { frequency: "bad", time: "99:99", weekday: 9 },
  } });
  assert.deepEqual(config.schedules.fio, { enabled: false, frequency: "monthly", time: "23:15", weekday: 0, day: 28 });
  assert.equal(config.schedules.geekbench5.frequency, "daily");
  assert.equal(config.schedules.geekbench5.time, "03:00");
  assert.equal(config.schedules.geekbench5.weekday, 6);
});

test("selects daily, weekly, and monthly schedules only once per day", () => {
  const config = core.normalizeConfig({ schedules: {
    sysbench: { enabled: true, frequency: "daily", time: "04:30" },
    memory: { enabled: true, frequency: "weekly", time: "04:30", weekday: 1 },
    fio: { enabled: true, frequency: "monthly", time: "04:30", day: 10 },
    geekbench5: { enabled: false },
  } });
  const mondayTheTenth = new Date(2026, 7, 10, 4, 30, 0);
  assert.deepEqual(core.dueTests(config, {}, mondayTheTenth), ["sysbench", "memory", "fio"]);
  assert.deepEqual(core.dueTests(config, { sysbench: mondayTheTenth.toISOString() }, mondayTheTenth), ["memory", "fio"]);
  assert.deepEqual(core.dueTests(config, {}, new Date(2026, 7, 10, 4, 31, 0)), []);
});

test("normalizes Komari client field names", () => {
  assert.deepEqual(core.clientInfo({ UUID: "id", Name: "node", Hidden: true }), { uuid: "id", name: "node", hidden: true });
});

test("distinguishes Komari task placeholders from finished results", () => {
  assert.equal(core.taskResultFinished({ exit_code: null, finished_at: null }), false);
  assert.equal(core.taskResultFinished({ exit_code: 0, finished_at: "2026-08-10T00:00:00Z" }), true);
  assert.equal(core.taskResultFinished({ ExitCode: -1, FinishedAt: "2026-08-10T00:00:00Z" }), true);
});
