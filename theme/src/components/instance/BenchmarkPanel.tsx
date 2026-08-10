"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, Cpu, ExternalLink, Gauge, HardDrive, MemoryStick, Settings, X } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import Loading from "@/components/loading";

type TestKey = "sysbench" | "memory" | "fio" | "geekbench5";
type Frequency = "daily" | "weekly" | "monthly";
type View = "geekbench5" | "sysbench" | "memory" | "disk";
type BlockSize = "4k" | "64k" | "512k" | "1m";
type DiskMetric = "throughput" | "iops";

type FioResult = {
  read_mib_s: number;
  write_mib_s: number;
  total_mib_s: number;
  read_iops: number;
  write_iops: number;
  total_iops: number;
};

type BenchmarkRecord = {
  test: TestKey;
  time: string;
  status: string;
  error?: string;
  result_url?: string;
  sysbench?: {
    cpu?: { single_eps: number; multi_eps: number; threads: number };
    memory?: { read_mib_s: number; write_mib_s: number };
  };
  fio?: Record<BlockSize, FioResult>;
  geekbench5?: { single_score: number; multi_score: number; url: string };
};

type HistoryResponse = {
  retention_days: number;
  updated_at: string | null;
  records: BenchmarkRecord[];
};

type TestSchedule = {
  enabled: boolean;
  frequency: Frequency;
  time: string;
  weekday: number;
  day: number;
};

type BenchmarkConfig = { version: number; schedules: Record<TestKey, TestSchedule> };

const colors = { blue: "#2388c2", amber: "#bd7700", green: "#07856b" };
const viewTest: Record<View, TestKey> = { geekbench5: "geekbench5", sysbench: "sysbench", memory: "memory", disk: "fio" };
const testLabels: Record<TestKey, string> = { geekbench5: "Geekbench 5", sysbench: "Sysbench", memory: "内存", fio: "fio 磁盘" };
const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function compactNumber(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: value >= 1000 ? 0 : 1, notation: "compact" }).format(value);
}

function formatValue(value: number | undefined, unit: string) {
  if (!finite(value)) return "--";
  const digits = value >= 1000 ? 0 : 1;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: digits })}${unit ? ` ${unit}` : ""}`;
}

function formatFailure(error: string | undefined) {
  if (!error) return "最近一次测试未完成";
  if (error.startsWith("missing tools:")) return `缺少测试依赖：${error.slice("missing tools:".length).trim()}`;
  if (error === "benchmark already running") return "已有基准测试正在运行";
  if (error === "less than 768 MiB free in /var/tmp") return "测试目录可用空间不足 768 MiB";
  if (error === "agent result timed out") return "Agent 返回结果超时";
  return error;
}

function SummaryItem({ label, value, unit }: { label: string; value?: number; unit: string }) {
  return <div className="ds-bench-summary-item"><span>{label}</span><strong>{formatValue(value, unit)}</strong></div>;
}

export default function BenchmarkPanel({ uuid }: { uuid: string }) {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [view, setView] = useState<View>("geekbench5");
  const [blockSize, setBlockSize] = useState<BlockSize>("4k");
  const [diskMetric, setDiskMetric] = useState<DiskMetric>("throughput");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [config, setConfig] = useState<BenchmarkConfig | null>(null);
  const [timezone, setTimezone] = useState("服务器本地时间");
  const [configMessage, setConfigMessage] = useState("");
  const [configBusy, setConfigBusy] = useState(false);

  useEffect(() => {
    fetch("/api/me", { credentials: "include" })
      .then((response) => response.ok ? response.json() : null)
      .then((me) => setIsAdmin(Boolean(me?.logged_in)))
      .catch(() => setIsAdmin(false));
  }, []);

  useEffect(() => {
    if (!uuid) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/plugin/komari-benchmark/history?uuid=${encodeURIComponent(uuid)}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 404 ? "尚无基准测试数据" : `HTTP ${response.status}`);
        const body = await response.json();
        return body.data as HistoryResponse;
      })
      .then(setData)
      .catch((reason) => { if (reason?.name !== "AbortError") setError(reason?.message || "加载失败"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [uuid]);

  const loadConfig = async () => {
    setConfigBusy(true);
    setConfigMessage("");
    try {
      const response = await fetch("/api/plugin/komari-benchmark/config", { credentials: "include", cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.message || `HTTP ${response.status}`);
      setConfig(body.data.config);
      setTimezone(body.data.timezone || "服务器本地时间");
    } catch (reason) {
      setConfigMessage(reason instanceof Error ? reason.message : "读取配置失败");
    } finally {
      setConfigBusy(false);
    }
  };

  const openSettings = () => {
    setSettingsOpen(true);
    void loadConfig();
  };

  const updateSchedule = (test: TestKey, patch: Partial<TestSchedule>) => {
    setConfig((current) => current ? { ...current, schedules: { ...current.schedules, [test]: { ...current.schedules[test], ...patch } } } : current);
  };

  const saveConfig = async () => {
    if (!config) return;
    setConfigBusy(true);
    setConfigMessage("");
    try {
      const response = await fetch("/api/plugin/komari-benchmark/config", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.message || `HTTP ${response.status}`);
      setConfig(body.data.config);
      setConfigMessage("已保存");
    } catch (reason) {
      setConfigMessage(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setConfigBusy(false);
    }
  };

  const recordsForView = useMemo(() => (data?.records || []).filter((record) => record.test === viewTest[view]), [data, view]);
  const successful = useMemo(() => recordsForView.filter((record) => record.status === "ok"), [recordsForView]);
  const latest = successful[successful.length - 1];
  const latestRecord = recordsForView[recordsForView.length - 1];
  const failedCount = recordsForView.filter((record) => record.status !== "ok").length;

  const chart = useMemo(() => {
    if (view === "geekbench5") return {
      unit: "分", series: [{ key: "single", label: "单核", color: colors.blue }, { key: "multi", label: "多核", color: colors.amber }],
      rows: recordsForView.map((record) => ({ time: record.time, single: record.status === "ok" ? record.geekbench5?.single_score ?? null : null, multi: record.status === "ok" ? record.geekbench5?.multi_score ?? null : null })),
    };
    if (view === "sysbench") return {
      unit: "events/s", series: [{ key: "single", label: "单核", color: colors.blue }, { key: "multi", label: "多核", color: colors.amber }],
      rows: recordsForView.map((record) => ({ time: record.time, single: record.status === "ok" ? record.sysbench?.cpu?.single_eps ?? null : null, multi: record.status === "ok" ? record.sysbench?.cpu?.multi_eps ?? null : null })),
    };
    if (view === "memory") return {
      unit: "MiB/s", series: [{ key: "read", label: "读", color: colors.blue }, { key: "write", label: "写", color: colors.amber }],
      rows: recordsForView.map((record) => ({ time: record.time, read: record.status === "ok" ? record.sysbench?.memory?.read_mib_s ?? null : null, write: record.status === "ok" ? record.sysbench?.memory?.write_mib_s ?? null : null })),
    };
    const suffix = diskMetric === "throughput" ? "mib_s" : "iops";
    return {
      unit: diskMetric === "throughput" ? "MiB/s" : "IOPS",
      series: [{ key: "read", label: "读", color: colors.blue }, { key: "write", label: "写", color: colors.amber }, { key: "total", label: "读写", color: colors.green }],
      rows: recordsForView.map((record) => {
        const fio = record.status === "ok" ? record.fio?.[blockSize] : undefined;
        return { time: record.time, read: fio?.[`read_${suffix}` as keyof FioResult] ?? null, write: fio?.[`write_${suffix}` as keyof FioResult] ?? null, total: fio?.[`total_${suffix}` as keyof FioResult] ?? null };
      }),
    };
  }, [blockSize, diskMetric, recordsForView, view]);

  const latestFio = latest?.fio?.[blockSize];
  const diskUnit = diskMetric === "throughput" ? "MiB/s" : "IOPS";

  if (loading) return <div className="ds-bench-loading"><Loading /></div>;

  return (
    <div className="ds-bench-card">
      <header className="ds-bench-head">
        <div><h2>基准测试</h2><p>最近 {data?.retention_days || 30} 天趋势</p></div>
        <div className="ds-bench-head-actions">
          <div className="ds-bench-tabs" role="tablist" aria-label="基准测试类型">
            <button type="button" className={view === "geekbench5" ? "is-active" : ""} onClick={() => setView("geekbench5")}><Gauge size={15} />Geekbench 5</button>
            <button type="button" className={view === "sysbench" ? "is-active" : ""} onClick={() => setView("sysbench")}><Cpu size={15} />Sysbench</button>
            <button type="button" className={view === "memory" ? "is-active" : ""} onClick={() => setView("memory")}><MemoryStick size={15} />内存</button>
            <button type="button" className={view === "disk" ? "is-active" : ""} onClick={() => setView("disk")}><HardDrive size={15} />磁盘</button>
          </div>
          {isAdmin ? <button type="button" className="ds-bench-settings-trigger" onClick={openSettings} title="测试计划"><Settings size={17} /></button> : null}
        </div>
      </header>

      {view === "disk" ? <div className="ds-bench-disk-controls">
        <div className="ds-bench-subtabs">{(["4k", "64k", "512k", "1m"] as BlockSize[]).map((size) => <button type="button" key={size} className={blockSize === size ? "is-active" : ""} onClick={() => setBlockSize(size)}>{size.toUpperCase()}</button>)}</div>
        <div className="ds-bench-subtabs"><button type="button" className={diskMetric === "throughput" ? "is-active" : ""} onClick={() => setDiskMetric("throughput")}>吞吐</button><button type="button" className={diskMetric === "iops" ? "is-active" : ""} onClick={() => setDiskMetric("iops")}>IOPS</button></div>
      </div> : null}

      <div className={`ds-bench-summary ${view === "disk" ? "ds-bench-summary-3" : ""}`}>
        {view === "geekbench5" ? <><SummaryItem label="单核" value={latest?.geekbench5?.single_score} unit="" /><SummaryItem label="多核" value={latest?.geekbench5?.multi_score} unit="" /></>
          : view === "sysbench" ? <><SummaryItem label="单核" value={latest?.sysbench?.cpu?.single_eps} unit="events/s" /><SummaryItem label={`多核 · ${latest?.sysbench?.cpu?.threads || "--"} 线程`} value={latest?.sysbench?.cpu?.multi_eps} unit="events/s" /></>
          : view === "memory" ? <><SummaryItem label="读" value={latest?.sysbench?.memory?.read_mib_s} unit="MiB/s" /><SummaryItem label="写" value={latest?.sysbench?.memory?.write_mib_s} unit="MiB/s" /></>
          : <><SummaryItem label="读" value={latestFio?.[diskMetric === "throughput" ? "read_mib_s" : "read_iops"]} unit={diskUnit} /><SummaryItem label="写" value={latestFio?.[diskMetric === "throughput" ? "write_mib_s" : "write_iops"]} unit={diskUnit} /><SummaryItem label="读写" value={latestFio?.[diskMetric === "throughput" ? "total_mib_s" : "total_iops"]} unit={diskUnit} /></>}
      </div>

      {successful.length ? <div className="ds-bench-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={chart.rows} margin={{ top: 18, right: 24, bottom: 8, left: 10 }}>
        <CartesianGrid vertical={false} strokeOpacity={0.35} />
        <XAxis dataKey="time" tickLine={false} minTickGap={32} tickFormatter={(value) => new Date(value).toLocaleDateString(undefined, { month: "numeric", day: "numeric" })} />
        <YAxis tickLine={false} axisLine={false} width={54} tickFormatter={(value) => compactNumber(Number(value))} />
        <Tooltip labelFormatter={(value) => new Date(String(value)).toLocaleString()} formatter={(value: number, name: string) => [formatValue(Number(value), chart.unit), chart.series.find((series) => series.key === name)?.label || name]} />
        {chart.series.map((series) => <Line key={series.key} type="linear" dataKey={series.key} name={series.key} stroke={series.color} strokeWidth={2.2} dot={{ r: 3, strokeWidth: 0, fill: series.color }} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false} />)}
      </LineChart></ResponsiveContainer></div>
        : <div className="ds-bench-empty"><Activity size={18} /><span>{error || (latestRecord?.status !== "ok" && latestRecord ? formatFailure(latestRecord.error) : "尚无成功的基准测试数据")}</span></div>}

      <footer className="ds-bench-foot">
        <span>{latest ? `最近成功：${new Date(latest.time).toLocaleString()}` : "等待首次测试"}</span>
        {view === "geekbench5" && (latest?.geekbench5?.url || latestRecord?.result_url) ? <a href={latest?.geekbench5?.url || latestRecord?.result_url} target="_blank" rel="noreferrer">查看完整结果 <ExternalLink size={13} /></a> : null}
        {failedCount > 0 ? <span>{failedCount} 个失败点未绘制</span> : null}
      </footer>

      {settingsOpen ? <div className="ds-bench-settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
        <section className="ds-bench-settings" role="dialog" aria-modal="true" aria-label="基准测试计划">
          <header><div><h3>测试计划</h3><p>执行时间按 {timezone} 计算</p></div><button type="button" onClick={() => setSettingsOpen(false)} aria-label="关闭"><X size={18} /></button></header>
          {configBusy && !config ? <div className="ds-bench-settings-loading"><Loading /></div> : null}
          {config ? <div className="ds-bench-schedule-list">{(Object.keys(testLabels) as TestKey[]).map((test) => {
            const schedule = config.schedules[test];
            return <div className="ds-bench-schedule-row" key={test}>
              <label className="ds-bench-schedule-enable"><input type="checkbox" checked={schedule.enabled} onChange={(event) => updateSchedule(test, { enabled: event.target.checked })} /><strong>{testLabels[test]}</strong></label>
              <select value={schedule.frequency} disabled={!schedule.enabled} onChange={(event) => updateSchedule(test, { frequency: event.target.value as Frequency })}><option value="daily">每天</option><option value="weekly">每周</option><option value="monthly">每月</option></select>
              {schedule.frequency === "weekly" ? <select value={schedule.weekday} disabled={!schedule.enabled} onChange={(event) => updateSchedule(test, { weekday: Number(event.target.value) })}>{weekdays.map((day, index) => <option value={index} key={day}>{day}</option>)}</select> : null}
              {schedule.frequency === "monthly" ? <select value={schedule.day} disabled={!schedule.enabled} onChange={(event) => updateSchedule(test, { day: Number(event.target.value) })}>{Array.from({ length: 28 }, (_, index) => index + 1).map((day) => <option value={day} key={day}>{day} 日</option>)}</select> : null}
              <input type="time" value={schedule.time} disabled={!schedule.enabled} onChange={(event) => updateSchedule(test, { time: event.target.value })} />
            </div>;
          })}</div> : null}
          <footer><span className={configMessage === "已保存" ? "is-success" : ""}>{configMessage}</span><div><button type="button" className="is-secondary" onClick={() => setSettingsOpen(false)}>取消</button><button type="button" className="is-primary" disabled={!config || configBusy} onClick={() => void saveConfig()}>{configBusy ? "保存中…" : "保存"}</button></div></footer>
        </section>
      </div> : null}
    </div>
  );
}
