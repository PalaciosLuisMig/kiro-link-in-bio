// Lambda entry point of the notifier, triggered by the DynamoDB stream of
// `LinkInBioTable`. It takes no event parameter on purpose: the stream records
// only signal that metrics or events changed, and their content is never used.
// Composition runs once at cold start.

import { composeNotifyPanel } from './notify-panel-composition.js';
import { handleNotifyPanel } from './notify-panel-routes.js';

const deps = composeNotifyPanel(process.env);

export async function handler(): Promise<void> {
  await handleNotifyPanel(deps);
}
