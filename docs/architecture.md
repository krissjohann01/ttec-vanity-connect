# Architecture

## How a phone call flows through the system

```mermaid
sequenceDiagram
    actor Caller
    participant DID as Claimed DID<br/>(Amazon Connect)
    participant Flow as Contact Flow<br/>"Vanity Number Lookup"
    participant Lambda as vanity-lookup<br/>Lambda
    participant DDB as DynamoDB<br/>CallLogTable

    Caller->>DID: dials the number
    DID->>Flow: inbound contact
    Flow->>Lambda: InvokeLambdaFunction<br/>(caller's number)
    Lambda->>Lambda: normalize number,<br/>generate & score<br/>vanity candidates
    Lambda->>DDB: PutItem (top 5 + caller number)
    Lambda-->>Flow: { vanity1, vanity2, vanity3 }<br/>(flat STRING_MAP)
    Flow->>Caller: text-to-speech:<br/>"Number one: ... Number two: ... Number three: ..."
    Flow->>Caller: disconnect
```

## Bonus: the "last 5 callers" web page

```mermaid
flowchart LR
    Browser["web/index.html<br/>(static, no build step)"] -->|GET| FnUrl["Lambda Function URL<br/>(AuthType: NONE)"]
    FnUrl --> CallersApi["callers-api Lambda"]
    CallersApi -->|Query pk=CALLLOG,<br/>ScanIndexForward=false,<br/>Limit=5| DDB[(DynamoDB<br/>CallLogTable)]
    DDB --> CallersApi --> FnUrl --> Browser
```

## Everything the CDK stack creates (AWS CDK, TypeScript)

```mermaid
flowchart TB
    subgraph Connect["Amazon Connect"]
        Instance["CfnInstance"]
        Phone["CfnPhoneNumber (DID)"]
        Integration["CfnIntegrationAssociation<br/>(LAMBDA_FUNCTION)"]
        Flow["CfnContactFlow"]
    end
    subgraph Compute["Lambda"]
        VanityFn["vanity-lookup"]
        ApiFn["callers-api"]
        AssocFn["phone-flow-association<br/>(custom resource handler)"]
    end
    subgraph Data["Storage"]
        Table[(DynamoDB CallLogTable)]
    end

    Phone -->|targetArn| Instance
    Integration --> Instance
    Integration --> VanityFn
    Flow --> Instance
    Flow -->|LambdaFunctionARN| VanityFn
    VanityFn --> Table
    ApiFn --> Table
    AssocFn -->|AssociatePhoneNumberContactFlow<br/>SDK call, not CFN-native| Phone
    AssocFn --> Flow
```

## What each piece does

- **vanity-lookup Lambda** (`lambda/vanity-lookup/`) — the actual algorithm lives in `vanity.ts`, kept separate from any AWS code so it can be tested on its own (`vanity.test.ts`). `index.ts` is a small wrapper that reads the incoming call event, runs the algorithm, saves to DynamoDB, and sends back the result.
- **DynamoDB CallLogTable** — all call records sit in one partition (`pk = "CALLLOG"`), sorted by a timestamp. This keeps things simple: both saving a new call and reading "the last 5 callers" are cheap, basic queries with no extra index needed. The trade-off is that one partition can only take so many writes per second — see [design-notes.md](design-notes.md) section 4.
- **Contact flow** — written as JSON code in `infra/lib/contact-flow-content.ts` instead of built by hand in Amazon Connect's drag-and-drop editor, so it's tracked in version control like everything else. It calls the Lambda, and on success reads back the 3 vanity numbers it returned; if the Lambda call fails for any reason, it plays an apology message instead of just failing silently.
- **phone-flow-association (custom resource)** — CloudFormation has no built-in way to connect a claimed phone number to a call flow; that connection can only be made through a separate API call. This is a small Lambda that CloudFormation runs automatically to make that one API call. See `lambda/phone-flow-association/index.ts`.
- **callers-api Lambda + Function URL** — the bonus feature. Kept intentionally simple (no API Gateway, no S3/CloudFront) since the brief asked for "small scale."
