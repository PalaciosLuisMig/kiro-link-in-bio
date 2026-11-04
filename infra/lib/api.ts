// `Api` construct: the HTTP API and the Lambdas `public-api` and `admin-api`.

import { Aws, Duration, Stack } from 'aws-cdk-lib';
import { CfnStage, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

import { API_ROUTES, ENV_VARS } from '@link-in-bio/shared';

import { backendFunction } from './lambdas.js';

/**
 * Name of the SSM SecureString with the owner token. CloudFormation cannot
 * create a `SecureString`, so it is created once with the CLI
 * (`aws ssm put-parameter`) and CDK only references it.
 */
export const OWNER_TOKEN_PARAMETER_NAME = '/link-in-bio/owner-token';

/** Per-route throttling (requests per second, burst) of the public writes. */
export const ROUTE_THROTTLING = {
  [`POST ${API_ROUTES.clicks}`]: { rate: 150, burst: 300 },
  [`POST ${API_ROUTES.visits}`]: { rate: 50, burst: 100 },
} as const;

export interface ApiProps {
  readonly table: ITable;
  /** `wss://` URL of the WebSocket, which `admin-api` returns with each ticket. */
  readonly wsUrl: string;
}

export class Api extends Construct {
  readonly httpApi: HttpApi;
  readonly publicFunction: NodejsFunction;
  readonly adminFunction: NodejsFunction;

  /** Host of the API (no scheme), the origin of CloudFront's `/api/*`. */
  get apiHost(): string {
    return `${this.httpApi.apiId}.execute-api.${Stack.of(this).region}.${Aws.URL_SUFFIX}`;
  }

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);
    const { table, wsUrl } = props;

    this.publicFunction = backendFunction(this, 'PublicApiFunction', {
      entry: 'http/public-api.ts',
      timeout: Duration.seconds(5),
      environment: { [ENV_VARS.tableName]: table.tableName },
    });
    table.grant(
      this.publicFunction,
      'dynamodb:GetItem',
      'dynamodb:Query',
      'dynamodb:UpdateItem',
      'dynamodb:PutItem',
    );

    this.adminFunction = backendFunction(this, 'AdminApiFunction', {
      entry: 'http/admin-api.ts',
      timeout: Duration.seconds(10),
      environment: {
        [ENV_VARS.tableName]: table.tableName,
        [ENV_VARS.ownerTokenParameter]: OWNER_TOKEN_PARAMETER_NAME,
        [ENV_VARS.wsUrl]: wsUrl,
      },
    });
    table.grant(
      this.adminFunction,
      'dynamodb:GetItem',
      'dynamodb:Query',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:DeleteItem',
    );
    StringParameter.fromSecureStringParameterAttributes(this, 'OwnerToken', {
      parameterName: OWNER_TOKEN_PARAMETER_NAME,
    }).grantRead(this.adminFunction);

    // No CORS: the browser only calls the API through CloudFront (same origin).
    // No access logs: they would store IP addresses.
    this.httpApi = new HttpApi(this, 'HttpApi');

    const publicIntegration = new HttpLambdaIntegration('PublicIntegration', this.publicFunction);
    const adminIntegration = new HttpLambdaIntegration('AdminIntegration', this.adminFunction);

    const publicRoutes: [HttpMethod, string][] = [
      [HttpMethod.GET, API_ROUTES.publicLinks],
      [HttpMethod.POST, API_ROUTES.visits],
      [HttpMethod.POST, API_ROUTES.clicks],
    ];
    const routes = publicRoutes.flatMap(([method, path]) =>
      this.httpApi.addRoutes({ path, methods: [method], integration: publicIntegration }),
    );

    const adminRoutes: [HttpMethod, string][] = [
      [HttpMethod.POST, API_ROUTES.realtimeTickets],
      [HttpMethod.GET, API_ROUTES.metrics],
      [HttpMethod.POST, API_ROUTES.metricsReset],
      [HttpMethod.GET, API_ROUTES.adminLinks],
      [HttpMethod.POST, API_ROUTES.adminLinks],
      [HttpMethod.PATCH, API_ROUTES.adminLink],
      [HttpMethod.DELETE, API_ROUTES.adminLink],
      [HttpMethod.PUT, API_ROUTES.adminLinksOrder],
    ];
    routes.push(
      ...adminRoutes.flatMap(([method, path]) =>
        this.httpApi.addRoutes({ path, methods: [method], integration: adminIntegration }),
      ),
    );

    // The L2 `HttpStage` only supports one limit for the whole stage, so the
    // per-route limits go on the L1 `CfnStage`, with the exact route keys.
    const cfnStage = this.httpApi.defaultStage?.node.defaultChild;
    if (!(cfnStage instanceof CfnStage)) {
      throw new Error('The default stage of the HTTP API was not found');
    }
    // `routeSettings` is typed `any` on the L1, and CloudFormation property names
    // are PascalCase: a lowercase key would not be applied (the tests check it).
    cfnStage.routeSettings = Object.fromEntries(
      Object.entries(ROUTE_THROTTLING).map(([routeKey, { rate, burst }]) => [
        routeKey,
        { ThrottlingRateLimit: rate, ThrottlingBurstLimit: burst },
      ]),
    );
    // CloudFormation rejects a stage whose `RouteSettings` name a route that does not
    // exist yet ("Unable to find Route by key POST /api/clicks"). Nothing else ties
    // the stage to the routes, so without this it can be created first and the whole
    // deploy rolls back. The deploy found it; a template test cannot see the order.
    cfnStage.node.addDependency(...routes);
  }
}
