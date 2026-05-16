"""
Mock LMS / LRS / IDP connections — what an admin would see in the
'Integrations' tab. Status, last sync, course count contributed.
"""
import json
from pathlib import Path
from datetime import datetime, timedelta

connections = [
    # Primary LMS — connected and active
    {
        'id': 'cornerstone-prod',
        'kind': 'LMS',
        'product': 'Cornerstone OnDemand',
        'instance': 'acme-utility.csod.com',
        'status': 'connected',
        'auth_method': 'OAuth 2.0 (corporate)',
        'last_sync': (datetime(2026, 4, 30) - timedelta(hours=3, minutes=22)).isoformat(),
        'sync_frequency': 'every 6 hours',
        'courses_contributed': 24,
        'auth_warning': None,
    },
    # Secondary LMS — for renewables-specific content
    {
        'id': 'docebo-renewables',
        'kind': 'LMS',
        'product': 'Docebo',
        'instance': 'acme-renewables.docebosaas.com',
        'status': 'connected',
        'auth_method': 'API key',
        'last_sync': (datetime(2026, 4, 30) - timedelta(hours=8, minutes=14)).isoformat(),
        'sync_frequency': 'every 12 hours',
        'courses_contributed': 8,
        'auth_warning': None,
    },
    # SCORM Cloud — for testing / staging
    {
        'id': 'scormcloud-staging',
        'kind': 'LMS',
        'product': 'SCORM Cloud',
        'instance': 'cloud.scorm.com (staging tenant)',
        'status': 'connected',
        'auth_method': 'App ID + Secret',
        'last_sync': (datetime(2026, 4, 30) - timedelta(days=2, hours=4)).isoformat(),
        'sync_frequency': 'manual',
        'courses_contributed': 5,
        'auth_warning': None,
    },
    # Identity provider — primary
    {
        'id': 'okta-prod',
        'kind': 'IDP',
        'product': 'Okta',
        'instance': 'acme-utility.okta.com',
        'status': 'connected',
        'auth_method': 'SAML 2.0 + SCIM 2.0',
        'last_sync': (datetime(2026, 4, 30) - timedelta(minutes=42)).isoformat(),
        'sync_frequency': 'real-time (SCIM)',
        'courses_contributed': None,  # IDP doesn't contribute courses
        'users_provisioned': 183,
        'groups_synced': 9,  # the 9 departments
        'auth_warning': None,
    },
    # HRIS
    {
        'id': 'workday-hris',
        'kind': 'HRIS',
        'product': 'Workday',
        'instance': 'acme-utility.workday.com',
        'status': 'connected',
        'auth_method': 'OAuth 2.0',
        'last_sync': (datetime(2026, 4, 30) - timedelta(hours=14)).isoformat(),
        'sync_frequency': 'nightly',
        'courses_contributed': None,
        'users_provisioned': 183,
        'auth_warning': None,
    },
    # LRS — proposed (not yet connected)
    {
        'id': 'watershed-lrs',
        'kind': 'LRS',
        'product': 'Watershed',
        'instance': '(not configured)',
        'status': 'available',
        'auth_method': '—',
        'last_sync': None,
        'sync_frequency': '—',
        'courses_contributed': None,
        'auth_warning': None,
    },
    # Solid pod federation (the architectural anchor)
    {
        'id': 'foxxi-pod-federation',
        'kind': 'Pod Federation',
        'product': 'Foxxi Context Graphs',
        'instance': 'interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io/markj/',
        'status': 'connected',
        'auth_method': 'WebID-OIDC',
        'last_sync': (datetime(2026, 4, 30) - timedelta(minutes=12)).isoformat(),
        'sync_frequency': 'on-publish',
        'courses_contributed': 2,  # Lessons 2 and 3
        'auth_warning': None,
    },
    # Direct upload (always present)
    {
        'id': 'direct-upload',
        'kind': 'Manual',
        'product': 'Direct Upload',
        'instance': '(local)',
        'status': 'connected',
        'auth_method': '—',
        'last_sync': None,
        'sync_frequency': 'on-demand',
        'courses_contributed': 4,
        'auth_warning': None,
    },
    # An expired one — for showing the warning UX
    {
        'id': 'cornerstone-legacy',
        'kind': 'LMS',
        'product': 'Cornerstone OnDemand (legacy)',
        'instance': 'acme-east.csod.com',
        'status': 'auth-expired',
        'auth_method': 'OAuth 2.0',
        'last_sync': (datetime(2026, 4, 30) - timedelta(days=22)).isoformat(),
        'sync_frequency': 'every 6 hours',
        'courses_contributed': 0,
        'auth_warning': 'Refresh token expired on 2026-04-08; reauthorize to resume sync.',
    },
]

Path('/home/claude/foxxi-admin/connections.json').write_text(json.dumps(connections, indent=2))
print(f'Connections: {len(connections)}')
for c in connections:
    print(f'  {c["product"]} ({c["kind"]}): {c["status"]}')
