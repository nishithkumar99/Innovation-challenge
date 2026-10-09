import { Directive, EmbeddedViewRef, TemplateRef, ViewContainerRef, effect, inject, input } from '@angular/core';
import { CanMatchFn, Router } from '@angular/router';
import { Permission } from '../models';
import { AuthService } from './auth.service';

/**
 * `<button *sclHasPermission="'override:robot'; else readOnly">`
 * UX affordance only — the backend is the security boundary.
 */
@Directive({ selector: '[sclHasPermission]' })
export class HasPermissionDirective {
  readonly sclHasPermission = input.required<Permission | Permission[]>();
  readonly sclHasPermissionElse = input<TemplateRef<unknown> | null>(null);

  private readonly auth = inject(AuthService);
  private readonly tpl = inject(TemplateRef<unknown>);
  private readonly vcr = inject(ViewContainerRef);
  private view: EmbeddedViewRef<unknown> | null = null;

  constructor() {
    effect(() => {
      const req = this.sclHasPermission();
      const list = Array.isArray(req) ? req : [req];
      const allowed = list.every((p) => this.auth.can(p));
      const otherwise = this.sclHasPermissionElse();
      this.vcr.clear();
      this.view = null;
      if (allowed) this.view = this.vcr.createEmbeddedView(this.tpl);
      else if (otherwise) this.vcr.createEmbeddedView(otherwise);
    });
  }
}

/** Functional guard for lazy routes: `canMatch` prevents the chunk from even being downloaded. */
export const permissionGuard = (permission: Permission): CanMatchFn => () => {
  const auth = inject(AuthService);
  return auth.can(permission) ? true : inject(Router).parseUrl(auth.landingRoute());
};
