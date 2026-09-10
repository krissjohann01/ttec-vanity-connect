import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Duration, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { buildContactFlowContent } from './contact-flow-content';

export class VanityConnectStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------------
    // DynamoDB: single-table call log. See lambda/vanity-lookup/dynamo.ts
    // for the access-pattern rationale (one partition, sorted by time).
    // ---------------------------------------------------------------------
    const callLogTable = new dynamodb.Table(this, 'CallLogTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Demo-scale shortcut: deleting the stack deletes real call history.
      // Production should use RETAIN (+ a backup plan) -- see design-notes.md.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ---------------------------------------------------------------------
    // Lambda: vanity number lookup, invoked directly by the contact flow.
    // ---------------------------------------------------------------------
    const vanityLookupFn = new NodejsFunction(this, 'VanityLookupFunction', {
      entry: path.join(__dirname, '../../lambda/vanity-lookup/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      // Must stay comfortably under Connect's 8s hard ceiling on the Invoke
      // Lambda block (see InvocationTimeLimitSeconds in contact-flow-content.ts)
      // so a slow Lambda always resolves -- success or caught error -- before
      // Connect gives up and takes the flow's own error branch.
      timeout: Duration.seconds(5),
      environment: { TABLE_NAME: callLogTable.tableName },
      bundling: { minify: true, sourceMap: false },
    });
    callLogTable.grantWriteData(vanityLookupFn);

    // ---------------------------------------------------------------------
    // Lambda: bonus "last 5 callers" read API, exposed via a Function URL.
    // ---------------------------------------------------------------------
    const callersApiFn = new NodejsFunction(this, 'CallersApiFunction', {
      entry: path.join(__dirname, '../../lambda/callers-api/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 128,
      timeout: Duration.seconds(5),
      environment: { TABLE_NAME: callLogTable.tableName },
      bundling: { minify: true, sourceMap: false },
    });
    callLogTable.grantReadData(callersApiFn);

    // AuthType.NONE is a deliberate, documented shortcut for this "minimal"
    // bonus feature -- see docs/design-notes.md "shortcuts" for the
    // production alternative (Cognito/IAM auth in front of the URL, plus a
    // WAF web ACL for rate limiting).
    const callersApiUrl = callersApiFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ['*'],
        allowedMethods: [lambda.HttpMethod.GET],
      },
    });

    // ---------------------------------------------------------------------
    // Amazon Connect: a fresh instance + a claimed DID, since the reviewer
    // doesn't already have a Connect instance to deploy into.
    // ---------------------------------------------------------------------
    const instance = new connect.CfnInstance(this, 'ConnectInstance', {
      identityManagementType: 'CONNECT_MANAGED',
      // Instance aliases are globally unique across all of Amazon Connect,
      // so this is derived from account+region rather than hardcoded.
      instanceAlias: `vanity-connect-${this.account}-${this.region}`.slice(0, 45),
      attributes: {
        inboundCalls: true,
        outboundCalls: true,
      },
    });

    const phoneNumber = new connect.CfnPhoneNumber(this, 'ConnectPhoneNumber', {
      targetArn: instance.attrArn,
      countryCode: 'US',
      type: 'DID',
      description: 'TTEC Digital take-home: vanity number lookup line',
    });

    // Let Connect invoke the vanity Lambda, scoped to this specific instance.
    vanityLookupFn.addPermission('AllowConnectInvoke', {
      principal: new iam.ServicePrincipal('connect.amazonaws.com'),
      sourceArn: instance.attrArn,
    });

    // Required before a contact flow can reference the Lambda: this is what
    // makes the function selectable inside an "Invoke AWS Lambda function"
    // block (the console equivalent is Flows > AWS Lambda > Add Lambda function).
    const lambdaIntegration = new connect.CfnIntegrationAssociation(this, 'LambdaIntegration', {
      instanceId: instance.attrArn,
      integrationType: 'LAMBDA_FUNCTION',
      integrationArn: vanityLookupFn.functionArn,
    });

    // ---------------------------------------------------------------------
    // Contact flow: invoke the Lambda, speak back the vanity numbers.
    // ---------------------------------------------------------------------
    const contactFlow = new connect.CfnContactFlow(this, 'VanityContactFlow', {
      instanceArn: instance.attrArn,
      name: 'Vanity Number Lookup',
      type: 'CONTACT_FLOW',
      content: buildContactFlowContent(vanityLookupFn.functionArn),
    });
    // Explicit, on top of whatever CDK infers from the ARN token embedded in
    // `content`: the flow can't be usable until Connect is actually allowed
    // to invoke the function it references.
    contactFlow.addResourceDependency(lambdaIntegration);

    // ---------------------------------------------------------------------
    // Bind the claimed number to the flow. There is no CloudFormation-native
    // resource for this association (verified against the CFN Connect
    // resource docs while building this) -- only the AssociatePhoneNumberContactFlow
    // API. A small custom resource fills the gap; see
    // lambda/phone-flow-association/index.ts and docs/design-notes.md.
    // ---------------------------------------------------------------------
    const associationHandler = new NodejsFunction(this, 'PhoneFlowAssociationHandler', {
      entry: path.join(__dirname, '../../lambda/phone-flow-association/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30),
      bundling: { minify: true, sourceMap: false },
    });
    associationHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['connect:AssociatePhoneNumberContactFlow'],
        // Connect does not support resource-level permissions for this
        // action as of this writing, so it can't be scoped further than '*'.
        resources: ['*'],
      }),
    );

    const associationProvider = new cr.Provider(this, 'PhoneFlowAssociationProvider', {
      onEventHandler: associationHandler,
    });

    const phoneFlowAssociation = new cdk.CustomResource(this, 'PhoneFlowAssociation', {
      serviceToken: associationProvider.serviceToken,
      properties: {
        InstanceId: instance.attrId,
        PhoneNumberId: phoneNumber.attrPhoneNumberArn,
        ContactFlowId: contactFlow.attrContactFlowArn,
      },
    });
    phoneFlowAssociation.node.addDependency(contactFlow, phoneNumber);

    // ---------------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------------
    new CfnOutput(this, 'ConnectInstanceId', { value: instance.attrId });
    new CfnOutput(this, 'PhoneNumber', {
      value: phoneNumber.attrAddress,
      description: 'Call this number to test the vanity-number flow.',
    });
    new CfnOutput(this, 'CallLogTableName', { value: callLogTable.tableName });
    new CfnOutput(this, 'CallersApiUrl', {
      value: callersApiUrl.url,
      description: 'Paste this into web/config.js for the bonus web app.',
    });
  }
}
