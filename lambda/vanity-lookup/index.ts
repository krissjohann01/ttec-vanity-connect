import { generateVanityCandidates, plainFormat } from './vanity';
import { logCall, candidatesToDisplayList } from './dynamo';

/**
 * Minimal shape of the event Amazon Connect sends an "Invoke AWS Lambda
 * function" block. Connect does not publish an `@types` package for this,
 * so this is hand-written to the fields we actually use -- see
 * https://docs.aws.amazon.com/connect/latest/adminguide/connect-lambda-functions.html
 */
export interface ConnectLambdaEvent {
  Details: {
    ContactData: {
      ContactId: string;
      CustomerEndpoint?: { Address?: string; Type?: string };
    };
    Parameters?: Record<string, string>;
  };
}

/**
 * Connect's "Set contact attributes -> External" mechanism only auto-promotes
 * a FLAT object of string values (ResponseValidation: STRING_MAP in the
 * contact flow). Nested objects/arrays or non-string values would silently
 * fail to appear as $.External.* attributes, so this shape is load-bearing --
 * see docs/design-notes.md.
 */
export interface VanityLookupResponse {
  vanity1: string;
  vanity2: string;
  vanity3: string;
  vanityCount: string;
}

const TOP_N_SAVED = 5;
const TOP_N_SPOKEN = 3;

export async function handler(event: ConnectLambdaEvent): Promise<VanityLookupResponse> {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) throw new Error('TABLE_NAME environment variable is not set');

  // Parameters override lets this same Lambda be smoke-tested from the
  // Lambda console / CLI without needing a live call.
  const callerNumber =
    event.Details.Parameters?.phoneNumber ?? event.Details.ContactData.CustomerEndpoint?.Address ?? '';
  const contactId = event.Details.ContactData.ContactId;

  try {
    const candidates = generateVanityCandidates(callerNumber, TOP_N_SAVED);
    const fallback = plainFormat(callerNumber) ?? callerNumber;

    // Always give the flow TOP_N_SPOKEN non-empty strings to read, even if
    // the algorithm found fewer than 3 real matches for this number.
    const spoken = Array.from({ length: TOP_N_SPOKEN }, (_, i) => candidates[i]?.display ?? fallback);

    // A DynamoDB failure shouldn't break the caller's experience -- log and
    // continue rather than letting it fall through to the outer catch,
    // which would trigger the contact flow's (less friendly) error branch.
    try {
      await logCall(tableName, callerNumber, contactId, candidatesToDisplayList(candidates.slice(0, TOP_N_SAVED)));
    } catch (err) {
      console.error('Failed to write call log to DynamoDB', err);
    }

    return {
      vanity1: spoken[0],
      vanity2: spoken[1],
      vanity3: spoken[2],
      vanityCount: String(candidates.length),
    };
  } catch (err) {
    console.error('Vanity lookup failed', err);
    const fallback = plainFormat(callerNumber) ?? 'your phone number';
    return { vanity1: fallback, vanity2: fallback, vanity3: fallback, vanityCount: '0' };
  }
}
