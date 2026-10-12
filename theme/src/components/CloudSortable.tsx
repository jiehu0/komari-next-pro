import React, { createContext, useContext } from "react";
import { DndContext, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable, arrayMove, rectSortingStrategy, verticalListSortingStrategy, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
const BusyContext = createContext(false);
export function SortArea({ ids, onOrder, children, rows = false, disabled = false }: { ids: string[]; onOrder?: (ids: string[]) => void; children: React.ReactNode; rows?: boolean; disabled?: boolean }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 7 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  return <BusyContext.Provider value={disabled}><DndContext modifiers={rows ? [restrictToVerticalAxis] : []} sensors={sensors} collisionDetection={closestCenter} onDragEnd={({ active, over }) => {
    if (disabled || !onOrder || !over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id)), to = ids.indexOf(String(over.id));
    if (from >= 0 && to >= 0) onOrder(arrayMove(ids, from, to));
  }}><SortableContext items={ids} strategy={rows ? verticalListSortingStrategy : rectSortingStrategy}>{children}</SortableContext></DndContext></BusyContext.Provider>;
}
const HandleContext = createContext<React.ReactNode>(null);
export function SortHandle() { return <>{useContext(HandleContext)}</>; }
export function SortItem({ id, enabled, row, children, className = "" }: { id: string; enabled: boolean; row?: boolean; children: React.ReactNode; className?: string }) {
  const busy = useContext(BusyContext);
  const s = useSortable({ id, disabled: !enabled || busy, transition: { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" } });
  const handle = enabled ? <button type="button" className="ds-cloud-grip" aria-label="拖动排序" disabled={busy} ref={s.setActivatorNodeRef} {...s.attributes} {...s.listeners} onClick={e => { e.preventDefault(); e.stopPropagation(); }}><GripVertical size={16} /></button> : null;
  const transform = CSS.Translate.toString(s.transform);
  const transition = s.isDragging ? "none" : (s.transition || "none");
  const style = { transform, transition, "--cloud-transform": transform || "none", "--cloud-transition": transition, position: "relative", zIndex: s.isDragging ? 10 : undefined, opacity: s.isDragging ? .85 : 1 } as React.CSSProperties;
  const stateClass = `${s.isDragging ? "is-dragging" : ""} ${s.isOver ? "is-drop-target" : ""}`;
  return <HandleContext.Provider value={handle}>{row ? <tr ref={s.setNodeRef} style={style} className={`ds-cloud-row ${stateClass} ${className}`}>{children}</tr> : <div ref={s.setNodeRef} style={style} className={`ds-cloud-card ${stateClass} ${className}`}>{children}</div>}</HandleContext.Provider>;
}
