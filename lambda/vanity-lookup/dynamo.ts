import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { VanityCandidate } from './vanity';

// One client per execution environment, reused across warm invocations --
// creating it per-request would add avoidable latency to every call.
// DYNAMODB_ENDPOINT is a local-dev-only hook (see scripts/local-server.ts) --
// it's never set in the deployed Lambda, which always talks to real DynamoDB.
const ddbClient = DynamoDBDocumentClient.from(
  new DynamoDBClient(process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {}),
);

export interface CallLogItem {
  pk: string;
  sk: string;
  callerNumber: string;
  contactId: string;
  timestamp: string;
  vanityTop5: string[];
}

/**
 * Single logical partition ("CALLLOG"), sorted by timestamp, so the bonus
 * "last 5 callers" feature is a plain Query (ScanIndexForward=false, Limit=5)
 * with no GSI or scan required. Documented in design-notes.md as a
 * demo-scale shortcut: a hot single partition would not survive real call
 * volume and would need sharding (e.g. a per-hour or per-shard pk) in production.
 */
const PARTITION_KEY_VALUE = 'CALLLOG';

export async function logCall(
  tableName: string,
  callerNumber: string,
  contactId: string,
  vanityTop5: string[],
): Promise<void> {
  const timestamp = new Date().toISOString();
  const item: CallLogItem = {
    pk: PARTITION_KEY_VALUE,
    // contactId suffix guarantees sk uniqueness even for two calls in the same millisecond.
    sk: `${timestamp}#${contactId}`,
    callerNumber,
    contactId,
    timestamp,
    vanityTop5,
  };
  await ddbClient.send(new PutCommand({ TableName: tableName, Item: item }));
}

export function candidatesToDisplayList(candidates: VanityCandidate[]): string[] {
  return candidates.map((c) => c.display);
}
