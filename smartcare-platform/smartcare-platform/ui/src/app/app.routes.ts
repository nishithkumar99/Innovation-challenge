import { inject } from '@angular/core';
import { Routes } from '@angular/router';
import { AuthService } from './core/auth/auth.service';
import { permissionGuard } from './core/auth/permission.directive';
import { ShellComponent } from './core/layout/shell.component';

/**
 * Every feature is a lazy chunk behind `canMatch`, so a staff member never downloads operator code.
 * (Guards are UX only — the backend enforces authorization.)
 */
export const routes: Routes = [
  {
    path: '',
    component: ShellComponent,
    children: [
      { path: '', pathMatch: 'full', redirectTo: () => inject(AuthService).landingRoute() },

      // ───── operators / managers ─────
      {
        path: 'ops', title: 'Control center', canMatch: [permissionGuard('fleet:view:full')],
        loadComponent: () => import('./domain/fleet/ops-workspace.component').then((m) => m.OpsWorkspaceComponent),
      },
      {
        path: 'tasks', title: 'Tasks', canMatch: [permissionGuard('task:read:all')],
        loadComponent: () => import('./domain/tasks/tasks-page.component').then((m) => m.TasksPageComponent),
      },
      {
        path: 'tasks/new', title: 'New task', canMatch: [permissionGuard('task:read:all')],
        loadComponent: () => import('./domain/tasks/tasks-page.component').then((m) => m.TaskCreatePageComponent),
      },
      {
        path: 'simulator', title: 'Task simulator', canMatch: [permissionGuard('simulation:run')],
        loadComponent: () => import('./domain/tasks/simulator-page.component').then((m) => m.SimulatorPageComponent),
      },
      {
        path: 'ai', title: 'AI Control', canMatch: [permissionGuard('fleet:view:full')],
        loadComponent: () => import('./domain/intel/intel-page.component').then((m) => m.IntelPageComponent),
      },
      {
        path: 'kpi', title: 'KPIs', canMatch: [permissionGuard('kpi:view:basic')],
        loadComponent: () => import('./domain/kpi/kpi-dashboard-page.component').then((m) => m.KpiDashboardPageComponent),
      },
      {
        path: 'audit', title: 'Audit log', canMatch: [permissionGuard('audit:view')],
        loadComponent: () => import('./domain/audit/audit-page.component').then((m) => m.AuditPageComponent),
      },

      // ───── staff / requestors ─────
      { path: 'request', pathMatch: 'full', redirectTo: 'request/mine' },
      {
        path: 'request/new', title: 'New request', canMatch: [permissionGuard('task:create')],
        loadComponent: () => import('./domain/requests/staff-pages.component').then((m) => m.NewRequestPageComponent),
      },
      {
        path: 'request/mine', title: 'My requests', canMatch: [permissionGuard('task:read:own')],
        loadComponent: () => import('./domain/requests/staff-pages.component').then((m) => m.MyRequestsPageComponent),
      },
      {
        path: 'request/track/:id', title: 'Track delivery', canMatch: [permissionGuard('task:read:own')],
        loadComponent: () => import('./domain/requests/staff-pages.component').then((m) => m.TrackDeliveryPageComponent),
      },
      {
        path: 'request/status', title: 'Department status', canMatch: [permissionGuard('fleet:view')],
        loadComponent: () => import('./domain/requests/staff-pages.component').then((m) => m.DepartmentStatusPageComponent),
      },

      { path: '**', redirectTo: () => inject(AuthService).landingRoute() },
    ],
  },
];
