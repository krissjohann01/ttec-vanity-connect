/**
 * Hand-authored Amazon Connect "Flow language" content for the inbound
 * vanity-number flow, generated as a typed function rather than a static
 * JSON file so the Lambda ARN can be injected at synth time.
 *
 * Schema reference (there is no CDK/CloudFormation typing for this -- the
 * `content` field of AWS::Connect::ContactFlow is just a JSON string):
 * https://docs.aws.amazon.com/connect/latest/adminguide/flow-language.html
 *
 * Flow: Invoke Lambda (caller's number in) -> on success, speak the 3
 * vanity numbers it returned (via $.External.vanity1/2/3, which Connect
 * auto-populates from the Lambda's flat STRING_MAP response -- this is
 * default InvokeLambdaFunction behavior, not something opted into via a
 * parameter) -> disconnect. On any Lambda error (throttle, timeout, bad
 * response, etc.) the flow takes a separate apology-and-disconnect branch
 * instead of failing the call -- see docs/design-notes.md "error handling"
 * for why this is layered on top of the Lambda's own internal fallback
 * rather than replacing it.
 *
 * NOTE: an earlier version of this also set a `ResponseValidation:
 * "STRING_MAP"` parameter, following what several secondary sources
 * described as a real InvokeLambdaFunction parameter. It isn't -- Connect's
 * CreateContactFlow API rejects it outright (`InvalidContactFlowException`).
 * Confirmed by diffing against a live account's auto-generated "Sample
 * Lambda integration" flow, which has no such parameter and still resolves
 * $.External.* from the Lambda's response. Root-caused via the AWS CLI
 * directly against a throwaway Connect instance after this exact bug caused
 * a real `cdk deploy` to fail -- see docs/design-notes.md "struggles".
 */
export function buildContactFlowContent(vanityLookupLambdaArn: string): string {
  const content = {
    Version: '2019-10-30',
    StartAction: 'InvokeVanityLookup',
    Metadata: {
      // Purely cosmetic (Connect's visual designer uses this for block
      // positions) -- harmless to omit but keeps the flow readable if
      // someone opens it in the console after deploy.
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
          // Hard Connect ceiling for this action type; the Lambda's own
          // timeout is set below this (see vanity-connect-stack.ts) so it
          // always resolves (success or caught error) before Connect gives up.
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
