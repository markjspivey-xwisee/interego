/** Refusals the world can explain. `code` is stable; the message is for a person. */
export class WorldError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'WorldError';
  }
}

export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackError';
  }
}
