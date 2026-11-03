// Entry point of the CDK app (`cdk synth`, `cdk diff`, `cdk deploy`).

import { App } from 'aws-cdk-lib';

import { LinkInBioStack } from '../lib/link-in-bio-stack.js';

/** Region of the project, chosen by the owner (steering `tech.md`). */
const DEPLOY_REGION = 'us-east-1';

const app = new App();

new LinkInBioStack(app, 'LinkInBioStack', {
  // The account comes from the CLI credentials; the Region is fixed so every
  // regional resource (API Gateway, Lambda, DynamoDB) is created in one place.
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: DEPLOY_REGION },
});
