import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

// DYNAMODB_ENDPOINT is only used for local testing (see scripts/local-server.ts)
// -- the real, deployed Lambda never sets it, so it always talks to real DynamoDB.
const ddbClient = DynamoDBDocumentClient.from(
  new DynamoDBClient(process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {}),
);

const PARTITION_KEY_VALUE = 'CALLLOG';
const RESULT_LIMIT = 5;

/**
 * The basic shape of a request/response for a Lambda that's called directly
 * over HTTP (a "Function URL"). Written by hand instead of pulling in a
 * whole extra package just for this one small handler. See
 * https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html
 */
export interface FunctionUrlEvent {
  requestContext?: { http?: { method?: string } };
}
interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Hides everything but the last 4 digits of a caller's number before
 * sending it out. A phone number is personal information -- a real product
 * would need a real, considered reason before showing full numbers on a
 * public web page, not just have it happen by default. This is a
 * deliberate choice, not something I forgot to lock down -- see
 * docs/design-notes.md. Set MASK_CALLER_NUMBERS=false to turn it off for
 * local demos.
 */
function maskCallerNumber(callerNumber: string): string {
  if (process.env.MASK_CALLER_NUMBERS === 'false') return callerNumber;
  const digits = callerNumber.replace(/\D/g, '');
  const last4 = digits.slice(-4);
  return `(***) ***-${last4}`;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  const method = event.requestContext?.http?.method ?? 'GET';
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const tableName = process.env.TABLE_NAME;
  if (!tableName) throw new Error('TABLE_NAME environment variable is not set');

  try {
    const result = await ddbClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': PARTITION_KEY_VALUE },
        ScanIndexForward: false, // show the newest calls first
        Limit: RESULT_LIMIT,
      }),
    );

    const callers = (result.Items ?? []).map((item) => ({
      callerNumber: maskCallerNumber(String(item.callerNumber ?? '')),
      timestamp: item.timestamp,
      vanityTop5: item.vanityTop5 ?? [],
    }));

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ callers }) };
  } catch (err) {
    console.error('Failed to query call log', err);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  }
}
