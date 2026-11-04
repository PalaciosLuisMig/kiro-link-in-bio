// Starts the local development server: `npm run dev:api` (or `npm run dev`, which
// also starts the web). Everything is in memory and nothing talks to AWS.
//
// Settings come from the environment, and `npm run dev:api` loads the `.env` file of
// the project root first (copy `.env.example`):
//   LOCAL_OWNER_TOKEN  REQUIRED. The token the Panel signs in with (32+ characters).
//   PORT               port of this server               (default 8787)
//   LOCAL_WS_URL       WebSocket URL given to the Panel  (default: through the Vite proxy)

import { ConfigError, readLocalConfig } from './config.js';
import { createLocalServer } from './local-server.js';

/** `process.stdout` and not `console`: only the Logger adapter may touch `console`. */
const say = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

let config;
try {
  config = readLocalConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`\nNo se puede arrancar el servidor local.\n${error.message}\n\n`);
    process.exit(1);
  }
  throw error;
}

const app = await createLocalServer({
  ownerToken: config.ownerToken,
  wsUrl: config.wsUrl,
  seed: true,
});
// Only the loopback interface: this server holds no real data, but nobody else on the
// network should be able to reach it.
const port = await app.listen(config.port, '127.0.0.1');

say('');
say('  Link in Bio · servidor local (datos en memoria, sin AWS)');
say('');
say(`  API:              http://localhost:${port}`);
say('  Token del Panel:  el valor de LOCAL_OWNER_TOKEN en tu archivo .env');
say('');
say('  Con la web (npm run dev):');
say('    Página pública  http://localhost:5173/');
say('    Panel           http://localhost:5173/panel.html');
say('');
say('  Los datos se pierden al parar el servidor. Ctrl+C para salir.');
say('');

const stop = (): void => {
  void app.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
