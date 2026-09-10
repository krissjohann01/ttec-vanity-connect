import { ConnectClient, AssociatePhoneNumberContactFlowCommand } from '@aws-sdk/client-connect';

/**
 * This fills a real gap in what CloudFormation can do on its own:
 * `AWS::Connect::PhoneNumber` has no setting to connect the number to a
 * call flow -- the only way to do that is through the separate
 * `AssociatePhoneNumberContactFlow` API call, since there's no
 * CloudFormation resource for it. CloudFormation runs this Lambda
 * automatically through a CDK "custom resource" -- see
 * infra/lib/vanity-connect-stack.ts.
 *
 * Checked against the real AWS API docs while building this:
 * https://docs.aws.amazon.com/connect/latest/APIReference/API_AssociatePhoneNumberContactFlow.html
 */
interface CloudFormationCustomResourceEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  ResourceProperties: {
    InstanceId: string;
    PhoneNumberId: string;
    ContactFlowId: string;
  };
}

interface CloudFormationCustomResourceResponse {
  PhysicalResourceId: string;
}

const client = new ConnectClient({});

export async function handler(
  event: CloudFormationCustomResourceEvent,
): Promise<CloudFormationCustomResourceResponse> {
  const { InstanceId, PhoneNumberId, ContactFlowId } = event.ResourceProperties;
  const physicalResourceId = `phone-flow-association-${PhoneNumberId}`;

  if (event.RequestType === 'Create' || event.RequestType === 'Update') {
    await client.send(
      new AssociatePhoneNumberContactFlowCommand({ InstanceId, PhoneNumberId, ContactFlowId }),
    );
  }

  // On Delete, this deliberately does nothing: the phone number and the
  // whole Connect instance are being deleted together anyway, so there's
  // nothing real left to disconnect -- and calling the API here would just
  // be one more thing that could fail and get in the way of a clean
  // `cdk destroy`. See docs/design-notes.md.
  return { PhysicalResourceId: physicalResourceId };
}
