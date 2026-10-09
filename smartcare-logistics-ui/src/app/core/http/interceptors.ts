import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { NotificationService } from '../layout/notification.service';

/** Adds the bearer token + site scope. (With the mock backend no HTTP is issued; this runs against the real adapters.) */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  return next(req.clone({ setHeaders: { Authorization: `Bearer ${auth.token()}`, 'X-Site-Id': 'klinikum-nord' } }));
};

/** Maps HTTP failures to user-facing behaviour: 401 re-auth, 403 permission toast, 409 conflict hint. */
export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const toast = inject(NotificationService);
  return next(req).pipe(
    catchError((err: HttpErrorResponse) => {
      if (err.status === 401) toast.push('error', 'Your session expired — please sign in again.');
      else if (err.status === 403) toast.push('error', 'You do not have permission for that action.');
      else if (err.status === 409) toast.push('warning', 'This item changed in the meantime — review and try again.');
      return throwError(() => err);
    }),
  );
};
