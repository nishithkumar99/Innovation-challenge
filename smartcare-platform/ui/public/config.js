// Runtime configuration, loaded before the app starts (no rebuild needed to change it).
//   backend: 'mock'  -> in-browser simulated fleet (demo, no server)
//            'real'  -> Java/Spring Boot core through /api (REST) and /ws (WebSocket)
// In Docker this file is generated from the SCL_BACKEND / SCL_API_BASE / SCL_WS_URL environment variables.
window.__SCL__ = { backend: 'mock', apiBase: '/api', wsUrl: '' };
