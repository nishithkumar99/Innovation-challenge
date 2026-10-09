import { Injectable, inject, signal } from '@angular/core';
import { AuthService } from '../auth/auth.service';

export interface DialogField {
  key: string;
  label: string;
  type: 'select' | 'text' | 'number' | 'textarea';
  options?: { value: string; label: string }[];
  required?: boolean;
  value?: string;
  placeholder?: string;
}
export interface DialogConfig {
  title: string;
  message?: string;
  fields?: DialogField[];
  confirmLabel?: string;
  tone?: 'default' | 'danger';
}
export type DialogResult = Record<string, string>;
interface ActiveDialog { cfg: DialogConfig; resolve: (v: DialogResult | null) => void; }

export const REASON_OPTIONS = [
  { value: 'congestion', label: 'Congestion / traffic' },
  { value: 'patient-safety', label: 'Patient or staff safety' },
  { value: 'priority-change', label: 'Clinical priority change' },
  { value: 'robot-issue', label: 'Robot issue' },
  { value: 'maintenance', label: 'Maintenance / cleaning' },
  { value: 'other', label: 'Other (see notes)' },
];

/** Promise-based modal host (rendered once by the shell with a native <dialog>). */
@Injectable({ providedIn: 'root' })
export class DialogService {
  private readonly auth = inject(AuthService);
  readonly active = signal<ActiveDialog | null>(null);

  open(cfg: DialogConfig): Promise<DialogResult | null> {
    return new Promise((resolve) => this.active.set({ cfg, resolve }));
  }

  close(result: DialogResult | null): void {
    const a = this.active();
    this.active.set(null);
    a?.resolve(result);
  }

  /** Reason capture for medium+ risk operations. Resolves to the reason text or null if cancelled. */
  async askReason(title: string, message: string, tone: 'default' | 'danger' = 'default', confirmLabel = 'Confirm'): Promise<string | null> {
    const r = await this.open({
      title, message, tone, confirmLabel,
      fields: [
        { key: 'reason', label: 'Reason', type: 'select', options: REASON_OPTIONS, required: true, value: 'congestion' },
        { key: 'notes', label: 'Notes (optional)', type: 'textarea' },
      ],
    });
    if (!r) return null;
    return r['notes'] ? `${r['reason']}: ${r['notes']}` : r['reason'];
  }

  /** Step-up (MFA) check for critical actions. Demo implementation accepts any 6-digit code. */
  async ensureStepUp(): Promise<boolean> {
    if (this.auth.stepUpValid()) return true;
    const r = await this.open({
      title: 'Re-authentication required',
      message: 'This is a critical action. Enter your 6-digit MFA code to continue. (Demo: any 6 digits are accepted.)',
      confirmLabel: 'Verify',
      fields: [{ key: 'code', label: 'MFA code', type: 'text', required: true, placeholder: '123456' }],
    });
    if (r && /^\d{6}$/.test(r['code'] ?? '')) { this.auth.markSteppedUp(); return true; }
    return false;
  }

  confirm(title: string, message: string, confirmLabel = 'Confirm', tone: 'default' | 'danger' = 'default'): Promise<boolean> {
    return this.open({ title, message, confirmLabel, tone }).then((r) => !!r);
  }
}
