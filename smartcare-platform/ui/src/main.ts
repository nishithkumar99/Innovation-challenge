import { RUNTIME } from './app/runtime-config';
import { loadRuntimeMap } from './app/core/map-data';

// The map comes from the Java core (which loads the simulator's route_nodes.json). It has to be installed
// before the application modules are evaluated, so they are imported only afterwards.
(RUNTIME.useMock ? Promise.resolve() : loadRuntimeMap(RUNTIME.apiBase))
  .then(async () => {
    const [{ bootstrapApplication }, { appConfig }, { App }] = await Promise.all([
      import('@angular/platform-browser'), import('./app/app.config'), import('./app/app'),
    ]);
    await bootstrapApplication(App, appConfig);
  })
  .catch((err) => console.error(err));
