import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { VanityCandidate } from './vanity';

// Created once and reused across calls, instead of once per call, since
// creating it fresh every time would just slow things down for no reason.
// DYNAMODB_ENDPOINT is only used for local testing (see scripts/local-server.ts)
// -- the real, deployed Lambda never sets it, so it always talks to real DynamoDB.
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
 * All calls are stored under this one key, sorted by time. That keeps
 * things simple -- the bonus "last 5 callers" feature is just a plain
 * query, no extra index needed. As noted in design-notes.md, this is a
 * shortcut that wouldn't hold up under real call volume -- a production
 * version would need to spread calls across multiple keys instead of one.
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
    // Adding the contactId on the end makes sure this stays unique, even if
    // two calls happen to come in at the exact same millisecond.
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
