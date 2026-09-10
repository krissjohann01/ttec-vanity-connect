# Design Notes

This covers the "Writing and Documentation" part of the brief. For diagrams, see [architecture.md](architecture.md).

## How I decided what "best" means for a vanity number

Code: [`lambda/vanity-lookup/vanity.ts`](../lambda/vanity-lookup/vanity.ts).

A vanity number is only good if a person would actually recognize it as a word and remember it. So I rank candidates in this order:

1. **How many digits turned into letters.** A number that's a full word (like `SHOEBOX`) is more memorable than one that's only partly a word (like `CAB-9999`). Full words always beat partial matches.
2. **Fewer words used.** `SHOEBOX` (one word) beats `SHOE-BOX` (two words), even though both use all the same digits. One clean word is easier to remember than two words stuck together.
3. **How common the word is.** I use a word-frequency list, so more common words rank higher. This matters because an obscure word doesn't feel "vanity" if nobody recognizes it when it's read out loud.
4. **How early the word starts.** The part of the number you hear first is the part that sticks, so an earlier match gets a small bonus.

Two other choices worth explaining:

- I only ever convert the **7-digit local number**, never the area code. This is how real vanity numbers work too — 1-800-**FLOWERS** keeps the toll-free part as numbers and only turns part of it into a word.
- The dictionary is a list of about 6,000 common English words (from Google's top-10,000-words list, filtered down to words that are 3-7 letters and only use letters found on a phone keypad, with profanity removed). I didn't use a full dictionary on purpose — a full dictionary would return a lot of weird, obscure words that nobody would recognize as real words.

## 1. Why I built it this way, and what went wrong along the way

- **I used AWS CDK (TypeScript) for infrastructure**, instead of SAM, Terraform, Serverless Framework, or plain CloudFormation. This role is TypeScript/Node.js focused, and CDK lets the Lambda code and the infrastructure code live in the same language and the same test setup. It also bundles the Lambda code automatically, so there's no separate build step to keep in sync.
- **The vanity-number logic is its own plain TypeScript file** (`vanity.ts`) with no AWS code in it at all. That means I can test it (23 tests) without needing to fake or mock any AWS services. `index.ts` is a small wrapper around it that just handles the Connect event and saves to DynamoDB.
- **The biggest gap I found: CloudFormation can't fully set up Amazon Connect on its own.** There's a CloudFormation resource for claiming a phone number, and one for creating a contact flow, but nothing to connect the two — linking a phone number to a flow is only possible through a separate API call (`AssociatePhoneNumberContactFlow`). I checked the AWS docs directly to be sure this wasn't just something I missed, then wrote a small extra Lambda (`lambda/phone-flow-association/`) that CloudFormation runs automatically to do that one API call for me. This way the whole thing still deploys with one command, with no manual step left for whoever reviews this.
- **Writing the contact flow by hand, and a real bug that only showed up on a real deploy.** Amazon Connect flows are normally built by dragging and dropping blocks in a web UI. Instead, I wrote the flow as JSON code (`infra/lib/contact-flow-content.ts`), so it's version-controlled like everything else. While researching the correct format, I picked up a detail from an article that turned out to be wrong — I had added a parameter called `ResponseValidation` to the "call this Lambda" step, which doesn't actually exist. When I ran a real deploy against a real AWS account, it failed. CloudFormation's error message didn't say why, so I called Amazon Connect's API directly (using the AWS CLI, against a throw-away test instance) to see the real error, and compared my flow to a working example flow that AWS generates automatically for new accounts. That's how I found and fixed the bad parameter. Good reminder: reading documentation and actually testing against a real system are two different levels of confidence, and only one of them proves your code works.
- **New AWS accounts come with limits you don't expect.** When I deployed into a brand-new AWS account, I hit two separate limits that wouldn't show up on an older account: new accounts start with a limit of 0 Amazon Connect instances, and claiming a phone number has its own separate limit that needs AWS's manual approval. The first one I could fix myself right away by requesting a limit increase (approved instantly). The second one opened a support case with AWS and needs a human at AWS to approve it, so it just takes time. Worth knowing: if a deploy fails on a brand-new AWS account, it's not always your code — sometimes it's the account itself.
- **My tests caught a real bug before I even deployed anything.** My first version of the code that formats a vanity number used a fixed pattern (3 digits, dash, 4 digits) no matter what. That caused a problem: the single word `SHOEBOX` and the two words `SHOE` + `BOX` (using the exact same digits) both ended up formatted as the exact same text, so my own code would treat them as duplicates and silently throw one away. A test that checked "these two should be different" caught it. The fix — showing word breaks clearly, like `512-SHOE-BOX` vs `512-SHOEBOX` — also just looks like a better, more realistic vanity number.

## 2. Shortcuts I took that would be bad practice in production

- **The DynamoDB table is set to fully delete when the stack is deleted** (`removalPolicy: DESTROY`). That means tearing down this project also deletes all call history. A production version should keep the data around and only delete it on purpose.
- **One DynamoDB partition holds all the call history.** This keeps things simple for a demo and needs no extra index, but one partition can only handle so many writes per second — see section 4 below.
- **The bonus API has no login/authentication at all.** Anyone with the URL can read it. Fine for a demo, not okay for real caller data.
- **Caller numbers are partly hidden in the bonus web app** (shown as `(***) ***-1234`), but the full number is still stored in the database and read out loud on the phone call. A real product would need an actual policy about how phone numbers (which count as personal/private data) are handled — not just one developer's personal judgment call.
- **Only US/Canada phone numbers are supported.** Any other country's number is simply rejected. This is a real limitation, not just a minor detail.
- **No alerts, no error dashboard.** If something breaks, the only way to notice is to go looking in the logs yourself.
- **The word list isn't hand-checked.** It's a general list of common English words, so it still has a few names and odd entries in it (I saw `JIM` and `LYNN` show up during testing) since I only filtered by word length, letters, and profanity — not by "is this actually a normal word."
- **The cleanup code for the phone-number/flow link doesn't undo itself.** When the whole project is deleted, the extra Lambda that links the phone number to the flow doesn't bother disconnecting them first, since everything's being deleted together anyway. Reasonable here, but I wouldn't reuse this shortcut in a bigger project.
- **No automated pipeline.** I run tests, linting, and `cdk synth` by hand — there's no GitHub Actions workflow checking every change automatically.
- **The local testing setup uses a stand-in database, not real DynamoDB.** Running `npm run dev` uses a small tool called [dynalite](https://github.com/mhart/dynalite) that copies DynamoDB's behavior in plain JavaScript, so testing locally doesn't need Docker, Java, or an AWS account. I checked that writing, reading, sorting, and the bonus web app all work correctly against it, and added `npm run db:admin` so you can actually browse the local table contents in a browser. It's close enough to be useful, but it's not guaranteed to behave exactly like real DynamoDB in every edge case. A more serious setup would use AWS's own local DynamoDB tool instead — I'm noting this instead of just assuming the stand-in is perfect.

## 3. What I'd do with more time

- **Use a better, hand-checked word list** instead of a general common-words list — remove names and brand words, and maybe favor words that sound natural out loud, not just words that are common in writing.
- **Support phone numbers from other countries**, not just US/Canada.
- **Split the call-history table into multiple partitions** so heavy call traffic and the bonus feature don't compete for the same write capacity (see section 4).
- **Add a CI pipeline** — run tests, linting, and `cdk synth` automatically on every change.
- **Add real monitoring** — logs that are easy to search, a dashboard showing errors and traffic, and at least one alert if something breaks.
- **Improve the word-scoring** using a better source of "how common is this word," and maybe factor in how natural a word sounds when spoken out loud by the text-to-speech voice.
- **Make the bonus web app more real** — host it properly (S3 + CloudFront) with an actual deploy process, and have it update live instead of only on page load.
- **Actually load-test the phone system** against Amazon Connect's real limits before calling any of this "ready for production."

## 4. What I'd need to think about before this could handle real traffic or real attackers

**Handling more traffic**

- The single database partition is the first thing that would break under real load — one partition can only handle so many writes per second, no matter how the table is otherwise configured. A production version would split the writes across multiple partitions and use a separate index for "give me the most recent calls."
- Amazon Connect only waits 8 seconds for the Lambda to respond before giving up. If the Lambda is slow to start up (common right after it's been idle), that's a real risk under heavy call volume. Keeping the code and word list small (which it already is) helps, and AWS has a feature to keep the Lambda "warm" that could help further.
- Amazon Connect itself has limits on how many calls it can handle at once per account — these would need to be checked and possibly raised with AWS before any real launch.

**Security**

- The bonus web app's API has no login and is open to anyone with the URL — real usage would need proper authentication and some protection against abuse (like a firewall with rate limiting).
- Phone numbers are personal, private information. A real product needs an actual policy on how that data is stored and protected — not just partially hiding it in one place, like this demo does.
- The permissions on the Lambda functions should be checked regularly over time, not just set correctly once and forgotten.
- There's nothing stopping someone from repeatedly calling the number to spam the system — a real version would need some kind of rate limiting on the phone line itself.
- The extra Lambda that links the phone number to the flow has broader permissions than I'd like, because Amazon Connect doesn't currently offer a way to narrow them further for that specific action. Worth checking again later in case AWS adds that option.

**Day-to-day operations**

- There's no alerting and no plan for what to do if something breaks at 2am. At minimum, a real version needs alerts for errors and a documented way to roll back a bad deploy.
