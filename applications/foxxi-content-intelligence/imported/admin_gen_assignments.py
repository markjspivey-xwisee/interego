"""
Build assignment policies. A policy is a RULE not a list:
  "Required: Phishing Awareness for all-employees, due 30 days after hire"
  "Recommended: Lesson 3 Inverter Controls for engineer-power-systems"

Each policy: id, course_id, audience (group_id or audience tag), 
requirement_type (required / recommended), trigger, due_relative,
created_at, created_by (a manager's user_id), enabled.

We also generate "assignment events" — actual rows of (user, course, status)
that result from policies being evaluated. This is what the admin sees
when they look at "who's behind on training."
"""

import json
import random
from datetime import datetime, timedelta
from pathlib import Path

random.seed(44)

catalog = json.loads(Path('/home/claude/foxxi-admin/catalog.json').read_text())
users = json.loads(Path('/home/claude/foxxi-admin/users.json').read_text())
groups = json.loads(Path('/home/claude/foxxi-admin/groups.json').read_text())

# Find a manager to author each policy (someone with manager-all tag)
managers = [u for u in users if 'manager-all' in u['audience_tags']]
ceo = next(u for u in users if u['job_title'] == 'Chief Executive Officer')

def find_course(title_substring):
    return next((c for c in catalog if title_substring.lower() in c['title'].lower()), None)

def find_group(group_id):
    return next((g for g in groups if g['group_id'] == group_id), None)


# Author the policies an L&D admin would actually have set up
policy_specs = [
    # Compliance-required across the org
    ('Phishing Awareness', 'tag-all-employees', 'required', 'on-hire', 30),
    ('Code of Conduct', 'tag-all-employees', 'required', 'on-hire', 14),
    ('Data Classification & Handling', 'tag-all-employees', 'required', 'annual', 365),
    
    # Role-specific required training
    ('IEEE 2800-2022 Compliance', 'tag-engineer-power-systems', 'required', 'on-hire', 90),
    ('NERC CIP-014 Physical Security', 'tag-compliance-officer', 'required', 'annual', 365),
    ('Arc Flash Safety', 'tag-field-tech', 'required', 'annual', 365),
    ('Lockout/Tagout Procedures', 'tag-field-tech', 'required', 'annual', 365),
    ('OT Security Fundamentals', 'tag-engineer-power-systems', 'required', 'on-hire', 60),
    ('OT Security Fundamentals', 'tag-plant-operator', 'required', 'on-hire', 60),
    
    # Manager-specific
    ('First-Time Manager Essentials', 'tag-manager-new', 'required', 'on-promotion', 60),
    ('Difficult Conversations', 'tag-manager-all', 'recommended', 'on-promotion', None),
    
    # Power systems learning path (the real ones + their context)
    ('Lesson 1: Power Grid Fundamentals', 'tag-engineer-power-systems', 'required', 'on-hire', 30),
    ('Lesson 2: Inverter Basics', 'tag-engineer-power-systems', 'required', 'on-hire', 60),
    ('Lesson 3: Inverter Controls', 'tag-engineer-power-systems', 'required', 'on-hire', 90),
    ('Lesson 1: Power Grid Fundamentals', 'tag-transmission-operator', 'required', 'on-hire', 30),
    ('Lesson 2: Inverter Basics', 'tag-transmission-operator', 'recommended', 'on-hire', None),
    
    # Onboarding cohort
    ('New Hire Orientation', 'new-hires-2024-2025', 'required', 'on-hire', 7),
    ('Company Overview & Values', 'new-hires-2024-2025', 'required', 'on-hire', 7),
]


policies = []
for idx, (title, gid, req, trigger, due_days) in enumerate(policy_specs):
    course = find_course(title)
    group = find_group(gid)
    if not course:
        print(f'  WARN: course "{title}" not in catalog')
        continue
    if not group:
        print(f'  WARN: group "{gid}" not found')
        continue
    
    creator = random.choice(managers)
    created_days_ago = random.randint(30, 540)
    
    policies.append({
        'policy_id': f'pol-{idx:03d}',
        'course_id': course['course_id'],
        'course_title': course['title'],
        'audience_group_id': group['group_id'],
        'audience_label': group['name'],
        'audience_member_count': group['member_count'],
        'requirement_type': req,
        'trigger': trigger,
        'due_relative_days': due_days,
        'created_at': (datetime(2026, 4, 30) - timedelta(days=created_days_ago)).date().isoformat(),
        'created_by_user_id': creator['user_id'],
        'created_by_name': creator['name'],
        'enabled': True,
    })


# Generate assignment events — actual user/course rows
events = []
event_id = 0
today = datetime(2026, 4, 30).date()

for policy in policies:
    group = find_group(policy['audience_group_id'])
    if not group:
        continue
    
    for user_id in group['member_ids']:
        user = next((u for u in users if u['user_id'] == user_id), None)
        if not user:
            continue
        
        # Determine assigned-at based on trigger
        if policy['trigger'] == 'on-hire':
            assigned_date = datetime.fromisoformat(user['hire_date']).date()
        elif policy['trigger'] == 'annual':
            # Last yearly cycle
            assigned_date = today - timedelta(days=random.randint(30, 365))
        elif policy['trigger'] == 'on-promotion':
            assigned_date = today - timedelta(days=random.randint(30, 540))
        else:
            assigned_date = today - timedelta(days=random.randint(30, 365))
        
        # Status distribution depends on how long ago and whether required
        days_since = (today - assigned_date).days
        due_date = (assigned_date + timedelta(days=policy['due_relative_days'])) if policy['due_relative_days'] else None
        
        if policy['requirement_type'] == 'required':
            # Required: most done, some in progress, some overdue
            if days_since > (policy['due_relative_days'] or 60):
                status = random.choices(
                    ['completed', 'overdue', 'in-progress'],
                    weights=[78, 15, 7],
                )[0]
            else:
                status = random.choices(
                    ['completed', 'in-progress', 'not-started'],
                    weights=[40, 35, 25],
                )[0]
        else:
            # Recommended: mostly not started or in progress
            status = random.choices(
                ['completed', 'in-progress', 'not-started'],
                weights=[20, 25, 55],
            )[0]
        
        # Completed: completion date between assigned and today
        completion_date = None
        if status == 'completed':
            completion_offset = random.randint(1, max(2, days_since))
            completion_date = (assigned_date + timedelta(days=completion_offset)).isoformat()
            if completion_date > today.isoformat():
                completion_date = today.isoformat()
        
        events.append({
            'event_id': f'evt-{event_id:06d}',
            'user_id': user_id,
            'course_id': policy['course_id'],
            'policy_id': policy['policy_id'],
            'assigned_at': assigned_date.isoformat(),
            'due_at': due_date.isoformat() if due_date else None,
            'status': status,
            'completed_at': completion_date,
            'requirement_type': policy['requirement_type'],
        })
        event_id += 1


# Audit log — actual access events the admin can show as proof
audit = []
audit_id = 0

# Course view events (random sample)
for _ in range(60):
    user = random.choice(users)
    event = random.choice(events)
    audit.append({
        'audit_id': f'aud-{audit_id:06d}',
        'timestamp': (datetime(2026, 4, 30) - timedelta(days=random.randint(0, 14), 
                                                          hours=random.randint(0, 23),
                                                          minutes=random.randint(0, 59))).isoformat(),
        'actor_user_id': user['user_id'],
        'actor_web_id': user['web_id'],
        'action': 'course.view',
        'target_type': 'course',
        'target_id': event['course_id'],
        'result': 'allowed',
        'reason': f'policy:{event["policy_id"]}',
    })
    audit_id += 1

# Some access denials (showing the access control is enforcing things)
for _ in range(8):
    user = random.choice(users)
    course = random.choice(catalog)
    audit.append({
        'audit_id': f'aud-{audit_id:06d}',
        'timestamp': (datetime(2026, 4, 30) - timedelta(days=random.randint(0, 7), 
                                                          hours=random.randint(0, 23))).isoformat(),
        'actor_user_id': user['user_id'],
        'actor_web_id': user['web_id'],
        'action': 'course.view',
        'target_type': 'course',
        'target_id': course['course_id'],
        'result': 'denied',
        'reason': 'no-policy-grants-access',
    })
    audit_id += 1

# Policy creation/modification events
for policy in policies[:8]:
    audit.append({
        'audit_id': f'aud-{audit_id:06d}',
        'timestamp': (datetime.fromisoformat(policy['created_at']).isoformat() + 'T09:30:00'),
        'actor_user_id': policy['created_by_user_id'],
        'actor_web_id': next((u['web_id'] for u in users if u['user_id'] == policy['created_by_user_id']), ''),
        'action': 'policy.create',
        'target_type': 'policy',
        'target_id': policy['policy_id'],
        'result': 'allowed',
        'reason': 'authorized-as-manager',
    })
    audit_id += 1

audit.sort(key=lambda a: a['timestamp'], reverse=True)

# Output
out = Path('/home/claude/foxxi-admin')
(out / 'policies.json').write_text(json.dumps(policies, indent=2))
(out / 'events.json').write_text(json.dumps(events, indent=2))
(out / 'audit.json').write_text(json.dumps(audit, indent=2))

print(f'Policies: {len(policies)}')
print(f'Events: {len(events)}')
print(f'Audit entries: {len(audit)}')

# Quick health check
from collections import Counter
print('\nEvent status distribution:')
for s, n in Counter(e['status'] for e in events).most_common():
    print(f'  {s}: {n}')

# Compliance posture per course
print('\nCompletion rates per real course:')
for course in [c for c in catalog if c['is_real']]:
    course_events = [e for e in events if e['course_id'] == course['course_id']]
    if course_events:
        done = sum(1 for e in course_events if e['status'] == 'completed')
        print(f'  {course["title"]}: {done}/{len(course_events)} ({100*done/len(course_events):.0f}%)')
