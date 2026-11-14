/**
 * Launch a tier's course for the consultant who already has a DID here.
 *
 * The call is Foxxi's existing `POST /agent/cmi5/launch`. The signed payload's
 * `agent_id` is that consultant's DID and `course_id` is the course the pack
 * names. This world does not mint a second guest for the player. Foxxi derives
 * the learner from the signature, so the key that signs must be one Foxxi
 * already accepts as that DID.
 */
export interface CourseLaunchRequest {
  readonly learnerDid: string;
  readonly courseId: string;
  readonly returnUrl?: string;
}

export interface CourseLaunchResult {
  readonly launchUrl: string;
  readonly registration?: string;
  readonly learner: string;
  readonly courseId: string;
}

export interface CourseLauncher {
  launch(request: CourseLaunchRequest): Promise<CourseLaunchResult>;
}

export class FoxxiCourseLauncher implements CourseLauncher {
  constructor(
    private readonly launchUrl: string,
    private readonly sign: (signedPayload: string) => Promise<string>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async launch(request: CourseLaunchRequest): Promise<CourseLaunchResult> {
    const payload: Record<string, string> = {
      course_id: request.courseId,
      agent_id: request.learnerDid,
      timestamp: new Date().toISOString(),
    };
    if (request.returnUrl) payload['return_url'] = request.returnUrl;
    const _signed_payload = JSON.stringify(payload);
    const _signature = await this.sign(_signed_payload);
    const response = await this.fetchImpl(this.launchUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ _signed_payload, _signature }),
    });
    if (!response.ok) throw new Error(`launch ${response.status}`);
    const body = await response.json() as { launchUrl?: unknown; registration?: unknown; learner?: unknown };
    if (typeof body.launchUrl !== 'string' || body.launchUrl.length === 0) throw new Error('launch returned no url');
    if (body.learner !== undefined && body.learner !== request.learnerDid) throw new Error('launch named a different learner');
    return {
      launchUrl: body.launchUrl,
      learner: request.learnerDid,
      courseId: request.courseId,
      ...(typeof body.registration === 'string' ? { registration: body.registration } : {}),
    };
  }
}
