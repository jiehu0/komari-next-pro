"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Radar, Activity, Wifi, ShieldCheck, Route, GripVertical, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { useRPC2Call } from "@/contexts/RPC2Context";
import PingChart from "./PingChart";

type PingRecord = {
  client: string;
  task_id: number;
  time: string;
  value: number;
};

type TaskInfo = {
  id: number;
  name: string;
  interval: number;
  loss: number;
  p99?: number;
  p50?: number;
  p99_p50_ratio?: number;
  min?: number;
  max?: number;
  avg?: number;
  latest?: number;
  total?: number;
  type?: string;
};

type PingTask = {
  id: number;
};

const colors = ["#F38181", "#347433", "#898AC4", "#03A6A1", "#7AD6F0", "#B388FF", "#FF8A65", "#FFD600"];

function fmtMs(v?: number) { return typeof v === "number" && Number.isFinite(v) ? `${Math.round(v)} ms` : "--"; }
function fmtPct(v?: number) { return typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(1)} %` : "--"; }
function fmtNum(v?: number, digits = 2) { return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "--"; }
function toneByLatency(v?: number) { if (typeof v !== "number" || !Number.isFinite(v)) return "neutral"; if (v < 100) return "good"; if (v < 220) return "warn"; return "bad"; }
function toneByLoss(v?: number) { if (typeof v !== "number" || !Number.isFinite(v)) return "neutral"; if (v < 2) return "good"; if (v < 8) return "warn"; return "bad"; }
function toneByVol(v?: number) { if (typeof v !== "number" || !Number.isFinite(v)) return "neutral"; if (v < 1.8) return "good"; if (v < 3.2) return "warn"; return "bad"; }

function SortableTaskCard({
  task,
  color,
  hidden,
  tone,
  canReorder,
  reordering,
  allTasksVisible,
  onToggle,
}: {
  task: TaskInfo;
  color: string;
  hidden: boolean;
  tone: string;
  canReorder: boolean;
  reordering: boolean;
  allTasksVisible: boolean;
  onToggle: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled: !canReorder || reordering,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`ds-nq-route-sortable ${isDragging ? "is-dragging" : ""}`}
    >
      <button
        className={`ds-nq-route-block ds-nq-route-block-${tone} ${hidden ? "is-hidden" : "is-active"} ${canReorder ? "is-sortable" : ""}`}
        onClick={onToggle}
        type="button"
        title={allTasksVisible ? "点击仅显示该线路" : hidden ? "点击显示该线路" : "点击隐藏该线路"}
      >
        <div className="ds-nq-route-block-top">
          <span className="ds-nq-route-dot" style={{ background: color }} />
          <span className="ds-nq-route-name">{task.name}</span>
        </div>
        <div className="ds-nq-route-pill-group">
          <div className="ds-nq-route-pill-row">
            {task.type ? <span className="ds-nq-route-pill">{String(task.type).toUpperCase()}</span> : null}
            {typeof task.interval === "number" ? <span className="ds-nq-route-pill">{task.interval}s</span> : null}
          </div>
          <div className="ds-nq-route-pill-row">
            <span className="ds-nq-route-pill">{fmtMs(task.latest ?? task.avg)}</span>
            <span className="ds-nq-route-pill">{fmtPct(task.loss)}</span>
          </div>
        </div>
      </button>
      {canReorder ? (
        <button
          {...attributes}
          {...listeners}
          className="ds-nq-route-drag-handle"
          type="button"
          disabled={reordering}
          aria-label={`拖拽调整 ${task.name} 的顺序`}
          title="拖拽调整顺序"
          onClick={(event) => event.stopPropagation()}
        >
          <GripVertical size={16} />
        </button>
      ) : null}
    </div>
  );
}

export default function NetworkQualityPanel({ uuid }: { uuid: string }) {
  const { call } = useRPC2Call();
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hiddenLines, setHiddenLines] = useState<Record<string, boolean>>({});
  const [canReorder, setCanReorder] = useState(false);
  const [reordering, setReordering] = useState(false);
  const sensors = useSensors(
    useSensor(MouseSensor),
    useSensor(TouchSensor),
    useSensor(KeyboardSensor),
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/api/me")
      .then((response) => response.ok ? response.json() : null)
      .then((account) => {
        if (!cancelled) setCanReorder(account?.logged_in === true);
      })
      .catch(() => {
        if (!cancelled) setCanReorder(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!uuid) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        type RpcResp = { count: number; records: PingRecord[]; tasks?: TaskInfo[]; from?: string; to?: string; };
        const result = await call<any, RpcResp>("common:getRecords", { uuid, type: "ping", hours: 24 });
        if (cancelled) return;
        const nextTasks = result?.tasks || [];
        setTasks(nextTasks);
        setHiddenLines((prev) => {
          const next = { ...prev };
          for (const t of nextTasks) {
            if (!(String(t.id) in next)) next[String(t.id)] = false;
          }
          return next;
        });
      } catch (err: any) {
        if (cancelled) return;
        setError(err?.message || "加载失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [uuid, call]);

  const stats = useMemo(() => {
    const valid = tasks.filter((t) => typeof t.avg === "number" || typeof t.latest === "number");
    const latestLatency = valid.length ? valid.reduce((s, t) => s + (typeof t.latest === "number" ? t.latest : (t.avg || 0)), 0) / valid.length : undefined;
    const avgLoss = tasks.length ? tasks.reduce((s, t) => s + (typeof t.loss === "number" ? t.loss : 0), 0) / tasks.length : undefined;
    const volTasks = tasks.filter((t) => typeof t.p99_p50_ratio === "number");
    const avgVol = volTasks.length ? volTasks.reduce((s, t) => s + (t.p99_p50_ratio || 0), 0) / volTasks.length : undefined;
    const successRate = typeof avgLoss === 'number' ? Math.max(0, 100 - avgLoss) : undefined;
    return { latestLatency, avgLoss, avgVol, successRate };
  }, [tasks]);

  const toggleTask = (id: number) => {
    const key = String(id);
    setHiddenLines((prev) => {
      const allVisible = tasks.every((task) => !prev[String(task.id)]);
      if (!allVisible) return { ...prev, [key]: !prev[key] };

      const next: Record<string, boolean> = {};
      tasks.forEach((task) => { next[String(task.id)] = task.id !== id; });
      return next;
    });
  };

  const allTasksVisible = tasks.every((task) => !hiddenLines[String(task.id)]);

  const handleDragEnd = async ({ active, over }: DragEndEvent) => {
    if (!canReorder || reordering || !over || active.id === over.id) return;

    const oldIndex = tasks.findIndex((task) => task.id === active.id);
    const newIndex = tasks.findIndex((task) => task.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const previousTasks = tasks;
    const nextTasks = arrayMove(tasks, oldIndex, newIndex);
    setTasks(nextTasks);
    setReordering(true);

    try {
      const allTasks = await call<undefined, PingTask[]>("admin:getAllPingTasks");
      const visibleIds = new Set(nextTasks.map((task) => task.id));
      let visibleIndex = 0;
      const mergedIds = allTasks.map((task) =>
        visibleIds.has(task.id) ? nextTasks[visibleIndex++].id : task.id
      );
      const order = Object.fromEntries(mergedIds.map((id, index) => [String(id), index]));
      await call<Record<string, number>, null>("admin:orderPingTask", order);
      toast.success("线路顺序已保存");
    } catch (err: any) {
      setTasks(previousTasks);
      toast.error(`线路顺序保存失败：${err?.message || "未知错误"}`);
    } finally {
      setReordering(false);
    }
  };

  const handleRestoreDefault = async () => {
    if (!canReorder || reordering) return;

    const previousTasks = tasks;
    const nextTasks = [...tasks].sort((a, b) => a.id - b.id);
    setTasks(nextTasks);
    setReordering(true);

    try {
      const allTasks = await call<undefined, PingTask[]>("admin:getAllPingTasks");
      const sortedIds = [...allTasks].sort((a, b) => a.id - b.id).map((task) => task.id);
      const order = Object.fromEntries(sortedIds.map((id, index) => [String(id), index]));
      await call<Record<string, number>, null>("admin:orderPingTask", order);
      toast.success("已恢复默认排序");
    } catch (err: any) {
      setTasks(previousTasks);
      toast.error(`恢复默认排序失败：${err?.message || "未知错误"}`);
    } finally {
      setReordering(false);
    }
  };

  return (
    <div className="ds-nq-page ds-nq-page-redesign">
      <div className="ds-nq-overview-grid ds-nq-overview-grid-4">
        <div className={`ds-nq-kpi ds-nq-kpi-${toneByLatency(stats.latestLatency)}`}>
          <div className="ds-nq-kpi-head"><span className="ds-nq-kpi-ico"><Radar size={16} /></span><span>平均延迟</span></div>
          <div className="ds-nq-kpi-value ds-nq-kpi-value-center">{fmtMs(stats.latestLatency)}</div>
        </div>
        <div className={`ds-nq-kpi ds-nq-kpi-${toneByVol(stats.avgVol)}`}>
          <div className="ds-nq-kpi-head"><span className="ds-nq-kpi-ico"><Activity size={16} /></span><span>抖动（波动）</span></div>
          <div className="ds-nq-kpi-value ds-nq-kpi-value-center">{fmtNum(stats.avgVol, 2)}</div>
        </div>
        <div className={`ds-nq-kpi ds-nq-kpi-${toneByLoss(stats.avgLoss)}`}>
          <div className="ds-nq-kpi-head"><span className="ds-nq-kpi-ico"><Wifi size={16} /></span><span>丢包率</span></div>
          <div className="ds-nq-kpi-value ds-nq-kpi-value-center">{fmtPct(stats.avgLoss)}</div>
        </div>
        <div className={`ds-nq-kpi ds-nq-kpi-${toneByLoss(stats.avgLoss)}`}>
          <div className="ds-nq-kpi-head"><span className="ds-nq-kpi-ico"><ShieldCheck size={16} /></span><span>成功率</span></div>
          <div className="ds-nq-kpi-value ds-nq-kpi-value-center">{fmtPct(stats.successRate)}</div>
        </div>
      </div>

      <div className="ds-nq-monitor-shell ds-nq-monitor-shell-v2">
        <section className="ds-nq-side-card">
          <header className="ds-nq-side-card-head">
            <div className="ds-nq-side-card-title"><Route size={16} /> 延迟监控</div>
            {canReorder ? (
              <div className="ds-nq-side-card-actions">
                <button
                  className="ds-nq-restore-order"
                  type="button"
                  disabled={reordering}
                  onClick={handleRestoreDefault}
                  aria-label="恢复默认排序"
                  title="按任务创建顺序恢复默认排序"
                >
                  <RotateCcw size={12} />
                  <span>恢复默认</span>
                </button>
                <span className="ds-nq-reorder-status">{reordering ? "保存中…" : "拖拽排序"}</span>
              </div>
            ) : null}
          </header>
          <div className="ds-nq-side-card-body">
            <div className="ds-nq-side-scroll">
              <DndContext
                collisionDetection={closestCenter}
                modifiers={[restrictToVerticalAxis]}
                onDragEnd={handleDragEnd}
                sensors={sensors}
              >
                <SortableContext items={tasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
                  {tasks.map((task, idx) => (
                    <SortableTaskCard
                      key={task.id}
                      task={task}
                      color={colors[idx % colors.length]}
                      hidden={!!hiddenLines[String(task.id)]}
                      tone={toneByLatency(task.latest ?? task.avg)}
                      canReorder={canReorder}
                      reordering={reordering}
                      allTasksVisible={allTasksVisible}
                      onToggle={() => toggleTask(task.id)}
                    />
                  ))}
                </SortableContext>
              </DndContext>
              {loading ? <div className="ds-nq-monitor-note">正在加载线路数据…</div> : null}
              {error ? <div className="ds-nq-monitor-note ds-nq-monitor-note-warn">{error}</div> : null}
            </div>
          </div>
        </section>

        <section className="ds-nq-trend-card">
          <header className="ds-nq-side-card-head ds-nq-trend-card-head">
            <div className="ds-nq-side-card-title"><Activity size={16} /> 延迟趋势</div>
          </header>
          <div className="ds-nq-trend-card-body">
            <PingChart
              uuid={uuid}
              taskOrder={tasks.map((task) => task.id)}
              externalHiddenLines={hiddenLines}
              onHiddenLinesChange={setHiddenLines}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
