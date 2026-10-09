import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter, withComponentInputBinding, withHashLocation } from '@angular/router';
import { FleetRestApi, FleetTransport, IS_MOCK_BACKEND } from './core/backend/fleet-backend';
import { HttpFleetRestApi, WebSocketTransport } from './core/backend/http/http-backend';
import { MockRestApi, MockTransport } from './core/backend/mock/mock-backend';
import { authInterceptor, errorInterceptor } from './core/http/interceptors';
import { routes } from './app.routes';
import { RUNTIME } from './runtime-config';

/**
 * Chosen at runtime from /config.js (`backend: 'mock' | 'real'`), so the same build runs as an offline demo
 * or against the Java/Spring Boot core. Nothing else in the app changes — stores and features only know the
 * FleetTransport / FleetRestApi contracts.
 */
export const USE_MOCK_BACKEND = RUNTIME.useMock;

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes, withComponentInputBinding(), withHashLocation()),
    provideHttpClient(withInterceptors([authInterceptor, errorInterceptor])),
    { provide: IS_MOCK_BACKEND, useValue: USE_MOCK_BACKEND },
    { provide: FleetTransport, useClass: USE_MOCK_BACKEND ? MockTransport : WebSocketTransport },
    { provide: FleetRestApi, useClass: USE_MOCK_BACKEND ? MockRestApi : HttpFleetRestApi },
  ],
};
