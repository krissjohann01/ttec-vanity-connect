/**
 * This is the Amazon Connect call flow, written by hand as JSON, instead of
 * built by dragging blocks around in the AWS console. It's written as a
 * function instead of a plain JSON file so the Lambda's address can be
 * filled in automatically when the project is deployed.
 *
 * There's no ready-made TypeScript definition for this format to check
 * against -- to CloudFormation, the whole flow is just one big block of
 * text. The real format is documented here:
 * https://docs.aws.amazon.com/connect/latest/adminguide/flow-language.html
 *
 * What the flow actually does: call the Lambda with the caller's number ->
 * if that works, read back the 3 vanity numbers it found (Connect
 * automatically makes the Lambda's response available for the flow to read
 * -- no extra setup needed for that part) -> hang up. If the Lambda call
 * fails for any reason, play an apology message instead of just failing
 * the call outright -- see the "error handling" part of design-notes.md
 * for why this exists on top of the Lambda's own fallback, not instead of it.
 *
 * NOTE: an earlier version of this had an extra setting called
 * `ResponseValidation: "STRING_MAP"`, based on what a few articles online
 * described as a real setting for this step. It isn't real -- Amazon
 * Connect rejects it outright. I found this out by actually running a real
 * deploy against a real AWS account and comparing my flow to one of AWS's
 * own example flows, which doesn't use that setting either. See the
 * "struggles" part of design-notes.md for the full story.
 */
export function buildContactFlowContent(vanityLookupLambdaArn: string): string {
  const content = {
    Version: '2019-10-30',
    StartAction: 'InvokeVanityLookup',
    Metadata: {
      // Just for looks -- this only controls where the boxes appear if
      // someone opens this flow in Amazon Connect's visual editor later.
      // Doesn't affect how the flow actually works.
      EntryPointPosition: { x: 40, y: 40 },
      ActionMetadata: {
        InvokeVanityLookup: { Position: { x: 260, y: 40 } },
        SpeakVanityNumbers: { Position: { x: 520, y: 40 } },
        SpeakApology: { Position: { x: 520, y: 220 } },
        Disconnect: { Position: { x: 780, y: 40 } },
      },
    },
    Actions: [
      {
        Identifier: 'InvokeVanityLookup',
        Type: 'InvokeLambdaFunction',
        Parameters: {
          LambdaFunctionARN: vanityLookupLambdaArn,
          // This is the most Connect will ever wait for this step. The
          // Lambda's own timeout is set lower than this (see
          // vanity-connect-stack.ts), so it always finishes -- one way or
          // another -- before Connect gives up on it.
          InvocationTimeLimitSeconds: '8',
        },
        Transitions: {
          NextAction: 'SpeakVanityNumbers',
          Errors: [{ ErrorType: 'NoMatchingError', NextAction: 'SpeakApology' }],
          Conditions: [],
        },
      },
      {
        Identifier: 'SpeakVanityNumbers',
        Type: 'MessageParticipant',
        Parameters: {
          Text:
            'Thanks for calling. Here are your top vanity numbers. ' +
            'Number one: $.External.vanity1. ' +
            'Number two: $.External.vanity2. ' +
            'Number three: $.External.vanity3. ' +
            'Goodbye.',
        },
        Transitions: { NextAction: 'Disconnect', Errors: [], Conditions: [] },
      },
      {
        Identifier: 'SpeakApology',
        Type: 'MessageParticipant',
        Parameters: {
          Text: "Sorry, we couldn't generate vanity numbers for your call right now. Goodbye.",
        },
        Transitions: { NextAction: 'Disconnect', Errors: [], Conditions: [] },
      },
      {
        Identifier: 'Disconnect',
        Type: 'DisconnectParticipant',
        Parameters: {},
        Transitions: {},
      },
    ],
  };
  return JSON.stringify(content);
}
