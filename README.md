# Vanity Number Lookup — Amazon Connect + Lambda + DynamoDB

A small take-home project. Here's what it does: someone calls an Amazon Connect phone number, a Lambda function turns their phone number into "vanity number" suggestions (like `512-CAB-9999`), the best 5 get saved to DynamoDB, and the phone call reads the top 3 back out loud. There's also a small bonus web page that shows the last 5 callers.

- **Docs**: [docs/architecture.md](docs/architecture.md) (diagrams) · [docs/design-notes.md](docs/design-notes.md) (why I built it this way, shortcuts I took, what I'd do with more time, production considerations)
- **Algorithm + tests**: [lambda/vanity-lookup/vanity.ts](lambda/vanity-lookup/vanity.ts), [vanity.test.ts](lambda/vanity-lookup/vanity.test.ts)
- **Infrastructure (AWS CDK, TypeScript)**: [infra/](infra/)

## What's in this repo

```
infra/                CDK app: DynamoDB table, both Lambdas, Connect instance/number/flow, custom resource
lambda/vanity-lookup/  Core algorithm + the handler Connect calls (unit tested, no AWS needed to test it)
lambda/callers-api/    Bonus: small Lambda that serves the last 5 callers
lambda/phone-flow-association/  Extra Lambda that fills a gap CloudFormation has (see design-notes.md)
web/                   Bonus: simple one-page web app showing the last 5 callers
docs/                  Architecture diagram + the required write-up
```

## Before you start

- Node.js 20+ and npm
- An AWS account with credentials set up (`aws configure` or similar), with permission to create Connect/Lambda/DynamoDB/IAM resources
- Run CDK's one-time setup for your account/region (`cdk bootstrap`, shown below)
- **Region**: Amazon Connect's phone features aren't available in every AWS region. This project defaults to `us-east-1` and will stop with a clear error if you point it at a region that doesn't support it (see `infra/bin/vanity-connect.ts`). Pass `-c region=<region>` if you want a different, supported region.

## Setup

```bash
npm install
npm test        # runs the algorithm's unit tests (no AWS needed)
npm run build   # type-checks everything
npx cdk synth   # builds the CloudFormation template (no AWS credentials needed for this step)
```

## Try it locally first (no AWS account needed)

Almost everything can be tested locally. The one exception is the actual phone call — Amazon Connect is a real phone service with no local version of it, so that part can only be tested after deploying. But the algorithm, both Lambda functions (the real code, unchanged), the database reads/writes, and the bonus web app can all be tested locally using [dynalite](https://github.com/mhart/dynalite), a small tool that copies DynamoDB's behavior — no Docker, no Java, no AWS account needed.

```bash
npm install
npm run dev
```

This starts a local server at `http://localhost:4000` (with dynalite running behind it on port 8000) that runs the real Lambda code against a local table. Open `http://localhost:4000` in a browser for a simple test page (simulate a call, see the caller list), or use curl:

```bash
# Simulate an inbound call (same shape of data Connect would send the Lambda)
curl -X POST http://localhost:4000/simulate-call \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber":"+15122255669"}'

# See the last 5 "callers"
curl http://localhost:4000/callers
```

### Looking at what's actually in the database

With `npm run dev` still running, open a second terminal:

```bash
npm run db:admin
```

This starts [dynamodb-admin](https://github.com/aaronshaf/dynamodb-admin), a simple browser tool for looking at DynamoDB-style tables, pointed at the local database. Open `http://localhost:8001`, click into `LocalCallLogTable`, and you can see every saved call — the caller's number, a timestamp, and the list of vanity numbers — plus search and filter tools, similar to what you'd see in the real AWS console after deploying.

To try the bonus web app against this local data:

```bash
cp web/config.example.js web/config.js
# edit web/config.js: window.API_URL = 'http://localhost:4000/callers';
npx serve web       # or open web/index.html directly in a browser
```

This local setup (`scripts/local-server.ts`) is just for testing — it's not part of what actually gets deployed to AWS. See `docs/design-notes.md` for what a more complete local-testing setup would look like.

## Deploying to your own AWS account

```bash
npx cdk bootstrap   # one-time setup per account/region
npx cdk deploy
```

This creates a **new Amazon Connect instance**, claims a **real phone number** (small ongoing cost — a US number runs roughly $1-2/month plus a bit per minute of use), a DynamoDB table, three Lambda functions, and the phone call flow, and connects them all together — including linking the phone number to the call flow through an extra step (see [design-notes.md](docs/design-notes.md) for why that needs an extra step instead of just being part of the normal setup).

Once it's done, note the outputs it prints:

- **`PhoneNumber`** — call this number to try the whole thing out.
- **`CallersApiUrl`** — the bonus API's address (see below).
- **`ConnectInstanceId`**, **`CallLogTableName`** — handy if you want to look around in the AWS console.

### Trying the phone number

Call `PhoneNumber` from any phone. You should hear the top 3 vanity numbers for your caller ID. If it just plays an apology message instead, check the CloudWatch logs for the `VanityLookupFunction` and `PhoneFlowAssociationHandler` Lambdas first — see Troubleshooting below.

### Bonus web app

```bash
cp web/config.example.js web/config.js
# edit web/config.js and paste in the CallersApiUrl output
npx serve web       # or just open web/index.html directly in a browser
```

### Taking it all down

```bash
npx cdk destroy
```

This releases the phone number and deletes the DynamoDB table, including all call history (see the note about `RemovalPolicy.DESTROY` in [design-notes.md](docs/design-notes.md)).

## Troubleshooting

- **`cdk bootstrap`/`cdk deploy` fails with a region error**: see the "Region" note above.
- **`cdk deploy` fails on `ConnectInstance` with something like `ServiceQuotaExceededException`, or on `ConnectPhoneNumber` with "did not stabilize"**: brand-new AWS accounts start out allowed to create 0 Amazon Connect instances. Check with:
  ```bash
  aws service-quotas get-service-quota --service-code connect --quota-code L-AA17A6B9
  ```
  If it shows 0, ask for more (this one is usually approved right away, automatically):
  ```bash
  aws service-quotas request-service-quota-increase --service-code connect --quota-code L-AA17A6B9 --desired-value 3
  ```
- **Claiming the phone number fails with "The allowed limit for claimed phone numbers has been exceeded for your instance"**: this is a separate, stricter limit (`L-8F812903`, "Phone numbers per instance") that usually needs a real person at AWS to approve it, rather than being automatic:
  ```bash
  aws service-quotas request-service-quota-increase --service-code connect --quota-code L-8F812903 --desired-value 5 --context-id <your-connect-instance-arn>
  ```
  This opens a support case instead of approving right away — it can take a few hours, sometimes longer, and re-running `cdk deploy` won't speed that up. Check on it with `aws service-quotas get-requested-service-quota-change --request-id <id>`.
- **The call connects but nothing plays, or it just plays the apology message**: check the CloudWatch logs for `VanityLookupFunction` first (it logs the caller's number and any error it ran into). If the call doesn't seem to reach the flow at all, check the `PhoneFlowAssociation` step's CloudFormation event (AWS Console → CloudFormation → this stack → Resources) — that's the step that connects the phone number to the call flow.
