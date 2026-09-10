# Vanity Number Lookup — Amazon Connect + Lambda + DynamoDB

TTEC Digital take-home project: a caller dials an Amazon Connect number, a Lambda function converts their phone number into candidate "vanity numbers" (e.g. `512-CAB-9999`), the best 5 are logged to DynamoDB, and the contact flow speaks the top 3 back to the caller. A minimal bonus web app shows the last 5 callers' vanity numbers.

- **Docs**: [docs/architecture.md](docs/architecture.md) (diagrams) · [docs/design-notes.md](docs/design-notes.md) (rationale, shortcuts, wishlist, production considerations — the required write-up)
- **Algorithm + tests**: [lambda/vanity-lookup/vanity.ts](lambda/vanity-lookup/vanity.ts), [vanity.test.ts](lambda/vanity-lookup/vanity.test.ts)
- **Infra (AWS CDK, TypeScript)**: [infra/](infra/)

## Repo layout

```
infra/                CDK app: DynamoDB table, both Lambdas, Connect instance/number/flow, custom resource
lambda/vanity-lookup/  Core algorithm + Connect-invoked handler (unit tested, no AWS mocks needed)
lambda/callers-api/    Bonus: Function URL Lambda serving the last 5 callers
lambda/phone-flow-association/  Custom-resource handler filling a CloudFormation gap (see design-notes.md)
web/                   Bonus: static single-page app for the last 5 callers
docs/                  Architecture diagram + the required write-up
```

## Prerequisites

- Node.js 20+ and npm
- An AWS account with credentials configured (`aws configure` or equivalent) and permission to create Connect/Lambda/DynamoDB/IAM resources
- AWS CDK bootstrap has been run once per account/region (`cdk bootstrap`, see below)
- **Region**: Amazon Connect telephony (claiming a phone number) isn't available in every AWS region. This stack defaults to `us-east-1` and fails fast with a clear error if pointed at a known-unsupported region (see `infra/bin/vanity-connect.ts`). Override with `-c region=<region>` if you want a different supported region.

## Setup

```bash
npm install
npm test        # runs the algorithm unit tests (no AWS needed)
npm run build   # tsc --noEmit, type-checks everything
npx cdk synth   # renders the CloudFormation template (no AWS credentials needed for this step)
```

## Run it locally first (no AWS account needed)

Everything except the actual phone call can be exercised locally — there's no local emulator for Amazon Connect itself (it's a managed telephony service), so the contact flow / real phone number can only be verified after a deploy. Everything else (the algorithm, both Lambda handlers exactly as deployed, real DynamoDB reads/writes, and the bonus web app) runs locally against [dynalite](https://github.com/mhart/dynalite), a pure-JS DynamoDB-API-compatible server — no Docker, no Java, no AWS credentials.

```bash
npm install
npm run dev
```

This starts a local dev server on `http://localhost:4000` (backed by dynalite on `:8000`) that runs the real `vanity-lookup` and `callers-api` Lambda handler code, unchanged, against a local table. Open `http://localhost:4000` in a browser for a click-to-test debug page (simulate a call, refresh the caller list), or use curl:

```bash
# Simulate an inbound call (same event shape Connect sends the Lambda)
curl -X POST http://localhost:4000/simulate-call \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber":"+15122255669"}'

# See the last 5 "callers"
curl http://localhost:4000/callers
```

### Browsing the DynamoDB table contents

With `npm run dev` running (so dynalite is up on `:8000`), open a second terminal:

```bash
npm run db:admin
```

This runs [dynamodb-admin](https://github.com/aaronshaf/dynamodb-admin) (a small GUI for browsing DynamoDB-API-compatible tables) pointed at the local dynalite instance. Open `http://localhost:8001`, click into `LocalCallLogTable`, and you'll see every logged call — `pk`/`sk`, `callerNumber`, `contactId`, `timestamp`, and the `vanityTop5` array — with scan/query/filter support, the same way you'd inspect the real table in the AWS console after deploying.

To see the bonus web app against this local data:

```bash
cp web/config.example.js web/config.js
# edit web/config.js: window.API_URL = 'http://localhost:4000/callers';
npx serve web       # or open web/index.html directly in a browser
```

This local harness (`scripts/local-server.ts`) is dev tooling only — it's never part of the deployed stack. See `docs/design-notes.md` for what a more complete local-testing setup (e.g. LocalStack, SAM local) would add.

## Deploy into your own AWS account

```bash
npx cdk bootstrap   # one-time per account/region
npx cdk deploy
```

This creates a **new Amazon Connect instance**, claims a **real phone number** (small ongoing cost — a US DID is roughly $1-2/month plus per-minute usage), a DynamoDB table, three Lambda functions, and the contact flow, and wires them together — including binding the claimed number to the contact flow via a custom resource (see [design-notes.md](docs/design-notes.md) for why that step needs a custom resource instead of a plain CloudFormation property).

When it finishes, note the stack outputs:

- **`PhoneNumber`** — call this number to test the flow end-to-end.
- **`CallersApiUrl`** — the bonus API endpoint (see below).
- **`ConnectInstanceId`**, **`CallLogTableName`** — useful for poking around in the AWS console.

### Testing the phone number

Call `PhoneNumber` from any phone. You should hear the top 3 vanity numbers for the caller ID Connect sees. If it goes straight to the apology message, check CloudWatch Logs for the `VanityLookupFunction` and `PhoneFlowAssociationHandler` Lambdas first — see the troubleshooting note below.

### Bonus web app

```bash
cp web/config.example.js web/config.js
# edit web/config.js and paste in the CallersApiUrl output
npx serve web       # or just open web/index.html directly in a browser
```

### Tearing it down

```bash
npx cdk destroy
```

This releases the claimed phone number and deletes the DynamoDB table (including call history — see `RemovalPolicy.DESTROY` note in [design-notes.md](docs/design-notes.md)).

## Troubleshooting

- **`cdk bootstrap`/`cdk deploy` fails with a region error**: see the "Region" note above.
- **Claiming a phone number fails**: some AWS accounts (particularly ones with no billing history) have DID-claiming restricted until AWS reviews the account. Check the Amazon Connect console under Channels > Phone Numbers for the actual error, or try `type: 'TOLL_FREE'` in `infra/lib/vanity-connect-stack.ts` instead of `'DID'` if DIDs are unavailable in your account/region combination.
- **Call connects but nothing plays / goes to the apology message**: check CloudWatch Logs for `VanityLookupFunction` first (the Lambda logs the caller number and any error it caught). If the call doesn't seem to reach the flow at all, check the `PhoneFlowAssociation` custom resource's CloudFormation event (Console → CloudFormation → this stack → Resources) — that's the step that binds the claimed number to the contact flow.
