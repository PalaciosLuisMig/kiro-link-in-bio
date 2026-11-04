import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { App, type CfnElement } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { API_ROUTES, ENV_VARS, ROUTE_SELECTION_EXPRESSION } from '@link-in-bio/shared';

import { ROUTE_THROTTLING } from './api.js';
import { panelCsp, publicCsp } from './frontend.js';
import { LinkInBioStack } from './link-in-bio-stack.js';
import { WEBSOCKET_STAGE_NAME } from './realtime.js';

// Infrastructure tests (task 13.6) with `aws-cdk-lib/assertions`. They check the
// decisions of the design that have a requirement behind them: on-demand table
// with TTL and stream, `nodejs24.x`, explicit timeouts, least-privilege IAM per
// Lambda role, per-route throttling, the stream filter, no access logs and the
// three response-header policies.
//
// Validates: Requirements 11.2, 12.8, 17.1, 17.2, 17.3, 17.4.

interface TemplateResource {
  Type: string;
  DeletionPolicy?: string;
  // The CloudFormation properties are free-form JSON.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Properties?: Record<string, any>;
}

interface Statement {
  Effect: string;
  Action: string | string[];
  Resource: unknown;
}

let assetDir: string;
let stack: LinkInBioStack;
let template: Template;
let resources: Record<string, TemplateResource>;

beforeAll(() => {
  // A fake `frontend/dist`: the stack needs the folder to exist when it is
  // synthesized (`BucketDeployment` stages it as an asset).
  assetDir = mkdtempSync(join(tmpdir(), 'link-in-bio-dist-'));
  mkdirSync(join(assetDir, 'assets'));
  writeFileSync(join(assetDir, 'index.html'), '<!doctype html>');
  writeFileSync(join(assetDir, 'panel.html'), '<!doctype html>');
  writeFileSync(join(assetDir, 'assets', 'app-abc123.js'), '');

  // `aws:cdk:bundling-stacks: []` skips the esbuild bundling of the Lambdas, so
  // the tests are fast and need neither esbuild nor Docker.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  stack = new LinkInBioStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    frontendAssetPath: assetDir,
  });
  template = Template.fromStack(stack);
  resources = (template.toJSON() as { Resources: Record<string, TemplateResource> }).Resources;
});

afterAll(() => {
  rmSync(assetDir, { recursive: true, force: true });
});

// --- Helpers ----------------------------------------------------------------

/** Logical id of the L1 resource behind a construct. */
function logicalId(construct: { node: { defaultChild?: unknown } }): string {
  return stack.getLogicalId(construct.node.defaultChild as CfnElement);
}

function propertiesOf(construct: { node: { defaultChild?: unknown } }) {
  return resources[logicalId(construct)]?.Properties ?? {};
}

function ofType(type: string): TemplateResource[] {
  return Object.values(resources).filter((resource) => resource.Type === type);
}

/** Every statement of every inline policy attached to a Lambda's role. */
function statementsOf(fn: NodejsFunction): Statement[] {
  const roleId = logicalId(fn.role as { node: { defaultChild?: unknown } });
  return ofType('AWS::IAM::Policy')
    .filter((policy) =>
      (policy.Properties?.Roles as { Ref?: string }[]).some((role) => role.Ref === roleId),
    )
    .flatMap((policy) => policy.Properties?.PolicyDocument.Statement as Statement[]);
}

function actionsOf(statement: Statement): string[] {
  return ([] as string[]).concat(statement.Action);
}

/** The DynamoDB actions granted to a Lambda, sorted. */
function dynamoActions(fn: NodejsFunction): string[] {
  return statementsOf(fn)
    .flatMap(actionsOf)
    .filter((action) => action.startsWith('dynamodb:'))
    .sort();
}

const functions = () => ({
  public: stack.api.publicFunction,
  admin: stack.api.adminFunction,
  ws: stack.realtime.wsFunction,
  notify: stack.realtime.notifyFunction,
});

// --- Tests ------------------------------------------------------------------

describe('synthesis', () => {
  test('has no CDK errors', () => {
    expect(Annotations.fromStack(stack).findError('*', Match.anyValue())).toEqual([]);
  });
});

describe('Storage', () => {
  test('table is on-demand with TTL on `ttl` and a KEYS_ONLY stream', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      StreamSpecification: { StreamViewType: 'KEYS_ONLY' },
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
    });
  });

  test('table is destroyed with the stack (demo)', () => {
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
    });
  });
});

describe('Lambdas', () => {
  test('the four project functions use nodejs24.x on ARM64 with 512 MB', () => {
    for (const fn of Object.values(functions())) {
      expect(propertiesOf(fn)).toMatchObject({
        Runtime: 'nodejs24.x',
        Architectures: ['arm64'],
        MemorySize: 512,
      });
    }
  });

  test('each function has an explicit timeout', () => {
    const { public: pub, admin, ws, notify } = functions();
    expect(propertiesOf(pub).Timeout).toBe(5);
    expect(propertiesOf(admin).Timeout).toBe(10);
    expect(propertiesOf(ws).Timeout).toBe(5);
    // 10 s, not the 3 s default: it pauses 1 s on top of reading and sending.
    expect(propertiesOf(notify).Timeout).toBe(10);
  });

  test('each function has an explicit log group with 7 days of retention', () => {
    for (const fn of Object.values(functions())) {
      const logGroupRef = propertiesOf(fn).LoggingConfig?.LogGroup as { Ref: string };
      expect(logGroupRef).toBeDefined();
      const logGroup = resources[logGroupRef.Ref];
      expect(logGroup?.Type).toBe('AWS::Logs::LogGroup');
      expect(logGroup?.Properties?.RetentionInDays).toBe(7);
    }
  });

  test('environment variables use the shared names', () => {
    const { public: pub, admin, ws, notify } = functions();
    const names = (fn: NodejsFunction) =>
      Object.keys(propertiesOf(fn).Environment.Variables as object).sort();
    expect(names(pub)).toEqual([ENV_VARS.tableName]);
    expect(names(ws)).toEqual([ENV_VARS.tableName]);
    expect(names(admin)).toEqual(
      [ENV_VARS.tableName, ENV_VARS.ownerTokenParameter, ENV_VARS.wsUrl].sort(),
    );
    expect(names(notify)).toEqual([ENV_VARS.tableName, ENV_VARS.wsManagementEndpoint].sort());
  });
});

describe('IAM: least privilege per Lambda role', () => {
  // A wildcard that is expected and cannot be narrowed. Listed on purpose, with
  // the reason, so any other wildcard fails the test:
  // - `dynamodb:ListStreams` does not support resource-level permissions, so the
  //   stream-read grant of the event source puts it on `*`.
  const EXPECTED_WILDCARD_RESOURCES = new Set(['dynamodb:ListStreams']);

  test('no role statement has a wildcard action or an unexpected wildcard resource', () => {
    for (const [name, fn] of Object.entries(functions())) {
      for (const statement of statementsOf(fn)) {
        for (const action of actionsOf(statement)) {
          expect(action, `${name}: ${action}`).not.toBe('*');
          expect(action.endsWith(':*'), `${name}: ${action}`).toBe(false);
          const resources = ([] as unknown[]).concat(statement.Resource);
          if (resources.includes('*')) {
            expect(EXPECTED_WILDCARD_RESOURCES.has(action), `${name}: ${action} on *`).toBe(true);
          }
        }
      }
    }
  });

  test('DynamoDB actions of each role match the design', () => {
    const { public: pub, admin, ws, notify } = functions();
    expect(dynamoActions(pub)).toEqual(
      ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem'].sort(),
    );
    expect(dynamoActions(admin)).toEqual(
      [
        'dynamodb:DeleteItem',
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:Query',
        'dynamodb:UpdateItem',
      ].sort(),
    );
    expect(dynamoActions(ws)).toEqual(['dynamodb:DeleteItem', 'dynamodb:PutItem']);
    expect(dynamoActions(notify)).toEqual(
      [
        'dynamodb:DeleteItem',
        'dynamodb:DescribeStream',
        'dynamodb:GetItem',
        'dynamodb:GetRecords',
        'dynamodb:GetShardIterator',
        'dynamodb:ListStreams',
        'dynamodb:Query',
      ].sort(),
    );
  });

  test('only admin-api reads the owner-token parameter', () => {
    const readsSsm = (fn: NodejsFunction) =>
      statementsOf(fn)
        .flatMap(actionsOf)
        .some((action) => action.startsWith('ssm:'));
    const { public: pub, admin, ws, notify } = functions();
    expect(readsSsm(admin)).toBe(true);
    expect([readsSsm(pub), readsSsm(ws), readsSsm(notify)]).toEqual([false, false, false]);
  });

  test('only notify-panel manages connections, and only POST @connections of the stage', () => {
    const manage = (fn: NodejsFunction) =>
      statementsOf(fn).filter((statement) =>
        actionsOf(statement).includes('execute-api:ManageConnections'),
      );
    const { public: pub, admin, ws, notify } = functions();
    expect([pub, admin, ws].map((fn) => manage(fn).length)).toEqual([0, 0, 0]);

    const statements = manage(notify);
    expect(statements).toHaveLength(1);
    const resource = JSON.stringify(statements[0]?.Resource);
    expect(resource).toContain(`/${WEBSOCKET_STAGE_NAME}/POST/@connections/*`);
  });
});

describe('Api', () => {
  const expectedRouteKeys = [
    `GET ${API_ROUTES.publicLinks}`,
    `POST ${API_ROUTES.visits}`,
    `POST ${API_ROUTES.clicks}`,
    `POST ${API_ROUTES.realtimeTickets}`,
    `GET ${API_ROUTES.metrics}`,
    `POST ${API_ROUTES.metricsReset}`,
    `GET ${API_ROUTES.adminLinks}`,
    `POST ${API_ROUTES.adminLinks}`,
    `PATCH ${API_ROUTES.adminLink}`,
    `DELETE ${API_ROUTES.adminLink}`,
    `PUT ${API_ROUTES.adminLinksOrder}`,
  ];

  test('the HTTP API has exactly the routes of the design', () => {
    const httpApiId = logicalId(stack.api.httpApi);
    const routeKeys = ofType('AWS::ApiGatewayV2::Route')
      .filter((route) => (route.Properties?.ApiId as { Ref?: string }).Ref === httpApiId)
      .map((route) => route.Properties?.RouteKey as string)
      .sort();
    expect(routeKeys).toEqual([...expectedRouteKeys].sort());
  });

  test('POST clicks and visits are throttled per route, with the exact route keys', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      RouteSettings: {
        'POST /api/clicks': { ThrottlingRateLimit: 150, ThrottlingBurstLimit: 300 },
        'POST /api/visits': { ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 },
      },
    });
    // A typo in a route key would silently throttle nothing: every throttled
    // key must be a real route.
    for (const routeKey of Object.keys(ROUTE_THROTTLING)) {
      expect(expectedRouteKeys).toContain(routeKey);
    }
  });

  test('the stage waits for every route, so the throttled route keys exist when it is created', () => {
    const stage = Object.values(
      template.findResources('AWS::ApiGatewayV2::Stage', {
        Properties: { RouteSettings: Match.anyValue() },
      }),
    )[0];
    const dependsOn = (stage?.DependsOn ?? []) as string[];
    const routes = template.findResources('AWS::ApiGatewayV2::Route', {
      Properties: { RouteKey: Match.stringLikeRegexp('^(GET|POST|PUT|PATCH|DELETE) /api/') },
    });
    expect(Object.keys(routes)).toHaveLength(expectedRouteKeys.length);
    for (const logicalId of Object.keys(routes)) {
      expect(dependsOn).toContain(logicalId);
    }
  });

  test('the HTTP API has no CORS configuration', () => {
    const properties = propertiesOf(stack.api.httpApi);
    expect(properties.CorsConfiguration).toBeUndefined();
  });
});

describe('Realtime', () => {
  test('the WebSocket API routes by `action`, so a keepalive lands on $default', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      ProtocolType: 'WEBSOCKET',
      RouteSelectionExpression: ROUTE_SELECTION_EXPRESSION,
    });
    const routeKeys = ofType('AWS::ApiGatewayV2::Route')
      .map((route) => route.Properties?.RouteKey as string)
      .filter((key) => key.startsWith('$'))
      .sort();
    expect(routeKeys).toEqual(['$connect', '$default', '$disconnect']);
  });

  test('the stream mapping only wakes on inserts and updates of METRICS and EVENTS', () => {
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      StartingPosition: 'LATEST',
      MaximumRetryAttempts: 1,
      MaximumRecordAgeInSeconds: 60,
      ParallelizationFactor: 1,
      BisectBatchOnFunctionError: false,
      MaximumBatchingWindowInSeconds: 0,
    });

    const mapping = ofType('AWS::Lambda::EventSourceMapping')[0];
    const filters = mapping?.Properties?.FilterCriteria.Filters as { Pattern: string }[];
    expect(filters).toHaveLength(1);
    expect(JSON.parse(filters[0]?.Pattern ?? '{}')).toEqual({
      eventName: ['INSERT', 'MODIFY'],
      dynamodb: { Keys: { pk: { S: ['METRICS', 'EVENTS'] } } },
    });
  });
});

describe('Privacy: no access or execution logs', () => {
  test('no API Gateway stage writes access logs or execution logs', () => {
    const stages = ofType('AWS::ApiGatewayV2::Stage');
    expect(stages).toHaveLength(2);
    for (const stage of stages) {
      expect(stage.Properties?.AccessLogSettings).toBeUndefined();
      expect(stage.Properties?.DefaultRouteSettings?.LoggingLevel).toBeUndefined();
      expect(stage.Properties?.DefaultRouteSettings?.DataTraceEnabled).toBeUndefined();
    }
  });

  test('CloudFront access logging is off', () => {
    const distribution = ofType('AWS::CloudFront::Distribution')[0];
    expect(distribution?.Properties?.DistributionConfig.Logging).toBeUndefined();
  });
});

describe('Frontend', () => {
  type Behavior = {
    PathPattern?: string;
    ViewerProtocolPolicy: string;
    ResponseHeadersPolicyId: { Ref: string };
    CachePolicyId?: string;
    OriginRequestPolicyId?: string;
    AllowedMethods?: string[];
  };

  const distributionConfig = () =>
    ofType('AWS::CloudFront::Distribution')[0]?.Properties?.DistributionConfig as {
      DefaultCacheBehavior: Behavior;
      CacheBehaviors: Behavior[];
    };

  const policyById = (id: string) =>
    resources[id]?.Properties?.ResponseHeadersPolicyConfig as {
      SecurityHeadersConfig?: {
        ContentSecurityPolicy?: { ContentSecurityPolicy: unknown };
        StrictTransportSecurity?: unknown;
        ContentTypeOptions?: unknown;
        ReferrerPolicy?: { ReferrerPolicy: string };
      };
      CustomHeadersConfig?: { Items: { Header: string; Value: string }[] };
    };

  const behaviorFor = (pattern: string | undefined) => {
    const config = distributionConfig();
    return pattern === undefined
      ? config.DefaultCacheBehavior
      : (config.CacheBehaviors.find((behavior) => behavior.PathPattern === pattern) as Behavior);
  };

  test('the bucket is private and only reachable through CloudFront OAC', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  });

  test('every behavior redirects HTTP to HTTPS', () => {
    const config = distributionConfig();
    for (const behavior of [config.DefaultCacheBehavior, ...config.CacheBehaviors]) {
      expect(behavior.ViewerProtocolPolicy).toBe('redirect-to-https');
    }
  });

  test('/api/* is not cached and forwards every method', () => {
    const api = behaviorFor('/api/*');
    // Managed policies CachingDisabled and AllViewerExceptHostHeader.
    expect(api.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
    expect(api.OriginRequestPolicyId).toBe('b689b0a8-53d0-40ab-baf2-68738e2966ac');
    expect([...(api.AllowedMethods ?? [])].sort()).toEqual(
      ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'].sort(),
    );
  });

  test('there are exactly three header policies, one per behavior', () => {
    template.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 3);
    const ids = new Set([
      behaviorFor(undefined).ResponseHeadersPolicyId.Ref,
      behaviorFor('/panel.html').ResponseHeadersPolicyId.Ref,
      behaviorFor('/api/*').ResponseHeadersPolicyId.Ref,
    ]);
    expect(ids.size).toBe(3);
  });

  test('public and Panel policies add HSTS, nosniff, Referrer-Policy and the CSP', () => {
    for (const pattern of [undefined, '/panel.html']) {
      const policy = policyById(behaviorFor(pattern).ResponseHeadersPolicyId.Ref);
      expect(policy.SecurityHeadersConfig?.StrictTransportSecurity).toBeDefined();
      expect(policy.SecurityHeadersConfig?.ContentTypeOptions).toBeDefined();
      expect(policy.SecurityHeadersConfig?.ReferrerPolicy?.ReferrerPolicy).toBe(
        'strict-origin-when-cross-origin',
      );
      expect(policy.SecurityHeadersConfig?.ContentSecurityPolicy).toBeDefined();
    }
  });

  test('the public CSP only allows the same origin', () => {
    const policy = policyById(behaviorFor(undefined).ResponseHeadersPolicyId.Ref);
    expect(policy.SecurityHeadersConfig?.ContentSecurityPolicy?.ContentSecurityPolicy).toBe(
      publicCsp(),
    );
    expect(publicCsp()).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    expect(policy.CustomHeadersConfig).toBeUndefined();
  });

  test('the Panel CSP also allows its WebSocket and the Panel is not indexed', () => {
    const policy = policyById(behaviorFor('/panel.html').ResponseHeadersPolicyId.Ref);
    const csp = JSON.stringify(
      policy.SecurityHeadersConfig?.ContentSecurityPolicy?.ContentSecurityPolicy,
    );
    expect(csp).toContain("connect-src 'self' wss://");
    expect(csp).toContain('execute-api');
    expect(panelCsp('abc.example')).toContain("connect-src 'self' wss://abc.example;");
    expect(policy.CustomHeadersConfig?.Items).toContainEqual(
      expect.objectContaining({ Header: 'X-Robots-Tag', Value: 'noindex' }),
    );
  });

  test('/api/* responses get Cache-Control: no-store from CloudFront', () => {
    const policy = policyById(behaviorFor('/api/*').ResponseHeadersPolicyId.Ref);
    expect(policy.CustomHeadersConfig?.Items).toContainEqual(
      expect.objectContaining({ Header: 'Cache-Control', Value: 'no-store' }),
    );
  });

  test('assets are cached for a year as immutable and the HTML is revalidated', () => {
    const deployments = JSON.stringify(ofType('Custom::CDKBucketDeployment'));
    expect(deployments).toContain('public, max-age=31536000, immutable');
    expect(deployments).toContain('no-cache');
  });
});
