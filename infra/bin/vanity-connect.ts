#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { VanityConnectStack } from '../lib/vanity-connect-stack';

// Amazon Connect telephony (claiming a phone number) is not available in
// every AWS region -- deploying to one of these would fail confusingly deep
// into the CfnPhoneNumber resource. Fail fast instead. Non-exhaustive by
// design: verify current coverage at
// https://docs.aws.amazon.com/connect/latest/adminguide/concepts-telephony.html
// before assuming any other region works.
const KNOWN_UNSUPPORTED_REGIONS = new Set(['us-gov-east-1', 'us-gov-west-1', 'af-south-1']);

const app = new cdk.App();

const region: string =
  app.node.tryGetContext('region') ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-1';
const account: string | undefined = process.env.CDK_DEFAULT_ACCOUNT;

if (KNOWN_UNSUPPORTED_REGIONS.has(region)) {
  throw new Error(
    `Amazon Connect telephony is not available in "${region}". ` +
      'Deploy to a supported region instead, e.g. us-east-1 ' +
      '(pass -c region=us-east-1, or set AWS_REGION/CDK_DEFAULT_REGION before deploying).',
  );
}

new VanityConnectStack(app, 'TtecVanityConnectStack', {
  env: { account, region },
  description:
    'Vanity phone number lookup: Amazon Connect + Lambda + DynamoDB (TTEC Digital take-home project).',
});
