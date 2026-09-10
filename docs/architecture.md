# Architecture

## Call path (the required deliverable)

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

## Bonus: "last 5 callers" web app

```mermaid
flowchart LR
    Browser["web/index.html<br/>(static, no build step)"] -->|GET| FnUrl["Lambda Function URL<br/>(AuthType: NONE)"]
    FnUrl --> CallersApi["callers-api Lambda"]
    CallersApi -->|Query pk=CALLLOG,<br/>ScanIndexForward=false,<br/>Limit=5| DDB[(DynamoDB<br/>CallLogTable)]
    DDB --> CallersApi --> FnUrl --> Browser
```

## Deployed resources (AWS CDK, TypeScript)

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

## Component notes

- **vanity-lookup Lambda** (`lambda/vanity-lookup/`) — pure, dependency-free algorithm in `vanity.ts`, unit tested in `vanity.test.ts` independent of AWS. `index.ts` is the thin Connect-facing adapter (parse event, call algorithm, write DynamoDB, shape the response).
- **DynamoDB CallLogTable** — one partition (`pk = "CALLLOG"`), sorted by `sk = ISO timestamp#contactId`. Serves both the write side (call logging) and the bonus read side (`Query`, no scan, no GSI) from a single table. Does not scale past a single-partition write ceiling — see [design-notes.md](design-notes.md) §4.
- **Contact flow** — authored as Connect "Flow language" JSON in `infra/lib/contact-flow-content.ts` rather than built in the visual designer, so it's versioned like the rest of the code. Invoke Lambda → success branch speaks the 3 vanity numbers via `$.External.vanity1/2/3`; error branch (any Lambda failure Connect itself catches) speaks an apology instead of failing the call.
- **phone-flow-association custom resource** — `AWS::Connect::PhoneNumber` has no CloudFormation property to bind a claimed number to a contact flow; that's only exposed via the `AssociatePhoneNumberContactFlow` API. A small Lambda behind a CDK `custom_resources.Provider` fills that gap on stack create/update. See `lambda/phone-flow-association/index.ts`.
- **callers-api Lambda + Function URL** — bonus feature, deliberately minimal (no API Gateway, no S3/CloudFront for the static page) per the "small scale" instruction in the brief.
