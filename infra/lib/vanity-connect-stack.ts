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
    // DynamoDB: one table holding all call history. See
    // lambda/vanity-lookup/dynamo.ts for why it's set up this way.
    // ---------------------------------------------------------------------
    const callLogTable = new dynamodb.Table(this, 'CallLogTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Shortcut for a demo project: deleting the stack deletes real call
      // history along with it. A production setup should keep the data
      // around on purpose -- see design-notes.md.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ---------------------------------------------------------------------
    // Lambda: the vanity-number lookup, called directly by the call flow.
    // ---------------------------------------------------------------------
    const vanityLookupFn = new NodejsFunction(this, 'VanityLookupFunction', {
      entry: path.join(__dirname, '../../lambda/vanity-lookup/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      // Amazon Connect only waits 8 seconds for this Lambda to respond
      // (see InvocationTimeLimitSeconds in contact-flow-content.ts), so
      // this timeout needs to stay well under that -- that way, whether
      // the Lambda succeeds or fails, Connect always hears back from it
      // before giving up and showing its own generic error instead.
      timeout: Duration.seconds(5),
      environment: { TABLE_NAME: callLogTable.tableName },
      bundling: { minify: true, sourceMap: false },
    });
    callLogTable.grantWriteData(vanityLookupFn);

    // ---------------------------------------------------------------------
    // Lambda: the bonus "last 5 callers" API, reachable over plain HTTP.
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

    // No login required to call this URL -- a deliberate shortcut for this
    // small bonus feature. See the "shortcuts" section of design-notes.md
    // for what a production version would need instead (real login, plus a
    // firewall to limit abuse).
    const callersApiUrl = callersApiFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ['*'],
        allowedMethods: [lambda.HttpMethod.GET],
      },
    });

    // ---------------------------------------------------------------------
    // Amazon Connect: creates a brand-new instance and claims a phone
    // number, since whoever deploys this likely doesn't have one already.
    // ---------------------------------------------------------------------
    const instance = new connect.CfnInstance(this, 'ConnectInstance', {
      identityManagementType: 'CONNECT_MANAGED',
      // This name has to be unique across all of Amazon Connect (not just
      // this AWS account), so it's built from the account ID and region
      // instead of being a fixed name.
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
      description: 'Vanity number lookup line',
    });

    // Give this specific Connect instance permission to call the Lambda.
    vanityLookupFn.addPermission('AllowConnectInvoke', {
      principal: new iam.ServicePrincipal('connect.amazonaws.com'),
      sourceArn: instance.attrArn,
    });

    // Needed before a call flow can use this Lambda -- this is what makes
    // it show up as an option in an "Invoke AWS Lambda function" step (the
    // same thing you'd do by hand under Flows > AWS Lambda in the console).
    const lambdaIntegration = new connect.CfnIntegrationAssociation(this, 'LambdaIntegration', {
      instanceId: instance.attrArn,
      integrationType: 'LAMBDA_FUNCTION',
      integrationArn: vanityLookupFn.functionArn,
    });

    // ---------------------------------------------------------------------
    // Contact flow: calls the Lambda, then reads the vanity numbers back.
    // ---------------------------------------------------------------------
    const contactFlow = new connect.CfnContactFlow(this, 'VanityContactFlow', {
      instanceArn: instance.attrArn,
      name: 'Vanity Number Lookup',
      type: 'CONTACT_FLOW',
      content: buildContactFlowContent(vanityLookupFn.functionArn),
    });
    // Spelled out explicitly, on top of whatever CDK already figures out on
    // its own: the flow isn't actually usable until Connect is allowed to
    // call the Lambda function it references.
    contactFlow.addResourceDependency(lambdaIntegration);

    // ---------------------------------------------------------------------
    // Connect the claimed number to the call flow. There's no built-in
    // CloudFormation way to do this (checked the AWS docs directly to make
    // sure) -- it's only possible through a separate API call. A small
    // extra Lambda fills that gap; see
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
        // Amazon Connect doesn't currently let you limit this specific
        // permission to just one instance, so it can't be narrowed further.
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
