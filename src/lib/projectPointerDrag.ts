import type { PointerEvent as ReactPointerEvent } from "react";
import type { ProjectDropPosition } from "./projectOrdering";

export interface ProjectDropTarget { id: string; position: ProjectDropPosition }
export interface ProjectDragActions {
  isPinned: (projectId: string) => boolean;
  setDragged: (projectId: string | null) => void;
  setTarget: (target: ProjectDropTarget | null) => void;
  onDrop: (target: ProjectDropTarget) => void;
}

/** Pointer reordering for workspace rows. The owner decides what a drop changes. */
export function startProjectPointerDrag(event: ReactPointerEvent<HTMLDivElement>, projectId: string, actions: ProjectDragActions): void {
  if ((event.button !== undefined && event.button !== 0) || (event.target as HTMLElement).closest(".row-menu")) return;
  const pointerId = event.pointerId;
  const startX = event.clientX;
  const startY = event.clientY;
  const workspaceList = event.currentTarget.closest(".workspace-list") as HTMLElement | null;
  let active = false;
  let target: ProjectDropTarget | null = null;
  const setTarget = (next: ProjectDropTarget | null) => {
    if (target?.id === next?.id && target?.position === next?.position) return;
    target = next;
    actions.setTarget(next);
  };
  const isCurrentPointer = (candidate: number | undefined) =>
    pointerId === undefined || candidate === undefined || candidate === pointerId;

  // A drag reorders within the pinned or the unpinned block, never across
  // them, so only same-group rows are offered as drop targets. The indicator
  // then always sits where the project will actually land, instead of
  // promising a slot the pinned-first order would immediately take back.
  const sourcePinned = actions.isPinned(projectId);
  const inSourceGroup = (row: HTMLElement) => (row.dataset.projectPinned === "true") === sourcePinned;

  const updateTarget = (clientX: number, clientY: number) => {
    if (!workspaceList) return;
    const listBounds = workspaceList.getBoundingClientRect();
    if (clientY < listBounds.top - 8 || clientY > listBounds.bottom + 8) {
      setTarget(null);
      return;
    }
    if (clientY < listBounds.top + 24) workspaceList.scrollTop -= 8;
    else if (clientY > listBounds.bottom - 24) workspaceList.scrollTop += 8;

    const pointedRow = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-project-id]");
    if (pointedRow?.dataset.projectId === projectId) {
      setTarget(null);
      return;
    }
    const rows = [...workspaceList.querySelectorAll<HTMLElement>("[data-project-id]")]
      .filter((row) => row.dataset.projectId !== projectId && inSourceGroup(row));
    const targetRow = pointedRow && pointedRow.dataset.projectId !== projectId && inSourceGroup(pointedRow) && workspaceList.contains(pointedRow)
      ? pointedRow
      : rows.reduce<HTMLElement | null>((nearest, row) => {
          if (!nearest) return row;
          const rowDistance = Math.abs(clientY - (row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2));
          const nearestBounds = nearest.getBoundingClientRect();
          const nearestDistance = Math.abs(clientY - (nearestBounds.top + nearestBounds.height / 2));
          return rowDistance < nearestDistance ? row : nearest;
        }, null);
    const targetId = targetRow?.dataset.projectId;
    if (!targetRow || !targetId) return;
    const bounds = targetRow.getBoundingClientRect();
    setTarget({ id: targetId, position: clientY < bounds.top + bounds.height / 2 ? "before" : "after" });
  };

  const onMove = (moveEvent: PointerEvent) => {
    if (!isCurrentPointer(moveEvent.pointerId)) return;
    if (!active && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 5) return;
    moveEvent.preventDefault();
    if (!active) {
      active = true;
      actions.setDragged(projectId);
      document.body.classList.add("project-reordering");
    }
    updateTarget(moveEvent.clientX, moveEvent.clientY);
  };

  const onEnd = (endEvent: PointerEvent) => {
    if (!isCurrentPointer(endEvent.pointerId)) return;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onEnd);
    window.removeEventListener("pointercancel", onEnd);
    document.body.classList.remove("project-reordering");
    if (endEvent.type === "pointerup" && active && target) actions.onDrop(target);
    actions.setDragged(null);
    setTarget(null);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onEnd);
  window.addEventListener("pointercancel", onEnd);
}
