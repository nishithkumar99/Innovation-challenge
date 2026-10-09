import { Pipe, PipeTransform } from '@angular/core';
import { RobotViewStatus, SIM_TIME_SCALE, SLA_SIM_MIN, Task, TaskPriority } from '../core/models';

/** mm:ss from seconds (simulated hospital time). */
export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null || !isFinite(sec)) return '—';
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtMinutes(min: number): string {
  const m = Math.round(min);
  return m >= 120 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
}

/** Age of a task in simulated seconds. */
export function simAgeSec(createdAt: number, now: number): number {
  return Math.max(0, ((now - createdAt) / 1000) * SIM_TIME_SCALE);
}

export type SlaState = 'ok' | 'warn' | 'breach' | 'done';
export function slaState(t: Task, now: number): SlaState {
  if (t.status === 'DELIVERED' || t.status === 'CANCELLED') return 'done';
  const used = simAgeSec(t.createdAt, now) / 60 / SLA_SIM_MIN[t.priority];
  return used >= 1 ? 'breach' : used >= 0.75 ? 'warn' : 'ok';
}

export const ROBOT_STATUS_LABEL: Record<RobotViewStatus, string> = {
  IDLE: 'Idle', EN_ROUTE_TO_PICKUP: 'To pickup', CARRYING: 'Carrying', WAITING: 'Waiting', CHARGING: 'Charging',
  FAULT: 'Fault / E-stop', MANUAL_OVERRIDE: 'Manual control', PAUSED: 'Paused', STALE: 'No signal',
};
/** Glyph so status is never conveyed by colour alone. */
export const ROBOT_STATUS_ICON: Record<RobotViewStatus, string> = {
  IDLE: '●', EN_ROUTE_TO_PICKUP: '➜', CARRYING: '▣', WAITING: '⏸', CHARGING: '⚡', FAULT: '⚠', MANUAL_OVERRIDE: '✋', PAUSED: '❚❚', STALE: '?',
};
export const ROBOT_STATUS_COLOR: Record<RobotViewStatus, string> = {
  IDLE: '#5aa9ff', EN_ROUTE_TO_PICKUP: '#3fd08a', CARRYING: '#2cc4b0', WAITING: '#f5b942', CHARGING: '#b58cf7',
  FAULT: '#ff6b6b', MANUAL_OVERRIDE: '#ee63c8', PAUSED: '#f5b942', STALE: '#8a9bb0',
};
export const PRIORITY_RANK: Record<TaskPriority, number> = { STAT: 0, URGENT: 1, ROUTINE: 2 };

export const TASK_STATUS_LABEL: Record<Task['status'], string> = {
  QUEUED: 'Queued', ASSIGNED: 'Assigned', TO_PICKUP: 'To pickup', IN_TRANSIT: 'In transit', DELIVERED: 'Delivered', CANCELLED: 'Cancelled',
};

@Pipe({ name: 'duration' })
export class DurationPipe implements PipeTransform {
  transform(sec: number | null | undefined): string { return fmtDuration(sec); }
}
