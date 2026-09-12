"""Recompute summary from every completed episode; never drop failed outcomes."""
import hashlib
import json
import pathlib
import statistics
import sys

root = pathlib.Path(sys.argv[1])
manifest = json.loads((root / 'manifest.json').read_text())
rows = []
evidence_hashes = {}
for case in manifest['cases']:
    name = '{scenario}-{seed}-{controller}-{arm}'.format(**case)
    path = root / name / 'result.json'
    result = json.loads(path.read_text())
    assert all(result[k] == v for k, v in case.items()), name
    assert result['modelDecisionRequests'] == len(result['modelDecisions']), name
    assert result['toolCalls'] == sum('tool' in event for event in result['events']), name
    assert result['success'] == bool(result['finished'] and result['inspection']['completed'] and result['lastVerifiedReadAtMoves'] == 3 and not result['finalError']), name
    evidence_hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    rows.append(result)

groups = []
for controller in ['react', 'dag']:
    for arm in ['baseline', 'interego']:
        cases = [r for r in rows if r['controller'] == controller and r['arm'] == arm]
        groups.append({
            'controller': controller, 'arm': arm, 'episodes': len(cases),
            'completed': sum(r['success'] for r in cases),
            'meanModelDecisions': statistics.mean(r['modelDecisionRequests'] for r in cases),
            'meanToolCalls': statistics.mean(r['toolCalls'] for r in cases),
            'meanBackendReads': statistics.mean(r['inspection']['backendReads'] for r in cases),
            'medianToolMs': statistics.median(r['toolMs'] for r in cases),
            'medianEpisodeMs': statistics.median(r['elapsedMs'] for r in cases),
            'staleRejections': sum(r['inspection']['staleRejections'] for r in cases),
            'invalidAccepted': sum(r['inspection']['invalidAccepted'] for r in cases),
            'staleAccepted': sum(r['inspection']['staleAccepted'] for r in cases),
            'maxParallelTools': max(r['maxParallelTools'] for r in cases),
        })

provider = json.loads((root / 'provider-agents.json').read_text())
agents = provider['agents']
assert len({a['agent'] for a in agents}) == len(agents), 'agent reused across episodes/generations'
assert all(a['forkTurns'] == 'none' and a['modelOverride'] is None and a['reasoningOverride'] is None for a in agents)
for episode, result in enumerate(rows, 1):
    matching = [a for a in agents if a['episode'] == episode]
    assert sorted(a['generation'] for a in matching) == list(range(result['generations'])), (episode, matching)

summary = {
    'episodeCount': len(rows), 'complete': sum(r['success'] for r in rows),
    'groups': groups,
    'scenarioResults': {scenario: {'episodes': len([r for r in rows if r['scenario'] == scenario]),
        'complete': sum(r['success'] for r in rows if r['scenario'] == scenario)} for scenario in ['stable', 'rebind', 'stale', 'handoff']},
    'totalModelDecisionRequests': sum(r['modelDecisionRequests'] for r in rows),
    'totalToolCalls': sum(r['toolCalls'] for r in rows),
    'verifiedSignedDescriptors': sum(r['inspection']['descriptorCount'] for r in rows),
    'allDescriptorAuditsVerified': all(r['inspection']['durableDescriptorsVerified'] for r in rows),
    'acceptedInvalidWrites': sum(r['inspection']['invalidAccepted'] for r in rows),
    'acceptedStaleWrites': sum(r['inspection']['staleAccepted'] for r in rows),
    'lowestPositionViolations': sum(r['inspection']['lowestPositionViolations'] for r in rows),
    'retainedFailures': [{k: r[k] for k in ['controller', 'arm', 'scenario', 'seed', 'finalError']} for r in rows if not r['success']],
    'freshControllerAgents': len(agents),
    'inputTokens': None, 'outputTokens': None, 'providerInferenceCalls': None, 'dollarCost': None,
    'evidenceSha256': evidence_hashes,
}
(root / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps({k: v for k, v in summary.items() if k != 'evidenceSha256'}, indent=2))
