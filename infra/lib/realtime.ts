// `Realtime` construct: the WebSocket API and the Lambdas behind it, `ws`
// (connections) and `notify-panel` (pushes the snapshot when data changes).

import { Duration, Stack } from 'aws-cdk-lib';
import { WebSocketApi, WebSocketStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { FilterCriteria, FilterRule, StartingPosition } from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

import { ENV_VARS, ROUTE_SELECTION_EXPRESSION } from '@link-in-bio/shared';

import { backendFunction } from './lambdas.js';

/** Name of the WebSocket stage. It is part of every connection URL. */
export const WEBSOCKET_STAGE_NAME = 'prod';

export interface RealtimeProps {
  readonly table: ITable;
}

export class Realtime extends Construct {
  readonly webSocketApi: WebSocketApi;
  readonly stage: WebSocketStage;
  readonly wsFunction: NodejsFunction;
  readonly notifyFunction: NodejsFunction;

  /** `wss://` URL the Panel connects to (returned with each ticket). */
  get wsUrl(): string {
    return this.stage.url;
  }

  /** Host of the WebSocket API, for the Panel's CSP `connect-src`. */
  get wsHost(): string {
    const { region, urlSuffix } = Stack.of(this);
    return `${this.webSocketApi.apiId}.execute-api.${region}.${urlSuffix}`;
  }

  constructor(scope: Construct, id: string, props: RealtimeProps) {
    super(scope, id);
    const { table } = props;

    this.wsFunction = backendFunction(this, 'WsFunction', {
      entry: 'websocket/ws.ts',
      timeout: Duration.seconds(5),
      environment: { [ENV_VARS.tableName]: table.tableName },
    });
    // `ws` consumes tickets (DeleteItem) and stores/removes connections.
    table.grant(this.wsFunction, 'dynamodb:PutItem', 'dynamodb:DeleteItem');

    // No access logs and no execution logs on the stage: they would record
    // connection ids and request details that the app promises not to keep.
    // A keepalive `{"type":"keepalive"}` has no `action`, so it is routed to
    // `$default`, the only message route.
    this.webSocketApi = new WebSocketApi(this, 'PanelSocket', {
      routeSelectionExpression: ROUTE_SELECTION_EXPRESSION,
      connectRouteOptions: {
        integration: new WebSocketLambdaIntegration('ConnectIntegration', this.wsFunction),
      },
      disconnectRouteOptions: {
        integration: new WebSocketLambdaIntegration('DisconnectIntegration', this.wsFunction),
      },
      defaultRouteOptions: {
        integration: new WebSocketLambdaIntegration('DefaultIntegration', this.wsFunction),
      },
    });
    this.stage = new WebSocketStage(this, 'ProdStage', {
      webSocketApi: this.webSocketApi,
      stageName: WEBSOCKET_STAGE_NAME,
      autoDeploy: true,
    });

    // 10 s, not the 3 s default: it pauses 1 s on top of reading and sending.
    this.notifyFunction = backendFunction(this, 'NotifyPanelFunction', {
      entry: 'streams/notify-panel.ts',
      timeout: Duration.seconds(10),
      environment: {
        [ENV_VARS.tableName]: table.tableName,
        [ENV_VARS.wsManagementEndpoint]: this.stage.callbackUrl,
      },
    });
    table.grant(this.notifyFunction, 'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:DeleteItem');

    // `PostToConnection` is `POST /@connections/{id}`: allow only that, only on
    // this stage. (`grantManageConnections` would allow every stage and method.)
    const { region, account, partition } = Stack.of(this);
    this.notifyFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ['execute-api:ManageConnections'],
        resources: [
          `arn:${partition}:execute-api:${region}:${account}:${this.webSocketApi.apiId}/${WEBSOCKET_STAGE_NAME}/POST/@connections/*`,
        ],
      }),
    );

    // The stream only wakes the notifier. Only inserts and modifications of the
    // METRICS and EVENTS items count: TTL deletions and changes to links,
    // connections or tickets would only cause useless snapshots. One shard is
    // processed sequentially, so the 1 s pause inside the function spaces the
    // sends. An old snapshot is useless: one retry, records older than 60 s are
    // dropped, and the Panel resyncs by itself every 30 s.
    this.notifyFunction.addEventSource(
      new DynamoEventSource(table, {
        startingPosition: StartingPosition.LATEST,
        batchSize: 100,
        maxBatchingWindow: Duration.seconds(0),
        retryAttempts: 1,
        maxRecordAge: Duration.seconds(60),
        parallelizationFactor: 1,
        bisectBatchOnError: false,
        filters: [
          FilterCriteria.filter({
            eventName: FilterRule.or('INSERT', 'MODIFY'),
            dynamodb: { Keys: { pk: { S: FilterRule.or('METRICS', 'EVENTS') } } },
          }),
        ],
      }),
    );
  }
}
