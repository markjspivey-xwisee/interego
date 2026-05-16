"""
The big differentiator: cross-catalog concept coverage.

For each concept that appears in ANY course, count how many courses
mention it (or 'teach' it formally). Surface:
  - Concepts taught in many places (potential redundancy / inconsistency)
  - Concepts mentioned but not taught (gaps)
  - Concepts core to one course but unmentioned elsewhere (silos)

Real concepts come from L2/L3. Stub concepts are fabricated based on 
category — power systems courses share many concepts (inverter, voltage,
grid), safety courses share their own (lockout, hazard, ppe), etc. We
pick a master list of plausible concepts for each category and randomly
distribute them across the courses in that category.
"""

import json
import random
from pathlib import Path
from collections import defaultdict, Counter

random.seed(45)

catalog = json.loads(Path('/home/claude/foxxi-admin/catalog.json').read_text())
real_lesson3 = json.loads(Path('/home/claude/storyline-test/dashboard_data_v03.json').read_text())
real_lesson2 = json.loads(Path('/home/claude/lesson2/dashboard_data_v03.json').read_text())

# Collect real concepts from L2 + L3
real_concepts_by_course = {
    'lesson3': [c for c in real_lesson3['concepts'] if c['is_free_standing']],
    'lesson2': [c for c in real_lesson2['concepts'] if c['is_free_standing']],
}

# Plausible concept pools per category
CONCEPT_POOLS = {
    'Power Systems / Technical': [
        'inverter', 'voltage', 'grid', 'reactive power', 'active power', 'frequency',
        'power factor', 'transformer', 'transmission line', 'substation', 'breaker',
        'fault', 'short circuit', 'phase angle', 'harmonics', 'imbalance', 'PLL',
        'capacitor bank', 'reactor', 'static var compensator', 'STATCOM',
        'load flow', 'contingency', 'voltage drop', 'voltage regulation',
        'grid voltage', 'terminal voltage', 'phase voltage', 'line voltage',
        'inertia', 'governor response', 'AGC', 'frequency response',
        'reactive current', 'active current', 'phase current', 'symmetrical components',
        'positive sequence', 'negative sequence', 'zero sequence',
    ],
    'Renewables': [
        'solar irradiance', 'photovoltaic cell', 'string inverter', 'central inverter',
        'wind turbine', 'rotor', 'blade pitch', 'doubly-fed induction generator',
        'permanent magnet generator', 'pitch control', 'maximum power point tracking',
        'MPPT', 'capacity factor', 'curtailment', 'inverter-based resource',
        'IBR', 'plant controller', 'POI', 'point of interconnection', 'BESS',
        'battery state of charge', 'battery cycling', 'inverter', 'voltage',
        'reactive power', 'power factor',
    ],
    'Standards & Compliance': [
        'NERC CIP', 'IEEE 2800', 'FERC Order 2023', 'BES', 'bulk electric system',
        'NERC reliability standards', 'PRC-024', 'PRC-025', 'TPL-001', 
        'interconnection request', 'large generator interconnection',
        'point of interconnection', 'POI', 'compliance audit', 'self-report',
        'mitigation plan', 'sanction', 'CIP-002', 'CIP-005', 'CIP-007', 'CIP-013',
        'CIP-014', 'high-impact BES', 'medium-impact BES', 'low-impact BES',
    ],
    'Safety': [
        'arc flash', 'incident energy', 'PPE', 'personal protective equipment',
        'lockout/tagout', 'LOTO', 'hazard assessment', 'job hazard analysis',
        'permit-required confined space', 'fall protection', 'fall arrest',
        'hot work', 'energized work', 'qualified person', 'unqualified person',
        'minimum approach distance', 'flash hazard boundary', 'shock hazard',
        'category 2 PPE', 'category 4 PPE', 'face shield', 'arc-rated clothing',
    ],
    'Onboarding': [
        'company values', 'mission', 'expense policy', 'time off policy',
        'remote work policy', 'data classification', 'phishing awareness',
        'password hygiene', 'MFA', 'multi-factor authentication',
        'company history', 'organizational chart', 'reporting structure',
        'benefits enrollment', 'health insurance', '401k', 'PTO',
    ],
    'Cybersecurity': [
        'phishing', 'spear phishing', 'social engineering', 'credential theft',
        'multi-factor authentication', 'MFA', 'data classification', 'PII',
        'PHI', 'incident response', 'IR plan', 'tabletop exercise',
        'OT security', 'IT/OT convergence', 'air gap', 'DMZ', 'firewall',
        'access control list', 'least privilege', 'privileged access management',
        'SIEM', 'EDR', 'malware', 'ransomware', 'zero trust',
    ],
    'Leadership': [
        'feedback', 'performance review', 'goal setting', 'OKR', 'SMART goals',
        'difficult conversation', 'conflict resolution', 'active listening',
        'emotional intelligence', 'psychological safety', 'inclusive leadership',
        'unconscious bias', 'mentorship', 'coaching', 'delegation',
        'one-on-one meeting', 'career development', 'succession planning',
    ],
    'Customer Service': [
        'customer escalation', 'service level agreement', 'SLA', 'ticket triage',
        'outage notification', 'customer communication standard',
        'incident communication', 'root cause analysis', 'post-mortem',
        'customer satisfaction', 'NPS', 'net promoter score',
    ],
    'Commercial': [
        'power purchase agreement', 'PPA', 'tolling agreement', 'capacity payment',
        'energy payment', 'merchant tail', 'curtailment risk', 'basis risk',
        'CFD', 'contract for differences', 'congestion revenue rights',
        'financial transmission rights', 'FTR',
    ],
    'Privacy & Regulatory': [
        'GDPR', 'data subject rights', 'right to be forgotten', 'data minimization',
        'lawful basis', 'CCPA', 'data subject access request', 'DSAR',
        'consent management', 'cross-border transfer', 'data protection officer',
    ],
}


# Build concept frequency map
# Each entry: { 'concept_label': str, 'taught_in': [course_ids], 'mentioned_in': [course_ids] }
# For real lessons: use actual concept lists
# For stubs: pick from category pools

concept_taught_in = defaultdict(set)
concept_mentioned_in = defaultdict(set)
concept_owners = {}  # primary course where most authoritative

# Real lessons — taught in
for course_id, concepts in real_concepts_by_course.items():
    for c in concepts:
        # The label IS what we use as identifier across courses (lowercase normalized)
        label = c['label'].lower().strip()
        concept_taught_in[label].add(course_id)
        concept_mentioned_in[label].add(course_id)

# Stub courses — sample concepts from their category pool
for stub in [c for c in catalog if not c['is_real']]:
    cat = stub['category']
    pool = CONCEPT_POOLS.get(cat, [])
    if not pool:
        continue
    # Pick taught: 30-60% of concepts in pool
    if stub['parse_status'] == 'queued':
        continue
    n_taught = max(1, int(len(pool) * random.uniform(0.30, 0.60)))
    taught = random.sample(pool, min(n_taught, len(pool)))
    for c in taught:
        label = c.lower().strip()
        concept_taught_in[label].add(stub['course_id'])
        concept_mentioned_in[label].add(stub['course_id'])
    # Some concepts are merely mentioned (not taught) — pick a few more
    rest = [c for c in pool if c not in taught]
    n_mention = max(0, int(len(rest) * random.uniform(0.10, 0.25)))
    mentioned = random.sample(rest, min(n_mention, len(rest)))
    for c in mentioned:
        label = c.lower().strip()
        concept_mentioned_in[label].add(stub['course_id'])

# Cross-pool overlap: power systems concepts also appear in renewables, etc.
# We've already captured this because the pools intentionally share concepts.

# Build the final coverage records
coverage = []
for label, taught_set in concept_taught_in.items():
    mentioned_set = concept_mentioned_in[label]
    only_mentioned = mentioned_set - taught_set
    coverage.append({
        'concept_label': label,
        'taught_in_courses': sorted(taught_set),
        'taught_count': len(taught_set),
        'mentioned_in_courses': sorted(mentioned_set),
        'mentioned_count': len(mentioned_set),
        'only_mentioned_count': len(only_mentioned),
        # categories where this concept appears
        'categories': sorted(set(
            c['category']
            for c in catalog
            if c['course_id'] in mentioned_set
        )),
    })

# Add concepts that are mentioned but never taught (gaps)
mentioned_only = set(concept_mentioned_in.keys()) - set(concept_taught_in.keys())
for label in mentioned_only:
    mentioned_set = concept_mentioned_in[label]
    coverage.append({
        'concept_label': label,
        'taught_in_courses': [],
        'taught_count': 0,
        'mentioned_in_courses': sorted(mentioned_set),
        'mentioned_count': len(mentioned_set),
        'only_mentioned_count': len(mentioned_set),
        'categories': sorted(set(
            c['category']
            for c in catalog
            if c['course_id'] in mentioned_set
        )),
    })

# Sort by total appearance count
coverage.sort(key=lambda x: -(x['mentioned_count']))

# Compute the gap/redundancy/silo classifications
gaps = [c for c in coverage if c['taught_count'] == 0 and c['mentioned_count'] >= 2]
redundancies = [c for c in coverage if c['taught_count'] >= 3]
silos = [c for c in coverage if c['taught_count'] == 1 and c['mentioned_count'] >= 4]

print(f'Total distinct concepts across catalog: {len(coverage)}')
print(f'Concepts taught in ≥3 courses (potential redundancy): {len(redundancies)}')
print(f'Concepts mentioned but not taught (gaps): {len(gaps)}')
print(f'Concepts taught in 1, mentioned in ≥4 (silos): {len(silos)}')
print(f'\nTop 10 most mentioned concepts:')
for c in coverage[:10]:
    print(f'  {c["concept_label"]}: taught in {c["taught_count"]}, mentioned in {c["mentioned_count"]}')

print(f'\nTop 5 redundancy candidates:')
for c in redundancies[:5]:
    print(f'  {c["concept_label"]}: taught in {c["taught_count"]} courses')

print(f'\nTop 5 gaps (mentioned, never taught):')
for c in gaps[:5]:
    print(f'  {c["concept_label"]}: mentioned in {c["mentioned_count"]} courses, taught in 0')

Path('/home/claude/foxxi-admin/coverage.json').write_text(json.dumps(coverage, indent=2))
