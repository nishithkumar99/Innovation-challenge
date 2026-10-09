import { Injectable, computed, signal } from '@angular/core';
import { Permission, Role, UserProfile } from '../models';

const STAFF: Permission[] = ['task:create', 'task:read:own', 'task:cancel:own', 'fleet:view', 'insight:view'];
const DEPT_LEAD: Permission[] = [...STAFF, 'task:read:dept', 'kpi:view:basic'];
const OPERATOR: Permission[] = [
  ...DEPT_LEAD, 'task:read:all', 'task:modify:any', 'fleet:view:full', 'insight:act',
  'override:robot', 'override:estop', 'simulation:run',
];
const MANAGER: Permission[] = [...OPERATOR, 'override:fleet', 'kpi:view:full', 'audit:view'];
const ADMIN: Permission[] = [...MANAGER, 'config:manage'];

/** Demo personas. In production the profile comes from OIDC claims (sub, name, permissions, departments, acr). */
export const PERSONAS: UserProfile[] = [
  { id: 'u-staff', name: 'Anna Keller', role: 'STAFF', roleLabel: 'Nurse · Ward 1', department: 'Ward1_Hallway', permissions: STAFF },
  { id: 'u-staff2', name: 'Sofia Rossi', role: 'STAFF', roleLabel: 'Nurse · Ward 2', department: 'Ward2_Hallway', permissions: STAFF },
  { id: 'u-staff3', name: 'Daniel Okafor', role: 'STAFF', roleLabel: 'Nurse · OR 1', department: 'OR_1_Hallway', permissions: STAFF },
  { id: 'u-staff4', name: 'Mia Hoffmann', role: 'STAFF', roleLabel: 'Nurse · OR 2', department: 'OR_2_Hallway', permissions: STAFF },
  { id: 'u-lead', name: 'Markus Brandt', role: 'DEPT_LEAD', roleLabel: 'Charge nurse · Ward 2', department: 'Ward2_Hallway', permissions: DEPT_LEAD },
  { id: 'u-op', name: 'Priya Nair', role: 'OPERATOR', roleLabel: 'Fleet operator', department: null, permissions: OPERATOR },
  { id: 'u-mgr', name: 'Jonas Weber', role: 'MANAGER', roleLabel: 'Fleet manager', department: null, permissions: MANAGER },
  { id: 'u-admin', name: 'Sai (admin)', role: 'ADMIN', roleLabel: 'Administrator', department: null, permissions: ADMIN },
];

const STEP_UP_MAX_AGE_MS = 60_000;
const KEY = 'scl.persona';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly _user = signal<UserProfile>(this.restore());
  private readonly stepUpAt = signal(0);

  readonly user = this._user.asReadonly();
  readonly permissionSet = computed(() => new Set(this._user().permissions));
  readonly isOps = computed(() => this.can('fleet:view:full'));
  readonly landingRoute = computed(() => (this.can('fleet:view:full') ? '/ops' : '/request'));

  /** Demo-only identity switch (an OIDC login would replace this). */
  switchPersona(id: string): void {
    const p = PERSONAS.find((x) => x.id === id);
    if (!p) return;
    try { sessionStorage.setItem(KEY, id); } catch { /* storage unavailable */ }
    this.stepUpAt.set(0);
    this._user.set(p);
  }

  can(permission: Permission): boolean { return this.permissionSet().has(permission); }
  hasRole(...roles: Role[]): boolean { return roles.includes(this._user().role); }

  /** Whether a fresh step-up (MFA, `acr`/`max_age`) is still valid for critical actions. */
  stepUpValid(): boolean { return Date.now() - this.stepUpAt() < STEP_UP_MAX_AGE_MS; }
  markSteppedUp(): void { this.stepUpAt.set(Date.now()); }

  /** Short-lived bearer token placeholder consumed by the HTTP interceptor. */
  token(): string { return `mock.${this._user().id}`; }

  private restore(): UserProfile {
    try {
      const id = sessionStorage.getItem(KEY);
      return PERSONAS.find((p) => p.id === id) ?? PERSONAS.find((p) => p.id === 'u-op') ?? PERSONAS[0];
    } catch {
      return PERSONAS.find((p) => p.id === 'u-op') ?? PERSONAS[0];
    }
  }
}
