/** Commit a provisional credential before acknowledging ownership, serialized with pod cleanup. */
export async function enrollProvisionalCredential<Methods>(options: {
  userId: string;
  withOwnerLock<T>(work: () => Promise<T>): Promise<T>;
  read(): Promise<Methods>;
  validate(methods: Methods): void;
  update(methods: Methods): boolean | void;
  persist(methods: Methods): Promise<void>;
}): Promise<void> {
  if (!/^u-try-play-[a-f0-9]{32}$/.test(options.userId)) throw new Error('Refusing non-Play credential enrollment');
  await options.withOwnerLock(async () => {
    // A reaped or unreadable owner must fail here, without creating an empty pod.
    const current = await options.read();
    options.validate(current);
    // Do not mutate cached/persisted truth while the durable PUT is unconfirmed.
    const candidate = structuredClone(current);
    if (options.update(candidate) === false) return;
    await options.persist(candidate);
  });
}
