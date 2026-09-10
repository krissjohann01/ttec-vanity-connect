import { ConnectClient, AssociatePhoneNumberContactFlowCommand } from '@aws-sdk/client-connect';

/**
 * CloudFormation custom-resource handler that fills a genuine IaC gap:
 * `AWS::Connect::PhoneNumber` has no property to bind the number to a
 * contact flow -- that association is only exposed via the
 * `AssociatePhoneNumberContactFlow` API (there is no CloudFormation-native
 * resource for it as of this writing). This is invoked through a CDK
 * `custom_resources.Provider` -- see infra/lib/vanity-connect-stack.ts.
 *
 * Confirmed against the AWS API reference during implementation:
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

  // Deliberately a no-op on Delete: the phone number and instance are being
  // torn down in the same stack deletion, so there's nothing meaningful to
  // disassociate, and calling the API here would just be one more thing
  // that could fail and block a clean `cdk destroy`. See docs/design-notes.md.
  return { PhysicalResourceId: physicalResourceId };
}
