# Design Notes

This answers the "Writing and Documentation" section of the brief directly. See also [architecture.md](architecture.md) for the diagrams.

## What "best" means for vanity numbers (Exercise §1)

Full implementation: [`lambda/vanity-lookup/vanity.ts`](../lambda/vanity-lookup/vanity.ts).

A vanity number is only useful if a human would actually recognize and remember it, so "best" is defined, in priority order, as:

1. **More of the number's 7 local digits converted to letters.** A fully-worded number (`SHOEBOX`) is more memorable than a partially-worded one (`CAB-9999`), so full segmentations always outrank partial matches.
2. **Fewer words used to cover that many digits.** `SHOEBOX` (one word) outranks `SHOE-BOX` (two words) even though both convert every digit — one memorable word beats a run-on phrase.
3. **More common words**, using average rank in a frequency-ordered dictionary (see below). This avoids surfacing an obscure word a caller wouldn't recognize when it's read aloud over the phone — a vanity number nobody recognizes as a word isn't actually vanity.
4. **Starting earlier in the local number.** The part a caller hears/reads first is the part that sticks, so an earlier match is weighted slightly higher as a tiebreaker.

Two other decisions worth calling out:

- Only the **7-digit local number** is ever converted, never the area code — this mirrors how real vanity numbers work (1-800-**FLOWERS** keeps the toll-free prefix numeric).
- The dictionary is a frequency-ranked ~6,000-word list (Google's 10k-most-common-English-words corpus, filtered to 3-7 letter alphabetic words, profanity-filtered), not a full dictionary. A full dictionary would surface technically-valid but obscure or confusing words; frequency ranking directly powers criterion 3 above.

## 1. Reasons, struggles, and problems overcome

- **AWS CDK (TypeScript) as the IaC tool**, over SAM/Terraform/Serverless/raw CloudFormation. It matches the role's TypeScript/Node.js focus, lets the Lambda code and infra share one language and toolchain (one `tsconfig`, one test runner), and `NodejsFunction` bundles the Lambdas with esbuild automatically — no separate build step to keep in sync with the stack.
- **The vanity-number algorithm is a pure, dependency-free TypeScript module** (`vanity.ts`) with zero AWS imports, so it's fully unit-testable (23 tests) without mocking AWS SDK calls. `index.ts` is a thin adapter that only handles the Connect-specific event shape and DynamoDB write.
- **The biggest struggle was Amazon Connect's IaC coverage gap**: `AWS::Connect::PhoneNumber` has no CloudFormation property to bind a claimed number to a contact flow — that's only exposed via the `AssociatePhoneNumberContactFlow` SDK API, with no CloudFormation-native resource for it. I confirmed this directly against the AWS API/CloudFormation reference docs rather than assuming, then closed the gap with a small custom resource (`lambda/phone-flow-association/`) behind a CDK `custom_resources.Provider`. This is exactly the kind of "the console can do it but IaC can't (yet)" gap a principal engineer is expected to notice and solve cleanly rather than paper over with a manual step.
- **Getting the contact-flow "Flow language" JSON right without a designer.** Amazon Connect flows are normally built by dragging blocks in the console; this project hand-authors the JSON instead (`infra/lib/contact-flow-content.ts`) so the flow is versioned like everything else. I verified the exact block schema (`InvokeLambdaFunction` parameters, `MessageParticipant` dynamic-text syntax, error-transition shape) against AWS's own Flow Language reference before writing it, rather than guessing at an undocumented format.
- **Response shape matters more than it looks.** Connect only auto-promotes a *flat* object of *string* values from a Lambda response into `$.External.*` contact attributes (`ResponseValidation: STRING_MAP`). A nested object or a non-string value (e.g. a real number) would silently fail to show up in the flow with no obvious error — this shaped both the Lambda's return type (`VanityLookupResponse`) and a comment flagging why it's load-bearing.
- **Caught a real bug via the unit tests, not by inspection.** The first version of the display formatter used a fixed 3-4 digit hyphen split (`XXX-XXXX`), which caused two *different* word segmentations of the same digits (`SHOEBOX` vs. `SHOE`+`BOX`) to render as the identical display string and silently deduplicate one away. A test asserting both should be distinguishable candidates caught it; the fix (format word-boundary-first, e.g. `512-SHOE-BOX` vs. `512-SHOEBOX`) is also just a better vanity-number format.

## 2. Shortcuts taken that would be bad practice in production

- **`DynamoDB.removalPolicy: DESTROY`** — `cdk destroy` deletes real call history. Production should be `RETAIN` with a real backup/lifecycle policy.
- **Single DynamoDB partition (`pk = "CALLLOG"`)** for the whole call log. It's cheap and simple at demo scale and needs no GSI, but a single logical partition has a hard write-throughput ceiling — see §4.
- **`callers-api` Function URL has `AuthType: NONE`** and is world-readable. Fine for a demo, not for anything handling real caller data.
- **Caller numbers are masked (`(***) ***-1234`) by default in the bonus API**, but the *full* number is still written to DynamoDB and spoken back over the phone unmasked — a real product would need an explicit data-handling policy for what counts as PII/CPNI here, not an ad hoc choice made by one engineer.
- **NANP-only phone number parsing.** International numbers are rejected outright (`normalizePhoneNumber` returns `null`), which is a real functionality gap, not just a formatting nicety.
- **No dead-letter queue, no alarms, no dashboard.** Lambda errors and DynamoDB throttles are only visible in CloudWatch Logs if someone goes looking.
- **The word dictionary is a general frequency list, not a curated/moderated one.** It still contains some proper nouns and web-crawl artifacts (see a few odd results in testing, e.g. `JIM`/`LYNN` turning up from a name-heavy corpus) since it wasn't hand-curated beyond profanity filtering and length/alphabetic filters.
- **The custom resource's Delete handler is a deliberate no-op** (see `lambda/phone-flow-association/index.ts`) rather than calling `DisassociatePhoneNumberContactFlow` — reasonable here since the number and flow are torn down in the same stack deletion, but worth flagging as a simplification rather than a general pattern.
- **No CI pipeline.** Tests, lint, and `cdk synth` all run locally/manually; there's no GitHub Actions workflow gating merges.
- **The local dev harness (`npm run dev`, see README "Run it locally first") uses [dynalite](https://github.com/mhart/dynalite)**, a community-maintained pure-JS reimplementation of the DynamoDB API, not real DynamoDB or AWS's own DynamoDB Local (which requires a JVM that isn't part of this project's toolchain). It's accurate enough to exercise the actual handler code end-to-end (verified: writes, queries, ordering, and the bonus web app all work against it, and `npm run db:admin` — [dynamodb-admin](https://github.com/aaronshaf/dynamodb-admin) pointed at the local dynalite endpoint — gives a real item-level table browser for it), but it's not guaranteed to match every DynamoDB behavior exactly (e.g. certain error codes, capacity-related throttling). A more production-grade local setup would use LocalStack or AWS's own DynamoDB Local instead — noted here rather than silently trusting a third-party emulator's fidelity. (One small wrinkle found while wiring this up: `dynamodb-admin`'s current release declares a Node >=22 engine requirement; it still runs fine on Node 20 in practice, but a reviewer on an older Node may see an engine warning that's safe to ignore.)

## 3. What I'd do with more time (wishlist)

- **A curated, moderated dictionary** instead of a general frequency list — filter out proper nouns/brand names, and possibly weight by *spoken* memorability, not just written frequency (some common written words are awkward to say aloud).
- **International number support** — at minimum E.164-aware parsing with per-country-code local-number-length rules, since the current implementation is NANP-only.
- **A GSI/sharded write path for the call log** so the bonus feature and any future analytics don't share a hot partition with call-time writes (see §4).
- **CI**: GitHub Actions running `npm test`, `npm run lint`, and `cdk synth` (plus `cdk diff` against a persistent dev stack) on every PR.
- **Real observability**: structured logs, a CloudWatch dashboard (Lambda errors/duration, DynamoDB throttles, Connect contact volume), and at least one alarm (Lambda error rate) wired to a notification target.
- **A second, richer scoring signal**: actual word-frequency corpora (e.g. COCA) instead of a generic top-10k list, and maybe a syllable/pronounceability heuristic for how naturally a word reads aloud via Polly.
- **Turn the bonus web app into something worth the name**: S3 + CloudFront + a real deploy pipeline, and probably a live-update (WebSocket or polling-with-etag) instead of load-once.
- **Load/soak testing the contact flow** against Connect's actual concurrency limits before calling any of this "production-ready."

## 4. Considerations before this is ready for real traffic and real attackers

**Scale**

- The call log's single DynamoDB partition is the first thing to break under real volume — DynamoDB partitions have a per-partition throughput ceiling regardless of the table's overall provisioned/on-demand capacity. Production would shard the partition key (e.g. `CALLLOG#<hour>` or a hashed shard suffix) and use a GSI for "recent N" queries instead of relying on partition-key locality.
- Lambda cold starts matter here specifically because Connect's `InvokeLambdaFunction` block has an 8-second hard ceiling — a cold start plus a slow dictionary load could blow that budget under bursty call volume. Provisioned concurrency (or at least keeping the bundle/dictionary small, which this implementation already does by loading the dictionary once at module scope) would be a first mitigation to measure.
- Amazon Connect itself has account-level concurrent-call and API rate limits that would need to be checked against expected call volume and raised via AWS Support ahead of any real launch.

**Security / attack surface**

- The `callers-api` Function URL is currently unauthenticated and world-readable — real production traffic would need auth (Cognito or IAM SigV4) plus a WAF web ACL for rate limiting/bot protection in front of it.
- Caller phone numbers are PII (and CPNI-adjacent, given the telephony context) — production needs an explicit data classification and retention policy, not the demo's ad hoc masking-in-the-API-only approach, and likely encryption-at-rest key management beyond DynamoDB's default.
- The vanity-lookup Lambda's IAM role should be reviewed for drift over time (it's scoped to `PutItem` on one table today, which is correct, but least-privilege needs to be actively maintained, not just true at launch).
- No abuse/rate-limiting exists on the phone line itself — a bad actor auto-dialing the number repeatedly would generate real DynamoDB writes and Lambda invocations with no backpressure; production would want per-caller-ID throttling in the contact flow or WAF-equivalent protection at the telephony layer.
- The `phone-flow-association` custom resource's IAM policy is scoped to `resources: ['*']` because Connect doesn't support resource-level permissions for `AssociatePhoneNumberContactFlow` as of this writing — worth re-checking if AWS adds resource-level support later.

**Operational readiness**

- No alerting, no runbook, no on-call story. At minimum: Lambda error-rate alarms, DynamoDB throttle alarms, and a documented rollback procedure (`cdk deploy` of the previous template) before this could be called production-ready.
