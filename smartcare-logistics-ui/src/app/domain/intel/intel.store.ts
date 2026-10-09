import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, of, switchMap, timer } from 'rxjs';
import { FleetRestApi } from '../../core/backend/fleet-backend';
import { Intel } from '../../core/intel.models';

/** Polls the intelligence view of the core (GET /api/intel) every 2 s while the AI Control page is open. */
@Injectable()
export class IntelStore {
  private readonly api = inject(FleetRestApi);

  readonly data = signal<Intel | null>(null);
  readonly error = signal<string | null>(null);
  readonly updatedAt = signal(0);
  readonly loading = computed(() => this.data() === null && this.error() === null);

  constructor() {
    timer(0, 2000).pipe(
      switchMap(() => this.api.getIntel().pipe(catchError((e) => { this.error.set(e?.status === 403 ? 'You do not have permission to view this page.' : 'The core did not answer — showing the last data.'); return of(null); }))),
      takeUntilDestroyed(inject(DestroyRef)),
    ).subscribe((d) => {
      if (!d) return;
      this.error.set(null);
      this.data.set(d);
      this.updatedAt.set(Date.now());
    });
  }
}
