import { generateVanityCandidates, plainFormat } from './vanity';
import { logCall, candidatesToDisplayList } from './dynamo';

/**
 * The shape of the data Amazon Connect sends when it calls this Lambda from
 * the "Invoke AWS Lambda function" step in the call flow. Amazon doesn't
 * publish a ready-made type for this, so this only covers the fields we
 * actually use -- see
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
 * Amazon Connect only picks up a Lambda's response automatically if it's a
 * flat object of plain text values -- no nested objects, no numbers or
 * true/false values, just strings. Anything else silently won't show up in
 * the call flow, with no error to tell you why. So this exact shape
 * matters -- see docs/design-notes.md for more on how this was figured out.
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

  // The Parameters override lets you test this same Lambda from the AWS
  // console or command line without needing to make a real phone call.
  const callerNumber =
    event.Details.Parameters?.phoneNumber ?? event.Details.ContactData.CustomerEndpoint?.Address ?? '';
  const contactId = event.Details.ContactData.ContactId;

  try {
    const candidates = generateVanityCandidates(callerNumber, TOP_N_SAVED);
    const fallback = plainFormat(callerNumber) ?? callerNumber;

    // Always hand back 3 real strings to read out loud, even if the
    // algorithm found fewer than 3 good matches for this number.
    const spoken = Array.from({ length: TOP_N_SPOKEN }, (_, i) => candidates[i]?.display ?? fallback);

    // If saving to DynamoDB fails, don't let that ruin the call for the
    // caller -- just log it and keep going, instead of letting it bubble up
    // to the outer catch block below, which would trigger a less friendly
    // error message in the call flow.
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
