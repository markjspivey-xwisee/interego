/**
 * What a bridge answers at `GET /health`.
 *
 * `build` is the field the deploy verifier (`tools/railway-redeploy.mjs`) polls and compares
 * with the commit it shipped, so it is always present: the sha the image was built from, or
 * `unset` when the process was not started from an image. `status` says whether the service is
 * ready; a bridge that answers before it has finished starting says `starting`. Everything else
 * a bridge wants to say about itself goes in `extra`, which can never replace the three fields
 * the verifier and the fleet audit read.
 */
export interface HealthInput {
  readonly service: string;
  /** The commit the running image was built from. Empty or undefined is reported as `unset`. */
  readonly build: string | undefined;
  readonly status?: 'ok' | 'starting';
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface HealthBody {
  readonly status: 'ok' | 'starting';
  readonly build: string;
  readonly service: string;
  readonly [key: string]: unknown;
}

export function healthBody(input: HealthInput): HealthBody {
  return { ...(input.extra ?? {}), status: input.status ?? 'ok', build: input.build?.trim() || 'unset', service: input.service };
}
