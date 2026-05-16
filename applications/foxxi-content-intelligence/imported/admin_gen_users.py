"""
Fabricate a 200-person utility / IPP organization. Gives the admin
dashboard realistic users to assign content to.

Org structure mirrors what you'd see in a real US utility:
  - Operations (largest dept) — control room, field ops, plant ops
  - Engineering — power systems, protection, interconnection, renewables
  - Compliance & Standards
  - IT / Cybersecurity
  - HR / Leadership
  - Commercial / Account Management
  - EHS

Each user has: WebID (for the Solid auth story), name, email, department,
job title, manager (chain rolls up to a CEO), location, audience tags
(used by assignment policies), employment status.
"""

import json
import random
from pathlib import Path

random.seed(43)

# Department → roles → typical headcount weights
ORG_DESIGN = {
    'Operations': {
        'roles': [
            ('Transmission Operator',     ['transmission-operator', 'control-room']),
            ('Plant Operator',            ['plant-operator']),
            ('Field Technician',          ['field-tech']),
            ('Operations Supervisor',     ['manager-all', 'control-room']),
            ('Control Room Manager',      ['manager-all', 'control-room']),
        ],
        'headcount': 60,
    },
    'Engineering': {
        'roles': [
            ('Power Systems Engineer',    ['engineer-power-systems']),
            ('Protection Engineer',       ['engineer-protection']),
            ('Interconnection Engineer',  ['engineer-interconnection']),
            ('Renewables Engineer',       ['engineer-renewables']),
            ('Engineering Manager',       ['manager-all', 'engineer-power-systems']),
            ('VP of Engineering',         ['manager-all', 'manager-new', 'engineer-power-systems']),
        ],
        'headcount': 45,
    },
    'Compliance & Standards': {
        'roles': [
            ('Compliance Officer',        ['compliance-officer']),
            ('NERC Compliance Lead',      ['compliance-officer']),
            ('Standards Coordinator',     ['compliance-officer', 'engineer-power-systems']),
        ],
        'headcount': 12,
    },
    'IT & Cybersecurity': {
        'roles': [
            ('OT Security Analyst',       ['security']),
            ('IT Support',                ['all-employees']),
            ('Cybersecurity Manager',     ['manager-all', 'security']),
        ],
        'headcount': 18,
    },
    'EHS': {
        'roles': [
            ('Safety Coordinator',        ['field-tech']),
            ('EHS Manager',               ['manager-all']),
        ],
        'headcount': 8,
    },
    'Commercial': {
        'roles': [
            ('Account Manager',           ['account-manager']),
            ('Commercial Analyst',        ['commercial-analyst']),
            ('VP of Commercial',          ['manager-all', 'account-manager']),
        ],
        'headcount': 22,
    },
    'HR & People': {
        'roles': [
            ('HR Business Partner',       ['all-employees']),
            ('Learning & Development',    ['all-employees']),
            ('Chief People Officer',      ['manager-all']),
        ],
        'headcount': 10,
    },
    'Procurement': {
        'roles': [
            ('Procurement Specialist',    ['procurement']),
            ('Director of Procurement',   ['manager-all', 'procurement']),
        ],
        'headcount': 7,
    },
}

LOCATIONS = ['Charlotte, NC', 'Houston, TX', 'San Francisco, CA', 'New York, NY', 
             'Atlanta, GA', 'Phoenix, AZ', 'Chicago, IL', 'Denver, CO', 'Remote']
LOCATION_WEIGHTS = [25, 22, 12, 8, 10, 8, 7, 4, 14]

# Plausible names
FIRST_NAMES = ['Sarah', 'James', 'Emily', 'Michael', 'Jessica', 'David', 'Ashley', 'Christopher',
               'Amanda', 'Matthew', 'Brittany', 'Joshua', 'Megan', 'Andrew', 'Stephanie',
               'Daniel', 'Nicole', 'Justin', 'Lauren', 'Brandon', 'Rachel', 'Tyler',
               'Maria', 'Kevin', 'Heather', 'Ryan', 'Crystal', 'Eric', 'Michelle', 'Jason',
               'Tiffany', 'Robert', 'Anna', 'William', 'Samantha', 'Jonathan', 'Elizabeth',
               'Anthony', 'Katherine', 'Scott', 'Rebecca', 'Brian', 'Laura', 'Christopher',
               'Christina', 'Thomas', 'Amy', 'Adam', 'Karen', 'Mark', 'Diana', 'Steven',
               'Priya', 'Jamal', 'Aaliyah', 'Diego', 'Mei', 'Ahmed', 'Yuki', 'Fatima',
               'Carlos', 'Aisha', 'Wei', 'Olufemi', 'Sofia', 'Hiroshi', 'Ngozi', 'Ravi']

LAST_NAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis',
              'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson',
              'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson',
              'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson', 'Walker',
              'Young', 'Allen', 'King', 'Wright', 'Scott', 'Torres', 'Nguyen', 'Hill', 'Flores',
              'Patel', 'Khan', 'Singh', 'Chen', 'Zhang', 'Wang', 'Kim', 'Park', 'Liu', 'Tanaka',
              'Okonkwo', 'Adeyemi', 'Hassan', 'Yamamoto', 'Volkov', 'Petrov', 'Kowalski',
              'Foxxim', 'Marina', 'Fortune', 'Vasquez', 'Cruz', 'Mendoza', 'Reyes']


def slugify_name(first, last):
    return (first[0] + last).lower().replace(' ', '')


def make_user(idx, dept, role_title, audience_tags, manager_idx=None):
    first = random.choice(FIRST_NAMES)
    last = random.choice(LAST_NAMES)
    base = slugify_name(first, last)
    # Disambiguate with idx if needed
    handle = f'{base}{idx if idx < 100 else idx % 100}' if idx >= 30 else base
    
    return {
        'user_id': f'u{idx:04d}',
        'web_id': f'https://id.acme-utility.com/{handle}/profile#me',
        'name': f'{first} {last}',
        'email': f'{handle}@acme-utility.com',
        'department': dept,
        'job_title': role_title,
        'manager_user_id': f'u{manager_idx:04d}' if manager_idx else None,
        'location': random.choices(LOCATIONS, weights=LOCATION_WEIGHTS)[0],
        'audience_tags': audience_tags + ['all-employees'],
        'status': 'active',
        # SCIM-style metadata that the admin UI can show
        'employee_id': f'EMP-{10000 + idx}',
        'hire_date': f'202{random.randint(0, 5)}-{random.randint(1, 12):02d}-{random.randint(1, 28):02d}',
    }


def main():
    users = []
    groups = []
    
    # CEO at top
    ceo = make_user(1, 'Executive', 'Chief Executive Officer', ['manager-all'])
    ceo['manager_user_id'] = None
    users.append(ceo)
    next_idx = 2
    
    # Build each department
    for dept, design in ORG_DESIGN.items():
        # Department head reports to CEO
        head_role, head_tags = design['roles'][-1]  # last role is the senior one
        dept_head = make_user(next_idx, dept, head_role, head_tags, manager_idx=1)
        users.append(dept_head)
        head_idx = next_idx
        next_idx += 1
        
        # Direct reports: managers (some roles)
        manager_indices_in_dept = [head_idx]
        manager_roles = [r for r in design['roles'] if 'manager-all' in r[1] and r != design['roles'][-1]]
        for mrole, mtags in manager_roles[:2]:  # cap on managers
            mgr = make_user(next_idx, dept, mrole, mtags, manager_idx=head_idx)
            users.append(mgr)
            manager_indices_in_dept.append(next_idx)
            next_idx += 1
        
        # Regular ICs split among managers
        ic_roles = [r for r in design['roles'] if 'manager-all' not in r[1]]
        remaining = design['headcount'] - len([u for u in users if u['department'] == dept])
        for _ in range(remaining):
            role_title, tags = random.choice(ic_roles)
            mgr_idx = random.choice(manager_indices_in_dept)
            users.append(make_user(next_idx, dept, role_title, tags, manager_idx=mgr_idx))
            next_idx += 1
    
    # Build groups — these are the access-policy targets
    # A group can be: department, role-based, location-based, audience-tag-based
    
    # Department groups
    departments = sorted(set(u['department'] for u in users))
    for d in departments:
        members = [u['user_id'] for u in users if u['department'] == d]
        groups.append({
            'group_id': f'dept-{d.lower().replace(" ", "-").replace("&", "and")}',
            'name': d,
            'kind': 'department',
            'member_count': len(members),
            'member_ids': members,
            'description': f'All members of {d}',
        })
    
    # Audience tag groups
    all_tags = set()
    for u in users:
        all_tags.update(u['audience_tags'])
    for tag in sorted(all_tags):
        members = [u['user_id'] for u in users if tag in u['audience_tags']]
        if len(members) < 2:
            continue
        groups.append({
            'group_id': f'tag-{tag}',
            'name': tag.replace('-', ' ').title(),
            'kind': 'audience',
            'member_count': len(members),
            'member_ids': members,
            'description': f'Users tagged "{tag}"',
        })
    
    # Location groups (just for the major hubs)
    for loc in ['Charlotte, NC', 'Houston, TX', 'San Francisco, CA']:
        members = [u['user_id'] for u in users if u['location'] == loc]
        groups.append({
            'group_id': f'loc-{loc.split(",")[0].lower().replace(" ", "")}',
            'name': loc,
            'kind': 'location',
            'member_count': len(members),
            'member_ids': members,
            'description': f'Users based in {loc}',
        })
    
    # New-hire group: anyone hired in 2024-2025
    new_hire_ids = [u['user_id'] for u in users if u['hire_date'].startswith(('2024', '2025'))]
    groups.append({
        'group_id': 'new-hires-2024-2025',
        'name': 'New Hires (2024-2025)',
        'kind': 'cohort',
        'member_count': len(new_hire_ids),
        'member_ids': new_hire_ids,
        'description': 'All employees hired in 2024 or 2025',
    })
    
    # Output
    out = Path('/home/claude/foxxi-admin')
    (out / 'users.json').write_text(json.dumps(users, indent=2))
    (out / 'groups.json').write_text(json.dumps(groups, indent=2))
    
    print(f'Users: {len(users)}')
    print(f'Groups: {len(groups)}')
    print('\nDepartment headcounts:')
    from collections import Counter
    for dept, n in Counter(u['department'] for u in users).most_common():
        print(f'  {dept}: {n}')
    print('\nGroup kinds:')
    for k, n in Counter(g['kind'] for g in groups).most_common():
        print(f'  {k}: {n}')


if __name__ == '__main__':
    main()
