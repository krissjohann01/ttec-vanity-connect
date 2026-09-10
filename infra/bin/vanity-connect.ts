#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { VanityConnectStack } from '../lib/vanity-connect-stack';

// Amazon Connect's phone features aren't available in every AWS region --
// deploying to one of these would fail later on, deep inside the phone
// number setup, with a confusing error. Better to stop early with a clear
// message instead. This list isn't complete on purpose -- check current
// coverage at
// https://docs.aws.amazon.com/connect/latest/adminguide/concepts-telephony.html
// rather than assuming any region not on this list definitely works.
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

new VanityConnectStack(app, 'VanityConnectStack', {
  env: { account, region },
  description: 'Vanity phone number lookup: Amazon Connect + Lambda + DynamoDB.',
});
