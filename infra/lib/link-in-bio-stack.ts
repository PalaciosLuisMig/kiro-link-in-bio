// The single stack of the app: Storage, Realtime, Api and Frontend.
//
// The order follows the dependencies between constructs: Realtime needs the
// table; Api needs the WebSocket URL (`admin-api` returns it with each ticket);
// Frontend needs the API host (CloudFront origin) and the WebSocket host (the
// Panel's CSP).

import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

import { Api } from './api.js';
import { Frontend } from './frontend.js';
import { FRONTEND_DIST } from './paths.js';
import { Realtime } from './realtime.js';
import { Storage } from './storage.js';

export interface LinkInBioStackProps extends StackProps {
  /** Built frontend to deploy. It must exist when the stack is synthesized. */
  readonly frontendAssetPath?: string;
}

export class LinkInBioStack extends Stack {
  readonly storage: Storage;
  readonly realtime: Realtime;
  readonly api: Api;
  readonly frontend: Frontend;

  constructor(scope: Construct, id: string, props: LinkInBioStackProps = {}) {
    super(scope, id, props);

    this.storage = new Storage(this, 'Storage');
    this.realtime = new Realtime(this, 'Realtime', { table: this.storage.table });
    this.api = new Api(this, 'Api', {
      table: this.storage.table,
      wsUrl: this.realtime.wsUrl,
    });
    this.frontend = new Frontend(this, 'Frontend', {
      apiHost: this.api.apiHost,
      wsHost: this.realtime.wsHost,
      assetPath: props.frontendAssetPath ?? FRONTEND_DIST,
    });

    new CfnOutput(this, 'SiteUrl', {
      value: `https://${this.frontend.distribution.distributionDomainName}`,
    });
    new CfnOutput(this, 'WebSocketUrl', { value: this.realtime.wsUrl });
  }
}
