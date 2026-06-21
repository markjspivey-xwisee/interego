// Cool demo: Distributed affordances, agent-era version.
//
// Verborgh's foundational 2013 paper "Distributed Affordance: An
// Open-World Assumption for Hypermedia" argued that affordances on a
// resource shouldn't be statically published with that resource —
// they should be ASSEMBLED at request time from three sources:
//
//   1. The resource's own representation (intrinsic affordances)
//   2. Independent action providers in the wider system
//   3. The user's context and registered preferences
//
// In 2013 the action providers were envisioned as web services. In
// 2026 they're AI agents. A user's pod registers which agents they
// have available; when ANY descriptor on ANY pod is requested, the
// affordance set is computed by joining what the descriptor offers
// intrinsically with what the asking agent's services can do.
//
// Result: the same descriptor presents different affordances to
// different agents — without changing the descriptor at all.

console.log('=== Distributed affordances, agent-era ===\n');
console.log('Verborgh\'s 2013 hypermedia thesis applied to AI agents.');
console.log('Affordances are computed at request time from THREE sources:');
console.log('   1. the descriptor itself (intrinsic)');
console.log('   2. the asking agent\'s registered services (distributed)');
console.log('   3. user context\n');

// ── A descriptor on the pod ─────────────────────────────────

const descriptor = {
  iri: 'urn:graph:notes/emergence',
  describes: 'urn:doc:research-notes-on-emergence',
  contentType: 'text/markdown',
  language: 'en',
  // Intrinsic affordances — the descriptor publishes these directly.
  // Every reader gets these regardless of who they are.
  intrinsicAffordances: [
    { rel: 'iep:canRead',     description: 'fetch the document' },
    { rel: 'iep:canCite',     description: 'reference in another descriptor (prov:wasDerivedFrom)' },
    { rel: 'iep:canSubscribe', description: 'subscribe to changes via Solid Notifications' },
  ],
  // Metadata about the content that downstream agents can react to.
  contentMetadata: {
    topic: 'emergence',
    technicalDepth: 'intermediate',
    estimatedReadingMinutes: 12,
  },
};

console.log(`The descriptor:        ${descriptor.iri}`);
console.log(`   contentType:        ${descriptor.contentType}`);
console.log(`   language:           ${descriptor.language}`);
console.log(`   intrinsic affordances: ${descriptor.intrinsicAffordances.map(a => a.rel).join(', ')}`);
console.log();

// ── Three asking agents, each with different registered services ──

const agents = {
  alice: {
    iri: 'urn:agent:alice',
    name: 'Alice',
    description: 'researcher; speaks Spanish',
    registeredServices: [
      {
        rel: 'iep:canTranslate',
        targetLang: 'es',
        // Service is offered if the resource is text and not already in es.
        appliesIf: (d) => d.contentType.startsWith('text/') && d.language !== 'es',
      },
    ],
  },
  bob: {
    iri: 'urn:agent:bob',
    name: 'Bob',
    description: 'code-quality reviewer',
    registeredServices: [
      {
        rel: 'iep:canReviewCode',
        appliesIf: (d) => d.contentType === 'text/markdown' && /code|fix|implementation/i.test(d.contentMetadata?.topic ?? ''),
      },
      {
        rel: 'iep:canExtractCodeBlocks',
        appliesIf: (d) => d.contentType === 'text/markdown',
      },
    ],
  },
  carol: {
    iri: 'urn:agent:carol',
    name: 'Carol',
    description: 'accessibility & summarization',
    registeredServices: [
      {
        rel: 'iep:canSummarize',
        appliesIf: (d) => d.contentType.startsWith('text/') && (d.contentMetadata?.estimatedReadingMinutes ?? 0) > 5,
      },
      {
        rel: 'iep:canNarrate',
        targetFormat: 'audio/mpeg',
        appliesIf: (d) => d.contentType.startsWith('text/'),
      },
      {
        rel: 'iep:canSimplifyLanguage',
        appliesIf: (d) => d.contentMetadata?.technicalDepth === 'intermediate' || d.contentMetadata?.technicalDepth === 'advanced',
      },
    ],
  },
  eve: {
    iri: 'urn:agent:eve',
    name: 'Eve',
    description: 'no registered services',
    registeredServices: [],
  },
};

// ── The distributed-affordance resolver ─────────────────────
//
// Given (descriptor, asking-agent), compute the full affordance set.
// This is the core of Verborgh's pattern: the affordances aren't
// stored anywhere; they're derived at request time from the
// intersection of the descriptor's properties and the agent's
// registered service applicability rules.

function resolveAffordances(descriptor, askingAgent, userContext = {}) {
  const intrinsic = descriptor.intrinsicAffordances.map(a => ({
    ...a, source: 'intrinsic',
  }));

  const distributed = (askingAgent.registeredServices ?? [])
    .filter(s => s.appliesIf(descriptor))
    .map(s => ({
      rel: s.rel,
      description: `service offered by ${askingAgent.iri.split(':').at(-1)}`,
      source: 'distributed',
      provider: askingAgent.iri,
      ...(s.targetLang ? { targetLang: s.targetLang } : {}),
      ...(s.targetFormat ? { targetFormat: s.targetFormat } : {}),
    }));

  // User-context affordances: e.g., if the user has marked this
  // descriptor as a favorite, expose `iep:canRemoveFromFavorites`.
  const contextual = [];
  if (userContext.favorites?.includes(descriptor.iri)) {
    contextual.push({ rel: 'iep:canRemoveFromFavorites', description: 'unfavorite', source: 'context' });
  } else if (userContext.favoritable !== false) {
    contextual.push({ rel: 'iep:canAddToFavorites', description: 'add to favorites', source: 'context' });
  }

  return [...intrinsic, ...distributed, ...contextual];
}

// ── Render affordance sets for each agent ──────────────────

function renderForAgent(agentKey, userContext = {}) {
  const agent = agents[agentKey];
  console.log(`── Affordances for ${agent.name} (${agent.description}) ──`);
  const affs = resolveAffordances(descriptor, agent, userContext);
  for (const a of affs) {
    const extra = a.targetLang ? ` → ${a.targetLang}`
                : a.targetFormat ? ` → ${a.targetFormat}`
                : '';
    const provider = a.provider ? ` [via ${a.provider.split(':').at(-1)}]` : '';
    console.log(`   [${a.source.padEnd(11)}]  ${a.rel}${extra}${provider}`);
  }
  console.log();
}

renderForAgent('alice');
renderForAgent('bob');
renderForAgent('carol', { favorites: ['urn:graph:notes/emergence'] });  // Carol has favorited it
renderForAgent('eve');

// ── The same descriptor changes — affordance sets re-derive ─

console.log('── Watching the affordance set re-derive when context changes ──\n');

console.log("Imagine the descriptor's content gets translated to Spanish");
console.log('(language: en → es). Alice\'s translate affordance vanishes:\n');

const translatedDescriptor = { ...descriptor, language: 'es' };
console.log(`   Alice asks again with the new descriptor:`);
const affs2 = resolveAffordances(translatedDescriptor, agents.alice);
for (const a of affs2) console.log(`     [${a.source}] ${a.rel}${a.targetLang ? ` → ${a.targetLang}` : ''}`);
console.log('   → translate affordance dropped (already in target language)\n');

console.log("If Bob registers a NEW service mid-session — say, code-block extraction — ");
console.log('the affordance set immediately reflects it:\n');

const bobUpgraded = {
  ...agents.bob,
  registeredServices: [
    ...agents.bob.registeredServices,
    { rel: 'iep:canRunInSandbox', appliesIf: (d) => d.contentType === 'text/markdown' },
  ],
};
console.log(`   Bob asks again:`);
const affs3 = resolveAffordances(descriptor, bobUpgraded);
for (const a of affs3) {
  const provider = a.provider ? ` [via ${a.provider.split(':').at(-1)}]` : '';
  console.log(`     [${a.source}] ${a.rel}${provider}`);
}
console.log('   → iep:canRunInSandbox now appears, no descriptor change required\n');

// ── Cross-pod federation: borrow another agent's services ──

console.log('── Cross-pod federation: agents borrow each other\'s services ──\n');

console.log('Eve has no services of her own. But on her pod she has');
console.log('subscribed to Carol\'s service registry (cross-pod federation).');
console.log('When Eve asks for affordances, the resolver also includes');
console.log("Carol's services as if Eve had them — provenance preserved.\n");

const eveWithCarolFederated = {
  ...agents.eve,
  registeredServices: agents.carol.registeredServices.map(s => ({
    ...s,
    delegatedFrom: 'urn:agent:carol',
  })),
};
const eveAffs = resolveAffordances(descriptor, eveWithCarolFederated);
console.log(`   Eve\'s effective affordance set (after federation with Carol):`);
for (const a of eveAffs) {
  console.log(`     [${a.source}] ${a.rel}`);
}

console.log('\n── What this demonstrates ──');
console.log('   The descriptor never changed. The asking agent changed,');
console.log('   the registered services changed, the user context changed,');
console.log('   the federation arrangement changed.');
console.log('');
console.log('   Each combination produces a different affordance set, computed');
console.log('   at request time — never stored, never stale, never out of sync');
console.log('   with the underlying capability availability.');
console.log('');
console.log('   This is Verborgh\'s 2013 distributed-affordance thesis applied');
console.log('   to AI agents: hypermedia is open-world, capabilities live where');
console.log('   they live, the resource and the asker JOIN at lookup time to');
console.log('   produce the actionable surface.');
console.log('');
console.log('   Trust + provenance are first-class — every distributed affordance');
console.log('   names its provider, so a user can audit "who am I implicitly');
console.log('   trusting if I act on this affordance?"');
