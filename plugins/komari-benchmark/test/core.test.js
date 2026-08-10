"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../lib/core");

function fioPayload(readBw, writeBw, readIops, writeIops) {
  return JSON.stringify({
    jobs: [{
      read: { bw: readBw, iops: readIops },
      write: { bw: writeBw, iops: writeIops },
    }],
  });
}

test("emits expandable fio result markers", () => {
  assert.match(core.BENCHMARK_COMMAND, /KMB_FIO_\$\{KEY\}_BEGIN/);
  assert.doesNotMatch(core.BENCHMARK_COMMAND, /KMB_FIO_\\\$\{KEY\}_BEGIN/);
});

test("parses a complete benchmark result", () => {
  const output = [
    "KMB_TIME=2026-08-10T00:00:00Z",
    "KMB_HOST_ARCH=x86_64",
    "KMB_CPU_THREADS=4",
    "KMB_SYSBENCH_VERSION=sysbench 1.0.20",
    "KMB_FIO_VERSION=fio-3.39",
    "KMB_CPU_SINGLE_EPS=400.5",
    "KMB_CPU_MULTI_EPS=1500.25",
    "KMB_MEMORY_READ_MIB_S=20000",
    "KMB_MEMORY_WRITE_MIB_S=12000",
    `KMB_FIO_4K_BEGIN\n${fioPayload(1024, 2048, 100, 200)}\nKMB_FIO_4K_END`,
    `KMB_FIO_64K_BEGIN\n${fioPayload(2048, 3072, 40, 50)}\nKMB_FIO_64K_END`,
    `KMB_FIO_512K_BEGIN\n${fioPayload(4096, 5120, 8, 10)}\nKMB_FIO_512K_END`,
    `KMB_FIO_1M_BEGIN\n${fioPayload(8192, 9216, 8, 9)}\nKMB_FIO_1M_END`,
    "KMB_STATUS=ok",
  ].join("\n");

  const result = core.parseBenchmarkOutput(output, 0);
  assert.equal(result.status, "ok");
  assert.equal(result.sysbench.cpu.single_eps, 400.5);
  assert.equal(result.sysbench.cpu.multi_eps, 1500.25);
  assert.equal(result.sysbench.memory.read_mib_s, 20000);
  assert.equal(result.fio["4k"].read_mib_s, 1);
  assert.equal(result.fio["4k"].total_iops, 300);
});

test("preserves an unsupported result without fabricated metrics", () => {
  const result = core.parseBenchmarkOutput(
    "KMB_TIME=2026-08-10T00:00:00Z\nKMB_STATUS=unsupported\nKMB_ERROR=missing tools: fio",
    0,
  );
  assert.equal(result.status, "unsupported");
  assert.equal(result.error, "missing tools: fio");
  assert.equal(result.sysbench, undefined);
});

test("preserves an agent execution error", () => {
  const result = core.parseBenchmarkOutput("Remote control is disabled.\n", -1);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "Remote control is disabled.");
});

test("drops records older than 30 days", () => {
  const history = {
    version: 1,
    updated_at: null,
    records: {
      node: [{ time: "2026-06-01T00:00:00Z", status: "ok" }],
    },
  };
  const merged = core.mergeHistory(
    history,
    "node",
    { time: "2026-08-10T00:00:00Z", status: "ok" },
    new Date("2026-08-10T01:00:00Z"),
  );
  assert.deepEqual(merged.records.node.map((record) => record.time), ["2026-08-10T00:00:00Z"]);
});

test("normalizes Komari client field names", () => {
  assert.deepEqual(core.clientInfo({ UUID: "id", Name: "node", Hidden: true }), {
    uuid: "id",
    name: "node",
    hidden: true,
  });
});

test("distinguishes Komari task placeholders from finished results", () => {
  assert.equal(core.taskResultFinished({ exit_code: null, finished_at: null }), false);
  assert.equal(core.taskResultFinished({ exit_code: 0, finished_at: "2026-08-10T00:00:00Z" }), true);
  assert.equal(core.taskResultFinished({ ExitCode: -1, FinishedAt: "2026-08-10T00:00:00Z" }), true);
});
