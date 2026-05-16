"""
Convert the v0.3 parsed RDF graph into a JSON structure for the dashboard.

v0.3 changes over v0.2:
  - Concepts now include is_free_standing, head_word, semiotic_role
  - Adds modifier_pairs (head-modifier morphological relations)
  - Concepts are stably-ordered (free-standing first, by confidence)
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from foxxi_storyline_parser_v03 import parse_package_v3
from foxxi_storyline_parser_v02 import slugify


def build_dashboard_data_v03(pkg_dir, transcripts_path, ttl_path=None):
    turtle, stats, manifest, content, concepts, slide_concepts, prereq_edges, modifier_pairs, transcripts = parse_package_v3(
        pkg_dir, transcripts_path=transcripts_path, run_whisper=False
    )
    if ttl_path:
        Path(ttl_path).write_text(turtle)
    
    data = {
        'package': {
            'id': manifest['package_id'],
            'title': manifest['organizations'][0]['title'],
            'standard': manifest['standard'],
            'authoring_tool': 'Articulate Storyline',
            'authoring_version': content.get('authoring_version'),
            'parser_version': '0.3.0',
            'vocab_version': '0.2.0',
        },
        'stats': stats,
        'scenes': [],
        'slides': [],
        'concepts': [],
        'prereq_edges': [],
        'modifier_pairs': [],
    }
    
    for scene in content['scenes']:
        data['scenes'].append({
            'id': scene['id'],
            'title': f'Scene {scene["scene_number"]}',
            'scene_number': scene['scene_number'],
            'slide_ids': [s['id'] for s in scene['slides']],
        })
    
    for scene in content['scenes']:
        for idx, slide in enumerate(scene['slides']):
            transcript_segments = []
            transcript_combined = []
            for au in slide['audio_urls']:
                if au in transcripts:
                    t = transcripts[au]
                    transcript_segments.append({
                        'audio_url': au,
                        'duration': t['duration'],
                        'text': t['text'],
                        'segments': t.get('segments', []),
                    })
                    transcript_combined.append(t['text'])
            
            slide_concept_ids = [
                slugify(c) for c in slide_concepts.get(slide['id'], [])
                if slugify(c)
            ]
            
            data['slides'].append({
                'id': slide['id'],
                'title': slide['title'].strip(),
                'scene_id': scene['id'],
                'sequence_index': idx,
                'lms_id': slide.get('lms_id'),
                'audio_count': len(slide['audio_urls']),
                'transcript_segments': transcript_segments,
                'transcript_combined': ' '.join(transcript_combined),
                'concept_ids': slide_concept_ids,
                'alt_text_corpus': '; '.join(set(
                    t for t in slide['alt_text_corpus']
                    if t and t != 'Image 41.emf'
                ))[:500],
            })
    
    # Concepts (sort: free-standing by confidence, then bare)
    concept_records = []
    for phrase, info in concepts.items():
        cid = slugify(phrase)
        if not cid: continue
        concept_records.append({
            'id': cid,
            'label': phrase,
            'confidence': info['confidence'],
            'tier': info['tier'],
            'is_free_standing': info['is_free_standing'],
            'head_word': info['head_word'],
            'taught_in_slides': info['slide_ids'],
            'total_freq': info['total_freq'],
        })
    concept_records.sort(key=lambda c: (not c['is_free_standing'], -c['confidence']))
    data['concepts'] = concept_records
    
    kept_ids = {c['id'] for c in concept_records}
    for from_phrase, to_phrase, conf in prereq_edges:
        from_id = slugify(from_phrase)
        to_id = slugify(to_phrase)
        if from_id in kept_ids and to_id in kept_ids:
            data['prereq_edges'].append({
                'from': from_id, 'to': to_id, 'confidence': conf,
            })
    
    # Modifier pairs
    seen = set()
    for modifier, target in modifier_pairs:
        m_id = slugify(modifier)
        t_id = slugify(target)
        if (m_id, t_id) in seen: continue
        seen.add((m_id, t_id))
        if m_id in kept_ids and t_id in kept_ids:
            data['modifier_pairs'].append({
                'modifier': m_id, 'target': t_id,
            })
    
    return data


if __name__ == '__main__':
    pkg_dir = '/home/claude/storyline-test'
    transcripts = '/home/claude/storyline-test/transcripts.json'
    ttl_out = '/home/claude/storyline-test/lesson3_v03.ttl'
    json_out = '/home/claude/storyline-test/dashboard_data_v03.json'
    
    data = build_dashboard_data_v03(pkg_dir, transcripts, ttl_out)
    Path(json_out).write_text(json.dumps(data, indent=2))
    
    fs = sum(1 for c in data['concepts'] if c['is_free_standing'])
    print(f"\nWrote {json_out}")
    print(f"  Slides: {len(data['slides'])}")
    print(f"  Concepts: {len(data['concepts'])} ({fs} free-standing)")
    print(f"  Prereq edges: {len(data['prereq_edges'])}")
    print(f"  Modifier pairs: {len(data['modifier_pairs'])}")
    print(f"  JSON size: {Path(json_out).stat().st_size:,} bytes")
