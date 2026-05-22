/**
 * Foxxi sample content — one substantial, realistic course and one
 * substantial job aid, shared by every demo so they showcase genuine
 * instructional content, not toy one-liners.
 *
 * The content is text, but it is *real*: a multi-module course with
 * concept fragments that actually explain, worked examples that walk a
 * realistic case, and assessment items that test understanding — the
 * shape an L&D team or a performance consultant would recognise.
 *
 * Pure data — no imports — so the bridge-side tools and the microsite
 * demo page can both consume it.
 */

export interface SampleCoursePayload {
  title: string;
  competency: string;
  audience: 'human' | 'agent';
  authoredBy: { id: string; kind: 'human' | 'agent' };
  modules: Array<{
    title: string;
    competencyPoint: string;
    lessons: Array<{
      title: string;
      competencyPoint: string;
      fragments: Array<{ modality: string; body: string; level: string }>;
    }>;
  }>;
}

export interface SampleJobAid {
  competencyPoint: string;
  triggerContext: string;
  body: string;
}

/** A realistic support-enablement course. */
export const SAMPLE_COURSE: SampleCoursePayload = {
  title: 'Refund Dispute Resolution',
  competency: 'resolving customer refund disputes within policy',
  audience: 'human',
  authoredBy: { id: 'did:web:acme#sme-lee', kind: 'human' },
  modules: [
    {
      title: 'Refund authority',
      competencyPoint: 'knowing what you may authorise',
      lessons: [
        {
          title: 'Authority thresholds and the approval tiers',
          competencyPoint: 'refund authority thresholds',
          fragments: [
            {
              modality: 'concept', level: 'foundational',
              body: 'Authority is tiered by the refund amount, not the order value. A support rep may '
                + 'authorise a refund up to $500. A team lead may authorise up to $2,500. Above $2,500 a '
                + 'manager must approve. Layered on top is a per-customer rolling 90-day cap: once a '
                + 'customer has received $1,000 in rep-authorised refunds within 90 days, the next refund '
                + 'routes to a team lead regardless of how small it is. The cap exists so a pattern of '
                + 'many small refunds gets a second set of eyes, not just the large ones.',
            },
            {
              modality: 'worked-example', level: 'working',
              body: 'A $420 dispute on a single order — within the $500 tier, the rep resolves it. '
                + 'A $1,300 dispute — above $500, route it to a team lead. A $300 dispute from a customer '
                + 'who has already had $850 refunded in the last 60 days — small, but it would carry the '
                + 'customer past the $1,000 rolling cap, so it routes to a lead even though $300 is well '
                + 'inside the rep tier.',
            },
            {
              modality: 'assessment-item', level: 'applied',
              body: 'A customer has had $700 in rep-authorised refunds in the last 90 days and now '
                + 'disputes a $250 charge. Who authorises it? ::: a team lead — the $250 would carry the '
                + 'customer past the $1,000 rolling 90-day cap',
            },
          ],
        },
        {
          title: 'The eligibility decision tree',
          competencyPoint: 'deciding whether a refund is in policy',
          fragments: [
            {
              modality: 'concept', level: 'foundational',
              body: 'Eligibility runs through four gates, in order — stop at the first that fails. '
                + 'Gate 1: was the item or service actually delivered, and is it being returned or '
                + 'cancelled? Gate 2: is the request inside the policy window — 30 days for physical '
                + 'goods, 14 days for digital? Gate 3: is the reason a covered one — defective, '
                + 'not-as-described, a billing error, or a duplicate charge — rather than an uncovered '
                + 'one such as a changed mind on a final-sale item? Gate 4: is the item in a refundable '
                + 'condition? All four must pass for an in-policy refund. A failure does not mean an '
                + 'automatic denial — it means the case moves to exception handling.',
            },
            {
              modality: 'worked-example', level: 'working',
              body: 'A customer reports headphones that arrived defective and wants to return them on '
                + 'day 22. Gate 1 — delivered and being returned: pass. Gate 2 — day 22, inside the '
                + '30-day goods window: pass. Gate 3 — "defective" is a covered reason: pass. Gate 4 — '
                + 'the unit is intact and returnable: pass. All four gates pass, so this is an in-policy '
                + 'refund the rep can resolve directly.',
            },
            {
              modality: 'assessment-item', level: 'applied',
              body: 'A digital subscription, cancellation requested on day 19, reason "didn\'t end up '
                + 'using it". Which gate fails? ::: the policy window — digital has a 14-day window',
            },
          ],
        },
      ],
    },
    {
      title: 'Working the dispute',
      competencyPoint: 'handling the customer well',
      lessons: [
        {
          title: 'Opening the conversation and de-escalation',
          competencyPoint: 'de-escalating a refund dispute',
          fragments: [
            {
              modality: 'concept', level: 'working',
              body: 'The first thirty seconds set the tone. Acknowledge the specific frustration rather '
                + 'than offering a generic apology — "a duplicate charge is exactly the kind of thing '
                + 'that\'s frustrating to find" lands; "sorry for any inconvenience" does not. Restate '
                + 'the customer\'s goal in your own words so they know they were heard. Then set a clear '
                + 'expectation of what happens next and by when. Do not argue the policy before you have '
                + 'understood the case — a customer who feels heard accepts a "no" far more readily than '
                + 'one who feels processed.',
            },
            {
              modality: 'worked-example', level: 'applied',
              body: 'Customer, angry: "I\'ve been charged twice and nobody will help me." Rep: '
                + '"Being double-charged and then bounced around — that\'s genuinely frustrating, and '
                + 'I\'m going to deal with it now. Let me make sure I have it right: you see two charges '
                + 'of $84.99 from the same order, and you want one of them reversed. Give me about two '
                + 'minutes to confirm the duplicate on our side, and I\'ll tell you exactly what I can '
                + 'do." Acknowledge the specific issue, restate the goal, set a concrete expectation.',
            },
          ],
        },
        {
          title: 'Communicating the decision',
          competencyPoint: 'delivering an approval or a denial',
          fragments: [
            {
              modality: 'concept', level: 'working',
              body: 'When you approve, state three facts precisely: the amount, the method, and the '
                + 'timing — "$84.99 back to the card ending 4412, arriving in 3 to 5 business days". '
                + 'Never promise a timeline you do not control. When you deny, give the specific reason '
                + 'tied to the gate that failed, never a vague "it\'s against policy"; offer the next '
                + 'best option — store credit, a partial refund, or a logged exception request; and '
                + 'never phrase it so the customer feels they did something wrong.',
            },
            {
              modality: 'assessment-item', level: 'applied',
              body: 'What three facts must every refund-approval message state? ::: the amount, the '
                + 'method, and the timing',
            },
          ],
        },
      ],
    },
    {
      title: 'Escalation, exceptions and records',
      competencyPoint: 'routing and closing a dispute correctly',
      lessons: [
        {
          title: 'When to escalate, and how',
          competencyPoint: 'recognising an escalation trigger',
          fragments: [
            {
              modality: 'concept', level: 'working',
              body: 'Four triggers route a dispute upward. One: the amount, or the rolling cap, is '
                + 'above your authority tier. Two: the customer is asking for a policy exception — a '
                + 'refund the four gates do not allow. Three: it is the customer\'s third or more '
                + 'dispute in 90 days — a pattern is reviewed as a pattern, not as another transaction. '
                + 'Four: any fraud signal — a name mismatch, a freight-forwarder shipping address, or a '
                + 'chargeback already filed on the order. Escalate with a recommendation and the case '
                + 'facts attached, never as a bare hand-off: the lead should be deciding, not '
                + 're-investigating from scratch.',
            },
            {
              modality: 'worked-example', level: 'applied',
              body: 'A good exception-request escalation reads: "Customer requests a refund on a '
                + 'final-sale jacket, day 9. Gate 3 fails — final-sale items are not a covered reason. '
                + 'Customer says the size chart was wrong; I checked and the listing\'s chart is indeed '
                + 'off by one size. History: clean, no prior disputes. My recommendation: approve as a '
                + 'one-time exception and flag the listing for correction." Facts, the failing gate, '
                + 'the recommendation, the history — the lead can decide in one read.',
            },
            {
              modality: 'assessment-item', level: 'applied',
              body: 'A customer files their third dispute in two months — each one small and '
                + 'individually in policy. Do you escalate? ::: yes — a repeat-dispute pattern is '
                + 'reviewed by a lead even when each dispute is individually in policy',
            },
          ],
        },
        {
          title: 'Documenting and closing the case',
          competencyPoint: 'recording a resolution',
          fragments: [
            {
              modality: 'concept', level: 'working',
              body: 'Every resolved dispute records five things: the decision and who authorised it; '
                + 'the policy gate that passed or the basis for the exception; the amount and the '
                + 'refund method; the customer\'s stated reason in their own words; and any commitment '
                + 'made to the customer. The record is both the audit trail and the next rep\'s '
                + 'context. A dispute is not closed when the refund is promised — it is closed only '
                + 'after the refund is confirmed initiated in the billing system.',
            },
            {
              modality: 'worked-example', level: 'working',
              body: 'Closing note, done right: "Approved $84.99 refund (duplicate charge, Gate 3). '
                + 'Authorised by rep within tier. Method: original card ending 4412. Customer reason: '
                + '\'charged twice for one order\'. Commitment: 3–5 business days, no follow-up needed. '
                + 'Refund confirmed initiated in billing at 14:22. Case closed." Every one of the five '
                + 'fields is present, and the case was closed only after the refund was confirmed.',
            },
          ],
        },
      ],
    },
  ],
};

/** A realistic in-the-flow job aid — the decision aid a rep opens mid-call. */
export const SAMPLE_JOB_AID: SampleJobAid = {
  competencyPoint: 'resolving a refund dispute within policy',
  triggerContext: 'a customer disputes a charge or asks for a refund',
  body:
    'ELIGIBILITY — run the four gates in order; stop at the first failure.\n'
    + '  1. Delivered, and being returned or cancelled?\n'
    + '  2. In the policy window — 30 days for goods, 14 days for digital?\n'
    + '  3. Covered reason — defective, not-as-described, billing error, or duplicate charge?\n'
    + '  4. In a refundable condition?\n'
    + 'All four pass → an in-policy refund. Any gate fails → exception handling, not an auto-denial.\n\n'
    + 'AUTHORITY — by refund amount, not order value.\n'
    + '  You: up to $500.   Team lead: up to $2,500.   Manager: above $2,500.\n'
    + '  Rolling cap: once a customer passes $1,000 of your refunds in 90 days, the next one routes '
    + 'to a lead at any amount.\n\n'
    + 'ESCALATE when: the amount or the cap is above your tier; a policy exception is being requested; '
    + 'it is the customer\'s 3rd+ dispute in 90 days; or any fraud signal (name mismatch, '
    + 'freight-forwarder address, chargeback already filed). Escalate with a recommendation and the '
    + 'case facts — not a bare hand-off.\n\n'
    + 'BEFORE YOU CLOSE — record: the decision and who authorised it; the gate or exception basis; '
    + 'the amount and method; the customer\'s stated reason; any commitment made. Close the case only '
    + 'after the refund is confirmed initiated.',
};
