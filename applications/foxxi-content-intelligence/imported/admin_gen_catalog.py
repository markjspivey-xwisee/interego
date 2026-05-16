"""
Fabricate a plausible enterprise training catalog. We seed it with the two
real lessons (which have full graphs) and add ~38 stub courses with
realistic metadata: title, category, audience, owner, last-modified, parse
status, concept count, slide count.

The catalog spans the categories a real utility / power-systems org would
have — domain technical, regulatory compliance, leadership, onboarding,
customer-specific. Concept counts are scaled to match the real ones we
have data for (Lesson 2: 128 concepts / 15 slides, Lesson 3: 92 / 12), so
the stubs feel proportionate.

Status distribution: most parsed clean, a few with warnings, one failed,
two queued. This makes the parse-status chip set look real.
"""

import json
import random
from datetime import datetime, timedelta
from pathlib import Path


random.seed(42)  # deterministic for reproducible demos

# Real packages we've already ingested
REAL_COURSES = [
    {
        'course_id': 'lesson3',
        'title': 'Lesson 3: Inverter Controls',
        'category': 'Power Systems / Technical',
        'audience_tags': ['transmission-operator', 'engineer-power-systems'],
        'owner': 'Power Systems Training',
        'authoring_tool': 'Articulate Storyline',
        'standard': 'SCORM 2004 4th',
        'concept_count': 92,
        'slide_count': 12,
        'audio_seconds': 605,
        'modifier_count': 28,
        'prereq_count': 130,
        'parse_status': 'clean',
        'shacl_violations': 0,
        'last_modified': '2025-10-27',
        'last_parsed': '2025-04-29',
        'is_real': True,
        'lms_source': 'Direct upload',
    },
    {
        'course_id': 'lesson2',
        'title': 'Lesson 2: Inverter Basics',
        'category': 'Power Systems / Technical',
        'audience_tags': ['transmission-operator', 'engineer-power-systems'],
        'owner': 'Power Systems Training',
        'authoring_tool': 'Articulate Storyline',
        'standard': 'SCORM 2004 4th',
        'concept_count': 128,
        'slide_count': 15,
        'audio_seconds': 736,
        'modifier_count': 32,
        'prereq_count': 323,
        'parse_status': 'clean',
        'shacl_violations': 0,
        'last_modified': '2025-10-27',
        'last_parsed': '2025-04-30',
        'is_real': True,
        'lms_source': 'Direct upload',
    },
]


# Stub catalog — realistic enterprise training mix, all power-systems
# adjacent so the org's identity is coherent (this is a utility / IPP)
STUB_COURSES = [
    # Power Systems Technical (continues the real lessons' arc)
    ('Lesson 1: Power Grid Fundamentals',         'Power Systems / Technical',     ['engineer-power-systems', 'transmission-operator'], 'Power Systems Training', 'clean'),
    ('Lesson 4: Reactive Power Compensation',     'Power Systems / Technical',     ['engineer-power-systems'], 'Power Systems Training', 'clean'),
    ('Lesson 5: Grid-Forming vs Grid-Following',  'Power Systems / Technical',     ['engineer-power-systems'], 'Power Systems Training', 'clean'),
    ('Lesson 6: Synchronous Machines',            'Power Systems / Technical',     ['engineer-power-systems'], 'Power Systems Training', 'clean'),
    ('Lesson 7: Protection & Relaying',           'Power Systems / Technical',     ['engineer-protection', 'transmission-operator'], 'Power Systems Training', 'warnings'),
    ('Lesson 8: HVDC Systems',                    'Power Systems / Technical',     ['engineer-power-systems'], 'Power Systems Training', 'clean'),
    ('Lesson 9: SCADA & EMS',                     'Power Systems / Technical',     ['transmission-operator', 'control-room'], 'Operations Training', 'clean'),
    ('Lesson 10: PMU & Wide-Area Monitoring',     'Power Systems / Technical',     ['transmission-operator', 'engineer-power-systems'], 'Operations Training', 'clean'),

    # Renewables-specific
    ('Solar PV Plant Operations',                  'Renewables',                    ['engineer-renewables', 'plant-operator'], 'Renewables COE', 'clean'),
    ('Wind Turbine Generator Theory',              'Renewables',                    ['engineer-renewables'], 'Renewables COE', 'clean'),
    ('Battery Energy Storage Systems',             'Renewables',                    ['engineer-renewables', 'engineer-power-systems'], 'Renewables COE', 'clean'),
    ('Hybrid Plant Controls',                      'Renewables',                    ['engineer-renewables'], 'Renewables COE', 'queued'),

    # Grid Code & Standards
    ('IEEE 2800-2022 Compliance',                  'Standards & Compliance',        ['engineer-power-systems', 'compliance-officer'], 'Standards & Compliance', 'clean'),
    ('FERC Order 2023 Overview',                   'Standards & Compliance',        ['compliance-officer', 'engineer-interconnection'], 'Standards & Compliance', 'clean'),
    ('NERC CIP-014 Physical Security',             'Standards & Compliance',        ['compliance-officer', 'security'], 'Compliance', 'clean'),
    ('NERC CIP-013 Supply Chain Risk',             'Standards & Compliance',        ['compliance-officer', 'procurement'], 'Compliance', 'warnings'),
    ('Interconnection Study Process',              'Standards & Compliance',        ['engineer-interconnection'], 'Standards & Compliance', 'clean'),

    # Safety
    ('Arc Flash Safety',                           'Safety',                        ['field-tech', 'engineer-power-systems'], 'EHS', 'clean'),
    ('Lockout/Tagout Procedures',                  'Safety',                        ['field-tech', 'plant-operator'], 'EHS', 'clean'),
    ('Confined Space Entry',                       'Safety',                        ['field-tech'], 'EHS', 'clean'),
    ('Working at Heights',                          'Safety',                        ['field-tech'], 'EHS', 'clean'),
    ('Hazmat Handling',                            'Safety',                        ['field-tech', 'plant-operator'], 'EHS', 'failed'),

    # Onboarding
    ('New Hire Orientation',                       'Onboarding',                    ['all-employees'], 'HR', 'clean'),
    ('Company Overview & Values',                  'Onboarding',                    ['all-employees'], 'HR', 'clean'),
    ('Code of Conduct',                            'Onboarding',                    ['all-employees'], 'Legal', 'clean'),
    ('IT Systems & Security',                      'Onboarding',                    ['all-employees'], 'IT', 'clean'),

    # Cybersecurity & IT
    ('Phishing Awareness',                         'Cybersecurity',                 ['all-employees'], 'IT Security', 'clean'),
    ('Data Classification & Handling',             'Cybersecurity',                 ['all-employees'], 'IT Security', 'clean'),
    ('OT Security Fundamentals',                   'Cybersecurity',                 ['engineer-power-systems', 'plant-operator', 'security'], 'IT Security', 'clean'),
    ('Incident Response for Operators',            'Cybersecurity',                 ['transmission-operator', 'plant-operator'], 'IT Security', 'warnings'),

    # Leadership & Management
    ('First-Time Manager Essentials',              'Leadership',                    ['manager-new'], 'Leadership Development', 'clean'),
    ('Difficult Conversations',                    'Leadership',                    ['manager-all'], 'Leadership Development', 'clean'),
    ('Performance Reviews',                        'Leadership',                    ['manager-all'], 'HR', 'clean'),
    ('Inclusive Leadership',                       'Leadership',                    ['manager-all'], 'Leadership Development', 'clean'),

    # Customer / Commercial
    ('Customer Communication Standards',           'Customer Service',              ['account-manager', 'field-tech'], 'Customer Operations', 'clean'),
    ('PPA Fundamentals',                            'Commercial',                   ['account-manager', 'commercial-analyst'], 'Commercial Training', 'clean'),
    ('Outage Communication Protocol',              'Customer Service',              ['account-manager', 'control-room', 'field-tech'], 'Customer Operations', 'queued'),

    # Regulatory & Privacy
    ('GDPR for Operations Personnel',              'Privacy & Regulatory',          ['all-employees-eu'], 'Compliance', 'clean'),
    ('CCPA Awareness',                             'Privacy & Regulatory',          ['all-employees-ca'], 'Compliance', 'clean'),
]


def fab_stub(idx, raw):
    title, category, audience, owner, status = raw
    course_id = f'stub_{idx:03d}'
    
    # Concept/slide counts vary by category. Compliance and onboarding tend
    # to be shorter; technical content has more concepts. Real numbers from
    # L2/L3 anchor the technical scale.
    if 'Technical' in category or 'Renewables' in category:
        slides = random.randint(10, 22)
        concepts = int(slides * random.uniform(7, 11))
    elif 'Safety' in category:
        slides = random.randint(6, 14)
        concepts = int(slides * random.uniform(5, 8))
    elif 'Onboarding' in category or 'Leadership' in category:
        slides = random.randint(8, 18)
        concepts = int(slides * random.uniform(4, 7))
    else:
        slides = random.randint(5, 16)
        concepts = int(slides * random.uniform(5, 9))
    
    # Other counts derive from concepts
    modifier_count = int(concepts * random.uniform(0.18, 0.30))
    prereq_count = int(concepts * random.uniform(1.2, 2.6))
    audio_seconds = slides * random.randint(35, 75)
    
    # SHACL violations only on warnings/failed
    shacl_violations = 0
    if status == 'warnings':
        shacl_violations = random.randint(2, 8)
    elif status == 'failed':
        shacl_violations = random.randint(15, 40)
        # Failed packages tend to have weird stat patterns
        concepts = max(1, int(concepts * 0.3))
        modifier_count = 0
        prereq_count = 0
    elif status == 'queued':
        # Queued = haven't parsed yet, no concept data
        concepts = 0
        modifier_count = 0
        prereq_count = 0
        audio_seconds = 0
    
    # Last-modified dates spread across the past year
    days_ago = random.randint(7, 540)
    last_mod = (datetime(2026, 4, 30) - timedelta(days=days_ago)).date().isoformat()
    
    # Parsed date is between modified and today (or null for queued)
    if status == 'queued':
        last_parsed = None
    else:
        parsed_days_ago = random.randint(1, max(2, days_ago - 1))
        last_parsed = (datetime(2026, 4, 30) - timedelta(days=parsed_days_ago)).date().isoformat()
    
    # LMS source — most from Cornerstone, some from Docebo, a few direct
    lms_source = random.choices(
        ['Cornerstone', 'Docebo', 'SCORM Cloud', 'Direct upload'],
        weights=[60, 20, 12, 8],
    )[0]
    
    # Authoring tool — Storyline dominant, others sprinkled
    authoring = random.choices(
        ['Articulate Storyline', 'Articulate Rise', 'Adobe Captivate', 'Lectora'],
        weights=[55, 25, 12, 8],
    )[0]
    
    # Standard
    standard = random.choices(
        ['SCORM 2004 4th', 'SCORM 1.2', 'cmi5', 'xAPI'],
        weights=[55, 25, 12, 8],
    )[0]
    
    return {
        'course_id': course_id,
        'title': title,
        'category': category,
        'audience_tags': list(audience),
        'owner': owner,
        'authoring_tool': authoring,
        'standard': standard,
        'concept_count': concepts,
        'slide_count': slides,
        'audio_seconds': audio_seconds,
        'modifier_count': modifier_count,
        'prereq_count': prereq_count,
        'parse_status': status,
        'shacl_violations': shacl_violations,
        'last_modified': last_mod,
        'last_parsed': last_parsed,
        'is_real': False,
        'lms_source': lms_source,
    }


def main():
    catalog = list(REAL_COURSES) + [
        fab_stub(idx + 1, stub) for idx, stub in enumerate(STUB_COURSES)
    ]
    out = Path('/home/claude/foxxi-admin/catalog.json')
    out.write_text(json.dumps(catalog, indent=2))
    
    # Quick stats
    print(f"Total courses: {len(catalog)}")
    print(f"Real (full graph): {sum(1 for c in catalog if c['is_real'])}")
    print(f"Stubs: {sum(1 for c in catalog if not c['is_real'])}")
    print(f"\nParse status distribution:")
    from collections import Counter
    for status, n in Counter(c['parse_status'] for c in catalog).most_common():
        print(f"  {status}: {n}")
    print(f"\nLMS sources:")
    for src, n in Counter(c['lms_source'] for c in catalog).most_common():
        print(f"  {src}: {n}")


if __name__ == '__main__':
    main()
