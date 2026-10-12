import React, { createContext, useContext } from "react";
import { DndContext, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
export function SortArea({ ids, onOrder, children }: { ids: string[]; onOrder?: (ids: string[]) => void; children: React.ReactNode }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 7 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  return <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={({ active, over }) => {
    if (!onOrder || !over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id)), to = ids.indexOf(String(over.id));
    if (from >= 0 && to >= 0) onOrder(arrayMove(ids, from, to));
  }}><SortableContext items={ids} strategy={rectSortingStrategy}>{children}</SortableContext></DndContext>;
}
const HandleContext = createContext<React.ReactNode>(null);
export function SortHandle() { return <>{useContext(HandleContext)}</>; }
export function SortItem({ id, enabled, row, children, className = "" }: { id: string; enabled: boolean; row?: boolean; children: React.ReactNode; className?: string }) {
  const s = useSortable({ id, disabled: !enabled });
  const handle = enabled ? <button type="button" className="ds-cloud-grip" aria-label="拖动排序" ref={s.setActivatorNodeRef} {...s.attributes} {...s.listeners} onClick={e => { e.preventDefault(); e.stopPropagation(); }}><GripVertical size={16} /></button> : null;
  const style = { transform: CSS.Transform.toString(s.transform), transition: s.transition, position: "relative" as const, zIndex: s.isDragging ? 10 : undefined, opacity: s.isDragging ? .7 : 1 };
  return <HandleContext.Provider value={handle}>{row ? <tr ref={s.setNodeRef} style={style} className={className}>{children}</tr> : <div ref={s.setNodeRef} style={style} className={`ds-cloud-card ${className}`}>{handle}{children}</div>}</HandleContext.Provider>;
}
