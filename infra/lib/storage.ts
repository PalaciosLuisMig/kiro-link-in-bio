// `Storage` construct: the single DynamoDB table of the app.

import { RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, BillingMode, StreamViewType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

/**
 * Table `LinkInBioTable`: on-demand (no capacity to size for a demo with
 * unpredictable peaks), TTL on `ttl` (events, connections and tickets expire
 * by themselves), and a `KEYS_ONLY` stream (the notifier only needs to know
 * that something changed, never the content, which also keeps data off the
 * stream). `DESTROY` is for the demo: the table goes away with the stack.
 */
export class Storage extends Construct {
  readonly table: Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.table = new Table(this, 'LinkInBioTable', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      stream: StreamViewType.KEYS_ONLY,
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }
}
