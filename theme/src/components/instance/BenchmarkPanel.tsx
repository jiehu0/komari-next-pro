"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, Cpu, HardDrive, MemoryStick } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import Loading from "@/components/loading";

type FioResult = {
  read_mib_s: number;
  write_mib_s: number;
  total_mib_s: number;
  read_iops: number;
  write_iops: number;
  total_iops: number;
};

type BenchmarkRecord = {
  time: string;
  status: string;
  error?: string;
  sysbench?: {
    cpu: { single_eps: number; multi_eps: number; threads: number };
    memory: { read_mib_s: number; write_mib_s: number };
  };
  fio?: Record<"4k" | "64k" | "512k" | "1m", FioResult>;
};

type HistoryResponse = {
  retention_days: number;
  updated_at: string | null;
  records: BenchmarkRecord[];
};

type View = "sysbench" | "memory" | "disk";
type BlockSize = "4k" | "64k" | "512k" | "1m";
type DiskMetric = "throughput" | "iops";

const colors = {
  blue: "#2388c2",
  amber: "#bd7700",
  green: "#07856b",
};

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
  return (
    <div className="ds-bench-summary-item">
      <span>{label}</span>
      <strong>{formatValue(value, unit)}</strong>
    </div>
  );
}

export default function BenchmarkPanel({ uuid }: { uuid: string }) {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [view, setView] = useState<View>("sysbench");
  const [blockSize, setBlockSize] = useState<BlockSize>("4k");
  const [diskMetric, setDiskMetric] = useState<DiskMetric>("throughput");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!uuid) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/plugin/komari-benchmark/history?uuid=${encodeURIComponent(uuid)}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 404 ? "尚无基准测试数据" : `HTTP ${response.status}`);
        const body = await response.json();
        return body.data as HistoryResponse;
      })
      .then((history) => setData(history))
      .catch((reason) => {
        if (reason?.name !== "AbortError") setError(reason?.message || "加载失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [uuid]);

  const successful = useMemo(
    () => (data?.records || []).filter((record) => record.status === "ok" && record.sysbench && record.fio),
    [data],
  );
  const latest = successful[successful.length - 1];
  const latestRecord = data?.records?.[data.records.length - 1];
  const failedCount = (data?.records || []).filter((record) => record.status !== "ok").length;

  const chart = useMemo(() => {
    const records = data?.records || [];
    if (view === "sysbench") {
      return {
        unit: "events/s",
        series: [
          { key: "single", label: "单核", color: colors.blue },
          { key: "multi", label: "多核", color: colors.amber },
        ],
        rows: records.map((record) => ({
          time: record.time,
          single: record.status === "ok" ? record.sysbench?.cpu.single_eps ?? null : null,
          multi: record.status === "ok" ? record.sysbench?.cpu.multi_eps ?? null : null,
        })),
      };
    }
    if (view === "memory") {
      return {
        unit: "MiB/s",
        series: [
          { key: "read", label: "读", color: colors.blue },
          { key: "write", label: "写", color: colors.amber },
        ],
        rows: records.map((record) => ({
          time: record.time,
          read: record.status === "ok" ? record.sysbench?.memory.read_mib_s ?? null : null,
          write: record.status === "ok" ? record.sysbench?.memory.write_mib_s ?? null : null,
        })),
      };
    }
    const suffix = diskMetric === "throughput" ? "mib_s" : "iops";
    return {
      unit: diskMetric === "throughput" ? "MiB/s" : "IOPS",
      series: [
        { key: "read", label: "读", color: colors.blue },
        { key: "write", label: "写", color: colors.amber },
        { key: "total", label: "读写", color: colors.green },
      ],
      rows: records.map((record) => {
        const fio = record.status === "ok" ? record.fio?.[blockSize] : undefined;
        return {
          time: record.time,
          read: fio?.[`read_${suffix}` as keyof FioResult] ?? null,
          write: fio?.[`write_${suffix}` as keyof FioResult] ?? null,
          total: fio?.[`total_${suffix}` as keyof FioResult] ?? null,
        };
      }),
    };
  }, [blockSize, data, diskMetric, view]);

  const latestFio = latest?.fio?.[blockSize];
  const diskUnit = diskMetric === "throughput" ? "MiB/s" : "IOPS";

  if (loading) return <div className="ds-bench-loading"><Loading /></div>;

  return (
    <div className="ds-bench-card">
      <header className="ds-bench-head">
        <div>
          <h2>基准测试</h2>
          <p>最近 {data?.retention_days || 30} 天趋势</p>
        </div>
        <div className="ds-bench-tabs" role="tablist" aria-label="基准测试类型">
          <button type="button" className={view === "sysbench" ? "is-active" : ""} onClick={() => setView("sysbench")}><Cpu size={15} />Sysbench</button>
          <button type="button" className={view === "memory" ? "is-active" : ""} onClick={() => setView("memory")}><MemoryStick size={15} />内存</button>
          <button type="button" className={view === "disk" ? "is-active" : ""} onClick={() => setView("disk")}><HardDrive size={15} />磁盘</button>
        </div>
      </header>

      {view === "disk" ? (
        <div className="ds-bench-disk-controls">
          <div className="ds-bench-subtabs">
            {(["4k", "64k", "512k", "1m"] as BlockSize[]).map((size) => (
              <button type="button" key={size} className={blockSize === size ? "is-active" : ""} onClick={() => setBlockSize(size)}>{size.toUpperCase()}</button>
            ))}
          </div>
          <div className="ds-bench-subtabs">
            <button type="button" className={diskMetric === "throughput" ? "is-active" : ""} onClick={() => setDiskMetric("throughput")}>吞吐</button>
            <button type="button" className={diskMetric === "iops" ? "is-active" : ""} onClick={() => setDiskMetric("iops")}>IOPS</button>
          </div>
        </div>
      ) : null}

      <div className={`ds-bench-summary ${view === "disk" ? "ds-bench-summary-3" : ""}`}>
        {view === "sysbench" ? (
          <>
            <SummaryItem label="单核" value={latest?.sysbench?.cpu.single_eps} unit="events/s" />
            <SummaryItem label={`多核 · ${latest?.sysbench?.cpu.threads || "--"} 线程`} value={latest?.sysbench?.cpu.multi_eps} unit="events/s" />
          </>
        ) : view === "memory" ? (
          <>
            <SummaryItem label="读" value={latest?.sysbench?.memory.read_mib_s} unit="MiB/s" />
            <SummaryItem label="写" value={latest?.sysbench?.memory.write_mib_s} unit="MiB/s" />
          </>
        ) : (
          <>
            <SummaryItem label="读" value={latestFio?.[diskMetric === "throughput" ? "read_mib_s" : "read_iops"]} unit={diskUnit} />
            <SummaryItem label="写" value={latestFio?.[diskMetric === "throughput" ? "write_mib_s" : "write_iops"]} unit={diskUnit} />
            <SummaryItem label="读写" value={latestFio?.[diskMetric === "throughput" ? "total_mib_s" : "total_iops"]} unit={diskUnit} />
          </>
        )}
      </div>

      {successful.length ? (
        <div className="ds-bench-chart">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chart.rows} margin={{ top: 18, right: 24, bottom: 8, left: 10 }}>
              <CartesianGrid vertical={false} strokeOpacity={0.35} />
              <XAxis
                dataKey="time"
                tickLine={false}
                minTickGap={32}
                tickFormatter={(value) => new Date(value).toLocaleDateString(undefined, { month: "numeric", day: "numeric" })}
              />
              <YAxis tickLine={false} axisLine={false} width={54} tickFormatter={(value) => compactNumber(Number(value))} />
              <Tooltip
                labelFormatter={(value) => new Date(String(value)).toLocaleString()}
                formatter={(value: number, name: string) => [formatValue(Number(value), chart.unit), chart.series.find((series) => series.key === name)?.label || name]}
              />
              {chart.series.map((series) => (
                <Line
                  key={series.key}
                  type="linear"
                  dataKey={series.key}
                  name={series.key}
                  stroke={series.color}
                  strokeWidth={2.2}
                  dot={{ r: 3, strokeWidth: 0, fill: series.color }}
                  activeDot={{ r: 5 }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="ds-bench-empty">
          <Activity size={18} />
          <span>{error || (latestRecord?.status !== "ok" && latestRecord ? formatFailure(latestRecord.error) : "尚无成功的基准测试数据")}</span>
        </div>
      )}

      <footer className="ds-bench-foot">
        <span>{latest ? `最近成功：${new Date(latest.time).toLocaleString()}` : "等待首次测试"}</span>
        {failedCount > 0 ? <span>{failedCount} 个失败点未绘制</span> : null}
      </footer>
    </div>
  );
}
